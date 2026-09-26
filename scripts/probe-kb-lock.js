#!/usr/bin/env node
'use strict';

// Live KB lease probe against a throwaway project, including contention between
// instances sharing one token. Requires --api-base; production needs the explicit
// --allow-production flag and a real production JWT. Production refuses --keep
// and --mint-token. --unit uses an offline loopback mock with no credentials.
// Examples:
//   npm run probe:kb-lock -- --api-base http://localhost:4454 --mint-token
//   npm run probe:kb-lock -- --api-base https://web.tipatask.com --allow-production --token "$TOK"
//   npm run probe:kb-lock:unit

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

function parseArgs(argv) {
  const opts = { apiBase: null, token: null, mintToken: false, userId: 1, keep: false, allowProduction: false, unit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--api-base') opts.apiBase = argv[++i];
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--mint-token') opts.mintToken = true;
    else if (a === '--user-id') opts.userId = Number(argv[++i]);
    else if (a === '--keep') opts.keep = true;
    // C1221 — opt-in escape hatch for a real production QA pass. Default stays deny; see
    // the guard in main() for what it does and does not relax.
    else if (a === '--allow-production') opts.allowProduction = true;
    // C1323 — offline mocked cases, no live API at all. See header comment.
    else if (a === '--unit') opts.unit = true;
  }
  return opts;
}

// Minimal HS256 JWT signer — same as probe-status-roles.js / probe-tag-descriptions.js /
// probe-kb-reindex.js, avoids pulling `jsonwebtoken` (an api/ dependency, not this
// package's) into ai/todo/server.
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
  if (!res.ok) {
    const err = new Error(`${method} ${path_} -> ${res.status}: ${json && json.error || res.statusText}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ── C1323 — offline unit cases ──
// A fake KB API standing in for api/src/routes/knowledge.js's lock/PUT/GET routes. Mirrors
// src/cli/knowledge-sync.test.js's startBodyServer: parses the JSON body, hands the handler
// (pathname, method, body, headers) so a case can inspect X-Tipatask-Instance, and lets the
// handler be async so a case can hold a response open to force real overlap.
function startFakeApi(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const u = new URL(req.url, 'http://localhost');
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* not JSON */ }
        const { status, body: resBody } = await handler(u.pathname, req.method, body, req.headers);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resBody ?? {}));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
function fakeApiUrl(srv) { return `http://127.0.0.1:${srv.address().port}`; }
function fakeLockUrl(projectId, fileKey) { return `/api/projects/${projectId}/knowledge/${fileKey}/lock`; }
function fakeDocUrl(projectId, fileKey) { return `/api/projects/${projectId}/knowledge/${fileKey}`; }
function fakeListUrl(projectId) { return `/api/projects/${projectId}/knowledge`; }

async function runUnitCases() {
  const { syncProjectKb, pushFile, getLocalVersions, __resetSyncState } = require('../src/cli/knowledge-sync');

  // ── 1. Project-open sync (main/window-state.js's bindWindowToProject -> syncProjectKb) ──
  console.log('1. Project-open sync: coalescing + re-arm, no credentials or throwaway project...');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-probe-unit-sync-'));
    let listHits = 0;
    const srv = await startFakeApi(async (pathname) => {
      if (pathname === fakeListUrl('u1')) { listHits++; return { status: 200, body: { files: [{ file_key: 'AGENTS.md', version: 1 }] } }; }
      if (pathname === '/api/projects/u1/knowledge/AGENTS.md') return { status: 200, body: { content: 'unit\n', version: 1 } };
      return { status: 404, body: {} };
    });
    fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({ TASK_BACKEND: 'api', API_BASE_URL: fakeApiUrl(srv), API_TOKEN: 'tok', API_PROJECT_ID: 'u1' }));
    const prevBackend = process.env.TASK_BACKEND;
    delete process.env.TASK_BACKEND; // a stray exported TASK_BACKEND must not win over config.json

    try {
      const [r1, r2] = await Promise.all([syncProjectKb(root, 'window-bind'), syncProjectKb(root, 'window-bind')]);
      assertTrue('two concurrent binds to one project coalesce to one GET', listHits === 1, `listHits=${listHits}`);
      assertTrue('both binds resolve the same synced result', r1.status === 'synced' && r2.status === 'synced');
      assertTrue('the file was actually pulled to disk', fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8') === 'unit\n');

      __resetSyncState(root);
      await syncProjectKb(root, 'window-bind');
      assertTrue('__resetSyncState re-arms the latch — a second real sync ran', listHits === 2, `listHits=${listHits}`);
    } finally {
      if (prevBackend === undefined) delete process.env.TASK_BACKEND; else process.env.TASK_BACKEND = prevBackend;
      srv.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  console.log();

  // ── 2. Cache-update race ──
  console.log('2. Cache-update race: concurrent pushes on different keys, and a corrupt cache...');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-probe-unit-cache-'));
    const srv = await startFakeApi(async (pathname, method) => {
      for (const key of ['a.md', 'b.md']) {
        if (pathname === fakeLockUrl('u2', key) && method === 'POST') return { status: 200, body: { file_key: key, version: 1, content: 'remote', locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 } };
        if (pathname === fakeLockUrl('u2', key) && method === 'DELETE') return { status: 200, body: { released: true } };
        if (pathname === fakeDocUrl('u2', key) && method === 'PUT') return { status: 200, body: { file_key: key, version: 2 } };
      }
      return { status: 404, body: {} };
    });
    try {
      await Promise.all([
        pushFile(fakeApiUrl(srv), 'u2', 'tok', 'a.md', 'content-a', 1, root, {}),
        pushFile(fakeApiUrl(srv), 'u2', 'tok', 'b.md', 'content-b', 1, root, {}),
      ]);
      const cache = getLocalVersions(root);
      assertTrue('concurrent pushes on different keys both land in the cache — no lost update', cache['a.md']?.version === 2 && cache['b.md']?.version === 2, JSON.stringify(cache));
    } finally {
      srv.close();
      fs.rmSync(root, { recursive: true, force: true });
    }

    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-probe-unit-corrupt-'));
    fs.mkdirSync(path.join(root2, '.tipatask'), { recursive: true });
    fs.writeFileSync(path.join(root2, '.tipatask', 'knowledge-versions.json'), '{not valid json', 'utf8');
    const srv2 = await startFakeApi(async (pathname, method) => {
      if (pathname === fakeLockUrl('u2', 'CLAUDE.md') && method === 'POST') return { status: 200, body: { file_key: 'CLAUDE.md', version: 5, content: 'remote', locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 } };
      if (pathname === fakeLockUrl('u2', 'CLAUDE.md') && method === 'DELETE') return { status: 200, body: { released: true } };
      if (pathname === fakeDocUrl('u2', 'CLAUDE.md') && method === 'PUT') return { status: 200, body: { file_key: 'CLAUDE.md', version: 6 } };
      return { status: 404, body: {} };
    });
    try {
      assertTrue('a corrupt cache reads as {} rather than throwing', Object.keys(getLocalVersions(root2)).length === 0);
      const result = await pushFile(fakeApiUrl(srv2), 'u2', 'tok', 'CLAUDE.md', 'content', 0, root2, {});
      assertTrue('push still succeeds against a corrupt cache and rewrites it clean', result.version === 6 && getLocalVersions(root2)['CLAUDE.md']?.version === 6, JSON.stringify(result));
    } finally {
      srv2.close();
      fs.rmSync(root2, { recursive: true, force: true });
    }
  }
  console.log();

  // ── 3. Lock release on failure ──
  console.log('3. Lock release on failure: a PUT 500 and a PUT lock_held 409 must both still release...');
  {
    for (const failMode of ['500', 'lock_held']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `tipatask-probe-unit-release-${failMode}-`));
      let releaseHits = 0;
      const srv = await startFakeApi(async (pathname, method) => {
        if (pathname === fakeLockUrl('u3', 'CLAUDE.md') && method === 'POST') {
          return { status: 200, body: { file_key: 'CLAUDE.md', version: 5, content: 'remote', locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 } };
        }
        if (pathname === fakeLockUrl('u3', 'CLAUDE.md') && method === 'DELETE') {
          releaseHits++;
          return { status: 200, body: { released: true } };
        }
        if (pathname === fakeDocUrl('u3', 'CLAUDE.md') && method === 'PUT') {
          if (failMode === '500') return { status: 500, body: {} };
          return { status: 409, body: { error: 'locked', lock_held: true, retry_after_seconds: 5, lock_expires_at: 'later', same_user: false, locked_by_email: 'other@x.com' } };
        }
        return { status: 404, body: {} };
      });
      try {
        let threw = null;
        try { await pushFile(fakeApiUrl(srv), 'u3', 'tok', 'CLAUDE.md', 'content', 5, root, {}); }
        catch (err) { threw = err; }
        assertTrue(`PUT ${failMode}: push rejected`, threw !== null);
        assertTrue(`PUT ${failMode}: lease released exactly once despite the failure (finally block fired)`, releaseHits === 1, `releaseHits=${releaseHits}`);
      } finally {
        srv.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
  console.log();

  // ── 4. Two-writer contention ──
  console.log('4. Two-writer contention: B blocked while A holds it, wins once A releases...');
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-probe-unit-contend-'));
    let held = true;
    let putHits = 0;
    const srv = await startFakeApi(async (pathname, method, body, headers) => {
      const instance = headers['x-tipatask-instance'];
      if (pathname === fakeLockUrl('u4', 'CLAUDE.md') && method === 'POST') {
        if (held) return { status: 409, body: { error: 'locked', lock_held: true, retry_after_seconds: 0, lock_expires_at: 'later', same_user: true } };
        return { status: 200, body: { file_key: 'CLAUDE.md', version: 5, content: 'remote', locked_instance: instance, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 } };
      }
      if (pathname === fakeLockUrl('u4', 'CLAUDE.md') && method === 'DELETE') return { status: 200, body: { released: true } };
      if (pathname === fakeDocUrl('u4', 'CLAUDE.md') && method === 'PUT') { putHits++; return { status: 200, body: { file_key: 'CLAUDE.md', version: 6 } }; }
      return { status: 404, body: {} };
    });
    try {
      let blockedErr = null;
      try { await pushFile(fakeApiUrl(srv), 'u4', 'tok', 'CLAUDE.md', 'attempt', 5, root, { instanceId: 'instance-b', lockWaitMs: 0 }); }
      catch (err) { blockedErr = err; }
      assertTrue('B with no wait budget rejects lockHeld while A holds it', blockedErr && blockedErr.lockHeld === true);
      assertTrue('no PUT reached the server while the lease was held', putHits === 0, `putHits=${putHits}`);

      const waiter = pushFile(fakeApiUrl(srv), 'u4', 'tok', 'CLAUDE.md', 'attempt-2', 5, root, { instanceId: 'instance-b', lockWaitMs: 5000 });
      await new Promise((r) => setTimeout(r, 50));
      held = false; // A releases mid-retry
      const result = await waiter;
      assertTrue('B\'s retry acquires once A releases, and PUTs exactly once', result.version === 6 && putHits === 1, JSON.stringify({ result, putHits }));
    } finally {
      srv.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  console.log();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.unit) {
    console.log('[probe-kb-lock] --unit: offline mocked cases, no API credentials, no network, no throwaway project.\n');
    await runUnitCases();
    console.log(`\n[probe-kb-lock] ${_passCount} passed, ${_failCount} failed.`);
    process.exitCode = _failCount > 0 ? 1 : 0;
    return;
  }
  if (!opts.apiBase) {
    console.error('[probe-kb-lock] --api-base is required (e.g. http://localhost:4454) — refusing to fall back to .tipatask/config.json, which points at production.');
    process.exitCode = 1;
    return;
  }
  const targetsProd = /(apppixies|tipatask)\.com/.test(opts.apiBase);
  if (targetsProd && !opts.allowProduction) {
    console.error('[probe-kb-lock] --api-base looks like the production host — refusing to run against it. Pass --allow-production for a real production QA pass (C1221); it creates and deletes its own throwaway project and never touches the live one.');
    process.exitCode = 1;
    return;
  }
  if (targetsProd && opts.mintToken) {
    console.error("[probe-kb-lock] --mint-token signs with the LOCAL api/.env JWT_SECRET, which doesn't match production's — it would just 401. Pass a real production --token instead.");
    process.exitCode = 1;
    return;
  }
  if (targetsProd && opts.keep) {
    console.error('[probe-kb-lock] --allow-production and --keep together would leave a throwaway project sitting on production indefinitely — refusing. Drop --keep, or inspect the project before it tears down.');
    process.exitCode = 1;
    return;
  }

  let token = opts.token;
  if (opts.mintToken) {
    const secret = readJwtSecret();
    token = signJwtHs256({ id: opts.userId, email: readUserEmail(opts.userId) }, secret);
    console.log(`[probe-kb-lock] minted a local JWT for user id=${opts.userId}`);
  }
  if (!token) {
    console.error('[probe-kb-lock] need --token <jwt> or --mint-token');
    process.exitCode = 1;
    return;
  }

  // C1221 — when pointed at production, compare the throwaway project we're about to create
  // against this repo's OWN live project id, so a coincidental id collision can never let a
  // lock/PUT/delete call land on the real project. Best-effort: absence of a local config
  // just means there's nothing to guard against.
  let liveProjectId = null;
  if (targetsProd) {
    try {
      const cfgPath = path.join(__dirname, '..', '..', '..', '..', '.tipatask', 'config.json');
      liveProjectId = String(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).API_PROJECT_ID || '');
    } catch { /* no local config to compare against */ }
  }

  console.log(`[probe-kb-lock] target: ${opts.apiBase}${targetsProd ? ' (PRODUCTION — --allow-production)' : ''}\n`);

  // C1221 — on production, force every pushFile-acquired lease down to the 30s minimum
  // (knowledge.js clamps ttl_seconds to [30,3600]) rather than the 600s server default, so
  // anything that outlives a failed teardown self-heals in under a minute instead of ten.
  const pushOpts = targetsProd ? { lockTtlSeconds: 30 } : {};

  const { acquireLock, releaseLock, pushFile, getLocalVersions } = require('../src/cli/knowledge-sync');
  const INSTANCE_A = 'probe-instance-a';
  const INSTANCE_B = 'probe-instance-b';

  // ── 1. Throwaway project ──
  console.log('1. Creating throwaway project...');
  const projectName = `probe-kb-lock-${Date.now()}`;
  const { project } = await apiFetch(opts.apiBase, token, 'POST', '/api/projects', { name: projectName });
  const projectId = project.id;
  console.log(`   created project id=${projectId} name="${project.name}"\n`);

  if (liveProjectId && String(projectId) === liveProjectId) {
    console.error(`[probe-kb-lock] FATAL: throwaway project id=${projectId} collides with this repo's live API_PROJECT_ID (${liveProjectId}) — refusing to run any lock/PUT/delete call against it.`);
    process.exitCode = 1;
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-probe-lock-'));
  // C1221 — isolated scratch .tipatask/config.json, never this repo's. Belt-and-braces: every
  // knowledge-sync call below takes baseUrl/projectId/token as explicit args and never reads
  // this file, but it satisfies the task's isolation requirement literally and future-proofs
  // against a helper that does read it.
  fs.mkdirSync(path.join(tmpRoot, '.tipatask'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(tmpRoot, '.tipatask', 'config.json'),
    JSON.stringify({ TASK_BACKEND: 'api', API_BASE_URL: opts.apiBase, API_PROJECT_ID: String(projectId), API_TOKEN: token }, null, 2),
    { mode: 0o600 },
  );

  let teardownFailed = false;
  try {
    const fileKey = 'ai/architecture/tt-probe-lock.md';

    // ── 2. Acquire on a never-written file_key — placeholder creation ──
    console.log('2. Acquiring a lease on a brand-new file_key (placeholder path)...');
    const lease1 = await acquireLock(opts.apiBase, projectId, token, fileKey, { instanceId: INSTANCE_A, ttlSeconds: 60 });
    assertTrue('acquire resolved a lease (not fail-open null — C1104 is deployed here)', lease1 !== null);
    if (lease1) {
      assertTrue('placeholder version is 0', lease1.version === 0, `version=${lease1.version}`);
      assertTrue('placeholder content is empty', lease1.content === '', `content=${JSON.stringify(lease1.content)}`);
      // NOT `new Date(lease1.lockExpiresAt).getTime() - Date.now()`: mysql2 parses a
      // DATETIME assuming the Node process's local TZ, which need not match the DB
      // container's — see knowledge.js's own LOCK_SELECT_COLUMNS comment on exactly this.
      // Comparing two DB-returned timestamps to each other cancels that offset out; only
      // a local-clock comparison doesn't.
      const deltaMs = new Date(lease1.lockExpiresAt).getTime() - new Date(lease1.lockedAt).getTime();
      assertTrue('lock_expires_at is ~60s after locked_at (the requested ttl_seconds)', deltaMs > 50000 && deltaMs < 70000, `deltaMs=${deltaMs}`);
    }
    console.log();

    // ── 3. Re-acquire same instance — renews, does not block ──
    console.log('3. Re-acquiring with the SAME instance id — must renew, not 409...');
    const lease1b = await acquireLock(opts.apiBase, projectId, token, fileKey, { instanceId: INSTANCE_A, ttlSeconds: 60 });
    assertTrue('same-instance re-acquire renews cleanly', lease1b !== null);
    console.log();

    // ── 4. Acquire from a DIFFERENT instance, same token/user — must contend (C1105 §1) ──
    console.log('4. Acquiring with a DIFFERENT X-Tipatask-Instance, same token — must 409 lock_held...');
    let blockedErr = null;
    try {
      await acquireLock(opts.apiBase, projectId, token, fileKey, { instanceId: INSTANCE_B, ttlSeconds: 60 });
    } catch (err) {
      blockedErr = err;
    }
    assertTrue('acquire threw', blockedErr !== null);
    if (blockedErr) {
      assertTrue('err.lockHeld is true', blockedErr.lockHeld === true);
      assertTrue('same_user is true (this IS the per-instance narrowing this task adds)', blockedErr.sameUser === true, `sameUser=${blockedErr.sameUser}`);
    }
    console.log();

    // ── 5. PUT under our own lease (instance A) — succeeds ──
    console.log('5. pushFile under our own held lease (instance A)...');
    // pushFile acquires its own lease internally using this process's real INSTANCE_ID —
    // release ours first so pushFile's acquire (a third, different instance again) doesn't
    // itself 409 against lease1/lease1b.
    await releaseLock(opts.apiBase, projectId, token, fileKey, { instanceId: INSTANCE_A });
    const pushResult = await pushFile(opts.apiBase, projectId, token, fileKey, '# tt-probe-lock — probe content\n', 0, tmpRoot, { ...pushOpts });
    assertTrue('pushFile succeeded (version bumped past the placeholder)', pushResult.version === 1, `version=${pushResult.version}`);
    // C1221 — the direct answer to "does the deployed API enforce the lease, or is
    // acquireLock still failing open (404/pre-C1104)": locked:false here would mean this
    // whole push happened without ever taking a lease.
    assertTrue('pushFile reports locked:true — not a 404 fail-open', pushResult.locked === true, `locked=${pushResult.locked}`);
    assertTrue('local version cache recorded the push', getLocalVersions(tmpRoot)[fileKey] !== undefined);
    console.log();

    // ── 6. PUT while instance B holds the lease — 409 lock_held ──
    console.log('6. PUT while a different instance holds the lease...');
    const lease2 = await acquireLock(opts.apiBase, projectId, token, fileKey, { instanceId: INSTANCE_B, ttlSeconds: 60 });
    assertTrue('instance B acquired (A released it in step 5)', lease2 !== null);
    let putBlockedErr = null;
    try {
      await pushFile(opts.apiBase, projectId, token, fileKey, 'attempted overwrite', lease2 ? lease2.version : 1, tmpRoot, { lockWaitMs: 0, ...pushOpts });
    } catch (err) {
      putBlockedErr = err;
    }
    assertTrue('pushFile threw lockHeld (own acquire blocked by instance B, no wait budget)', putBlockedErr && putBlockedErr.lockHeld === true);
    console.log();

    // ── 7. Release ──
    console.log('7. Releasing instance B\'s lease...');
    const released = await releaseLock(opts.apiBase, projectId, token, fileKey, { instanceId: INSTANCE_B });
    assertTrue('released:true', released && released.released === true);
    console.log();

    console.log('8. Releasing again — idempotent, not an error...');
    const releasedAgain = await releaseLock(opts.apiBase, projectId, token, fileKey, { instanceId: INSTANCE_B });
    assertTrue('released:false reason:not_locked', releasedAgain && releasedAgain.released === false && releasedAgain.reason === 'not_locked', JSON.stringify(releasedAgain));
    console.log();

    // ── 9. Acquire-then-release a never-PUT file_key — placeholder row must be removed ──
    console.log('9. Acquire + release (no PUT in between) on a fresh file_key — placeholder must be deleted...');
    const throwawayKey = 'ai/architecture/tt-probe-lock-throwaway.md';
    await acquireLock(opts.apiBase, projectId, token, throwawayKey, { instanceId: INSTANCE_A, ttlSeconds: 60 });
    const releasedPlaceholder = await releaseLock(opts.apiBase, projectId, token, throwawayKey, { instanceId: INSTANCE_A });
    assertTrue('placeholderRemoved:true', releasedPlaceholder && releasedPlaceholder.placeholderRemoved === true, JSON.stringify(releasedPlaceholder));
    const { files } = await apiFetch(opts.apiBase, token, 'GET', `/api/projects/${projectId}/knowledge`);
    assertTrue('GET /knowledge no longer lists the throwaway placeholder', !files.some(f => f.file_key === throwawayKey));
    console.log();

    // ── 10. PUT itself enforces per-instance contention, not just acquire (C1221) ──
    // The probe's original step 6 only proves ACQUIRE-level blocking (pushFile's own
    // internal acquire throws before ever reaching the PUT). This proves the PUT endpoint's
    // own isSameHolder check on the deployed build, and that it runs BEFORE the version
    // check — via a deliberately WRONG version_hint that must still 409 as lock_held, not as
    // a version conflict.
    console.log('10. PUT under a live lease, exercising the instance-header contract directly...');
    const putKey = 'ai/architecture/tt-probe-lock-put.md';
    const putLease = await acquireLock(opts.apiBase, projectId, token, putKey, { instanceId: INSTANCE_A, ttlSeconds: 60 });
    assertTrue('acquired the PUT-test lease as instance A', putLease !== null);

    async function rawPut(instanceHeader, versionHint) {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      if (instanceHeader !== undefined) headers['X-Tipatask-Instance'] = instanceHeader;
      const res = await fetch(`${opts.apiBase}/api/projects/${projectId}/knowledge/${putKey}`, {
        method: 'PUT', headers, body: JSON.stringify({ content: 'attempted overwrite', version_hint: versionHint }),
      });
      let body = null;
      try { body = await res.json(); } catch { /* no body */ }
      return { status: res.status, body };
    }

    // 10a. Different instance + a deliberately WRONG version_hint (99, real is 0) — proves
    // the deployed server checks the lock BEFORE the version, not just the source we read.
    const putB = await rawPut(INSTANCE_B, 99);
    assertTrue('PUT from a different instance while A holds it -> 409', putB.status === 409, `status=${putB.status}`);
    assertTrue('body carries lock_held:true (not a version conflict, despite the wrong version_hint)', !!(putB.body && putB.body.lock_held === true), JSON.stringify(putB.body));
    assertTrue('body carries same_user:true (same token, different instance)', !!(putB.body && putB.body.same_user === true), JSON.stringify(putB.body));

    // 10b. Legacy back-compat negative control — a caller sending NO instance header at all
    // (a pre-C1105 client) falls back to the per-user rule and succeeds as the lease's own
    // holder, even though it names no instance. Pins the NULL/no-header branch nothing else
    // in this probe exercises — the whole 047 migration's back-compat argument rests on it.
    const putNoHeader = await rawPut(undefined, putLease.version);
    assertTrue('PUT with no instance header succeeds under the per-user back-compat fallback', putNoHeader.status === 200, `status=${putNoHeader.status} body=${JSON.stringify(putNoHeader.body)}`);

    // 10c. Post-release control — once A releases, a same-instance PUT is no longer blocked
    // by a lock at all (may still 409 on version, must never 409 as lock_held).
    await releaseLock(opts.apiBase, projectId, token, putKey, { instanceId: INSTANCE_A });
    const putAfterRelease = await rawPut(INSTANCE_A, putNoHeader.body ? putNoHeader.body.version : putLease.version + 1);
    assertTrue('after release, PUT is never blocked by lock_held', !(putAfterRelease.body && putAfterRelease.body.lock_held === true), JSON.stringify(putAfterRelease.body));
    console.log();
  } catch (err) {
    // Let teardown below still run on any thrown assert/error — this is the fix for the
    // original bug where a throw here skipped the DELETE and leaked the throwaway project.
    _failCount++;
    console.error(`[probe-kb-lock] a step threw: ${err.message}`);
    if (err.body) console.error('  response body:', JSON.stringify(err.body));
  } finally {
    // ── 11. Teardown — ALWAYS runs, even if a step above threw (C1221 defect C fix) ──
    if (opts.keep) {
      console.log(`11. --keep set: leaving project id=${projectId} ("${project.name}") in place for inspection.`);
    } else {
      console.log('11. Tearing down throwaway project...');
      try {
        await apiFetch(opts.apiBase, token, 'DELETE', `/api/projects/${projectId}`);
        console.log('    deleted.');
      } catch (err) {
        teardownFailed = true;
        console.error(`[probe-kb-lock] FATAL: teardown failed — project id=${projectId} ("${project.name}") may still exist on ${opts.apiBase}. Delete it manually: DELETE ${opts.apiBase}/api/projects/${projectId}`);
        console.error(`  ${err.message}`);
      }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`\n[probe-kb-lock] ${_passCount} passed, ${_failCount} failed.`);
  if (_failCount > 0 || teardownFailed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[probe-kb-lock] failed:', err.message);
  if (err.body) console.error('  response body:', JSON.stringify(err.body));
  process.exitCode = 1;
});
