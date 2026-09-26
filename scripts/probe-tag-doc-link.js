#!/usr/bin/env node
'use strict';

// Live tag-to-KB-doc link probe: stub write, push, tag upsert, and link route.
// Requires --api-base and a throwaway project. Production needs explicit
// --allow-production, which refuses --mint-token and --keep.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const opts = { apiBase: null, token: null, mintToken: false, userId: 1, keep: false, allowProduction: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--api-base') opts.apiBase = argv[++i];
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--mint-token') opts.mintToken = true;
    else if (a === '--user-id') opts.userId = Number(argv[++i]);
    else if (a === '--keep') opts.keep = true;
    else if (a === '--allow-production') opts.allowProduction = true;
  }
  return opts;
}

// Minimal HS256 JWT signer — same as probe-kb-lock.js / probe-tag-descriptions.js.
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
    const err = new Error(`${method} ${path_} -> ${res.status}: ${(json && json.error) || res.statusText}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Builds a PUT /api/todo-shaped ```json fence body with one CODING task carrying a
// single tt-* tag plus a matching new_tags entry — the exact shape chat-task-preview.js
// sends from a bulk objective-proposal save.
function buildTodoContent({ taskId, tag, hint }) {
  const payload = {
    tasks: [{
      id: taskId, title: `Probe task for ${tag}`, description: 'probe', category: 'CODING',
      status: 'pending', priority: 900, order: 1, dependencies: [], tags: [tag], assignee: null,
    }],
    new_tags: [{ name: tag, description: `Probe-registered tag for ${tag}`, architecture_hint: hint }],
  };
  return '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.apiBase) {
    console.error('[probe-tag-doc-link] --api-base is required (e.g. http://localhost:4454) — refusing to fall back to .tipatask/config.json, which points at production.');
    process.exitCode = 1;
    return;
  }
  const targetsProd = /(apppixies|tipatask)\.com/.test(opts.apiBase);
  if (targetsProd && !opts.allowProduction) {
    console.error('[probe-tag-doc-link] --api-base looks like the production host — refusing to run against it. api/src/routes/tags.js has no DELETE endpoint, so a tag/KB-file created here is PERMANENT. Pass --allow-production only with a real reason.');
    process.exitCode = 1;
    return;
  }
  if (targetsProd && opts.mintToken) {
    console.error("[probe-tag-doc-link] --mint-token signs with the LOCAL api/.env JWT_SECRET, which doesn't match production's — it would just 401. Pass a real production --token instead.");
    process.exitCode = 1;
    return;
  }
  if (targetsProd && opts.keep) {
    console.error('[probe-tag-doc-link] --allow-production and --keep together would leave a throwaway project (and its permanent tag/KB rows) sitting on production indefinitely — refusing.');
    process.exitCode = 1;
    return;
  }

  let token = opts.token;
  if (opts.mintToken) {
    const secret = readJwtSecret();
    token = signJwtHs256({ id: opts.userId, email: readUserEmail(opts.userId) }, secret);
    console.log(`[probe-tag-doc-link] minted a local JWT for user id=${opts.userId}`);
  }
  if (!token) {
    console.error('[probe-tag-doc-link] need --token <jwt> or --mint-token');
    process.exitCode = 1;
    return;
  }

  let liveProjectId = null;
  if (targetsProd) {
    try {
      const cfgPath = path.join(__dirname, '..', '..', '..', '..', '.tipatask', 'config.json');
      liveProjectId = String(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).API_PROJECT_ID || '');
    } catch { /* no local config to compare against */ }
  }

  console.log(`[probe-tag-doc-link] target: ${opts.apiBase}${targetsProd ? ' (PRODUCTION — --allow-production)' : ''}\n`);

  // ── 1. Throwaway project ──
  console.log('1. Creating throwaway project...');
  const projectName = `probe-tag-doc-link-${Date.now()}`;
  const { project } = await apiFetch(opts.apiBase, token, 'POST', '/api/projects', { name: projectName });
  const projectId = project.id;
  console.log(`   created project id=${projectId} name="${project.name}"\n`);

  if (liveProjectId && String(projectId) === liveProjectId) {
    console.error(`[probe-tag-doc-link] FATAL: throwaway project id=${projectId} collides with this repo's live API_PROJECT_ID (${liveProjectId}) — refusing to run.`);
    process.exitCode = 1;
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-probe-taglink-'));
  fs.mkdirSync(path.join(tmpRoot, '.tipatask'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(tmpRoot, '.tipatask', 'config.json'),
    JSON.stringify({ TASK_BACKEND: 'api', API_BASE_URL: opts.apiBase, API_PROJECT_ID: String(projectId), API_TOKEN: token }, null, 2),
    { mode: 0o600 },
  );

  const tagsBase = `/api/projects/${projectId}/tags`;
  const knowledgeBase = `/api/projects/${projectId}/knowledge`;
  let teardownFailed = false;

  try {
    const { createApiBackend } = require('../src/server/api-backend');
    const backend = createApiBackend({}, tmpRoot);
    await backend.init();

    // ── 2. New tt-* tag with an architecture_hint links atomically at save ──
    console.log('2. overwriteRawWithRemap: new tt-* tag + new_tags with architecture_hint...');
    const tag1 = 'tt-probe-linkfix';
    const fileKey1 = `ai/architecture/${tag1}.md`;
    const hint1 = 'Probe module: verifies C1237 save-time KB linking end to end.';
    await backend.overwriteRawWithRemap(buildTodoContent({ taskId: 'C1', tag: tag1, hint: hint1 }));

    const { tags: afterSave1 } = await apiFetch(opts.apiBase, token, 'GET', tagsBase);
    const row1 = afterSave1.find(t => t.name === tag1);
    assertTrue('tag registered', !!row1);
    assertTrue('knowledge_file_key set to the expected doc', !!row1 && row1.knowledge_file_key === fileKey1, row1 && row1.knowledge_file_key);

    const kbFile1 = await apiFetch(opts.apiBase, token, 'GET', `${knowledgeBase}/${fileKey1}`);
    assertTrue('remote KB file content contains the architecture_hint', typeof kbFile1.content === 'string' && kbFile1.content.includes(hint1));

    const localAbs1 = path.join(tmpRoot, fileKey1);
    assertTrue('local stub file exists on disk', fs.existsSync(localAbs1));
    assertTrue('local stub content matches what was pushed', fs.existsSync(localAbs1) && fs.readFileSync(localAbs1, 'utf8') === kbFile1.content);
    console.log();

    // ── 3. Idempotence: saving again does not re-push or unlink ──
    console.log('3. Idempotence — identical save again...');
    await backend.overwriteRawWithRemap(buildTodoContent({ taskId: 'C1', tag: tag1, hint: hint1 }));
    const kbFile1Again = await apiFetch(opts.apiBase, token, 'GET', `${knowledgeBase}/${fileKey1}`);
    assertTrue('KB file version unchanged on a repeat save (already linked, not re-pushed)', kbFile1Again.version === kbFile1.version, `${kbFile1.version} -> ${kbFile1Again.version}`);
    const { tags: afterSave1b } = await apiFetch(opts.apiBase, token, 'GET', tagsBase);
    assertTrue('still linked after repeat save', afterSave1b.find(t => t.name === tag1)?.knowledge_file_key === fileKey1);
    console.log();

    // ── 4. Dup-link guard: file_key already owned by a different tag ──
    console.log('4. Dup-link guard — a second tag targeting an already-linked file_key...');
    const tagOwner = 'tt-probe-owner';
    const tagDup = 'tt-probe-dup';
    const fileKeyShared = `ai/architecture/${tagDup}.md`; // tagOwner will be linked to tagDup's expected file_key
    await apiFetch(opts.apiBase, token, 'POST', tagsBase, { tags: [{ name: tagOwner, description: 'Pre-existing owner tag' }] });
    await apiFetch(opts.apiBase, token, 'POST', knowledgeBase, { files: [{ file_key: fileKeyShared, content: '# pre-existing doc\n' }] });
    await apiFetch(opts.apiBase, token, 'PUT', `${tagsBase}/${tagOwner}/link`, { file_key: fileKeyShared });

    let dupSaveErr = null;
    try {
      await backend.overwriteRawWithRemap(buildTodoContent({ taskId: 'C2', tag: tagDup, hint: 'Would collide with tt-probe-owner\'s file.' }));
    } catch (err) { dupSaveErr = err; }
    assertTrue('save succeeds despite the dup-link conflict (never blocks the save)', !dupSaveErr, dupSaveErr && dupSaveErr.message);
    const { tags: afterDup } = await apiFetch(opts.apiBase, token, 'GET', tagsBase);
    const dupRow = afterDup.find(t => t.name === tagDup);
    assertTrue('conflicting tag still registered', !!dupRow);
    assertTrue('conflicting tag left unlinked, not stolen from the owner', !!dupRow && dupRow.knowledge_file_key == null, dupRow && dupRow.knowledge_file_key);
    const ownerRow = afterDup.find(t => t.name === tagOwner);
    assertTrue("owner tag's link untouched", !!ownerRow && ownerRow.knowledge_file_key === fileKeyShared);
    console.log();

    // ── 5. Remote-present heal: doc already exists remotely, tag unlinked ──
    console.log('5. Remote-present heal — doc exists remotely, tag registered unlinked...');
    const tagRemote = 'tt-probe-remote';
    const fileKeyRemote = `ai/architecture/${tagRemote}.md`;
    await apiFetch(opts.apiBase, token, 'POST', knowledgeBase, { files: [{ file_key: fileKeyRemote, content: '# already on the server\n' }] });
    await apiFetch(opts.apiBase, token, 'POST', tagsBase, { tags: [{ name: tagRemote, description: 'Registered unlinked before this save' }] });

    await backend.overwriteRawWithRemap(buildTodoContent({ taskId: 'C3', tag: tagRemote, hint: 'Should link with no local write.' }));
    const { tags: afterRemote } = await apiFetch(opts.apiBase, token, 'GET', tagsBase);
    const remoteRow = afterRemote.find(t => t.name === tagRemote);
    assertTrue('tag now linked to the pre-existing remote doc', !!remoteRow && remoteRow.knowledge_file_key === fileKeyRemote);
    assertTrue('no local file was written for the remote-present case', !fs.existsSync(path.join(tmpRoot, fileKeyRemote)));
    console.log();

    // ── 6. Teardown ──
    if (opts.keep) {
      console.log(`6. --keep set: leaving project id=${projectId} ("${project.name}") in place for inspection.`);
    } else {
      console.log('6. Tearing down throwaway project...');
      try {
        await apiFetch(opts.apiBase, token, 'DELETE', `/api/projects/${projectId}`);
        console.log('   deleted.');
      } catch (err) {
        teardownFailed = true;
        console.error(`[probe-tag-doc-link] FATAL: teardown failed — project id=${projectId} ("${project.name}") may still exist on ${opts.apiBase}. Delete it manually: DELETE ${opts.apiBase}/api/projects/${projectId}`);
        console.error(`  ${err.message}`);
      }
    }
  } catch (err) {
    _failCount++;
    console.error(`[probe-tag-doc-link] a step threw: ${err.message}`);
    if (err.body) console.error('  response body:', JSON.stringify(err.body));
    if (!opts.keep) {
      try {
        await apiFetch(opts.apiBase, token, 'DELETE', `/api/projects/${projectId}`);
      } catch (teardownErr) {
        teardownFailed = true;
        console.error(`[probe-tag-doc-link] FATAL: teardown after failure also failed — project id=${projectId} ("${projectName}") may still exist. Delete manually.`);
        console.error(`  ${teardownErr.message}`);
      }
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`\n[probe-tag-doc-link] ${_passCount} passed, ${_failCount} failed.`);
  if (_failCount > 0 || teardownFailed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[probe-tag-doc-link] failed:', err.message);
  if (err.body) console.error('  response body:', JSON.stringify(err.body));
  process.exitCode = 1;
});
