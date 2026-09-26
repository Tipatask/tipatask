#!/usr/bin/env node
'use strict';

// Live KB reindex probe: real API, backend, Opus batching, and persistence.
// Requires --api-base; uses isolated credentials and a throwaway project, never
// production or port 4455. Scratch project covers plain tags; local tt-* docs are
// outside this probe. --detect-only skips Opus and writes; --dry-run skips writes.
// Examples:
//   npm run probe:kb-reindex -- --api-base http://localhost:4454 --mint-token --detect-only
//   npm run probe:kb-reindex -- --api-base http://localhost:4454 --mint-token --dry-run
//   npm run probe:kb-reindex -- --api-base http://localhost:4454 --mint-token

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const opts = { apiBase: null, token: null, mintToken: false, userId: 1, keep: false, dryRun: false, detectOnly: false, forceOnce: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--api-base') opts.apiBase = argv[++i];
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--mint-token') opts.mintToken = true;
    else if (a === '--user-id') opts.userId = Number(argv[++i]);
    else if (a === '--keep') opts.keep = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--detect-only') opts.detectOnly = true;
    // (C1230) --force-once exercises hasNeverBeenReindexed()/forceReindexOnStartup()
    // against a real throwaway project: fresh project has kb_last_reindexed_at === null,
    // forceReindexOnStartup runs once (real Opus batch on probe-blank-tag), the column
    // is stamped, and a second call proves "fires once" — no second Opus spawn, no
    // second POST /knowledge/reindex.
    else if (a === '--force-once') opts.forceOnce = true;
  }
  return opts;
}

// Minimal HS256 JWT signer — same as probe-status-roles.js / probe-tag-descriptions.js,
// avoids pulling `jsonwebtoken` (an api/ dependency, not ai/todo/server's) into this package.
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.apiBase) {
    console.error('[probe-kb-reindex] --api-base is required (e.g. http://localhost:4454) — refusing to fall back to .tipatask/config.json, which points at production.');
    process.exitCode = 1;
    return;
  }
  if (/(apppixies|tipatask)\.com/.test(opts.apiBase)) {
    console.error('[probe-kb-reindex] --api-base looks like the production host — refusing to run against it.');
    process.exitCode = 1;
    return;
  }

  let token = opts.token;
  if (opts.mintToken) {
    const secret = readJwtSecret();
    token = signJwtHs256({ id: opts.userId, email: readUserEmail(opts.userId) }, secret);
    console.log(`[probe-kb-reindex] minted a local JWT for user id=${opts.userId}`);
  }
  if (!token) {
    console.error('[probe-kb-reindex] need --token <jwt> or --mint-token');
    process.exitCode = 1;
    return;
  }

  console.log(`[probe-kb-reindex] target: ${opts.apiBase}${opts.dryRun ? ' (--dry-run: no writes)' : ''}\n`);

  // ── 1. Throwaway project + scratch config ──
  console.log('1. Creating throwaway project...');
  const projectName = `probe-kb-reindex-${Date.now()}`;
  const { project } = await apiFetch(opts.apiBase, token, 'POST', '/api/projects', { name: projectName });
  const projectId = project.id;
  console.log(`   created project id=${projectId} name="${project.name}"`);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-probe-'));
  fs.mkdirSync(path.join(tmpRoot, '.tipatask'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, '.tipatask', 'config.json'),
    JSON.stringify({ TASK_BACKEND: 'api', API_BASE_URL: opts.apiBase, API_PROJECT_ID: String(projectId), API_TOKEN: token }, null, 2)
  );
  console.log(`   scratch config: ${tmpRoot}/.tipatask/config.json (isolated, never the real repo's)\n`);

  try {
    // ── 2. Seed tags: one broken (scope-in), one already-good (scope-out) ──
    // Only a blank description is seedable here — bulk-migrate itself now rejects the
    // literal "Auto-registered..." placeholder text at write time (C1038, already live),
    // so a *new* placeholder-text row can no longer be created through any documented
    // path. Re-index's own rejection of a placeholder-text write is covered separately
    // in step 7 below; legacy placeholder rows from before C1038 shipped are what
    // Re-Index's scope check exists to clean up in the real project, not reproducible
    // through today's write path.
    console.log('2. Seeding tags — one blank, one already-good...');
    await apiFetch(opts.apiBase, token, 'POST', `/api/projects/${projectId}/tags/bulk-migrate`, {
      tags: [
        { name: 'probe-blank-tag' },
        { name: 'probe-good-tag', description: 'Already has a real, specific description — must not change.' },
      ],
    });
    console.log();

    // ── 3. A couple of tasks carrying the broken tag, for describeTagBatch's sample-titles context ──
    console.log('3. Creating sample tasks so the broken tag has context to describe from...');
    const { createApiBackend } = require('../src/server/api-backend');
    const backend = createApiBackend({}, tmpRoot);
    await backend.init();
    await backend.createTask({
      id: 'C1', title: 'Fix invoice PDF header alignment on retina displays', description: 'probe',
      category: 'CODING', status: 'pending', priority: 100, order: 0, dependencies: [], tags: ['probe-blank-tag'], assignee: null,
    });
    await backend.createTask({
      id: 'C2', title: 'Add retry/backoff to invoice PDF generation on timeout', description: 'probe',
      category: 'CODING', status: 'pending', priority: 100, order: 0, dependencies: [], tags: ['probe-blank-tag'], assignee: null,
    });
    console.log();

    // ── 3b. A tt-* tag with a matching local doc + a GOOD description, but the DB link
    // (tags.knowledge_file_id, migration 046) deliberately left unset — exercises the
    // link-only repair path (kb-reindex.js's linkOnlyEntries), which must NOT call Opus
    // since the description is already fine. ──
    console.log('3b. Seeding a tt-* tag + matching local doc with a broken (missing) DB link only...');
    const archDir = path.join(tmpRoot, 'ai', 'architecture');
    fs.mkdirSync(archDir, { recursive: true });
    const linkFixDesc = 'Already has a real, specific description — link-only repair must not call Opus.';
    fs.writeFileSync(path.join(archDir, 'tt-probe-linkfix.md'), `# tt-probe-linkfix — ${linkFixDesc}\n\nbody\n`);
    await apiFetch(opts.apiBase, token, 'POST', `/api/projects/${projectId}/knowledge`, {
      files: [{ file_key: 'ai/architecture/tt-probe-linkfix.md', content: `# tt-probe-linkfix — ${linkFixDesc}\n\nbody\n` }],
    });
    // description set, file_key deliberately omitted — knowledge_file_id stays NULL.
    await apiFetch(opts.apiBase, token, 'POST', `/api/projects/${projectId}/tags`, {
      tags: [{ name: 'tt-probe-linkfix', description: linkFixDesc }],
    });
    console.log();

    if (opts.detectOnly) {
      // ── 4-6 (detect-only). No presync, no Opus, no writes — see detectStaleDescriptions'
      // own doc comment in kb-reindex.js for the exact contract this is verifying. ──
      console.log('4. Running detectStaleDescriptions (no Opus, no writes)...');
      const { detectStaleDescriptions } = require('../src/server/kb-reindex');
      const t0 = Date.now();
      const detected = await detectStaleDescriptions({ backend, rootPath: tmpRoot, baseUrl: opts.apiBase, projectId, token });
      const elapsedMs = Date.now() - t0;
      console.log(`   elapsed: ${elapsedMs}ms\n`);

      console.log('5. Verifying detect scope...');
      assertTrue('hasStale is true (probe-blank-tag is stale)', detected.hasStale === true);
      assertTrue('only the blank tag is scoped as a plain tag (tagCount=1)', detected.tagCount === 1, `tagCount=${detected.tagCount}`);
      assertTrue('fileCount is 0 (no tt-* doc / core-file entries in this scratch project)', detected.fileCount === 0, `fileCount=${detected.fileCount}`);
      assertTrue('tt-probe-linkfix is counted as link-only, NOT as stale (no Opus call needed for it)', detected.linkOnlyCount === 1, `linkOnlyCount=${detected.linkOnlyCount}`);
      assertTrue('probe-blank-tag is the only scoped plain-tag entry', detected.scope.plainTagEntries.length === 1 && detected.scope.plainTagEntries[0].name === 'probe-blank-tag');
      assertTrue('detect completed well under a real Opus batch\'s latency (no spawn happened)', elapsedMs < 5000, `${elapsedMs}ms`);
      assertTrue('detect result carries no `proposals` (that field is reindexKnowledge-only)', !('proposals' in detected));
      console.log();

      console.log('6. Verifying detect wrote nothing (re-GET /tags, check for the state file)...');
      const { tags: tagsAfterDetect } = await apiFetch(opts.apiBase, token, 'GET', `/api/projects/${projectId}/tags`);
      const byNameAfterDetect = Object.fromEntries(tagsAfterDetect.map(t => [t.name, t]));
      assertTrue('probe-blank-tag description is still unset', !byNameAfterDetect['probe-blank-tag'].description);
      assertTrue('tt-probe-linkfix knowledge_file_key is still unset', !byNameAfterDetect['tt-probe-linkfix'].knowledge_file_key);
      assertTrue('no .tipatask/kb-reindex-state.json was created by detect', !fs.existsSync(path.join(tmpRoot, '.tipatask', 'kb-reindex-state.json')));
      console.log();

      // ── Teardown ──
      if (opts.keep) {
        console.log(`7. --keep set: leaving project id=${projectId} ("${project.name}") in place for inspection.`);
      } else {
        console.log('7. Tearing down throwaway project...');
        await apiFetch(opts.apiBase, token, 'DELETE', `/api/projects/${projectId}`);
        console.log('   deleted.');
      }
      console.log(`\n[probe-kb-reindex] ${_passCount} passed, ${_failCount} failed.`);
      if (_failCount > 0) process.exitCode = 1;
      return;
    }

    if (opts.forceOnce) {
      // ── C1230: hasNeverBeenReindexed()/forceReindexOnStartup() against a real project ──
      console.log('4. Verifying the fresh project reads kb_last_reindexed_at === null (C1229)...');
      const { project: freshProject } = await apiFetch(opts.apiBase, token, 'GET', `/api/projects/${projectId}`);
      assertTrue('kb_last_reindexed_at is null on a never-indexed project', freshProject.kb_last_reindexed_at === null, `got ${JSON.stringify(freshProject.kb_last_reindexed_at)}`);
      console.log();

      console.log('5. Running forceReindexOnStartup() — first call (real Opus batch)...');
      const { forceReindexOnStartup } = require('../src/server/kb-reindex');
      const first = await forceReindexOnStartup({
        backend, rootPath: tmpRoot, label: 'probe',
        onProgress: (p) => console.log(`   [progress] ${p.phase} ${p.done}/${p.total}`),
      });
      console.log(`   status=${first.status} ok=${first.ok} stamped=${first.stamped}\n`);
      assertTrue('first call ran (project was never indexed)', first.status === 'ran', `status=${first.status}`);
      assertTrue('first call succeeded', first.ok === true);

      console.log('6. Verifying the column is now stamped...');
      const { project: afterFirst } = await apiFetch(opts.apiBase, token, 'GET', `/api/projects/${projectId}`);
      assertTrue('kb_last_reindexed_at is non-null after the forced run', afterFirst.kb_last_reindexed_at != null, `got ${JSON.stringify(afterFirst.kb_last_reindexed_at)}`);
      const { tags: tagsAfterFirst } = await apiFetch(opts.apiBase, token, 'GET', `/api/projects/${projectId}/tags`);
      const byNameAfterFirst = Object.fromEntries(tagsAfterFirst.map(t => [t.name, t]));
      assertTrue('probe-blank-tag got a real description from the forced run (Strength 1: force:false)', !!byNameAfterFirst['probe-blank-tag'].description && !/^Auto-registered/i.test(byNameAfterFirst['probe-blank-tag'].description));
      assertTrue('probe-good-tag was untouched (force:false — only blank/placeholder entries described)', byNameAfterFirst['probe-good-tag'].description === 'Already has a real, specific description — must not change.');
      console.log();

      console.log('7. Running forceReindexOnStartup() again — must fire only ONCE per project...');
      const before = afterFirst.kb_last_reindexed_at;
      const second = await forceReindexOnStartup({ backend, rootPath: tmpRoot, label: 'probe' });
      console.log(`   status=${second.status} ok=${second.ok} stamped=${second.stamped}\n`);
      assertTrue('second call is skipped — already indexed, no second Opus spawn', second.status === 'skipped-already-indexed', `status=${second.status}`);
      assertTrue('second call did not re-stamp', second.stamped === false);
      const { project: afterSecond } = await apiFetch(opts.apiBase, token, 'GET', `/api/projects/${projectId}`);
      assertTrue('kb_last_reindexed_at is unchanged by the second (skipped) call', afterSecond.kb_last_reindexed_at === before, `before=${before} after=${afterSecond.kb_last_reindexed_at}`);
      console.log();

      // ── Teardown ──
      if (opts.keep) {
        console.log(`8. --keep set: leaving project id=${projectId} ("${project.name}") in place for inspection.`);
      } else {
        console.log('8. Tearing down throwaway project...');
        await apiFetch(opts.apiBase, token, 'DELETE', `/api/projects/${projectId}`);
        console.log('   deleted.');
      }
      console.log(`\n[probe-kb-reindex] ${_passCount} passed, ${_failCount} failed.`);
      if (_failCount > 0) process.exitCode = 1;
      return;
    }

    // ── 4. Run reindexKnowledge — real scope detection + real Opus batch ──
    console.log(`4. Running reindexKnowledge(${opts.dryRun ? 'dryRun=true' : 'dryRun=false'})...`);
    const { reindexKnowledge } = require('../src/server/kb-reindex');
    const result = await reindexKnowledge({
      baseUrl: opts.apiBase,
      projectId,
      token,
      rootPath: tmpRoot,
      backend,
      onProgress: (p) => console.log(`   [progress] ${p.phase} ${p.done}/${p.total}`),
      dryRun: opts.dryRun,
    });
    console.log(`   errors: ${JSON.stringify(result.errors)}`);
    console.log();

    console.log('5. Verifying scope + proposals...');
    const proposedNames = result.proposals.tags.map(t => t.name);
    assertTrue('probe-blank-tag was proposed', proposedNames.includes('probe-blank-tag'));
    assertTrue('probe-good-tag was NOT proposed (already good, force=false)', !proposedNames.includes('probe-good-tag'));
    const blankProposal = result.proposals.tags.find(t => t.name === 'probe-blank-tag');
    assertTrue('proposed description is non-empty', !!(blankProposal && blankProposal.description));
    assertTrue('proposed description is not a placeholder', !!(blankProposal && !/^Auto-registered/i.test(blankProposal.description)));
    if (blankProposal) console.log(`   probe-blank-tag -> "${blankProposal.description}"`);
    const linkFixProposal = result.proposals.tags.find(t => t.name === 'tt-probe-linkfix');
    assertTrue('tt-probe-linkfix was proposed (link-only, missing knowledge_file_id)', !!linkFixProposal);
    assertTrue('tt-probe-linkfix proposal carries file_key (link repair)', !!(linkFixProposal && linkFixProposal.file_key === 'ai/architecture/tt-probe-linkfix.md'));
    assertTrue('tt-probe-linkfix description is unchanged (no Opus call needed)', !!(linkFixProposal && linkFixProposal.description === linkFixDesc));
    console.log();

    if (!opts.dryRun) {
      console.log('6. Verifying DB persistence (re-fetch /tags)...');
      const { tags } = await apiFetch(opts.apiBase, token, 'GET', `/api/projects/${projectId}/tags`);
      const byName = Object.fromEntries(tags.map(t => [t.name, t]));
      assertTrue('probe-blank-tag has a real description now', !!byName['probe-blank-tag'].description && !/^Auto-registered/i.test(byName['probe-blank-tag'].description));
      assertTrue('probe-good-tag description untouched', byName['probe-good-tag'].description === 'Already has a real, specific description — must not change.');
      assertTrue('tt-probe-linkfix knowledge_file_key repaired', byName['tt-probe-linkfix'].knowledge_file_key === 'ai/architecture/tt-probe-linkfix.md');
      console.log();

      console.log('7. Re-index endpoint rejects a placeholder write directly...');
      try {
        await apiFetch(opts.apiBase, token, 'POST', `/api/projects/${projectId}/knowledge/reindex`, {
          tags: [{ name: 'probe-good-tag', description: 'Auto-registered by createTask' }],
        });
        assertTrue('placeholder write was rejected', false, 'expected a 400, got 200');
      } catch (err) {
        assertTrue('placeholder write was rejected (400)', err.status === 400, `got status ${err.status}`);
      }
      console.log();
    } else {
      console.log('6-7. --dry-run: skipping DB-persistence + placeholder-rejection checks.\n');
    }

    // ── Teardown ──
    if (opts.keep) {
      console.log(`8. --keep set: leaving project id=${projectId} ("${project.name}") in place for inspection.`);
    } else {
      console.log('8. Tearing down throwaway project...');
      await apiFetch(opts.apiBase, token, 'DELETE', `/api/projects/${projectId}`);
      console.log('   deleted.');
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`\n[probe-kb-reindex] ${_passCount} passed, ${_failCount} failed.`);
  if (_failCount > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[probe-kb-reindex] failed:', err.message);
  if (err.body) console.error('  response body:', JSON.stringify(err.body));
  process.exitCode = 1;
});
