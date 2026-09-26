#!/usr/bin/env node
'use strict';

// Live KB conflict probe: two writers diverge and local-wins overwrite remains
// recoverable through the API. Requires --api-base, uses throwaway project, and
// never targets the configured live project. --keep preserves scratch data.

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

// Minimal HS256 JWT signer — same as probe-kb-lock.js / probe-kb-reindex.js / etc, avoids
// pulling `jsonwebtoken` (an api/ dependency, not this package's) into ai/todo/server.
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

async function apiFetch(apiBase, token, method, path_, body, extraHeaders) {
  const res = await fetch(`${apiBase}${path_}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(extraHeaders || {}) },
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

// Writes a .tipatask/kb-conflicts-seen.json marker directly — mirrors
// knowledge-sync.js's writeConflictsSeenState (not exported), used here to seed a root's
// "already checked up to" point without going through a real first checkKnowledgeConflicts
// call, so the own-instance filter can be tested in isolation from the first-run no-op.
function seedConflictsSeenMarker(rootPath, iso) {
  const dir = path.join(rootPath, '.tipatask');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kb-conflicts-seen.json'), JSON.stringify({ lastCheckedAt: iso }), 'utf8');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.apiBase) {
    console.error('[probe-kb-conflict] --api-base is required (e.g. http://localhost:4454) — refusing to fall back to .tipatask/config.json, which points at production.');
    process.exitCode = 1;
    return;
  }
  if (/(apppixies|tipatask)\.com/.test(opts.apiBase)) {
    console.error('[probe-kb-conflict] --api-base looks like the production host — refusing to run against it.');
    process.exitCode = 1;
    return;
  }

  let token = opts.token;
  if (opts.mintToken) {
    const secret = readJwtSecret();
    token = signJwtHs256({ id: opts.userId, email: readUserEmail(opts.userId) }, secret);
    console.log(`[probe-kb-conflict] minted a local JWT for user id=${opts.userId}`);
  }
  if (!token) {
    console.error('[probe-kb-conflict] need --token <jwt> or --mint-token');
    process.exitCode = 1;
    return;
  }

  console.log(`[probe-kb-conflict] target: ${opts.apiBase}\n`);

  const {
    pushFile, pullFile, getLocalVersions,
    fetchConflictRecords, fetchConflictRecord, checkKnowledgeConflicts, INSTANCE_ID,
  } = require('../src/cli/knowledge-sync');

  // ── 1. Throwaway project ──
  console.log('1. Creating throwaway project...');
  const projectName = `probe-kb-conflict-${Date.now()}`;
  const { project } = await apiFetch(opts.apiBase, token, 'POST', '/api/projects', { name: projectName });
  const projectId = project.id;
  console.log(`   created project id=${projectId} name="${project.name}"\n`);

  const tmpRootA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-probe-conflict-a-'));
  const tmpRootB = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-probe-conflict-b-'));
  const tmpRootNeverSynced = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-probe-conflict-fresh-'));

  try {
    // ── 2. Two writers diverge, one overwrites the other with local-wins ──
    console.log('2. Two writers diverge; the stale one pushes with local-wins over genuinely different content...');
    const fileKey = 'ai/architecture/tt-probe-conflict.md';
    const contentAv1 = '# tt-probe-conflict — v1 from writer A\n';
    const contentBv2 = '# tt-probe-conflict — v2, writer B\'s edit, about to be destroyed\n';
    const contentAv3 = '# tt-probe-conflict — v3, writer A overwriting on a stale cache\n';

    const pushA1 = await pushFile(opts.apiBase, projectId, token, fileKey, contentAv1, 0, tmpRootA, {});
    assertTrue('writer A\'s initial push lands at v1', pushA1.version === 1, `version=${pushA1.version}`);

    await pullFile(opts.apiBase, projectId, token, fileKey, tmpRootB);
    assertTrue('writer B pulled v1 into its own cache', getLocalVersions(tmpRootB)[fileKey] !== undefined);

    const pushB2 = await pushFile(opts.apiBase, projectId, token, fileKey, contentBv2, 1, tmpRootB, {});
    assertTrue('writer B\'s in-sync push lands at v2, no conflict', pushB2.version === 2 && !pushB2.conflict, JSON.stringify(pushB2));

    // Writer A's cache is still v1 — pushing now collides with B's v2 remote content.
    const pushA3 = await pushFile(opts.apiBase, projectId, token, fileKey, contentAv3, 1, tmpRootA, {
      onConflict: 'local-wins', preserveRemoteOnConflict: true,
    });
    assertTrue('writer A\'s stale push still lands (local-wins), at v3', pushA3.version === 3, `version=${pushA3.version}`);
    assertTrue('conflict:true', pushA3.conflict === true);
    assertTrue('remoteDiverged:true (A had a cached hash for v1, remote had moved to B\'s different v2)', pushA3.remoteDiverged === true);
    assertTrue('conflictRecorded:true', pushA3.conflictRecorded === true);
    assertTrue('conflictRecordId is a number', typeof pushA3.conflictRecordId === 'number', `conflictRecordId=${pushA3.conflictRecordId}`);
    const recordedId = pushA3.conflictRecordId;
    console.log();

    // ── 3. Recover B's lost content from the API — the task's core claim ──
    console.log('3. Recovering writer B\'s destroyed content from the API (not from any machine\'s disk)...');
    const list = await fetchConflictRecords(opts.apiBase, projectId, token, { fileKey });
    const listEntry = list.conflicts.find(c => c.id === recordedId);
    assertTrue('GET list finds the record', !!listEntry);
    if (listEntry) {
      assertTrue('list entry overwritten_version is 2 (B\'s destroyed version)', listEntry.overwritten_version === 2, `overwritten_version=${listEntry.overwritten_version}`);
      assertTrue('list entry content_bytes matches B\'s content length', listEntry.content_bytes === Buffer.byteLength(contentBv2, 'utf8'), `content_bytes=${listEntry.content_bytes}`);
      assertTrue('list entry carries no content field (metadata-only)', listEntry.overwritten_content === undefined);
    }

    const detail = await fetchConflictRecord(opts.apiBase, projectId, token, recordedId);
    assertTrue(
      'detail overwritten_content is byte-identical to what writer B actually wrote',
      detail.overwritten_content === contentBv2,
      `got=${JSON.stringify(detail.overwritten_content)}`,
    );
    assertTrue('detail overwritten_by.email matches the pushing user', detail.overwritten_by && detail.overwritten_by.email === readUserEmail(opts.userId));
    console.log();

    // ── 4. Own-instance filter: this process's own conflict must NOT be reported to itself ──
    console.log('4. checkKnowledgeConflicts filters out a conflict this same process authored...');
    seedConflictsSeenMarker(tmpRootB, new Date(0).toISOString()); // bypass first-run no-op
    const ownInstanceReport = await checkKnowledgeConflicts(opts.apiBase, projectId, token, tmpRootB);
    assertTrue(
      'own-authored record is absent from the report',
      !ownInstanceReport.some(r => r.id === recordedId),
      `report=${JSON.stringify(ownInstanceReport.map(r => r.id))}`,
    );
    console.log();

    // ── 5. Foreign-instance record: authored elsewhere, must surface ──
    console.log('5. A conflict authored by a genuinely different instance IS surfaced...');
    const foreignFileKey = 'ai/architecture/tt-probe-conflict-foreign.md';
    const foreignContent = '# tt-probe-conflict-foreign — content from a different machine\n';
    const foreignPost = await apiFetch(
      opts.apiBase, token, 'POST', `/api/projects/${projectId}/knowledge-conflicts`,
      { file_key: foreignFileKey, overwritten_content: foreignContent, overwritten_version: 1 },
      { 'X-Tipatask-Instance': 'probe-foreign-instance' },
    );
    assertTrue('direct POST with a foreign instance header recorded', foreignPost.recorded === true);
    seedConflictsSeenMarker(tmpRootB, new Date(0).toISOString()); // re-seed so this new record is in range
    const foreignReport = await checkKnowledgeConflicts(opts.apiBase, projectId, token, tmpRootB);
    assertTrue(
      'foreign-instance record IS in the report',
      foreignReport.some(r => r.id === foreignPost.id),
      `report=${JSON.stringify(foreignReport.map(r => r.id))}`,
    );
    console.log();

    // ── 6. First-run no-op: a never-before-checked root reports nothing, but marks the point ──
    console.log('6. First-ever checkKnowledgeConflicts call for a root reports nothing (no marker existed)...');
    const tmpRootFirstRun = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-probe-conflict-firstrun-'));
    const firstRunReport = await checkKnowledgeConflicts(opts.apiBase, projectId, token, tmpRootFirstRun);
    assertTrue('first-ever call for a root returns empty even though conflicts already exist', firstRunReport.length === 0, `report=${JSON.stringify(firstRunReport)}`);
    const secondRunReport = await checkKnowledgeConflicts(opts.apiBase, projectId, token, tmpRootFirstRun);
    assertTrue('the immediately-following call also reports nothing new (marker now at "now")', secondRunReport.length === 0, `report=${JSON.stringify(secondRunReport)}`);
    fs.rmSync(tmpRootFirstRun, { recursive: true, force: true });
    console.log();

    // ── 7. Never-synced machine: no cached hash, but content still genuinely differs ──
    console.log('7. A machine with no prior sync history for this file still records what it overwrites...');
    const neverSyncedKey = 'ai/architecture/tt-probe-conflict-neversynced.md';
    const establishedContent = '# tt-probe-conflict-neversynced — established remote content\n';
    const neverSyncedNewContent = '# tt-probe-conflict-neversynced — pushed with zero sync history\n';
    const establish = await pushFile(opts.apiBase, projectId, token, neverSyncedKey, establishedContent, 0, tmpRootA, {});
    assertTrue('remote content established at v1', establish.version === 1, `version=${establish.version}`);

    // tmpRootNeverSynced has NEVER pulled or pushed this key — its cache has no entry at
    // all, so priorHash is null and remoteDiverged (which needs priorHash != null) can only
    // ever be false here. That's the exact gap the broader record gate closes.
    const neverSyncedPush = await pushFile(opts.apiBase, projectId, token, neverSyncedKey, neverSyncedNewContent, 0, tmpRootNeverSynced, {
      onConflict: 'local-wins', preserveRemoteOnConflict: true,
    });
    assertTrue('remoteDiverged:false (no cached hash to compare against)', neverSyncedPush.remoteDiverged === false, `remoteDiverged=${neverSyncedPush.remoteDiverged}`);
    assertTrue('conflictRecorded:true anyway — the broader gate catches what remoteDiverged misses', neverSyncedPush.conflictRecorded === true);
    assertTrue('conflictRecordId is a number', typeof neverSyncedPush.conflictRecordId === 'number');

    const neverSyncedDetail = await fetchConflictRecord(opts.apiBase, projectId, token, neverSyncedPush.conflictRecordId);
    assertTrue(
      'the established content survives in the record even though no sidecar was ever written for it',
      neverSyncedDetail.overwritten_content === establishedContent,
    );
    console.log();

    // ── 8. Idempotence: recording the same (file_key, version) twice is a no-op ──
    console.log('8. Recording the same (file_key, overwritten_version) twice is idempotent...');
    const dupeFileKey = 'ai/architecture/tt-probe-conflict-dupe.md';
    const first = await apiFetch(
      opts.apiBase, token, 'POST', `/api/projects/${projectId}/knowledge-conflicts`,
      { file_key: dupeFileKey, overwritten_content: 'dupe test content', overwritten_version: 5 },
    );
    assertTrue('first POST recorded:true', first.recorded === true);
    const second = await apiFetch(
      opts.apiBase, token, 'POST', `/api/projects/${projectId}/knowledge-conflicts`,
      { file_key: dupeFileKey, overwritten_content: 'dupe test content, retried', overwritten_version: 5 },
    );
    assertTrue('second POST for the same (file_key, version) is recorded:false', second.recorded === false && second.reason === 'already_recorded', JSON.stringify(second));
    assertTrue('both POSTs report the same record id', second.id === first.id, `first=${first.id} second=${second.id}`);
    console.log();

    console.log(`   this process's INSTANCE_ID: ${INSTANCE_ID}`);

    // ── Teardown ──
    if (opts.keep) {
      console.log(`9. --keep set: leaving project id=${projectId} ("${project.name}") in place for inspection.`);
    } else {
      console.log('9. Tearing down throwaway project...');
      await apiFetch(opts.apiBase, token, 'DELETE', `/api/projects/${projectId}`);
      console.log('   deleted.');
    }
  } finally {
    fs.rmSync(tmpRootA, { recursive: true, force: true });
    fs.rmSync(tmpRootB, { recursive: true, force: true });
    fs.rmSync(tmpRootNeverSynced, { recursive: true, force: true });
  }

  console.log(`\n[probe-kb-conflict] ${_passCount} passed, ${_failCount} failed.`);
  if (_failCount > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[probe-kb-conflict] failed:', err.message);
  if (err.body) console.error('  response body:', JSON.stringify(err.body));
  process.exitCode = 1;
});
