'use strict';

// C1218 — unit tests for kb-reindex.js's detectStaleDescriptions()/classifyKnowledgeScope()
// split. Same style as ../cli/knowledge-sync.test.js: node:test + node:assert, a real
// throwaway http.createServer standing in for the Tipatask API, and a real fs.mkdtempSync
// project root with real ai/architecture/tt-*.md files — no module mocking.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { detectStaleDescriptions, hasNeverBeenReindexed, forceReindexOnStartup } = require('./kb-reindex');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-reindex-'));
  fs.mkdirSync(path.join(root, 'ai', 'architecture'), { recursive: true });
  return root;
}

function writeArchDoc(root, tagName, description) {
  const p = path.join(root, 'ai', 'architecture', `${tagName}.md`);
  fs.writeFileSync(p, `# ${tagName} — ${description}\n\nBody text.\n`, 'utf8');
  return p;
}

// Minimal throwaway HTTP server standing in for GET /api/projects/:id/knowledge (the list
// endpoint). `files` is the list-response payload; `hits` counts GETs to the list route so
// tests can assert detect issues exactly one. Any OTHER route (single-file GET/PUT — what
// a presync would hit) 500s and increments `unexpectedHits`, so a regression that makes
// detect call presync fails loudly instead of silently passing.
function startKnowledgeServer(files) {
  const state = { hits: 0, unexpectedHits: 0 };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && u.pathname === '/api/projects/p1/knowledge') {
        state.hits++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files }));
        return;
      }
      state.unexpectedHits++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected route hit' }));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, state, baseUrl: `http://127.0.0.1:${srv.address().port}` }));
  });
}

function throwingBackend(dbTags) {
  return {
    getTagsDetailed: async () => dbTags,
    getTasksUnfiltered: async () => { throw new Error('getTasksUnfiltered must not be called by detectStaleDescriptions'); },
    reindexKnowledge: async () => { throw new Error('reindexKnowledge (persist) must not be called by detectStaleDescriptions'); },
  };
}

test('detectStaleDescriptions scopes blank and placeholder plain-tag descriptions, leaves a real one alone', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { srv, baseUrl } = await startKnowledgeServer([]);
  t.after(() => srv.close());

  const dbTags = [
    { name: 'plain-blank', description: null, knowledgeFileKey: null },
    { name: 'plain-placeholder', description: 'Auto-registered by createTask', knowledgeFileKey: null },
    { name: 'plain-good', description: 'A real, specific one-line description.', knowledgeFileKey: null },
  ];
  const backend = throwingBackend(dbTags);

  const result = await detectStaleDescriptions({ backend, rootPath: root, baseUrl, projectId: 'p1', token: 'tok' });

  assert.deepStrictEqual(result.scope.plainTagEntries.map(e => e.name).sort(), ['plain-blank', 'plain-placeholder']);
  assert.strictEqual(result.hasStale, true);
  assert.strictEqual(result.tagCount, 2);
  assert.strictEqual(result.fileCount, 0);
  assert.strictEqual(result.staleCount, 2);
  assert.strictEqual(result.linkOnlyCount, 0);
});

test('a tt-* tag whose only defect is a missing knowledge_file_id is linkOnly, not stale', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeArchDoc(root, 'tt-probe', 'Real description of the probe module.');
  const { srv, baseUrl } = await startKnowledgeServer([]);
  t.after(() => srv.close());

  const dbTags = [
    { name: 'tt-probe', description: 'Real description of the probe module.', knowledgeFileKey: null },
  ];
  const backend = throwingBackend(dbTags);

  const result = await detectStaleDescriptions({ backend, rootPath: root, baseUrl, projectId: 'p1', token: 'tok' });

  assert.strictEqual(result.hasStale, false, 'a link-only defect must never force an Opus call on its own');
  assert.strictEqual(result.linkOnlyCount, 1);
  assert.strictEqual(result.linkConflictCount, 0);
  assert.strictEqual(result.tagCount, 0);
  assert.strictEqual(result.fileCount, 0);
  assert.strictEqual(result.scope.linkOnlyEntries[0].name, 'tt-probe');
  // C1244 — needsRun is broader than hasStale: a link-only gap still needs a (zero-Opus)
  // run to drain, so fireAutoReindex must not report 'clean' for this fixture.
  assert.strictEqual(result.needsRun, true);
});

test('C1244 — a tt-* tag whose expected doc is already linked to a different tag is a linkConflict, not linkOnly, and does not force a run', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeArchDoc(root, 'tt-probe', 'Real description of the probe module.');
  const { srv, baseUrl } = await startKnowledgeServer([]);
  t.after(() => srv.close());

  const dbTags = [
    // tt-probe wants ai/architecture/tt-probe.md, but tt-other already holds that link —
    // repairing tt-probe would hit the uk_tags_knowledge_file UNIQUE constraint.
    { name: 'tt-probe', description: 'Real description of the probe module.', knowledgeFileKey: null },
    { name: 'tt-other', description: 'An unrelated, already-good description.', knowledgeFileKey: 'ai/architecture/tt-probe.md' },
  ];
  const backend = throwingBackend(dbTags);

  const result = await detectStaleDescriptions({ backend, rootPath: root, baseUrl, projectId: 'p1', token: 'tok' });

  assert.strictEqual(result.linkOnlyCount, 0);
  assert.strictEqual(result.linkConflictCount, 1);
  assert.strictEqual(result.scope.linkConflicts[0].name, 'tt-probe');
  assert.strictEqual(result.scope.linkConflicts[0].claimedBy, 'tt-other');
  assert.strictEqual(result.hasStale, false);
  assert.strictEqual(result.needsRun, false, 'an unrepairable conflict must not keep re-firing a run every trigger');
});

// Regression test for the h1Bad bug this backfill surfaced: a tt-* DB tag with NO matching
// local doc (a "phantom" tag — renamed/superseded/pre-doc feature) used to be treated as
// unconditionally stale (`h1Bad = !sys || ...`), so it was re-described from task titles on
// EVERY run, force or not, silently overwriting even an already-good hand-written
// description forever. Fixed to `h1Bad = !!sys && ...` — see kb-reindex.js's classifyKnowledgeScope.
test('a tt-* tag with no matching local doc and an already-good description is NOT scoped', async (t) => {
  const root = makeRoot(); // deliberately no doc written for this tag — the doc-less case
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { srv, baseUrl } = await startKnowledgeServer([]);
  t.after(() => srv.close());

  const dbTags = [
    { name: 'tt-doc-less-good', description: 'A real, specific, already-good description.', knowledgeFileKey: null },
  ];
  const result = await detectStaleDescriptions({ backend: throwingBackend(dbTags), rootPath: root, baseUrl, projectId: 'p1', token: 'tok' });

  assert.strictEqual(result.hasStale, false, 'a doc-less tag with a good description must never be re-scoped for regeneration');
  assert.strictEqual(result.tagCount, 0);
  assert.strictEqual(result.scope.plainTagEntries.length, 0);
});

test('a tt-* tag with no matching local doc and a genuinely blank description IS scoped as a plain tag', async (t) => {
  const root = makeRoot(); // no doc written — same doc-less shape, but this time dbBad is real
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { srv, baseUrl } = await startKnowledgeServer([]);
  t.after(() => srv.close());

  const dbTags = [
    { name: 'tt-doc-less-blank', description: null, knowledgeFileKey: null },
  ];
  const result = await detectStaleDescriptions({ backend: throwingBackend(dbTags), rootPath: root, baseUrl, projectId: 'p1', token: 'tok' });

  assert.strictEqual(result.hasStale, true);
  assert.strictEqual(result.tagCount, 1);
  assert.strictEqual(result.fileCount, 0, 'a doc-less tag never writes a file row — there is no file to link');
  assert.deepStrictEqual(result.scope.plainTagEntries.map(e => e.name), ['tt-doc-less-blank']);
  assert.strictEqual(result.scope.ttDocEntries.length, 0, 'no local doc exists, so this can never become a ttDocEntry');
});

test('a tt-* doc with a placeholder H1 is stale even when the DB description is good', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeArchDoc(root, 'tt-probe2', 'Auto-registered by createTask');
  const { srv, baseUrl } = await startKnowledgeServer([]);
  t.after(() => srv.close());

  const dbTags = [
    // DB description is real AND the link is already correct — only the doc's own H1 is bad.
    { name: 'tt-probe2', description: 'A perfectly fine real description.', knowledgeFileKey: 'ai/architecture/tt-probe2.md' },
  ];
  const backend = throwingBackend(dbTags);

  const result = await detectStaleDescriptions({ backend, rootPath: root, baseUrl, projectId: 'p1', token: 'tok' });

  assert.strictEqual(result.hasStale, true);
  assert.strictEqual(result.scope.ttDocEntries.length, 1);
  assert.strictEqual(result.scope.ttDocEntries[0].name, 'tt-probe2');
  assert.strictEqual(result.tagCount, 1);
  assert.strictEqual(result.fileCount, 1, 'a tt-* doc entry writes both stores, so it counts toward fileCount too');
});

test('a core SYNC_FILE absent from disk is out of scope even with a blank DB description', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // No CLAUDE.md written to disk.
  const { srv, baseUrl } = await startKnowledgeServer([{ file_key: 'CLAUDE.md', description: null }]);
  t.after(() => srv.close());

  const backend = throwingBackend([]);
  const result = await detectStaleDescriptions({ backend, rootPath: root, baseUrl, projectId: 'p1', token: 'tok' });

  assert.strictEqual(result.scope.coreFileEntries.length, 0);
  assert.strictEqual(result.hasStale, false);
});

test('force:true scopes an already-good plain tag and an already-present core file', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Project\n\nGood real content.\n', 'utf8');
  const { srv, baseUrl } = await startKnowledgeServer([{ file_key: 'CLAUDE.md', description: 'Already a real description.' }]);
  t.after(() => srv.close());

  const dbTags = [{ name: 'plain-good2', description: 'Already a real, established description.', knowledgeFileKey: null }];
  const backend = throwingBackend(dbTags);

  const clean = await detectStaleDescriptions({ backend, rootPath: root, baseUrl, projectId: 'p1', token: 'tok' });
  assert.strictEqual(clean.hasStale, false, 'sanity: without force, an all-good project is clean');

  const forced = await detectStaleDescriptions({ backend, rootPath: root, baseUrl, projectId: 'p1', token: 'tok', force: true });
  assert.strictEqual(forced.hasStale, true);
  assert.ok(forced.scope.plainTagEntries.some(e => e.name === 'plain-good2'));
  assert.ok(forced.scope.coreFileEntries.some(e => e.name === 'CLAUDE.md'));
});

test('detectStaleDescriptions issues exactly one list-knowledge-files GET, never touches getTasksUnfiltered/reindexKnowledge, and writes nothing to disk', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A tt-* doc whose DB description AND H1 already agree and read real — exercises the
  // doc-read path (classifyKnowledgeScope reads it off disk to check the H1) without
  // itself being in scope, so the ONLY stale row is the plain-blank tag below.
  writeArchDoc(root, 'tt-probe3', 'A real DB description already.');
  const { srv, state, baseUrl } = await startKnowledgeServer([]);
  t.after(() => srv.close());

  const dbTags = [
    { name: 'tt-probe3', description: 'A real DB description already.', knowledgeFileKey: 'ai/architecture/tt-probe3.md' },
    { name: 'plain-blank', description: null, knowledgeFileKey: null },
  ];
  const backend = throwingBackend(dbTags); // throws if getTasksUnfiltered/reindexKnowledge are ever called

  const docPath = path.join(root, 'ai', 'architecture', 'tt-probe3.md');
  const before = fs.readFileSync(docPath, 'utf8');
  const t0 = Date.now();

  const result = await detectStaleDescriptions({ backend, rootPath: root, baseUrl, projectId: 'p1', token: 'tok' });

  const elapsedMs = Date.now() - t0;
  assert.strictEqual(state.hits, 1, 'expected exactly one GET to the knowledge-files list route');
  assert.strictEqual(state.unexpectedHits, 0, 'no presync route (single-file GET/PUT) should ever be hit');
  assert.ok(elapsedMs < 5000, `detect should be far cheaper than a real Opus batch (${elapsedMs}ms)`);
  assert.strictEqual(fs.readFileSync(docPath, 'utf8'), before, 'detect must never rewrite an arch doc');
  assert.strictEqual(fs.existsSync(path.join(root, '.tipatask')), false, 'detect must never create .tipatask state');
  assert.strictEqual(result.hasStale, true);
  assert.strictEqual(result.tagCount, 1);
  assert.strictEqual(result.scope.plainTagEntries[0].name, 'plain-blank');
});

// ── C1230 — hasNeverBeenReindexed() / forceReindexOnStartup() ──

function writeApiConfig(root) {
  fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api', API_BASE_URL: 'http://127.0.0.1:1', API_TOKEN: 'tok', API_PROJECT_ID: 'p1',
  }), 'utf8');
}

test('hasNeverBeenReindexed: true for a null stamp on a fetched row', async () => {
  const backend = { getProjectSettings: async () => ({ kb_last_reindexed_at: null }) };
  assert.strictEqual(await hasNeverBeenReindexed(backend), true);
});

test('hasNeverBeenReindexed: true for an explicit undefined stamp (key present via `in`, value nullish)', async () => {
  const backend = { getProjectSettings: async () => ({ kb_last_reindexed_at: undefined, foo: 1 }) };
  assert.strictEqual(await hasNeverBeenReindexed(backend), true);
});

test('hasNeverBeenReindexed: false for a real ISO-string stamp', async () => {
  const backend = { getProjectSettings: async () => ({ kb_last_reindexed_at: '2026-08-20T10:00:00.000Z' }) };
  assert.strictEqual(await hasNeverBeenReindexed(backend), false);
});

test('hasNeverBeenReindexed: fails CLOSED — no getProjectSettings, null row, throw, and a row missing the column all read as "already indexed"', async () => {
  assert.strictEqual(await hasNeverBeenReindexed(null), false, 'no backend at all');
  assert.strictEqual(await hasNeverBeenReindexed({}), false, 'backend with no getProjectSettings (e.g. file backend)');
  assert.strictEqual(await hasNeverBeenReindexed({ getProjectSettings: async () => null }), false, 'offline / no creds — getProjectSettings never throws, returns null');
  assert.strictEqual(await hasNeverBeenReindexed({ getProjectSettings: async () => { throw new Error('boom'); } }), false, 'a throwing getProjectSettings must not read as never-indexed');
  assert.strictEqual(await hasNeverBeenReindexed({ getProjectSettings: async () => ({ some_other_column: 1 }) }), false, 'API predates migration 050 — no kb_last_reindexed_at key at all');
});

test('forceReindexOnStartup: an already-stamped project skips before touching getTagsDetailed/reindexKnowledge', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeApiConfig(root);
  const backend = {
    ...throwingBackend([]),
    getProjectSettings: async () => ({ kb_last_reindexed_at: '2026-08-20T10:00:00.000Z' }),
  };

  const res = await forceReindexOnStartup({ backend, rootPath: root, label: 'test' });
  assert.deepStrictEqual(res, { status: 'skipped-already-indexed', ok: true, stamped: false });
});

test('forceReindexOnStartup: never-indexed + nothing written fires exactly one stamp-only reindexKnowledge({files:[],tags:[]})', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeApiConfig(root);

  const persistCalls = [];
  const backend = {
    getTagsDetailed: async () => [],
    getTasksUnfiltered: async () => [],
    getProjectSettings: async () => ({ kb_last_reindexed_at: null }),
    reindexKnowledge: async (payload) => { persistCalls.push(payload); return { tags_updated: 0, files_updated: 0, skipped: [] }; },
  };
  // TEST SEAM: bypass the real Opus/presync reindexKnowledge — simulate "nothing to describe".
  const runReindex = async () => ({ tagsUpdated: 0, filesUpdated: 0, skipped: 0, errors: [] });

  const res = await forceReindexOnStartup({ backend, rootPath: root, label: 'test', runReindex });

  assert.strictEqual(res.status, 'ran');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.stamped, true);
  assert.strictEqual(persistCalls.length, 1, 'exactly one stamp-only persist call');
  assert.deepStrictEqual(persistCalls[0], { files: [], tags: [] });
});

test('forceReindexOnStartup: never-indexed + something written does NOT fire a second stamp-only call', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeApiConfig(root);

  const persistCalls = [];
  const backend = {
    getTagsDetailed: async () => [],
    getTasksUnfiltered: async () => [],
    getProjectSettings: async () => ({ kb_last_reindexed_at: null }),
    reindexKnowledge: async (payload) => { persistCalls.push(payload); return { tags_updated: 1, files_updated: 0, skipped: [] }; },
  };
  // TEST SEAM: simulate a real run that described + persisted one tag on its own — the
  // fake never calls backend.reindexKnowledge itself (real reindexKnowledge() would), so
  // any call recorded in persistCalls here can only be forceReindexOnStartup's own.
  const runReindex = async () => ({ tagsUpdated: 1, filesUpdated: 0, skipped: 0, errors: [] });

  const res = await forceReindexOnStartup({ backend, rootPath: root, label: 'test', runReindex });

  assert.strictEqual(res.status, 'ran');
  assert.strictEqual(res.stamped, false, 'the real run already wrote something — no extra stamp-only call needed');
  assert.strictEqual(persistCalls.length, 0, 'forceReindexOnStartup must not call reindexKnowledge itself here');
});

test('forceReindexOnStartup: a failing stamp-only persist surfaces as stamp-failed, not a silent success', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeApiConfig(root);

  const backend = {
    getTagsDetailed: async () => [],
    getTasksUnfiltered: async () => [],
    getProjectSettings: async () => ({ kb_last_reindexed_at: null }),
    reindexKnowledge: async () => { throw new Error('network blip'); },
  };
  const runReindex = async () => ({ tagsUpdated: 0, filesUpdated: 0, skipped: 0, errors: [] });

  const res = await forceReindexOnStartup({ backend, rootPath: root, label: 'test', runReindex });

  assert.strictEqual(res.status, 'stamp-failed');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.stamped, false);
  assert.match(res.message, /network blip/);
});
