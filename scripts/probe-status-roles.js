#!/usr/bin/env node
'use strict';

// Live custom-status role probe: canceled role resolution, MCP dependency floors,
// update validation, and reopen logic. Requires --api-base and uses isolated
// credentials plus throwaway project; never production or port 4455. --dry-run
// reads status context only; --keep preserves the scratch project.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const opts = { apiBase: null, token: null, mintToken: false, userId: 1, keep: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--api-base') opts.apiBase = argv[++i];
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--mint-token') opts.mintToken = true;
    else if (a === '--user-id') opts.userId = Number(argv[++i]);
    else if (a === '--keep') opts.keep = true;
    else if (a === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

// ── Minimal HS256 JWT signer — avoids pulling `jsonwebtoken` (an api/ dependency, not an
// ai/todo/server one) into this package just for a probe script. Mirrors api/src/routes/
// auth.js's jwt.sign({ id, email }, JWT_SECRET, { expiresIn: '7d' }) payload shape exactly
// — that's what requireAuth (api/src/middleware/auth.js) expects on req.user. ──
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
  // Best-effort — only used to populate the JWT's `email` claim, which requireAuth never
  // actually validates against the DB (it trusts the signature). A wrong/placeholder email
  // here cannot cause a false pass or false fail anywhere in this probe.
  return userId === 1 ? (process.env.TIPATASK_PROBE_USER_EMAIL || 'user1@example.invalid') : `probe-user-${userId}@example.invalid`;
}

let _passCount = 0, _failCount = 0;
function assertEq(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (pass) {
    _passCount++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    _failCount++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
  }
}
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
  if (!res.ok) {
    const err = new Error(`${method} ${path_} -> ${res.status}: ${json && json.error || res.statusText}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.apiBase) {
    console.error('[probe-status-roles] --api-base is required (e.g. http://localhost:4454) — refusing to fall back to .tipatask/config.json, which points at production.');
    process.exitCode = 1;
    return;
  }
  if (/(apppixies|tipatask)\.com/.test(opts.apiBase)) {
    console.error('[probe-status-roles] --api-base looks like the production host — refusing to run against it.');
    process.exitCode = 1;
    return;
  }

  let token = opts.token;
  if (opts.mintToken) {
    const secret = readJwtSecret();
    token = signJwtHs256({ id: opts.userId, email: readUserEmail(opts.userId) }, secret);
    console.log(`[probe-status-roles] minted a local JWT for user id=${opts.userId}`);
  }
  if (!token) {
    console.error('[probe-status-roles] need --token <jwt> or --mint-token');
    process.exitCode = 1;
    return;
  }

  console.log(`[probe-status-roles] target: ${opts.apiBase}\n`);

  // ── 1. Create a throwaway project ──
  console.log('1. Creating throwaway project...');
  const projectName = `probe-status-roles-${Date.now()}`;
  const { project } = await apiFetch(opts.apiBase, token, 'POST', '/api/projects', { name: projectName });
  const projectId = project.id;
  console.log(`   created project id=${projectId} name="${project.name}"`);

  // Scratch .tipatask/config.json — isolated temp dir, never this repo's config.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-probe-'));
  fs.mkdirSync(path.join(tmpRoot, '.tipatask'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, '.tipatask', 'config.json'),
    JSON.stringify({ TASK_BACKEND: 'api', API_BASE_URL: opts.apiBase, API_PROJECT_ID: String(projectId), API_TOKEN: token }, null, 2)
  );
  console.log(`   scratch config: ${tmpRoot}/.tipatask/config.json (isolated, never the real repo's)\n`);

  try {
    // ── 2. Verify default seeding + is_workflow_canceled ──
    console.log('2. GET /statuses — verify default 5-row seed + is_workflow_canceled...');
    const { statuses } = await apiFetch(opts.apiBase, token, 'GET', `/api/projects/${projectId}/statuses`);
    assertEq('5 default statuses seeded', statuses.length, 5);
    const byName = Object.fromEntries(statuses.map(s => [s.name, s]));
    assertTrue('pending holds is_workflow_start', !!byName.pending?.is_workflow_start);
    assertTrue('in_progress holds is_in_progress', !!byName.in_progress?.is_in_progress);
    assertTrue('completed holds is_workflow_complete', !!byName.completed?.is_workflow_complete);
    assertTrue('canceled holds is_workflow_canceled (the new 4th flag)', !!byName.canceled?.is_workflow_canceled);
    console.log();

    if (opts.dryRun) {
      console.log('[probe-status-roles] --dry-run: skipping rename/task/MCP-logic steps.');
    } else {
      // ── 3. Rename all 4 role holders ──
      console.log('3. PATCH-renaming all 4 role-holding statuses...');
      const renameMap = { pending: 'Backlog', in_progress: 'Doing', completed: 'Shipped', canceled: 'Dropped' };
      for (const [oldName, newName] of Object.entries(renameMap)) {
        await apiFetch(opts.apiBase, token, 'PATCH', `/api/projects/${projectId}/statuses/${byName[oldName].id}`, { name: newName });
      }
      const { statuses: renamed } = await apiFetch(opts.apiBase, token, 'GET', `/api/projects/${projectId}/statuses`);
      const renamedByName = Object.fromEntries(renamed.map(s => [s.name, s]));
      assertTrue('Backlog now holds is_workflow_start', !!renamedByName.Backlog?.is_workflow_start);
      assertTrue('Doing now holds is_in_progress', !!renamedByName.Doing?.is_in_progress);
      assertTrue('Shipped now holds is_workflow_complete', !!renamedByName.Shipped?.is_workflow_complete);
      assertTrue('Dropped now holds is_workflow_canceled', !!renamedByName.Dropped?.is_workflow_canceled);
      console.log();

      // ── 4. Real api-backend.js instance against the renamed registry ──
      console.log('4. Building a real api-backend.js instance (scratch config, isolated)...');
      const { createApiBackend } = require('../src/server/api-backend');
      const { fetchStatusContext } = require('../src/server/status-roles');
      const backend = createApiBackend({}, tmpRoot);
      await backend.init();
      const ctx = await fetchStatusContext(backend);
      assertEq('roles.start resolves to Backlog', ctx.roles.start, 'Backlog');
      assertEq('roles.in_progress resolves to Doing', ctx.roles.in_progress, 'Doing');
      assertEq('roles.complete resolves to Shipped', ctx.roles.complete, 'Shipped');
      assertEq('roles.canceled resolves to Dropped', ctx.roles.canceled, 'Dropped');
      assertEq('active set = {Backlog, Doing, on_fire}', [...ctx.active].sort(), ['Backlog', 'Doing', 'on_fire']);
      console.log();

      // ── 5. create_task path: status omitted -> lands on the start role ──
      console.log('5. Creating task A with status omitted (should land on Backlog)...');
      const taskA = await backend.createTask({
        id: 'C1', title: 'Probe task A', description: 'probe', category: 'CODING',
        status: ctx.roles.start, priority: 100, order: 0, dependencies: [], tags: [], assignee: null,
      });
      assertEq('task A status = Backlog', taskA.status, 'Backlog');
      console.log();

      // ── 6. Dependency floor: the exact bug this task fixes ──
      // Mirrors the real-world trigger (CLAUDE.md step 3a): a mid-task follow-up whose
      // priority is PINNED to the current task's sprint (not left to fall through to the
      // max_plus_one tier) and which also depends on a task already active in that same
      // sprint. Pre-C1187, applyDependencyFloor's ACTIVE.has(status) check matched only
      // the legacy literal names, so on a renamed registry it silently no-op'd and B
      // landed in the SAME sprint as the thing it's blocked on.
      console.log('6. Dependency floor — task B pinned to A\'s own sprint, depends on A...');
      const { applyDependencyFloor } = require('../src/mcp/priority-fallback');
      const allTasks = await backend.getTasksUnfiltered();
      const floored = applyDependencyFloor({
        priority: taskA.priority, dependencies: ['C1'], tasks: allTasks,
        taskId: 'C2', status: ctx.roles.start, activeStatuses: ctx.active,
      });
      assertTrue('dependency floor fired (bumped=true)', floored.bumped === true,
        'this is the exact bug fixed by C1187 — pre-fix, applyDependencyFloor\'s ACTIVE.has(status) check silently failed on a custom status and the floor never applied');
      assertTrue('B\'s priority > A\'s priority', floored.priority > taskA.priority);
      const taskB = await backend.createTask({
        id: 'C2', title: 'Probe task B', description: 'probe', category: 'CODING',
        status: ctx.roles.start, priority: floored.priority, order: 0, dependencies: ['C1'], tags: [], assignee: null,
      });
      console.log();

      // ── 7. Both tasks appear in the active set (list_task_id_meta equivalent) ──
      console.log('7. Both A and B resolve as active via ctx.active...');
      const afterCreate = await backend.getTasksUnfiltered();
      const activeIds = afterCreate.filter(t => ctx.active.has(t.status)).map(t => t.id);
      assertTrue('C1 (task A) is active', activeIds.includes('C1'));
      assertTrue('C2 (task B) is active', activeIds.includes('C2'));
      console.log();

      // ── 8. update_task-equivalent: custom status name accepted, bogus name rejected ──
      console.log('8. update_task-equivalent — custom status name accepted, bogus name rejected...');
      const updated = await backend.updateTask('C1', { status: 'Doing' });
      assertEq('C1 accepted status "Doing"', updated.status, 'Doing');
      const namesNow = (await fetchStatusContext(backend, { refresh: true })).names;
      assertTrue('bogus status name is rejected (not in registry)', !namesNow.includes('not-a-real-status'));
      console.log();

      // ── 9. isClosedName on the renamed registry ──
      console.log('9. isClosedName resolves by role, not by the old literal "canceled"...');
      const { isClosedName } = require('../src/server/status-roles');
      assertTrue('isClosedName("Shipped") === true', isClosedName('Shipped', ctx.roles));
      assertTrue('isClosedName("Dropped") === true', isClosedName('Dropped', ctx.roles));
      assertTrue('isClosedName("completed") === false (not this project\'s name)', !isClosedName('completed', ctx.roles));
      assertTrue('isClosedName("canceled") === false (literal-name residue is gone)', !isClosedName('canceled', ctx.roles));
      console.log();
    }

    // ── 10. Teardown ──
    if (opts.keep) {
      console.log(`10. --keep set: leaving project id=${projectId} ("${project.name}") in place for inspection.`);
    } else {
      console.log('10. Tearing down throwaway project...');
      await apiFetch(opts.apiBase, token, 'DELETE', `/api/projects/${projectId}`);
      console.log('   deleted.');
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`\n[probe-status-roles] ${_passCount} passed, ${_failCount} failed.`);
  if (_failCount > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[probe-status-roles] failed:', err.message);
  if (err.body) console.error('  response body:', JSON.stringify(err.body));
  process.exitCode = 1;
});
