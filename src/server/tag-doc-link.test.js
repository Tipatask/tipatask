'use strict';

// C1237 — unit tests for tag-doc-link.js: selecting which new tt-* tags need a KB-doc
// link, writing/pushing the stub, and the per-tag PUT /tags/:name/link call. Same style
// as kb-reindex.test.js / reserve-task-keys.test.js: node:test + node:assert, a real
// throwaway http.createServer standing in for the Tipatask API, a real fs.mkdtempSync
// project root — no module mocking.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { archFileKey, buildTagStub, selectLinkCandidates, prepareTagDocs, linkTagDocs } = require('./tag-doc-link');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-tag-doc-link-'));
}

// Minimal throwaway HTTP server. `routes` is a Map keyed by "METHOD pathname" -> handler
// (req, res, body) => void. Any unmatched route 404s and is counted, so a test asserting
// "zero pushes" can catch an accidental hit on the wrong path instead of silently passing.
function startServer(routes) {
  const hits = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const key = `${req.method} ${u.pathname}`;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* not json */ }
        hits.push({ key, body });
        const handler = routes.get(key);
        if (handler) return handler(req, res, body);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no route: ' + key }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, baseUrl: `http://127.0.0.1:${srv.address().port}` }));
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ── selectLinkCandidates (pure) ──

test('selectLinkCandidates: includes a new unlinked tt-* tag, excludes plain tags', () => {
  const tagRegistrations = [{ name: 'tt-new-module', description: 'desc' }, { name: 'plain-tag', description: 'd' }];
  const hints = new Map([['tt-new-module', 'hint text']]);
  const existing = [{ name: 'other-tag', description: 'x', knowledge_file_key: null }];
  const out = selectLinkCandidates(tagRegistrations, hints, existing);
  assert.deepStrictEqual(out, [{ tag: 'tt-new-module', fileKey: 'ai/architecture/tt-new-module.md', description: 'desc', hint: 'hint text' }]);
});

test('selectLinkCandidates: skips a tag already correctly linked', () => {
  const tagRegistrations = [{ name: 'tt-linked', description: 'desc' }];
  const existing = [{ name: 'tt-linked', description: 'desc', knowledge_file_key: 'ai/architecture/tt-linked.md' }];
  const out = selectLinkCandidates(tagRegistrations, new Map(), existing);
  assert.deepStrictEqual(out, []);
});

test('selectLinkCandidates: skips when the file_key is already owned by a different tag', () => {
  const tagRegistrations = [{ name: 'tt-dup', description: 'desc' }];
  const existing = [{ name: 'tt-other-owner', description: 'x', knowledge_file_key: 'ai/architecture/tt-dup.md' }];
  const out = selectLinkCandidates(tagRegistrations, new Map(), existing);
  assert.deepStrictEqual(out, []);
});

test('selectLinkCandidates: disables itself entirely when rows carry no knowledge_file_key key at all (API predates 046)', () => {
  const tagRegistrations = [{ name: 'tt-new', description: 'desc' }];
  const existing = [{ name: 'other-tag', description: 'x' }]; // no knowledge_file_key property
  const out = selectLinkCandidates(tagRegistrations, new Map(), existing);
  assert.deepStrictEqual(out, []);
});

test('selectLinkCandidates: normalizes bare-string existing rows and dedupes repeated names', () => {
  const tagRegistrations = [{ name: 'tt-a', description: 'd' }, { name: 'tt-a', description: 'd' }];
  const existing = [{ name: 'tt-a', description: 'd', knowledge_file_key: null }];
  const out = selectLinkCandidates(tagRegistrations, new Map(), existing);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].tag, 'tt-a');
});

test('selectLinkCandidates: empty registrations -> empty candidates, no crash on empty existing rows', () => {
  assert.deepStrictEqual(selectLinkCandidates([], new Map(), []), []);
});

// Regression: a brand-new project (or the very first tt-* tag ever registered) has
// ZERO existing tag rows — that must NOT be mistaken for "API predates migration 046"
// and disable linking. Caught live by scripts/probe-tag-doc-link.js against a real
// throwaway project before this fix (candidates always came back empty on the very
// first save).
test('selectLinkCandidates: empty existingTagRows (brand-new project) still produces candidates', () => {
  const tagRegistrations = [{ name: 'tt-first-ever', description: 'desc' }];
  const hints = new Map([['tt-first-ever', 'hint']]);
  const out = selectLinkCandidates(tagRegistrations, hints, []);
  assert.deepStrictEqual(out, [{ tag: 'tt-first-ever', fileKey: 'ai/architecture/tt-first-ever.md', description: 'desc', hint: 'hint' }]);
});

// ── prepareTagDocs (I/O) ──

test('prepareTagDocs: hint present writes buildTagStub content and pushes it', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fileKey = 'ai/architecture/tt-probe-linkfix.md';
  const routes = new Map();
  routes.set('GET /api/projects/p1/knowledge', (req, res) => json(res, 200, { files: [] }));
  routes.set(`PUT /api/projects/p1/knowledge/${fileKey}`, (req, res, body) => {
    json(res, 200, { file_key: fileKey, version: (body.version_hint || 0) + 1 });
  });
  const { srv, hits, baseUrl } = await startServer(routes);
  t.after(() => srv.close());

  const candidates = [{ tag: 'tt-probe-linkfix', fileKey, description: 'A probe tag', hint: 'Module purpose, key files.' }];
  const result = await prepareTagDocs({ baseUrl, projectId: 'p1', token: 'tok', rootPath: root, candidates, tasks: [], buildStub: () => null });

  assert.deepStrictEqual(result.linkable, [{ tag: 'tt-probe-linkfix', fileKey }]);
  assert.deepStrictEqual(result.skipped, []);

  const written = fs.readFileSync(path.join(root, fileKey), 'utf8');
  assert.strictEqual(written, buildTagStub('tt-probe-linkfix', 'A probe tag', 'Module purpose, key files.'));

  const pushHit = hits.find((h) => h.key === `PUT /api/projects/p1/knowledge/${fileKey}`);
  assert.strictEqual(pushHit.body.content, written);
});

test('prepareTagDocs: hint absent falls back to task-derived buildStub', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fileKey = 'ai/architecture/tt-from-tasks.md';
  const routes = new Map();
  routes.set('GET /api/projects/p1/knowledge', (req, res) => json(res, 200, { files: [] }));
  routes.set(`PUT /api/projects/p1/knowledge/${fileKey}`, (req, res, body) => json(res, 200, { version: (body.version_hint || 0) + 1 }));
  const { srv, baseUrl } = await startServer(routes);
  t.after(() => srv.close());

  const candidates = [{ tag: 'tt-from-tasks', fileKey, description: undefined, hint: undefined }];
  const tasks = [{ title: 'A task', tags: ['tt-from-tasks'] }];
  const fakeBuildStub = (tag, ts) => `# ${tag} — task-derived\n\n${ts.length} task(s).\n`;
  const result = await prepareTagDocs({ baseUrl, projectId: 'p1', token: 'tok', rootPath: root, candidates, tasks, buildStub: fakeBuildStub });

  assert.deepStrictEqual(result.linkable, [{ tag: 'tt-from-tasks', fileKey }]);
  const written = fs.readFileSync(path.join(root, fileKey), 'utf8');
  assert.strictEqual(written, '# tt-from-tasks — task-derived\n\n1 task(s).\n');
});

test('prepareTagDocs: neither hint nor stub source -> skipped no-stub-source, no write', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fileKey = 'ai/architecture/tt-nothing.md';
  const routes = new Map();
  routes.set('GET /api/projects/p1/knowledge', (req, res) => json(res, 200, { files: [] }));
  const { srv, hits, baseUrl } = await startServer(routes);
  t.after(() => srv.close());

  const candidates = [{ tag: 'tt-nothing', fileKey, description: undefined, hint: undefined }];
  const result = await prepareTagDocs({ baseUrl, projectId: 'p1', token: 'tok', rootPath: root, candidates, tasks: [], buildStub: () => null });

  assert.deepStrictEqual(result.linkable, []);
  assert.deepStrictEqual(result.skipped, [{ tag: 'tt-nothing', reason: 'no-stub-source' }]);
  assert.strictEqual(fs.existsSync(path.join(root, fileKey)), false);
  assert.strictEqual(hits.some((h) => h.key.startsWith('PUT')), false);
});

test('prepareTagDocs: existing local file is never overwritten, its exact bytes are pushed', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fileKey = 'ai/architecture/tt-existing.md';
  const abs = path.join(root, fileKey);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const original = '# tt-existing — hand-written doc\n\nReal content, not a stub.\n';
  fs.writeFileSync(abs, original, 'utf8');

  const routes = new Map();
  routes.set('GET /api/projects/p1/knowledge', (req, res) => json(res, 200, { files: [] }));
  routes.set(`PUT /api/projects/p1/knowledge/${fileKey}`, (req, res, body) => json(res, 200, { version: (body.version_hint || 0) + 1 }));
  const { srv, hits, baseUrl } = await startServer(routes);
  t.after(() => srv.close());

  const candidates = [{ tag: 'tt-existing', fileKey, description: 'd', hint: 'h' }];
  const result = await prepareTagDocs({ baseUrl, projectId: 'p1', token: 'tok', rootPath: root, candidates, tasks: [], buildStub: () => null });

  assert.deepStrictEqual(result.linkable, [{ tag: 'tt-existing', fileKey }]);
  assert.strictEqual(fs.readFileSync(abs, 'utf8'), original); // unchanged on disk
  const pushHit = hits.find((h) => h.key === `PUT /api/projects/p1/knowledge/${fileKey}`);
  assert.strictEqual(pushHit.body.content, original);
});

test('prepareTagDocs: doc already exists remotely -> linkable with zero local writes and zero pushes', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fileKey = 'ai/architecture/tt-remote-only.md';
  const routes = new Map();
  routes.set('GET /api/projects/p1/knowledge', (req, res) => json(res, 200, { files: [{ file_key: fileKey, version: 3 }] }));
  const { srv, hits, baseUrl } = await startServer(routes);
  t.after(() => srv.close());

  const candidates = [{ tag: 'tt-remote-only', fileKey, description: 'd', hint: 'h' }];
  const result = await prepareTagDocs({ baseUrl, projectId: 'p1', token: 'tok', rootPath: root, candidates, tasks: [], buildStub: () => null });

  assert.deepStrictEqual(result.linkable, [{ tag: 'tt-remote-only', fileKey }]);
  assert.strictEqual(fs.existsSync(path.join(root, fileKey)), false); // no local write
  assert.strictEqual(hits.filter((h) => h.key.startsWith('PUT')).length, 0); // no push
});

test('prepareTagDocs: PUT 500 -> skipped push-failed, no throw', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fileKey = 'ai/architecture/tt-push-fails.md';
  const routes = new Map();
  routes.set('GET /api/projects/p1/knowledge', (req, res) => json(res, 200, { files: [] }));
  routes.set(`PUT /api/projects/p1/knowledge/${fileKey}`, (req, res) => json(res, 500, { error: 'boom' }));
  const { srv, baseUrl } = await startServer(routes);
  t.after(() => srv.close());

  const candidates = [{ tag: 'tt-push-fails', fileKey, description: 'd', hint: 'h' }];
  const result = await prepareTagDocs({ baseUrl, projectId: 'p1', token: 'tok', rootPath: root, candidates, tasks: [], buildStub: () => null });

  assert.deepStrictEqual(result.linkable, []);
  assert.strictEqual(result.skipped.length, 1);
  assert.strictEqual(result.skipped[0].tag, 'tt-push-fails');
  assert.match(result.skipped[0].reason, /^push-failed:/);
});

test('prepareTagDocs: lease held by another writer -> skipped lock-held, version cache untouched', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fileKey = 'ai/architecture/tt-locked.md';
  const routes = new Map();
  routes.set('GET /api/projects/p1/knowledge', (req, res) => json(res, 200, { files: [] }));
  routes.set(`POST /api/projects/p1/knowledge/${fileKey}/lock`, (req, res) => {
    json(res, 409, {
      error: 'File is locked by someone@example.com', lock_held: true, locked_by: 99,
      locked_by_email: 'someone@example.com', same_user: false, retry_after_seconds: 5,
      lock_expires_at: new Date(Date.now() + 60000).toISOString(),
    });
  });
  const { srv, baseUrl } = await startServer(routes);
  t.after(() => srv.close());

  const candidates = [{ tag: 'tt-locked', fileKey, description: 'd', hint: 'h' }];
  const result = await prepareTagDocs({ baseUrl, projectId: 'p1', token: 'tok', rootPath: root, candidates, tasks: [], buildStub: () => null });

  assert.deepStrictEqual(result.linkable, []);
  assert.deepStrictEqual(result.skipped, [{ tag: 'tt-locked', reason: 'lock-held' }]);
  // Stub is written locally (so the next Re-Index / bulk sync can pick it up) but the
  // version cache is never stamped for a push that never completed.
  assert.strictEqual(fs.existsSync(path.join(root, fileKey)), true);
  const cachePath = path.join(root, '.tipatask', 'knowledge-versions.json');
  assert.strictEqual(fs.existsSync(cachePath), false);
});

test('prepareTagDocs: creates ai/architecture/ when missing', async (t) => {
  const root = makeRoot(); // no ai/architecture dir at all
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(fs.existsSync(path.join(root, 'ai', 'architecture')), false);

  const fileKey = 'ai/architecture/tt-fresh-dir.md';
  const routes = new Map();
  routes.set('GET /api/projects/p1/knowledge', (req, res) => json(res, 200, { files: [] }));
  routes.set(`PUT /api/projects/p1/knowledge/${fileKey}`, (req, res, body) => json(res, 200, { version: (body.version_hint || 0) + 1 }));
  const { srv, baseUrl } = await startServer(routes);
  t.after(() => srv.close());

  const candidates = [{ tag: 'tt-fresh-dir', fileKey, description: 'd', hint: 'h' }];
  await prepareTagDocs({ baseUrl, projectId: 'p1', token: 'tok', rootPath: root, candidates, tasks: [], buildStub: () => null });

  assert.strictEqual(fs.existsSync(path.join(root, fileKey)), true);
});

test('prepareTagDocs: empty candidates does zero I/O', async () => {
  const result = await prepareTagDocs({ baseUrl: 'http://127.0.0.1:1', projectId: 'p1', token: 'tok', rootPath: '/nonexistent', candidates: [], tasks: [], buildStub: () => null });
  assert.deepStrictEqual(result, { linkable: [], skipped: [] });
});

test('prepareTagDocs: remote list fetch fails entirely -> every candidate skipped, no throw', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const routes = new Map();
  routes.set('GET /api/projects/p1/knowledge', (req, res) => json(res, 500, { error: 'down' }));
  const { srv, baseUrl } = await startServer(routes);
  t.after(() => srv.close());

  const candidates = [{ tag: 'tt-a', fileKey: 'ai/architecture/tt-a.md', description: 'd', hint: 'h' }];
  const result = await prepareTagDocs({ baseUrl, projectId: 'p1', token: 'tok', rootPath: root, candidates, tasks: [], buildStub: () => null });
  assert.deepStrictEqual(result.linkable, []);
  assert.strictEqual(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /^remote-check-failed:/);
});

// ── linkTagDocs (I/O) ──

test('linkTagDocs: 200 -> linked', async (t) => {
  const routes = new Map();
  routes.set('PUT /api/projects/p1/tags/tt-a/link', (req, res, body) => {
    assert.strictEqual(body.file_key, 'ai/architecture/tt-a.md');
    json(res, 200, { tag: { name: 'tt-a', knowledge_file_id: 5, knowledge_file_key: body.file_key } });
  });
  const { srv, baseUrl } = await startServer(routes);
  t.after(() => srv.close());

  const result = await linkTagDocs({ baseUrl, projectId: 'p1', token: 'tok', linkable: [{ tag: 'tt-a', fileKey: 'ai/architecture/tt-a.md' }] });
  assert.deepStrictEqual(result, { linked: ['tt-a'], failed: [] });
});

test('linkTagDocs: 404/400 -> failed, never throws, other tags still attempted', async (t) => {
  const routes = new Map();
  routes.set('PUT /api/projects/p1/tags/tt-missing/link', (req, res) => json(res, 404, { error: 'Tag not found' }));
  routes.set('PUT /api/projects/p1/tags/tt-dup/link', (req, res) => json(res, 400, { error: 'file_key already linked to a different tag' }));
  routes.set('PUT /api/projects/p1/tags/tt-ok/link', (req, res, body) => json(res, 200, { tag: { name: 'tt-ok', knowledge_file_key: body.file_key } }));
  const { srv, baseUrl } = await startServer(routes);
  t.after(() => srv.close());

  const linkable = [
    { tag: 'tt-missing', fileKey: 'ai/architecture/tt-missing.md' },
    { tag: 'tt-dup', fileKey: 'ai/architecture/tt-dup.md' },
    { tag: 'tt-ok', fileKey: 'ai/architecture/tt-ok.md' },
  ];
  const result = await linkTagDocs({ baseUrl, projectId: 'p1', token: 'tok', linkable });
  assert.deepStrictEqual(result.linked, ['tt-ok']);
  assert.strictEqual(result.failed.length, 2);
  assert.deepStrictEqual(result.failed.map((f) => f.tag).sort(), ['tt-dup', 'tt-missing']);
});

test('linkTagDocs: transport error (unreachable host) -> failed, no throw', async () => {
  const result = await linkTagDocs({ baseUrl: 'http://127.0.0.1:1', projectId: 'p1', token: 'tok', linkable: [{ tag: 'tt-a', fileKey: 'ai/architecture/tt-a.md' }] });
  assert.strictEqual(result.linked.length, 0);
  assert.strictEqual(result.failed.length, 1);
  assert.strictEqual(result.failed[0].tag, 'tt-a');
});

test('linkTagDocs: empty linkable does zero I/O', async () => {
  const result = await linkTagDocs({ baseUrl: 'http://127.0.0.1:1', projectId: 'p1', token: 'tok', linkable: [] });
  assert.deepStrictEqual(result, { linked: [], failed: [] });
});

// ── archFileKey / buildTagStub ──

test('archFileKey builds the ai/architecture/{tag}.md convention path', () => {
  assert.strictEqual(archFileKey('tt-foo'), 'ai/architecture/tt-foo.md');
});

test('buildTagStub matches the create_system_tag template shape', () => {
  const stub = buildTagStub('tt-foo', 'One-line desc', 'Hint body.');
  assert.match(stub, /^# tt-foo — One-line desc\n\nHint body\.\n\n## Files\n/);
  assert.match(stub, /## Behavior\n\n_\(expand with specific schema/);
});
