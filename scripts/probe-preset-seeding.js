#!/usr/bin/env node
'use strict';

// Live preset-seeding probe: reserved keys must finalize into visible tasks,
// never blank reservation rows. Uses a throwaway project per preset and checks
// the unregistered-tag failure control. Requires --api-base; --preset narrows
// to one preset, and --keep retains scratch data.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const opts = { apiBase: null, token: null, mintToken: false, userId: 1, keep: false, preset: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--api-base') opts.apiBase = argv[++i];
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--mint-token') opts.mintToken = true;
    else if (a === '--user-id') opts.userId = Number(argv[++i]);
    else if (a === '--preset') opts.preset = argv[++i];
    else if (a === '--keep') opts.keep = true;
  }
  return opts;
}

// Minimal HS256 signer — mirrors api/src/routes/auth.js jwt.sign({ id, email }, JWT_SECRET,
// { expiresIn: '7d' }); avoids pulling `jsonwebtoken` (an api/ dependency) into this package.
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signJwtHs256(payload, secret) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ ...payload, iat: now, exp: now + 7 * 24 * 3600 }))}`;
  const sig = crypto.createHmac('sha256', secret).update(unsigned).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${unsigned}.${sig}`;
}
function readJwtSecret() {
  const envPath = path.join(__dirname, '..', '..', '..', '..', 'api', '.env');
  const m = fs.readFileSync(envPath, 'utf8').match(/^JWT_SECRET=(.+)$/m);
  if (!m) throw new Error(`JWT_SECRET not found in ${envPath}`);
  return m[1].trim();
}

let _pass = 0, _fail = 0;
function check(label, cond, detail) {
  if (cond) { _pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { _fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}`); }
}

// Never throws on non-2xx — several steps assert on a 400 on purpose.
async function api(apiBase, token, method, p, body) {
  const res = await fetch(`${apiBase}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data };
}
function must(res, what) {
  if (res.status >= 400) throw new Error(`${what} -> ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data;
}

const RESERVE_PLACEHOLDER_TITLE = 'New task';
const RESERVE_PLACEHOLDER_DESCRIPTION = 'Reserved key — pending finalization.';
const DEFAULT_TAGS = ['feature', 'bugfix', 'refactor', 'migration', 'config', 'security', 'css'];

const created = [];
async function newProject(apiBase, token, label) {
  const { project } = must(await api(apiBase, token, 'POST', '/api/projects', { name: `probe-preset-${label}-${Date.now()}` }), 'create project');
  created.push(project.id);
  return project;
}

async function control(apiBase, token) {
  console.log('0. CONTROL — the API contract behind the bug (PATCH validates tags before any write)');
  const project = await newProject(apiBase, token, 'control');
  const base = `/api/projects/${project.id}`;
  const { tasks } = must(await api(apiBase, token, 'POST', `${base}/tasks/reserve`, { count: 1, category: 'CODING', priority: 0 }), 'reserve');
  const key = tasks[0].task_key;
  check(`reserved ${key} as a placeholder`, tasks[0].is_reservation === 1 && tasks[0].title === RESERVE_PLACEHOLDER_TITLE);

  const bad = await api(apiBase, token, 'PATCH', `${base}/tasks/${key}`, {
    title: 'Real title', description: 'Real description', status: 'pending', priority: 1, tags: ['existing-code'],
  });
  check('PATCH naming an UNREGISTERED tag is rejected with 400', bad.status === 400, `got ${bad.status}: ${JSON.stringify(bad.data)}`);
  check('400 body names the missing tag', Array.isArray(bad.data && bad.data.missing) && bad.data.missing.includes('existing-code'));

  const after = must(await api(apiBase, token, 'GET', `${base}/tasks/${key}`), 'get after bad PATCH');
  const row = after.task || after;
  check('…and NOTHING was written: row is still the blank placeholder (the reported bug)',
    row.is_reservation === 1 && row.title === RESERVE_PLACEHOLDER_TITLE && row.description === RESERVE_PLACEHOLDER_DESCRIPTION,
    `title=${JSON.stringify(row.title)} is_reservation=${row.is_reservation}`);

  const good = must(await api(apiBase, token, 'PATCH', `${base}/tasks/${key}`, {
    title: 'Real title', description: 'Real description', status: 'pending', priority: 1, tags: ['feature'],
  }), 'good PATCH');
  const g = good.task;
  check('PATCH with only registered tags clears is_reservation', g.is_reservation === 0);
  check('…persists the description', g.description === 'Real description');
  check('…persists the title', g.title === 'Real title');

  const visible = must(await api(apiBase, token, 'GET', `${base}/tasks`), 'list');
  const list = Array.isArray(visible) ? visible : visible.tasks;
  check('finalized task now appears in GET /tasks (no include_reservations)', list.some(t => t.task_key === key));
  console.log();
}

async function probePreset(apiBase, token, preset) {
  const { PRESET_TASKS, seedPresetTasks } = require('../src/cli/seed-setup-tasks');
  const defs = PRESET_TASKS[preset];
  console.log(`1. PRESET ${preset} — fresh project, real seedPresetTasks()`);
  const project = await newProject(apiBase, token, preset);
  const base = `/api/projects/${project.id}`;

  const before = must(await api(apiBase, token, 'GET', `${base}/tags`), 'tags before').tags.map(t => t.name).sort();
  check('fresh project starts with only the 7 default tags', JSON.stringify(before) === JSON.stringify([...DEFAULT_TAGS].sort()), `got ${before.join(', ')}`);
  const featureBefore = must(await api(apiBase, token, 'GET', `${base}/tags`), 'tags').tags.find(t => t.name === 'feature').description;

  const result = await seedPresetTasks(preset, { apiBaseUrl: apiBase, token, projectId: project.id, presetDescription: null });
  check(`seedPresetTasks reports ${defs.length} seeded, 0 failed`, result.seeded === defs.length && result.failed === 0, JSON.stringify(result));

  const visibleRes = must(await api(apiBase, token, 'GET', `${base}/tasks`), 'list default');
  const visible = Array.isArray(visibleRes) ? visibleRes : visibleRes.tasks;
  check(`GET /tasks WITHOUT include_reservations returns all ${defs.length} tasks`, visible.length === defs.length, `got ${visible.length}`);

  const allRes = must(await api(apiBase, token, 'GET', `${base}/tasks?include_reservations=true`), 'list all');
  const all = Array.isArray(allRes) ? allRes : allRes.tasks;
  check('WITH include_reservations the count is the same — zero stranded placeholders', all.length === defs.length && all.every(t => !t.is_reservation), `total=${all.length} reserved=${all.filter(t => t.is_reservation).length}`);

  const byTitle = new Map(all.map(t => [t.title, t]));
  const keys = [];
  for (const [title, description, extra = {}] of defs) {
    const t = byTitle.get(title);
    check(`"${title}" exists with its real title (not "${RESERVE_PLACEHOLDER_TITLE}")`, !!t);
    if (!t) continue;
    keys.push(t.task_key);
    check('  full PRESET_TASKS description persisted', t.description === description, `len ${String(t.description || '').length} vs ${description.length}`);
    check('  description is not the reservation placeholder text', t.description !== RESERVE_PLACEHOLDER_DESCRIPTION);
    check('  is_reservation cleared, status pending, priority from preset', !t.is_reservation && t.status === 'pending' && t.priority === (extra.priority ?? 1), `is_reservation=${t.is_reservation} status=${t.status} priority=${t.priority}`);
    const wantTags = extra.tags || [];
    const gotTags = (t.tags || []).map(x => (typeof x === 'string' ? x : x.name));
    check('  tags attached', wantTags.every(n => gotTags.includes(n)), `want ${wantTags.join(',')} got ${gotTags.join(',')}`);
  }
  // dependsOn indexes -> real keys
  defs.forEach(([title, , extra = {}], i) => {
    const idxs = extra.dependsOn ?? (extra.dependsOnCodeScan ? [0] : []);
    if (!idxs.length) return;
    const t = byTitle.get(title);
    const deps = (t && t.dependencies) || [];
    check(`"${title}" depends on ${idxs.map(ix => keys[ix]).join(', ')}`, idxs.every(ix => deps.includes(keys[ix])), `got ${JSON.stringify(deps)}`);
  });

  const tagsAfter = must(await api(apiBase, token, 'GET', `${base}/tags`), 'tags after').tags;
  const want = [...new Set(defs.flatMap(([, , e = {}]) => e.tags || []))];
  for (const n of want) {
    const row = tagsAfter.find(t => t.name === n);
    check(`tag "${n}" is registered with a real description`, !!row && !!row.description && !/^auto-registered\b/i.test(row.description));
  }
  const featureAfter = tagsAfter.find(t => t.name === 'feature').description;
  check('default tag "feature" description was not overwritten', featureAfter === featureBefore, `before=${JSON.stringify(featureBefore)} after=${JSON.stringify(featureAfter)}`);
  console.log();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.apiBase) {
    console.error('[probe-preset-seeding] --api-base is required (e.g. http://localhost:4454) — refusing to fall back to .tipatask/config.json, which points at production.');
    process.exitCode = 1; return;
  }
  if (/(apppixies|tipatask)\.com/.test(opts.apiBase) || /:4455(\/|$)/.test(opts.apiBase)) {
    console.error('[probe-preset-seeding] --api-base looks like production or the Task App port 4455 — refusing to run against it.');
    process.exitCode = 1; return;
  }
  let token = opts.token;
  if (opts.mintToken) {
    token = signJwtHs256({ id: opts.userId, email: opts.userId === 1 ? (process.env.TIPATASK_PROBE_USER_EMAIL || 'user1@example.invalid') : `probe-user-${opts.userId}@example.invalid` }, readJwtSecret());
    console.log(`[probe-preset-seeding] minted a local JWT for user id=${opts.userId}`);
  }
  if (!token) { console.error('[probe-preset-seeding] need --token <jwt> or --mint-token'); process.exitCode = 1; return; }
  console.log(`[probe-preset-seeding] target: ${opts.apiBase}\n`);

  const presets = opts.preset ? [opts.preset] : ['original-specification', 'existing-code'];
  try {
    await control(opts.apiBase, token);
    for (const p of presets) await probePreset(opts.apiBase, token, p);
  } finally {
    if (opts.keep) {
      console.log(`--keep set: leaving project id(s) ${created.join(', ')} in place for inspection.`);
    } else {
      for (const id of created) {
        const r = await api(opts.apiBase, token, 'DELETE', `/api/projects/${id}`);
        console.log(`teardown: project ${id} ${r.status < 400 ? 'deleted' : `NOT deleted (${r.status})`}`);
      }
    }
  }
  console.log(`\n[probe-preset-seeding] ${_pass} passed, ${_fail} failed.`);
  if (_fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[probe-preset-seeding] failed:', err.message);
  process.exitCode = 1;
});
