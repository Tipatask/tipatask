#!/usr/bin/env node
'use strict';

// Live tag-description probe: API rejects blank/placeholder descriptions and
// backend no longer auto-registers unknown tags. Requires --api-base, isolated
// credentials, and a throwaway project; never production or port 4455.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const opts = { apiBase: null, token: null, mintToken: false, userId: 1, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--api-base') opts.apiBase = argv[++i];
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--mint-token') opts.mintToken = true;
    else if (a === '--user-id') opts.userId = Number(argv[++i]);
    else if (a === '--keep') opts.keep = true;
  }
  return opts;
}

// ── Minimal HS256 JWT signer — see probe-status-roles.js for the full rationale. ──
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signJwtHs256(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + 7 * 24 * 3600 };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(fullPayload))}`;
  const sig = crypto.createHmac('sha256', secret).update(unsigned).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${unsigned}.${sig}`;
}
function readJwtSecret() {
  const envPath = path.join(__dirname, '..', '..', '..', '..', 'api', '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  const m = content.match(/^JWT_SECRET=(.+)$/m);
  if (!m) throw new Error(`JWT_SECRET not found in ${envPath}`);
  return m[1].trim();
}
function readUserEmail(userId) {
  return userId === 1 ? (process.env.TIPATASK_PROBE_USER_EMAIL || 'user1@example.invalid') : `probe-user-${userId}@example.invalid`;
}

let _passCount = 0, _failCount = 0;
function assertTrue(label, cond, detail) {
  if (cond) { _passCount++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { _failCount++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function apiFetch(apiBase, token, method, path_, body) {
  const res = await fetch(`${apiBase}${path_}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.apiBase) {
    console.error('[probe-tag-descriptions] --api-base is required (e.g. http://localhost:4454) — refusing to fall back to .tipatask/config.json, which points at production.');
    process.exitCode = 1;
    return;
  }
  if (/(apppixies|tipatask)\.com/.test(opts.apiBase)) {
    console.error('[probe-tag-descriptions] --api-base looks like the production host — refusing to run against it.');
    process.exitCode = 1;
    return;
  }

  let token = opts.token;
  if (opts.mintToken) {
    const secret = readJwtSecret();
    token = signJwtHs256({ id: opts.userId, email: readUserEmail(opts.userId) }, secret);
    console.log(`[probe-tag-descriptions] minted a local JWT for user id=${opts.userId}`);
  }
  if (!token) {
    console.error('[probe-tag-descriptions] need --token <jwt> or --mint-token');
    process.exitCode = 1;
    return;
  }

  console.log(`[probe-tag-descriptions] target: ${opts.apiBase}\n`);

  // ── 1. Throwaway project ──
  console.log('1. Creating throwaway project...');
  const projectName = `probe-tag-descriptions-${Date.now()}`;
  const createProj = await apiFetch(opts.apiBase, token, 'POST', '/api/projects', { name: projectName });
  if (createProj.status !== 201 && createProj.status !== 200) {
    console.error('[probe-tag-descriptions] failed to create project:', createProj.status, createProj.json);
    process.exitCode = 1;
    return;
  }
  const projectId = createProj.json.project.id;
  console.log(`   created project id=${projectId} name="${projectName}"`);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-probe-'));
  fs.mkdirSync(path.join(tmpRoot, '.tipatask'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, '.tipatask', 'config.json'),
    JSON.stringify({ TASK_BACKEND: 'api', API_BASE_URL: opts.apiBase, API_PROJECT_ID: String(projectId), API_TOKEN: token }, null, 2)
  );
  console.log(`   scratch config: ${tmpRoot}/.tipatask/config.json (isolated, never the real repo's)\n`);

  const tagsBase = `/api/projects/${projectId}/tags`;

  try {
    // ── 2. POST /tags rejects both literals + a prefix variant, names both literals ──
    console.log('2. POST /tags placeholder rejection...');
    const literals = ['Auto-registered by objective save', 'Auto-registered by createTask'];
    for (const [i, literal] of literals.entries()) {
      const res = await apiFetch(opts.apiBase, token, 'POST', tagsBase, { tags: [{ name: `probe-literal-${i}`, description: literal }] });
      assertTrue(`POST /tags rejects literal "${literal}" (400)`, res.status === 400);
      assertTrue('  error names both rejected literals', typeof res.json?.error === 'string' && literals.every(l => res.json.error.includes(l)), res.json?.error);
    }
    const prefixRes = await apiFetch(opts.apiBase, token, 'POST', tagsBase, { tags: [{ name: 'probe-prefix', description: 'Auto-registered by importer' }] });
    assertTrue('POST /tags rejects "Auto-registered by importer" prefix variant (400)', prefixRes.status === 400);

    const { tags: afterReject } = (await apiFetch(opts.apiBase, token, 'GET', tagsBase)).json;
    assertTrue('no rejected tag rows were created', !afterReject.some(t => t.name.startsWith('probe-literal-') || t.name === 'probe-prefix'));

    // A description merely starting with "Auto" (not "Auto-registered") is fine.
    const autoScalingRes = await apiFetch(opts.apiBase, token, 'POST', tagsBase, { tags: [{ name: 'probe-auto-scaling', description: 'Auto-scaling worker pool config' }] });
    assertTrue('POST /tags accepts a real description starting with "Auto" (200)', autoScalingRes.status === 200);
    console.log();

    // ── 3. POST /tags with a real description succeeds ──
    console.log('3. POST /tags with a real description...');
    const realRes = await apiFetch(opts.apiBase, token, 'POST', tagsBase, { tags: [{ name: 'probe-real-tag', description: 'Tags used by the probe script itself' }] });
    assertTrue('POST /tags with real description returns 200', realRes.status === 200);
    console.log();

    // ── 4. PUT /tags/:name placeholder rejection + real update ──
    console.log('4. PUT /tags/:name...');
    const putPlaceholder = await apiFetch(opts.apiBase, token, 'PUT', `${tagsBase}/probe-real-tag`, { description: 'Auto-registered by objective save' });
    assertTrue('PUT rejects placeholder (400)', putPlaceholder.status === 400);
    const putReal = await apiFetch(opts.apiBase, token, 'PUT', `${tagsBase}/probe-real-tag`, { description: 'Updated real description' });
    assertTrue('PUT with real description returns 200', putReal.status === 200);
    console.log();

    // ── 5. bulk-migrate: placeholder object entry rejected, bare string still allowed ──
    console.log('5. POST /tags/bulk-migrate...');
    const bulkPlaceholder = await apiFetch(opts.apiBase, token, 'POST', `${tagsBase}/bulk-migrate`, { tags: [{ name: 'probe-bulk-placeholder', description: 'Auto-registered by createTask' }] });
    assertTrue('bulk-migrate rejects placeholder object entry (400)', bulkPlaceholder.status === 400);
    const bulkBareString = await apiFetch(opts.apiBase, token, 'POST', `${tagsBase}/bulk-migrate`, { tags: ['probe-bulk-bare'] });
    assertTrue('bulk-migrate still accepts a bare-string entry (200)', bulkBareString.status === 200);
    console.log();

    // ── 6. Real api-backend.js instance: createTask with an unregistered tag fails fast ──
    console.log('6. api-backend.js createTask — unregistered tag fails fast, no placeholder row written...');
    const { createApiBackend } = require('../src/server/api-backend');
    const backend = createApiBackend({}, tmpRoot);
    await backend.init();

    let createErr = null;
    try {
      await backend.createTask({
        id: 'C1', title: 'Probe task', description: 'probe', category: 'CODING',
        status: 'pending', priority: 100, order: 0, dependencies: [], tags: ['probe-unregistered'], assignee: null,
      });
    } catch (err) {
      createErr = err;
    }
    assertTrue('createTask throws for an unregistered tag', !!createErr, 'expected a throw — no more silent auto-registration');
    assertTrue('  error names the unregistered tag + tells the agent what to call', !!createErr && /probe-unregistered/.test(createErr.message) && /ensure_project_tag|create_system_tag/.test(createErr.message), createErr?.message);

    const { tags: afterFailedCreate } = (await apiFetch(opts.apiBase, token, 'GET', tagsBase)).json;
    assertTrue('no placeholder row was written for the unregistered tag', !afterFailedCreate.some(t => t.name === 'probe-unregistered'));
    console.log();

    // ── 7. ensureTag with a real description, then createTask succeeds ──
    console.log('7. backend.ensureTag (ensure_project_tag equivalent) then createTask...');
    await backend.ensureTag('probe-unregistered', 'A tag registered by the probe for its own task');
    let secondErr = null;
    let created = null;
    try {
      created = await backend.createTask({
        id: 'C2', title: 'Probe task 2', description: 'probe', category: 'CODING',
        status: 'pending', priority: 100, order: 1, dependencies: [], tags: ['probe-unregistered'], assignee: null,
      });
    } catch (err) {
      secondErr = err;
    }
    assertTrue('createTask succeeds once the tag is registered with a real description', !secondErr && !!created, secondErr?.message);
    console.log();

    // ── 7b. C1439 — case-drifted tag name rewrites to the DB's canonical spelling ──
    // The API's own resolveTagIds (api/src/routes/tasks.js) matches case-INSENSITIVELY in
    // SQL but then filters case-SENSITIVELY in JS against the DB's own spelling — so a
    // client that merely case-folds without rewriting the outgoing name would still 400
    // downstream. This is the one part of the C1439 fix that pure unit tests can't fully
    // prove (it depends on the real API's actual matching behavior) — see
    // tag-registry-gate.js's resolveTagNames() for the client-side logic under test here.
    console.log('7b. C1439 — case-drifted tag ("Probe-CaseDrift" registered, "probe-casedrift" sent) still succeeds, rewritten to canonical...');
    await backend.ensureTag('Probe-CaseDrift', 'Registered with mixed case, on purpose, for the C1439 case-fold probe');
    let caseDriftErr = null;
    let caseDriftCreated = null;
    try {
      caseDriftCreated = await backend.createTask({
        id: 'C3', title: 'Probe case-drift task', description: 'probe', category: 'CODING',
        status: 'pending', priority: 100, order: 2, dependencies: [], tags: ['probe-casedrift'], assignee: null,
      });
    } catch (err) {
      caseDriftErr = err;
    }
    assertTrue('createTask succeeds for a case-drifted tag name', !caseDriftErr && !!caseDriftCreated, caseDriftErr?.message);
    assertTrue(
      '  task.tags carries the CANONICAL (registered) spelling, not the input spelling',
      !!caseDriftCreated && Array.isArray(caseDriftCreated.tags) && caseDriftCreated.tags.includes('Probe-CaseDrift'),
      JSON.stringify(caseDriftCreated?.tags)
    );
    console.log();

    // ── 8. Teardown ──
    if (opts.keep) {
      console.log(`8. --keep set: leaving project id=${projectId} ("${projectName}") in place for inspection.`);
    } else {
      console.log('8. Tearing down throwaway project...');
      await apiFetch(opts.apiBase, token, 'DELETE', `/api/projects/${projectId}`);
      console.log('   deleted.');
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`\n[probe-tag-descriptions] ${_passCount} passed, ${_failCount} failed.`);
  if (_failCount > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[probe-tag-descriptions] failed:', err.message);
  if (err.body) console.error('  response body:', JSON.stringify(err.body));
  process.exitCode = 1;
});
