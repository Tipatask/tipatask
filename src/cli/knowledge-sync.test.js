'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const {
  fireSessionSync, syncProjectKb, fireAutoReindex,
  acquireLock, pushFile, pushAll, autoPushOnEdit, getLocalVersions, saveLocalVersions,
  checkKnowledgeConflicts, INSTANCE_ID, pullFile, syncOnSessionStart, __resetSyncState,
  isKbFileKey, resolveKbDest,
} = require('./knowledge-sync');

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function writeConfig(root, values) {
  fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify(values), 'utf8');
}

// Minimal throwaway HTTP server standing in for the Tipatask API's
// /api/projects/:id/knowledge[/:fileKey] endpoints. `handler(pathname)`
// returns { status, body } synchronously per request.
function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const { status, body } = handler(u.pathname, req.method);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body ?? {}));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function serverUrl(srv) {
  return `http://127.0.0.1:${srv.address().port}`;
}

test('fireSessionSync latch is keyed per rootPath, not process-global (C1062)', async (t) => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-latch-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-latch-b-'));
  t.after(() => {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  let listHits = 0;
  const srv = await startServer((pathname) => {
    if (pathname === '/api/projects/p1/knowledge') {
      listHits++;
      return { status: 200, body: { files: [] } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());
  const baseUrl = serverUrl(srv);

  // Same root, called twice before either settles — must return the SAME
  // in-flight promise, not double-fetch.
  const p1 = fireSessionSync(baseUrl, 'p1', 'tok', rootA, 'test-a');
  const p2 = fireSessionSync(baseUrl, 'p1', 'tok', rootA, 'test-a');
  assert.strictEqual(p1, p2, 'second call for the same root reuses the in-flight promise');

  // Different root — must fire independently, not be latched out by rootA
  // (this is the process-global-boolean bug the keyed Map fixes).
  const p3 = fireSessionSync(baseUrl, 'p1', 'tok', rootB, 'test-b');
  assert.notStrictEqual(p1, p3);

  await Promise.all([p1, p3]);
  assert.strictEqual(listHits, 2, 'one remote-versions fetch per distinct rootPath');
});

test('a failed sync clears its latch so the next call for the same root retries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-latch-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let hits = 0;
  const srv = await startServer((pathname) => {
    if (pathname === '/api/projects/p2/knowledge') {
      hits++;
      if (hits === 1) return { status: 500, body: {} };
      return { status: 200, body: { files: [] } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());
  const baseUrl = serverUrl(srv);

  const first = await fireSessionSync(baseUrl, 'p2', 'tok', root, 'test-retry');
  assert.strictEqual(first, null, 'first (500) attempt resolves null, never throws');

  const second = await fireSessionSync(baseUrl, 'p2', 'tok', root, 'test-retry');
  // conflicts: [] — C1220's checkKnowledgeConflicts fails open (this fake server has no
  // /knowledge-conflicts handler, so its 404 resolves an empty array, never throws).
  assert.deepStrictEqual(second, { pulledCount: 0, remoteIsEmpty: true, pulledKeys: [], conflicts: [] });
  assert.strictEqual(hits, 2, 'retry actually re-hit the server — latch was cleared on failure');
});

test('syncProjectKb: no root path is a no-op', async () => {
  assert.deepStrictEqual(await syncProjectKb(null, 'l'), { ok: true, status: 'skipped-no-root' });
});

// (C1353) syncProjectKb's TASK_BACKEND gate now runs through coerceBackendType() —
// '', 'file', and 'api' all resolve to 'api' (C1352 retired the file backend), so this
// no longer skips on 'file'. Use a genuinely unrecognized value to still exercise the
// skipped-no-backend path.
test('syncProjectKb: an unrecognized backend is skipped, no HTTP attempted', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-guard-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeConfig(root, { TASK_BACKEND: 'legacy-unknown' });

  // syncProjectKb prefers process.env.TASK_BACKEND over config.json (same
  // precedence as autoPushOnEdit) — a dev shell with a stray exported
  // TASK_BACKEND=api would otherwise make this test flaky. Stub it out.
  const prevEnv = process.env.TASK_BACKEND;
  delete process.env.TASK_BACKEND;
  t.after(() => { if (prevEnv !== undefined) process.env.TASK_BACKEND = prevEnv; });

  const res = await syncProjectKb(root, 'l');
  assert.deepStrictEqual(res, { ok: true, status: 'skipped-no-backend' });
});

test('syncProjectKb: missing API_TOKEN is skipped, no HTTP attempted', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-guard-creds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Deliberately unreachable baseUrl — if the missing-creds guard were ever
  // bypassed this would fail loudly (connection error) instead of silently
  // passing.
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: 'http://127.0.0.1:1', API_PROJECT_ID: 'p3' });

  const res = await syncProjectKb(root, 'l');
  assert.deepStrictEqual(res, { ok: true, status: 'skipped-no-creds' });
});

test('syncProjectKb pulls stale files end-to-end through the real HTTP + fs path', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const srv = await startServer((pathname) => {
    if (pathname === '/api/projects/p4/knowledge') {
      return { status: 200, body: { files: [{ file_key: 'AGENTS.md', version: 3 }] } };
    }
    if (pathname === '/api/projects/p4/knowledge/AGENTS.md') {
      return { status: 200, body: { content: '# remote agents doc\n', version: 3 } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());
  const baseUrl = serverUrl(srv);
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'p4' });

  const res = await syncProjectKb(root, 'test-e2e');

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.status, 'synced');
  assert.strictEqual(res.pulledCount, 1);
  assert.deepStrictEqual(res.pulledKeys, ['AGENTS.md']);
  assert.strictEqual(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# remote agents doc\n');
});

test('syncProjectKb never rejects — a remote 500 resolves an error-status object', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-e2e-500-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const srv = await startServer(() => ({ status: 500, body: {} }));
  t.after(() => srv.close());
  const baseUrl = serverUrl(srv);
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'p5' });

  const res = await syncProjectKb(root, 'test-500');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 'error');
});

// ── C1337 — latch TTL (open → close → re-open must re-sync) ──

test('fireSessionSync: a settled result is reused inside the TTL window, and a genuine re-sync fires once it expires', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-latch-ttl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let hits = 0;
  const srv = await startServer((pathname) => {
    if (pathname === '/api/projects/pttl/knowledge') {
      hits++;
      return { status: 200, body: { files: [] } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());
  const baseUrl = serverUrl(srv);

  // Only Date is mocked (no setTimeout in the latch itself) — per the node:test mock-timer
  // gotcha, a deadline/TTL check against Date.now() only trips if Date itself is mocked.
  t.mock.timers.enable({ apis: ['Date'] });
  t.after(() => t.mock.timers.reset());

  const first = await fireSessionSync(baseUrl, 'pttl', 'tok', root, 'ttl-test');
  assert.ok(first);
  assert.strictEqual(hits, 1);

  // Still inside the reuse window — same settled result, no re-fetch. This is what makes
  // "project opened, closed, and re-opened within the window" cheap, same as before.
  const second = await fireSessionSync(baseUrl, 'pttl', 'tok', root, 'ttl-test');
  assert.strictEqual(second, first, 'settled result reused inside the TTL window');
  assert.strictEqual(hits, 1);

  // Past the window — before C1337 this returned the SAME stale cached promise forever;
  // now it must genuinely re-sync.
  t.mock.timers.tick(60001);
  const third = await fireSessionSync(baseUrl, 'pttl', 'tok', root, 'ttl-test');
  assert.notStrictEqual(third, first, 'latch expired — a new sync actually ran');
  assert.strictEqual(hits, 2);
});

// ── C1337 — syncProjectKb push half ──

test('syncProjectKb: {push:true} pushes core KB files AFTER the pull resolves, folding pushed/pushSkipped into the result', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-push-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'local content', 'utf8');

  const order = [];
  const srv = await startBodyServer((pathname, method) => {
    if (pathname === '/api/projects/p/knowledge' && method === 'GET') {
      order.push('pull');
      return { status: 200, body: { files: [] } };
    }
    // Un-upgraded API on the lock route — acquireLock fails open, pushFile falls through
    // to a plain PUT (§ Lock-Protected Push's documented fail-open contract).
    if (pathname === lockUrl('CLAUDE.md') && method === 'POST') return { status: 404, body: {} };
    if (pathname === docUrl('CLAUDE.md') && method === 'PUT') {
      order.push('push');
      return { status: 200, body: { file_key: 'CLAUDE.md', version: 1 } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());
  const baseUrl = serverUrl(srv);
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'p' });

  const res = await syncProjectKb(root, 'push-test', { push: true });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.status, 'synced');
  assert.deepStrictEqual(order, ['pull', 'push'], 'push must happen strictly after the pull, never before');
  assert.deepStrictEqual(res.pushed, ['CLAUDE.md']);
  assert.deepStrictEqual(res.pushSkipped, []);
});

test('syncProjectKb: {push:true} never runs on a skipped pull — no push HTTP attempted', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-push-skip-creds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Unreachable baseUrl + no API_TOKEN — if the missing-creds guard (which runs BEFORE the
  // push half is even reached) were ever bypassed, this fails loudly instead of hanging.
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: 'http://127.0.0.1:1', API_PROJECT_ID: 'p' });

  const res = await syncProjectKb(root, 'l', { push: true });
  assert.deepStrictEqual(res, { ok: true, status: 'skipped-no-creds' });
});

test("syncProjectKb: {push:true} — a push failure never flips the pull's ok/status", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-push-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'local content', 'utf8');

  const srv = await startBodyServer((pathname, method) => {
    if (pathname === '/api/projects/p/knowledge' && method === 'GET') return { status: 200, body: { files: [] } };
    if (pathname === lockUrl('CLAUDE.md') && method === 'POST') return { status: 404, body: {} };
    if (pathname === docUrl('CLAUDE.md') && method === 'PUT') return { status: 500, body: {} };
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());
  const baseUrl = serverUrl(srv);
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'p' });

  const res = await syncProjectKb(root, 'push-fail-test', { push: true });

  assert.strictEqual(res.ok, true, "a broken push must not fail the pull it rode in on");
  assert.strictEqual(res.status, 'synced');
  assert.strictEqual(res.pushed, undefined, 'push half never completed — nothing folded in');
});

// ── C1337 — pushAll hash-skip (mirrors pushArchitectureDocs' pre-existing skip) ──

test('pushAll: unchanged content is hash-skipped (zero PUTs); a real edit still pushes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-pushall-hashskip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const content = 'unchanged content\n';
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), content, 'utf8');
  saveLocalVersions(root, { 'CLAUDE.md': { version: 3, hash: sha256(content) } });

  let putHits = 0;
  const srv = await startBodyServer((pathname, method) => {
    if (pathname === lockUrl('CLAUDE.md') && method === 'POST') return { status: 404, body: {} };
    if (pathname === docUrl('CLAUDE.md') && method === 'PUT') {
      putHits++;
      return { status: 200, body: { file_key: 'CLAUDE.md', version: 4 } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());
  const baseUrl = serverUrl(srv);

  const first = await pushAll(baseUrl, 'p', 'tok', root);
  assert.deepStrictEqual(first, { pushed: [], skipped: ['CLAUDE.md'] });
  assert.strictEqual(putHits, 0, 'unchanged content must never PUT');

  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'edited content\n', 'utf8');
  const second = await pushAll(baseUrl, 'p', 'tok', root);
  assert.deepStrictEqual(second, { pushed: ['CLAUDE.md'], skipped: [] });
  assert.strictEqual(putHits, 1, 'a real content change must still PUT');
});

// ── C1231 — pullFile version/content skip ──

test('pullFile: cached version matches remote + on-disk hash matches — zero HTTP, zero disk write', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-pull-skip-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const content = '# up to date\n';
  fs.writeFileSync(path.join(root, 'AGENTS.md'), content, 'utf8');
  saveLocalVersions(root, { 'AGENTS.md': { version: 3, hash: sha256(content) } });

  let hits = 0;
  const srv = await startServer(() => { hits++; return { status: 500, body: {} }; }); // would fail loudly if ever hit
  t.after(() => srv.close());

  const res = await pullFile(serverUrl(srv), 'pX', 'tok', 'AGENTS.md', root, { remoteVersion: 3 });
  assert.deepStrictEqual(res, { written: false, skipped: 'version-match', version: 3 });
  assert.strictEqual(hits, 0, 'no HTTP request should be made when the remoteVersion pre-check already confirms up-to-date');
  assert.strictEqual(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), content);
});

test('pullFile: cached version matches but the file was deleted from disk — still fetched and written', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-pull-skip-deleted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const content = '# was deleted locally\n';
  saveLocalVersions(root, { 'AGENTS.md': { version: 3, hash: sha256(content) } }); // no file on disk

  const srv = await startServer((pathname) => {
    if (pathname === '/api/projects/pX/knowledge/AGENTS.md') return { status: 200, body: { content, version: 3 } };
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  const res = await pullFile(serverUrl(srv), 'pX', 'tok', 'AGENTS.md', root, { remoteVersion: 3 });
  assert.deepStrictEqual(res, { written: true, skipped: null, version: 3 });
  assert.strictEqual(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), content, 'a version-matching cache entry must never stand in for a file that is actually missing');
});

test('pullFile: remote version bumped but content is byte-identical — no disk write, cache still advances (anti-re-GET-forever)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-pull-skip-content-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const content = '# unchanged content, just a version bump\n';
  const dest = path.join(root, 'AGENTS.md');
  fs.writeFileSync(dest, content, 'utf8');
  saveLocalVersions(root, { 'AGENTS.md': { version: 2, hash: sha256(content) } });
  const mtimeBefore = fs.statSync(dest).mtimeMs;

  let hits = 0;
  const srv = await startServer((pathname) => {
    if (pathname === '/api/projects/pX/knowledge/AGENTS.md') { hits++; return { status: 200, body: { content, version: 3 } }; }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  const res = await pullFile(serverUrl(srv), 'pX', 'tok', 'AGENTS.md', root, { remoteVersion: 3 });
  assert.deepStrictEqual(res, { written: false, skipped: 'content-match', version: 3 });
  assert.strictEqual(hits, 1, 'the version bump still costs one GET — only the file write is skipped');
  assert.strictEqual(fs.statSync(dest).mtimeMs, mtimeBefore, 'file must not be rewritten when content is identical');
  assert.deepStrictEqual(getLocalVersions(root)['AGENTS.md'], { version: 3, hash: sha256(content) },
    'cache must advance to v3 even on a skip, or this file re-GETs on every future sync forever');
});

test('syncOnSessionStart: a content-identical version bump is excluded from pulledCount/pulledKeys but still updates the cache', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-sync-mixed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const changedOld = '# AGENTS old\n';
  const changedNew = '# AGENTS new\n';
  const unchangedContent = '# CLAUDE unchanged\n';
  fs.writeFileSync(path.join(root, 'AGENTS.md'), changedOld, 'utf8');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), unchangedContent, 'utf8');
  saveLocalVersions(root, {
    'AGENTS.md': { version: 1, hash: sha256(changedOld) },
    'CLAUDE.md': { version: 1, hash: sha256(unchangedContent) },
  });

  const srv = await startServer((pathname) => {
    if (pathname === '/api/projects/pX/knowledge') {
      return { status: 200, body: { files: [{ file_key: 'AGENTS.md', version: 2 }, { file_key: 'CLAUDE.md', version: 2 }] } };
    }
    if (pathname === '/api/projects/pX/knowledge/AGENTS.md') return { status: 200, body: { content: changedNew, version: 2 } };
    if (pathname === '/api/projects/pX/knowledge/CLAUDE.md') return { status: 200, body: { content: unchangedContent, version: 2 } };
    if (pathname === '/api/projects/pX/knowledge-conflicts') return { status: 200, body: { conflicts: [] } };
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  const res = await syncOnSessionStart(serverUrl(srv), 'pX', 'tok', root);
  assert.strictEqual(res.pulledCount, 1);
  assert.deepStrictEqual(res.pulledKeys, ['AGENTS.md']);
  assert.strictEqual(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), changedNew);
  assert.strictEqual(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), unchangedContent);
  assert.strictEqual(getLocalVersions(root)['CLAUDE.md'].version, 2, 'cache must still advance for the skipped file');
});

// ── C1545 — KB-root write guard + never-synced materialization ──

test('isKbFileKey: allow/deny matrix', () => {
  const allow = [
    'CLAUDE.md', 'AGENTS.md', 'ai/architecture/GENERAL.md', 'ai/CONVENTIONS.md',
    'ai/architecture/tt-mcp-server.md', 'ai/architecture/sub/dir/x.md',
  ];
  const deny = [
    '../evil.md', '../../etc/x.md', '/etc/passwd', '.git/hooks/pre-commit',
    '.tipatask/config.json', 'ai/notes.txt', 'ai/architecture/tt-../../../x.md',
    'ai/x/../y.md', '', null, undefined, 42,
  ];
  for (const key of allow) assert.strictEqual(isKbFileKey(key), true, `expected allow: ${JSON.stringify(key)}`);
  for (const key of deny) assert.strictEqual(isKbFileKey(key), false, `expected deny: ${JSON.stringify(key)}`);
});

test('pullFile: never-synced remote-only tt-*.md — missing parent dir, no cache entry — is always materialized', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-pull-never-synced-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Deliberately no ai/ directory at all yet, and no version-cache entry for this key.
  assert.strictEqual(fs.existsSync(path.join(root, 'ai')), false);

  const content = '# tt-brand-new — a tag that only ever existed remotely\n';
  const srv = await startServer((pathname) => {
    if (pathname === '/api/projects/pX/knowledge/ai/architecture/tt-brand-new.md') {
      return { status: 200, body: { content, version: 1 } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  const res = await pullFile(serverUrl(srv), 'pX', 'tok', 'ai/architecture/tt-brand-new.md', root);
  assert.deepStrictEqual(res, { written: true, skipped: null, version: 1 });
  const dest = path.join(root, 'ai', 'architecture', 'tt-brand-new.md');
  assert.strictEqual(fs.existsSync(dest), true, 'nested ai/architecture/ parent dirs must be created before write');
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), content);
  assert.deepStrictEqual(getLocalVersions(root)['ai/architecture/tt-brand-new.md'], { version: 1, hash: sha256(content) });
});

test('pullFile: path traversal outside the KB roots is rejected before any HTTP request', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-pull-traversal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let hits = 0;
  const srv = await startServer(() => { hits++; return { status: 500, body: {} }; });
  t.after(() => srv.close());

  await assert.rejects(
    () => pullFile(serverUrl(srv), 'pX', 'tok', '../evil.md', root),
    /outside the allowed roots/,
  );
  assert.strictEqual(hits, 0, 'the guard must run before any GET');
  assert.strictEqual(fs.existsSync(path.join(root, '..', 'evil.md')), false);
});

test('pullFile: absolute file_key and in-root landmines are rejected', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-pull-landmines-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let hits = 0;
  const srv = await startServer(() => { hits++; return { status: 500, body: {} }; });
  t.after(() => srv.close());

  for (const badKey of ['/etc/passwd', '.git/hooks/pre-commit', '.tipatask/config.json', 'ai/notes.txt']) {
    await assert.rejects(() => pullFile(serverUrl(srv), 'pX', 'tok', badKey, root), /Refusing to write/);
  }
  assert.strictEqual(hits, 0);
  assert.strictEqual(fs.existsSync(path.join(root, '.git')), false);
  assert.strictEqual(fs.existsSync(path.join(root, '.tipatask', 'config.json')), false);
});

test('resolveKbDest: returns the resolved path for a valid key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-resolve-kb-dest-'));
  try {
    const dest = resolveKbDest(root, 'ai/architecture/tt-x.md');
    assert.strictEqual(dest, path.resolve(root, 'ai/architecture/tt-x.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('syncOnSessionStart: an unsafe remote file_key is skipped, the rest of the bulk pull still completes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-sync-unsafe-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const content = '# a legit brand-new tag\n';
  const srv = await startServer((pathname) => {
    if (pathname === '/api/projects/pX/knowledge') {
      return {
        status: 200,
        body: {
          files: [
            { file_key: '../evil.md', version: 5 },
            { file_key: 'ai/architecture/tt-legit.md', version: 1 },
          ],
        },
      };
    }
    if (pathname === '/api/projects/pX/knowledge/ai/architecture/tt-legit.md') {
      return { status: 200, body: { content, version: 1 } };
    }
    if (pathname === '/api/projects/pX/knowledge-conflicts') return { status: 200, body: { conflicts: [] } };
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  const res = await syncOnSessionStart(serverUrl(srv), 'pX', 'tok', root);
  assert.strictEqual(res.pulledCount, 1, 'the unsafe key must not abort the rest of the sync');
  assert.deepStrictEqual(res.pulledKeys, ['ai/architecture/tt-legit.md']);
  assert.strictEqual(fs.readFileSync(path.join(root, 'ai', 'architecture', 'tt-legit.md'), 'utf8'), content);
  assert.strictEqual(fs.existsSync(path.join(root, '..', 'evil.md')), false);
});

// ── C1218 — fireAutoReindex guard ladder ──
// Real throwaway HTTP server (startServer/serverUrl above) for the one GET
// detectStaleDescriptions issues; backend.getTagsDetailed/reindexKnowledge are plain
// functions (duck-typed, same as every real backend); no module mocking.

function withEnv(t, key, value) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; });
}

function backendFor(dbTags) {
  return {
    getTagsDetailed: async () => dbTags,
    getTasksUnfiltered: async () => [],
    reindexKnowledge: async () => ({ tagsUpdated: 0, filesUpdated: 0, skipped: 0, errors: [] }), // shape-check only — never actually invoked when opts.runReindex is passed
  };
}

const STALE_TAGS = [{ name: 'plain-blank', description: null, knowledgeFileKey: null }];
const CLEAN_TAGS = [{ name: 'plain-good', description: 'A real, already-good description.', knowledgeFileKey: null }];

async function startEmptyKnowledgeServer() {
  let hits = 0;
  const srv = await startServer((pathname) => {
    if (pathname.endsWith('/knowledge')) { hits++; return { status: 200, body: { files: [] } }; }
    return { status: 404, body: {} };
  });
  return { srv, baseUrl: serverUrl(srv), getHits: () => hits };
}

// (C1353) fireAutoReindex's TASK_BACKEND gate now runs through coerceBackendType() too —
// 'file' resolves to 'api' (C1352 retired the file backend), so this uses a genuinely
// unrecognized value to still exercise the skipped-no-backend path.
test('fireAutoReindex: no root, unrecognized backend, unsupported backend shape, and missing creds all skip before any HTTP', async (t) => {
  withEnv(t, 'TASK_BACKEND', undefined);

  assert.deepStrictEqual(await fireAutoReindex(null, 'test'), { ok: true, status: 'skipped-no-root' });

  const rootFile = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-file-'));
  t.after(() => fs.rmSync(rootFile, { recursive: true, force: true }));
  writeConfig(rootFile, { TASK_BACKEND: 'legacy-unknown' });
  assert.deepStrictEqual(await fireAutoReindex(rootFile, 'test'), { ok: true, status: 'skipped-no-backend' });

  const rootShape = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-shape-'));
  t.after(() => fs.rmSync(rootShape, { recursive: true, force: true }));
  writeConfig(rootShape, { TASK_BACKEND: 'api', API_BASE_URL: 'http://127.0.0.1:1', API_TOKEN: 'tok', API_PROJECT_ID: 'p' });
  assert.deepStrictEqual(await fireAutoReindex(rootShape, 'test', { backend: {} }), { ok: true, status: 'skipped-unsupported-backend' });

  const rootCreds = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-creds-'));
  t.after(() => fs.rmSync(rootCreds, { recursive: true, force: true }));
  writeConfig(rootCreds, { TASK_BACKEND: 'api' }); // no API_TOKEN/API_BASE_URL/API_PROJECT_ID
  assert.deepStrictEqual(await fireAutoReindex(rootCreds, 'test', { backend: backendFor(STALE_TAGS) }), { ok: true, status: 'skipped-no-creds' });
});

test('fireAutoReindex: a clean project never calls runReindex and arms the recheck damper', async (t) => {
  withEnv(t, 'TASK_BACKEND', undefined);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-clean-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { srv, baseUrl, getHits } = await startEmptyKnowledgeServer();
  t.after(() => srv.close());
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'p' });

  const runReindex = async () => { throw new Error('runReindex must not be called for a clean project'); };
  const backend = backendFor(CLEAN_TAGS);

  const first = await fireAutoReindex(root, 'test', { backend, runReindex });
  assert.strictEqual(first.status, 'clean');
  assert.strictEqual(getHits(), 1);

  const second = await fireAutoReindex(root, 'test', { backend, runReindex });
  assert.strictEqual(second.status, 'skipped-recently-checked');
  assert.strictEqual(getHits(), 1, 'the damper must skip the second detect entirely, not just skip the run');
});

test('C1244 — fireAutoReindex fires a run (status:"ran") for a link-only gap even though nothing is stale', async (t) => {
  withEnv(t, 'TASK_BACKEND', undefined);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-linkonly-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Real local doc, so archCache.listSystemTags(root) resolves tt-probe -> tt-probe.md,
  // matching kb-reindex.test.js's fixture shape for a link-only defect.
  fs.mkdirSync(path.join(root, 'ai', 'architecture'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'ai', 'architecture', 'tt-probe.md'),
    '# tt-probe — Real description of the probe module.\n\nBody text.\n',
    'utf8',
  );
  const { srv, baseUrl } = await startEmptyKnowledgeServer();
  t.after(() => srv.close());
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'p' });

  const LINK_ONLY_TAGS = [
    { name: 'tt-probe', description: 'Real description of the probe module.', knowledgeFileKey: null },
  ];
  const backend = backendFor(LINK_ONLY_TAGS);
  let runCalled = false;
  const runReindex = async () => {
    runCalled = true;
    return { tagsUpdated: 1, filesUpdated: 0, skipped: 0, errors: [] };
  };

  const res = await fireAutoReindex(root, 'test', { backend, runReindex });

  assert.strictEqual(res.status, 'ran', 'a link-only gap must fire a (zero-Opus) run, not report clean');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(runCalled, true);
  assert.strictEqual(res.staleCount, 0, 'nothing was actually stale — only the DB link needed repair');
  assert.strictEqual(res.linkOnlyCount, 1);
});

test('fireAutoReindex: two triggers in quick succession on a stale project run Opus exactly once', async (t) => {
  withEnv(t, 'TASK_BACKEND', undefined);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-singleflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { srv, baseUrl } = await startEmptyKnowledgeServer();
  t.after(() => srv.close());
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'p' });

  let runCount = 0;
  let resolveRun;
  const runGate = new Promise((resolve) => { resolveRun = resolve; });
  const runReindex = async () => { runCount++; await runGate; return { tagsUpdated: 1, filesUpdated: 0, skipped: 0, errors: [] }; };
  const backend = backendFor(STALE_TAGS);

  const pa = fireAutoReindex(root, 'a', { backend, runReindex });
  const pb = fireAutoReindex(root, 'b', { backend, runReindex });

  const rb = await pb;
  assert.strictEqual(rb.status, 'skipped-in-flight', 'second concurrent auto trigger must not start a second detect/run');

  resolveRun();
  const ra = await pa;
  assert.strictEqual(ra.status, 'ran');
  assert.strictEqual(ra.ok, true);
  assert.strictEqual(runCount, 1);
});

test('fireAutoReindex: a completed run arms the disk cooldown even though rows are still stale — success and failure both', async (t) => {
  withEnv(t, 'TASK_BACKEND', undefined);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-cooldown-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { srv, baseUrl } = await startEmptyKnowledgeServer();
  t.after(() => srv.close());
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'p' });
  const backend = backendFor(STALE_TAGS);

  const ok = await fireAutoReindex(root, 'test', { backend, runReindex: async () => ({ tagsUpdated: 1, filesUpdated: 0, skipped: 0, errors: [] }) });
  assert.strictEqual(ok.status, 'ran');
  assert.strictEqual(ok.ok, true);

  const afterSuccess = await fireAutoReindex(root, 'test', { backend, runReindex: async () => { throw new Error('must not run — still in cooldown'); } });
  assert.strictEqual(afterSuccess.status, 'skipped-cooldown');
  assert.ok(afterSuccess.cooldownRemainingMs > 0);

  // A fresh project (independent cooldown state) that FAILS should also cool down, not
  // retry on the very next trigger.
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-cooldown-fail-'));
  t.after(() => fs.rmSync(root2, { recursive: true, force: true }));
  writeConfig(root2, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'p' });

  const failed = await fireAutoReindex(root2, 'test', { backend, runReindex: async () => { throw new Error('boom'); } });
  assert.strictEqual(failed.status, 'ran');
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.message, 'boom');

  const afterFailure = await fireAutoReindex(root2, 'test', { backend, runReindex: async () => { throw new Error('must not run — still in cooldown after a failure'); } });
  assert.strictEqual(afterFailure.status, 'skipped-cooldown');
});

test('fireAutoReindex honors a cooldown/lease written by another process, before this process ever fired for that root', async (t) => {
  withEnv(t, 'TASK_BACKEND', undefined);
  const backend = backendFor(STALE_TAGS);

  const rootCooldown = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-otherproc-cooldown-'));
  t.after(() => fs.rmSync(rootCooldown, { recursive: true, force: true }));
  writeConfig(rootCooldown, { TASK_BACKEND: 'api', API_BASE_URL: 'http://127.0.0.1:1', API_TOKEN: 'tok', API_PROJECT_ID: 'p' });
  fs.mkdirSync(path.join(rootCooldown, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(rootCooldown, '.tipatask', 'kb-reindex-state.json'), JSON.stringify({ lastRunFinishedAt: Date.now(), lastRunOk: true }), 'utf8');
  const cooldownRes = await fireAutoReindex(rootCooldown, 'test', { backend, runReindex: async () => { throw new Error('must not run'); } });
  assert.strictEqual(cooldownRes.status, 'skipped-cooldown');

  // (TPT295) The lease only counts while its owner is alive — process.ppid (the test runner) is a
  // live process other than this one. A state without a usable pid keeps the time-only lease.
  for (const lastRunPid of [process.ppid, undefined]) {
    const rootLease = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-otherproc-lease-'));
    t.after(() => fs.rmSync(rootLease, { recursive: true, force: true }));
    writeConfig(rootLease, { TASK_BACKEND: 'api', API_BASE_URL: 'http://127.0.0.1:1', API_TOKEN: 'tok', API_PROJECT_ID: 'p' });
    fs.mkdirSync(path.join(rootLease, '.tipatask'), { recursive: true });
    fs.writeFileSync(path.join(rootLease, '.tipatask', 'kb-reindex-state.json'), JSON.stringify({ lastRunStartedAt: Date.now(), lastRunFinishedAt: 0, lastRunPid }), 'utf8');
    const leaseRes = await fireAutoReindex(rootLease, 'test', { backend, runReindex: async () => { throw new Error('must not run'); } });
    assert.strictEqual(leaseRes.status, 'skipped-in-flight-other-process', `lastRunPid=${lastRunPid}`);
  }
});

// (TPT295) The server shutdown reaper kills an in-flight re-index's Opus children and exits, leaving
// its lease on disk. A lease whose owner is gone must not hold the retry back for 30 minutes.
test('fireAutoReindex retries at once when the disk lease owner is gone (dead pid, or this very process)', async (t) => {
  withEnv(t, 'TASK_BACKEND', undefined);
  const { srv, baseUrl } = await startEmptyKnowledgeServer();
  t.after(() => srv.close());
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid; // exited and reaped
  assert.ok(Number.isInteger(deadPid) && deadPid > 0);

  for (const [label, lastRunPid] of [['dead owner', deadPid], ['this process, no run in flight', process.pid]]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-deadlease-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'p' });
    fs.writeFileSync(path.join(root, '.tipatask', 'kb-reindex-state.json'), JSON.stringify({ lastRunStartedAt: Date.now(), lastRunFinishedAt: 0, lastRunPid }), 'utf8');
    let runs = 0;
    const res = await fireAutoReindex(root, 'test', {
      backend: backendFor(STALE_TAGS),
      runReindex: async () => { runs++; return { tagsUpdated: 1, filesUpdated: 0, skipped: 0, errors: [] }; },
    });
    assert.strictEqual(res.status, 'ran', label);
    assert.strictEqual(res.ok, true, label);
    assert.strictEqual(runs, 1, label);
  }
});

test('fireAutoReindex: manual bypasses the hasStale gate, and joins (does not duplicate) an in-flight auto run', async (t) => {
  withEnv(t, 'TASK_BACKEND', undefined);
  const { srv, baseUrl } = await startEmptyKnowledgeServer();
  t.after(() => srv.close());

  // (a) manual on a CLEAN project still runs — a click must always do something.
  const rootClean = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-manual-clean-'));
  t.after(() => fs.rmSync(rootClean, { recursive: true, force: true }));
  writeConfig(rootClean, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'p' });
  let manualRunCount = 0;
  const manualRes = await fireAutoReindex(rootClean, 'manual', {
    backend: backendFor(CLEAN_TAGS), manual: true,
    runReindex: async () => { manualRunCount++; return { tagsUpdated: 0, filesUpdated: 0, skipped: 0, errors: [] }; },
  });
  assert.strictEqual(manualRes.status, 'ran');
  assert.strictEqual(manualRunCount, 1);

  // (b) manual arriving while an auto run is in flight joins it instead of starting a second.
  const rootJoin = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-manual-join-'));
  t.after(() => fs.rmSync(rootJoin, { recursive: true, force: true }));
  writeConfig(rootJoin, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'p' });
  let runCount = 0;
  let resolveRun;
  const runGate = new Promise((resolve) => { resolveRun = resolve; });
  const runReindex = async () => { runCount++; await runGate; return { tagsUpdated: 2, filesUpdated: 1, skipped: 0, errors: [] }; };
  const backend = backendFor(STALE_TAGS);

  const autoPromise = fireAutoReindex(rootJoin, 'auto', { backend, runReindex });
  // Give the auto call's synchronous guard prefix + entry claim a chance to land before
  // the manual call fires — a real trigger site would never race this tightly, but the
  // in-flight Map is populated synchronously before the first await either way (see the
  // implementation note in knowledge-sync.js), so this is deterministic, not flaky.
  await Promise.resolve();

  let joinedStart = null;
  const manualPromise = fireAutoReindex(rootJoin, 'manual', {
    backend, manual: true, runReindex: async () => { throw new Error('manual must not start its own run — it should join'); },
    onStart: (d) => { if (d.joined) joinedStart = d; },
  });

  resolveRun();
  const [autoRes, manualJoinRes] = await Promise.all([autoPromise, manualPromise]);
  assert.strictEqual(runCount, 1, 'only the auto run should have actually called runReindex');
  assert.strictEqual(autoRes.status, 'ran');
  assert.strictEqual(manualJoinRes.status, 'joined');
  assert.ok(joinedStart, 'onStart should have fired with joined:true for the manual caller');
});

test('fireAutoReindex never rejects — a thrown runReindex resolves {ok:false, status:"ran"}', async (t) => {
  withEnv(t, 'TASK_BACKEND', undefined);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-throws-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { srv, baseUrl } = await startEmptyKnowledgeServer();
  t.after(() => srv.close());
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'p' });

  const res = await fireAutoReindex(root, 'test', {
    backend: backendFor(STALE_TAGS),
    runReindex: () => { throw new Error('synchronous throw, not even a rejected promise'); },
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 'ran');
  assert.match(res.message, /synchronous throw/);
});

test('TIPATASK_KB_AUTOREINDEX=0 disables auto firing only — a manual call still runs', async (t) => {
  withEnv(t, 'TASK_BACKEND', undefined);
  withEnv(t, 'TIPATASK_KB_AUTOREINDEX', '0');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-autoreindex-killswitch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { srv, baseUrl } = await startEmptyKnowledgeServer();
  t.after(() => srv.close());
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'p' });
  const backend = backendFor(STALE_TAGS);

  const autoRes = await fireAutoReindex(root, 'test', { backend, runReindex: async () => { throw new Error('must not run — kill switch is on'); } });
  assert.strictEqual(autoRes.status, 'skipped-disabled');

  const manualRes = await fireAutoReindex(root, 'test', { backend, manual: true, runReindex: async () => ({ tagsUpdated: 1, filesUpdated: 0, skipped: 0, errors: [] }) });
  assert.strictEqual(manualRes.status, 'ran');
});

// ── C1105 — client-side KB lock acquire/wait/release ──
// The lock tests need to inspect PUT request bodies (version_hint) and vary a response by
// call count (contention/backoff) — startServer above only hands the handler a pathname, so
// this variant parses the JSON body first and lets the handler be async.
// C1221 — 4th arg `req.headers` lets a handler assert on X-Tipatask-Instance (acquire, PUT,
// and release must all carry the SAME instance id, per pushFile's C1105/C1221 contract).
// Existing handlers all take only (pathname, method, body) and simply ignore the extra arg.
function startBodyServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const u = new URL(req.url, 'http://localhost');
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* not JSON, leave {} */ }
        const { status, body: resBody } = await handler(u.pathname, req.method, body, req.headers);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resBody ?? {}));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function lockUrl(fileKey) { return `/api/projects/p/knowledge/${fileKey}/lock`; }
function docUrl(fileKey) { return `/api/projects/p/knowledge/${fileKey}`; }

test('acquireLock: 200 resolves the granted lease', async (t) => {
  const srv = await startBodyServer((pathname, method) => {
    if (pathname === lockUrl('CLAUDE.md') && method === 'POST') {
      return {
        status: 200,
        body: {
          file_key: 'CLAUDE.md', version: 2, content: 'hi',
          locked_by: 1, locked_instance: 'probe-instance-a', locked_at: '2026-01-01T00:00:00.000Z',
          lock_expires_at: '2026-01-01T00:10:00.000Z', ttl_seconds: 600,
        },
      };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  const lease = await acquireLock(serverUrl(srv), 'p', 'tok', 'CLAUDE.md');
  assert.deepStrictEqual(lease, {
    fileKey: 'CLAUDE.md', version: 2, content: 'hi', lockedInstance: 'probe-instance-a',
    lockedAt: '2026-01-01T00:00:00.000Z', lockExpiresAt: '2026-01-01T00:10:00.000Z', ttlSeconds: 600,
  });
});

test('acquireLock: 409 lock_held rejects with a distinguishable error', async (t) => {
  const srv = await startBodyServer(() => ({
    status: 409,
    body: {
      error: 'File is locked', lock_held: true, retry_after_seconds: 42,
      lock_expires_at: 'later', locked_by_email: 'alice@x.com', same_user: false,
    },
  }));
  t.after(() => srv.close());

  await assert.rejects(
    () => acquireLock(serverUrl(srv), 'p', 'tok', 'CLAUDE.md'),
    (err) => {
      assert.strictEqual(err.lockHeld, true);
      assert.strictEqual(err.retryAfterSeconds, 42);
      assert.strictEqual(err.lockedByEmail, 'alice@x.com');
      assert.strictEqual(err.sameUser, false);
      return true;
    },
  );
});

test('acquireLock: a 404 (API predates C1104) fails open — resolves null, never throws', async (t) => {
  const srv = await startBodyServer(() => ({ status: 404, body: { error: 'not found' } }));
  t.after(() => srv.close());

  assert.strictEqual(await acquireLock(serverUrl(srv), 'p', 'tok', 'CLAUDE.md'), null);
});

test('pushFile: bounded backoff retries acquire through contention, then completes with exactly one PUT', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-lock-backoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let lockAttempts = 0;
  let putHits = 0;
  let releaseHits = 0;
  const srv = await startBodyServer((pathname, method) => {
    if (pathname === lockUrl('CLAUDE.md') && method === 'POST') {
      lockAttempts++;
      if (lockAttempts < 3) {
        return { status: 409, body: { error: 'locked', lock_held: true, retry_after_seconds: 0, lock_expires_at: 'later' } };
      }
      return {
        status: 200,
        body: { file_key: 'CLAUDE.md', version: 5, content: 'remote', locked_by: 1, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 },
      };
    }
    if (pathname === lockUrl('CLAUDE.md') && method === 'DELETE') {
      releaseHits++;
      return { status: 200, body: { released: true } };
    }
    if (pathname === docUrl('CLAUDE.md') && method === 'PUT') {
      putHits++;
      return { status: 200, body: { file_key: 'CLAUDE.md', version: 6 } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  // localVersion (5) matches the version the 3rd acquire attempt granted, so this exercises
  // the plain PUT path once the lease is finally held — not the placeholder/conflict paths.
  const result = await pushFile(serverUrl(srv), 'p', 'tok', 'CLAUDE.md', 'local content', 5, root, { lockWaitMs: 5000 });
  assert.deepStrictEqual(result, { version: 6, locked: true });
  assert.strictEqual(lockAttempts, 3, 'acquire retried through contention to success');
  assert.strictEqual(putHits, 1, 'PUT fired exactly once — no 409 lock_held ever reached it');
  assert.strictEqual(releaseHits, 1, 'lease released after the push');
});

test('pushFile: releases the lease in a finally block even when the PUT itself fails', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-lock-release-on-throw-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let releaseHits = 0;
  const srv = await startBodyServer((pathname, method) => {
    if (pathname === lockUrl('CLAUDE.md') && method === 'POST') {
      return {
        status: 200,
        body: { file_key: 'CLAUDE.md', version: 5, content: 'remote', locked_by: 1, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 },
      };
    }
    if (pathname === lockUrl('CLAUDE.md') && method === 'DELETE') {
      releaseHits++;
      return { status: 200, body: { released: true } };
    }
    if (pathname === docUrl('CLAUDE.md') && method === 'PUT') {
      return { status: 500, body: {} };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  await assert.rejects(
    () => pushFile(serverUrl(srv), 'p', 'tok', 'CLAUDE.md', 'local content', 5, root, {}),
    /HTTP 500/,
  );
  assert.strictEqual(releaseHits, 1, 'release must fire even though the PUT threw');
});

test('pushFile: a lock_held 409 on the PUT itself never falls into conflict merge — local file untouched', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-lock-put409-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  withEnv(t, 'TIPATASK_KB_LOCK', '0'); // skip acquire — exercise the PUT's own 409 branch directly

  fs.mkdirSync(path.join(root, 'ai', 'architecture'), { recursive: true });
  const filePath = path.join(root, 'ai/architecture/tt-foo.md');
  fs.writeFileSync(filePath, 'ORIGINAL LOCAL CONTENT\n', 'utf8');

  const srv = await startBodyServer((pathname, method) => {
    if (pathname === docUrl('ai/architecture/tt-foo.md') && method === 'PUT') {
      return {
        status: 409,
        body: { error: 'locked', lock_held: true, retry_after_seconds: 5, lock_expires_at: 'later', same_user: false, locked_by_email: 'bob@x.com' },
      };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  await assert.rejects(
    () => pushFile(serverUrl(srv), 'p', 'tok', 'ai/architecture/tt-foo.md', 'NEW CONTENT', 0, root, {}),
    (err) => { assert.strictEqual(err.lockHeld, true); return true; },
  );
  assert.strictEqual(
    fs.readFileSync(filePath, 'utf8'), 'ORIGINAL LOCAL CONTENT\n',
    'merge-local-diff must never run on a lock 409 — the local file must be untouched',
  );
});

test('pushFile: a fresh lock placeholder short-circuits conflict resolution — PUTs at version_hint 0, local file untouched', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-lock-placeholder-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const filePath = path.join(root, 'CLAUDE.md');
  fs.writeFileSync(filePath, 'LOCAL FILE UNTOUCHED\n', 'utf8');

  let putBody = null;
  const srv = await startBodyServer((pathname, method, body) => {
    if (pathname === lockUrl('CLAUDE.md') && method === 'POST') {
      // Placeholder — this file_key never existed server-side before this acquire.
      return {
        status: 200,
        body: { file_key: 'CLAUDE.md', version: 0, content: '', locked_by: 1, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 },
      };
    }
    if (pathname === docUrl('CLAUDE.md') && method === 'PUT') {
      putBody = body;
      return { status: 200, body: { file_key: 'CLAUDE.md', version: 1 } };
    }
    if (pathname === lockUrl('CLAUDE.md') && method === 'DELETE') {
      return { status: 200, body: { released: true } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  // localVersion=5 (a stale cache entry) diverges from the placeholder's version 0 — must
  // NOT be treated as a version conflict against empty content, or merge-local-diff would
  // overwrite the local file with ''.
  const result = await pushFile(serverUrl(srv), 'p', 'tok', 'CLAUDE.md', 'NEW LOCAL CONTENT', 5, root, {});
  assert.deepStrictEqual(result, { version: 1, locked: true });
  assert.deepStrictEqual(putBody, { content: 'NEW LOCAL CONTENT', version_hint: 0 });
  assert.strictEqual(
    fs.readFileSync(filePath, 'utf8'), 'LOCAL FILE UNTOUCHED\n',
    'the placeholder short-circuit never runs the merge-local-diff disk write',
  );
});

test('pushFile: PUT carries X-Tipatask-Instance, matching acquire\'s (C1221)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-lock-put-header-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let acquireInstance = null;
  let putInstance = null;
  const srv = await startBodyServer((pathname, method, body, headers) => {
    if (pathname === lockUrl('CLAUDE.md') && method === 'POST') {
      acquireInstance = headers['x-tipatask-instance'];
      return {
        status: 200,
        body: { file_key: 'CLAUDE.md', version: 5, content: 'remote', locked_by: 1, locked_instance: acquireInstance, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 },
      };
    }
    if (pathname === docUrl('CLAUDE.md') && method === 'PUT') {
      putInstance = headers['x-tipatask-instance'];
      return { status: 200, body: { file_key: 'CLAUDE.md', version: 6 } };
    }
    if (pathname === lockUrl('CLAUDE.md') && method === 'DELETE') {
      return { status: 200, body: { released: true } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  await pushFile(serverUrl(srv), 'p', 'tok', 'CLAUDE.md', 'local content', 5, root, { instanceId: 'probe-instance-a' });
  assert.strictEqual(acquireInstance, 'probe-instance-a');
  assert.strictEqual(putInstance, 'probe-instance-a', 'the PUT must carry the same instance id as the acquire — otherwise isSameHolder degrades to the per-user fallback on the write path');
});

test('pushFile: release forwards opts.instanceId, matching acquire\'s (C1221 — prevents a leaked lease)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-lock-release-instance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let acquireInstance = null;
  let releaseInstance = null;
  const srv = await startBodyServer((pathname, method, body, headers) => {
    if (pathname === lockUrl('CLAUDE.md') && method === 'POST') {
      acquireInstance = headers['x-tipatask-instance'];
      return {
        status: 200,
        body: { file_key: 'CLAUDE.md', version: 5, content: 'remote', locked_by: 1, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 },
      };
    }
    if (pathname === docUrl('CLAUDE.md') && method === 'PUT') {
      return { status: 200, body: { file_key: 'CLAUDE.md', version: 6 } };
    }
    if (pathname === lockUrl('CLAUDE.md') && method === 'DELETE') {
      releaseInstance = headers['x-tipatask-instance'];
      return { status: 200, body: { released: true } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  await pushFile(serverUrl(srv), 'p', 'tok', 'CLAUDE.md', 'local content', 5, root, { instanceId: 'probe-instance-a' });
  assert.strictEqual(acquireInstance, 'probe-instance-a');
  // Before this fix, the finally-block release fell back to this process's own module-level
  // INSTANCE_ID here instead of the impersonated 'probe-instance-a' — a mismatch the server
  // would reject as lockHeld, silently swallowed by pushFile's own .catch(()=>{}), leaking the
  // lease until its TTL.
  assert.strictEqual(releaseInstance, acquireInstance, 'release must use the SAME instance id the acquire used, or the release 409s and the lease leaks until TTL');
});

test('pushFile: a lock POST 404 (API predates C1104) still pushes, and reports locked:false', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-lock-fail-open-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let putHits = 0;
  const srv = await startBodyServer((pathname, method) => {
    if (pathname === lockUrl('CLAUDE.md') && method === 'POST') return { status: 404, body: { error: 'not found' } };
    if (pathname === docUrl('CLAUDE.md') && method === 'PUT') {
      putHits++;
      return { status: 200, body: { file_key: 'CLAUDE.md', version: 3 } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  // C1221 — this is the exact seam that made every `pushed` line in kb-autopush.log
  // ambiguous before `locked` existed: a push can succeed with zero lease taken.
  const result = await pushFile(serverUrl(srv), 'p', 'tok', 'CLAUDE.md', 'local content', 2, root, {});
  assert.deepStrictEqual(result, { version: 3, locked: false });
  assert.strictEqual(putHits, 1, 'the PUT still happens — a 404 on the lock route must never block the write');
});

test('pushFile: TIPATASK_KB_LOCK=0 skips the lock route entirely and sends no instance header on the PUT', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-lock-kill-switch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  withEnv(t, 'TIPATASK_KB_LOCK', '0');

  let lockHits = 0;
  let putHeaders = null;
  const srv = await startBodyServer((pathname, method, body, headers) => {
    if (pathname === lockUrl('CLAUDE.md')) { lockHits++; return { status: 200, body: {} }; }
    if (pathname === docUrl('CLAUDE.md') && method === 'PUT') {
      putHeaders = headers;
      return { status: 200, body: { file_key: 'CLAUDE.md', version: 3 } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  const result = await pushFile(serverUrl(srv), 'p', 'tok', 'CLAUDE.md', 'local content', 2, root, {});
  assert.deepStrictEqual(result, { version: 3, locked: false });
  assert.strictEqual(lockHits, 0, 'acquire/release must not fire at all under the kill switch');
  // C1221 — pins the restore-the-exact-pre-C1105-flow contract: the header must be gated on
  // lockingEnabled, or a same-user/different-instance PUT could still 409 even with the kill
  // switch on, defeating its purpose as a recovery path for a leaked lease.
  assert.strictEqual(putHeaders['x-tipatask-instance'], undefined, 'the kill switch must restore the EXACT pre-C1105 plain-PUT flow, including no instance header');
});

test('autoPushOnEdit: a lease held by someone else past the wait budget defers rather than fails', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-lock-autopush-defer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  withEnv(t, 'TASK_BACKEND', undefined);
  withEnv(t, 'TIPATASK_KB_AUTOPUSH_LOCK_WAIT_MS', '200'); // test seam — real default is 30s

  const filePath = path.join(root, 'CLAUDE.md');
  fs.writeFileSync(filePath, '# claude doc\n', 'utf8');

  const srv = await startBodyServer(() => ({
    status: 409,
    body: { error: 'locked', lock_held: true, retry_after_seconds: 0, lock_expires_at: 'later', same_user: false, locked_by_email: 'carol@x.com' },
  }));
  t.after(() => srv.close());
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: serverUrl(srv), API_TOKEN: 'tok', API_PROJECT_ID: 'p' });

  const res = await autoPushOnEdit(filePath, root);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.status, 'skipped-lock-held');
  assert.strictEqual(res.fileKey, 'CLAUDE.md');
  assert.deepStrictEqual(getLocalVersions(root), {}, 'version cache stays untouched so the next bulk sync retries the write');
});

test('autoPushOnEdit: surfaces locked:true on a pushed edit, and omits it on a dry-run (C1221)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-lock-autopush-locked-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  withEnv(t, 'TASK_BACKEND', undefined);

  const filePath = path.join(root, 'CLAUDE.md');
  fs.writeFileSync(filePath, '# claude doc\n', 'utf8');

  const srv = await startBodyServer((pathname, method) => {
    if (pathname === lockUrl('CLAUDE.md') && method === 'POST') {
      // version:0/content:'' — a fresh placeholder matching the empty local version cache
      // (this file has never been pushed before), so pushFile takes the plain-PUT path
      // rather than the local-wins conflict path (which would report status
      // 'conflict-overwrote-remote' instead of 'pushed' regardless of real content).
      return { status: 200, body: { file_key: 'CLAUDE.md', version: 0, content: '', locked_by: 1, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 } };
    }
    if (pathname === docUrl('CLAUDE.md') && method === 'PUT') {
      return { status: 200, body: { file_key: 'CLAUDE.md', version: 1 } };
    }
    if (pathname === lockUrl('CLAUDE.md') && method === 'DELETE') {
      return { status: 200, body: { released: true } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: serverUrl(srv), API_TOKEN: 'tok', API_PROJECT_ID: 'p' });

  const pushed = await autoPushOnEdit(filePath, root);
  assert.strictEqual(pushed.status, 'pushed');
  assert.strictEqual(pushed.locked, true, 'a real lease was taken for this push');

  // A dry-run never calls pushFile at all — locked must not appear (undefined), never a
  // stale/lying `false`.
  withEnv(t, 'TIPATASK_KB_AUTOPUSH', 'dry');
  fs.writeFileSync(filePath, '# claude doc v2\n', 'utf8');
  const dryRun = await autoPushOnEdit(filePath, root);
  assert.strictEqual(dryRun.status, 'dry-run');
  assert.strictEqual(dryRun.locked, undefined);
});

// ── C1220 — conflict records ──

function conflictsUrl() { return '/api/projects/p/knowledge-conflicts'; }

test('pushFile local-wins over genuinely diverged content POSTs the pre-overwrite copy as a conflict record', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-conflict-record-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fileKey = 'ai/architecture/tt-conflict-test.md';
  const filePath = path.join(root, fileKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const localContent = 'our own new edit, about to win locally';
  fs.writeFileSync(filePath, localContent, 'utf8');

  // Seed the cache as if we'd previously synced at v1 with THIS content — so the current
  // remote content (below) reads as a genuine divergence, not just version drift.
  const priorRemoteContent = 'old remote content, what we last synced';
  saveLocalVersions(root, { [fileKey]: { version: 1, hash: sha256(priorRemoteContent) } });
  const currentRemoteContent = 'someone else genuinely changed this since our last sync';

  let conflictPostBody = null;
  const srv = await startBodyServer((pathname, method, body) => {
    if (pathname === lockUrl(fileKey) && method === 'POST') {
      return { status: 200, body: { file_key: fileKey, version: 2, content: currentRemoteContent, locked_by: 1, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 } };
    }
    if (pathname === docUrl(fileKey) && method === 'PUT') {
      return { status: 200, body: { file_key: fileKey, version: 3 } };
    }
    if (pathname === conflictsUrl() && method === 'POST') {
      conflictPostBody = body;
      return { status: 201, body: { id: 42, file_key: fileKey, overwritten_version: body.overwritten_version, created_at: '2026-01-01T00:00:00.000Z', recorded: true } };
    }
    if (pathname === lockUrl(fileKey) && method === 'DELETE') {
      return { status: 200, body: { released: true } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  const result = await pushFile(serverUrl(srv), 'p', 'tok', fileKey, localContent, 1, root, { onConflict: 'local-wins', preserveRemoteOnConflict: true });

  assert.strictEqual(result.version, 3);
  assert.strictEqual(result.remoteDiverged, true);
  assert.strictEqual(result.conflictRecorded, true);
  assert.strictEqual(result.conflictRecordId, 42);
  assert.ok(conflictPostBody, 'a conflict record POST was made');
  assert.strictEqual(conflictPostBody.file_key, fileKey);
  assert.strictEqual(conflictPostBody.overwritten_content, currentRemoteContent, 'the record captures the content that WAS about to be destroyed');
  assert.strictEqual(conflictPostBody.overwritten_version, 2);
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), localContent, 'local-wins never touches the local file');
});

test('pushFile: a never-synced file (no cached hash) still records what it overwrites', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-conflict-neversynced-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fileKey = 'ai/architecture/tt-conflict-neversynced.md';
  const localContent = 'pushed with zero prior sync history for this file';
  const currentRemoteContent = 'remote content this machine never pulled';

  let conflictPostBody = null;
  const srv = await startBodyServer((pathname, method, body) => {
    if (pathname === lockUrl(fileKey) && method === 'POST') {
      return { status: 200, body: { file_key: fileKey, version: 1, content: currentRemoteContent, locked_by: 1, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 } };
    }
    if (pathname === docUrl(fileKey) && method === 'PUT') {
      return { status: 200, body: { file_key: fileKey, version: 2 } };
    }
    if (pathname === conflictsUrl() && method === 'POST') {
      conflictPostBody = body;
      return { status: 201, body: { id: 7, recorded: true } };
    }
    if (pathname === lockUrl(fileKey) && method === 'DELETE') {
      return { status: 200, body: { released: true } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  // getLocalVersions(root) is {} — no cache entry at all for this fileKey, so
  // readEntry(...).hash is null and remoteDiverged (which needs priorHash != null) can only
  // ever be false. The broader record gate doesn't need a prior hash to fire.
  const result = await pushFile(serverUrl(srv), 'p', 'tok', fileKey, localContent, 0, root, { onConflict: 'local-wins', preserveRemoteOnConflict: true });

  assert.strictEqual(result.remoteDiverged, false, 'no cached hash to compare against');
  assert.strictEqual(result.conflictRecorded, true, 'the broader gate records anyway');
  assert.ok(conflictPostBody);
  assert.strictEqual(conflictPostBody.overwritten_content, currentRemoteContent);
});

test('pushFile: pure version drift (remote content unchanged) never POSTs a conflict record', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-conflict-drift-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fileKey = 'ai/architecture/tt-conflict-drift.md';
  const sharedContent = 'content that is identical locally and remotely';
  saveLocalVersions(root, { [fileKey]: { version: 1, hash: sha256(sharedContent) } });

  let conflictPostHits = 0;
  const srv = await startBodyServer((pathname, method) => {
    if (pathname === lockUrl(fileKey) && method === 'POST') {
      // Some other push bumped the version without changing content.
      return { status: 200, body: { file_key: fileKey, version: 2, content: sharedContent, locked_by: 1, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 } };
    }
    if (pathname === docUrl(fileKey) && method === 'PUT') {
      return { status: 200, body: { file_key: fileKey, version: 3 } };
    }
    if (pathname === conflictsUrl() && method === 'POST') {
      conflictPostHits++;
      return { status: 201, body: { id: 99, recorded: true } };
    }
    if (pathname === lockUrl(fileKey) && method === 'DELETE') {
      return { status: 200, body: { released: true } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  const result = await pushFile(serverUrl(srv), 'p', 'tok', fileKey, sharedContent, 1, root, { onConflict: 'local-wins', preserveRemoteOnConflict: true });

  assert.strictEqual(result.remoteDiverged, false);
  assert.strictEqual(result.conflictRecorded, false, 'identical content is version drift, not a real conflict');
  assert.strictEqual(conflictPostHits, 0, 'no conflict-record POST for pure version drift');
});

test('pushFile: a failing conflict-record POST never fails the push itself', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-conflict-record-fails-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fileKey = 'ai/architecture/tt-conflict-record-fails.md';
  const priorRemoteContent = 'old remote content';
  saveLocalVersions(root, { [fileKey]: { version: 1, hash: sha256(priorRemoteContent) } });
  const currentRemoteContent = 'genuinely different remote content';
  const localContent = 'our local edit';

  const srv = await startBodyServer((pathname, method) => {
    if (pathname === lockUrl(fileKey) && method === 'POST') {
      return { status: 200, body: { file_key: fileKey, version: 2, content: currentRemoteContent, locked_by: 1, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 } };
    }
    if (pathname === docUrl(fileKey) && method === 'PUT') {
      return { status: 200, body: { file_key: fileKey, version: 3 } };
    }
    if (pathname === conflictsUrl() && method === 'POST') {
      return { status: 500, body: { error: 'db exploded' } };
    }
    if (pathname === lockUrl(fileKey) && method === 'DELETE') {
      return { status: 200, body: { released: true } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  const result = await pushFile(serverUrl(srv), 'p', 'tok', fileKey, localContent, 1, root, { onConflict: 'local-wins', preserveRemoteOnConflict: true });

  assert.strictEqual(result.version, 3, 'the push itself still succeeds');
  assert.strictEqual(result.conflictRecorded, false);
  assert.strictEqual(result.conflictRecordId, null);
});

test('checkKnowledgeConflicts filters out records this process authored itself and advances its marker', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-conflict-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let listCallCount = 0;
  const conflictsPayload = {
    conflicts: [
      { id: 1, file_key: 'a.md', overwritten_version: 1, overwritten_instance: INSTANCE_ID, created_at: '2026-01-01T00:00:00.000Z', content_bytes: 10, overwritten_by: null },
      { id: 2, file_key: 'b.md', overwritten_version: 1, overwritten_instance: 'someone-elses-machine', created_at: '2026-01-01T00:00:01.000Z', content_bytes: 10, overwritten_by: null },
    ],
    total: 2, limit: 200, offset: 0,
  };

  const srv = await startBodyServer((pathname, method) => {
    if (pathname === conflictsUrl() && method === 'GET') {
      listCallCount++;
      return { status: 200, body: conflictsPayload };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  const first = await checkKnowledgeConflicts(serverUrl(srv), 'p', 'tok', root);
  assert.deepStrictEqual(first, [], 'first-ever call for a root reports nothing, even though the server already has records');
  assert.strictEqual(listCallCount, 1);

  const marker = JSON.parse(fs.readFileSync(path.join(root, '.tipatask', 'kb-conflicts-seen.json'), 'utf8'));
  assert.strictEqual(marker.lastCheckedAt, '2026-01-01T00:00:01.000Z', 'marker advances to the max created_at seen');

  const second = await checkKnowledgeConflicts(serverUrl(srv), 'p', 'tok', root);
  assert.strictEqual(listCallCount, 2);
  assert.strictEqual(second.length, 1, 'only the foreign-instance record is reported — id 1 is this process\'s own');
  assert.strictEqual(second[0].id, 2);
});

// ── C1323 — project-open sync + concurrency ──
// Gaps left by the tests above: the C1062 latch test never forces two syncs to actually
// overlap in flight, nothing exercises same-root coalescing through the public
// syncProjectKb() entry point (the shape two Electron windows on one project actually hit),
// and the "Known gap" the arch doc calls out — no in-process mutex on two concurrent
// pushFile() calls racing one file_key — is asserted nowhere. __resetSyncState is a
// TEST-ONLY seam (see knowledge-sync.js) that clears the process-local single-flight state
// so a case can re-run the same rootPath without a settled promise leaking into the next one.

test('two different roots sync independently even when their pulls genuinely overlap in flight', async (t) => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-overlap-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-overlap-b-'));
  t.after(() => {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });
  withEnv(t, 'TASK_BACKEND', undefined);

  let releaseA;
  const aHeld = new Promise((res) => { releaseA = res; });
  let bArrivedWhileAHeld = false;

  // startBodyServer's handler may be async — used here (with no body needed) purely to hold
  // root A's list response open until root B's own list call has actually reached the server.
  const srv = await startBodyServer(async (pathname) => {
    if (pathname === '/api/projects/pA/knowledge') {
      await aHeld;
      return { status: 200, body: { files: [{ file_key: 'AGENTS.md', version: 1 }] } };
    }
    if (pathname === '/api/projects/pA/knowledge/AGENTS.md') {
      return { status: 200, body: { content: 'a-content\n', version: 1 } };
    }
    if (pathname === '/api/projects/pB/knowledge') {
      bArrivedWhileAHeld = true;
      releaseA();
      return { status: 200, body: { files: [{ file_key: 'CLAUDE.md', version: 1 }] } };
    }
    if (pathname === '/api/projects/pB/knowledge/CLAUDE.md') {
      return { status: 200, body: { content: 'b-content\n', version: 1 } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());
  const baseUrl = serverUrl(srv);
  writeConfig(rootA, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'pA' });
  writeConfig(rootB, { TASK_BACKEND: 'api', API_BASE_URL: baseUrl, API_TOKEN: 'tok', API_PROJECT_ID: 'pB' });

  const [resA, resB] = await Promise.all([
    syncProjectKb(rootA, 'test-overlap-a'),
    syncProjectKb(rootB, 'test-overlap-b'),
  ]);

  assert.strictEqual(bArrivedWhileAHeld, true, 'B\'s request reached the server while A\'s was still held open — genuine overlap, not serialization');
  assert.strictEqual(resA.status, 'synced');
  assert.deepStrictEqual(resA.pulledKeys, ['AGENTS.md']);
  assert.strictEqual(fs.readFileSync(path.join(rootA, 'AGENTS.md'), 'utf8'), 'a-content\n');
  assert.strictEqual(resB.status, 'synced');
  assert.deepStrictEqual(resB.pulledKeys, ['CLAUDE.md']);
  assert.strictEqual(fs.readFileSync(path.join(rootB, 'CLAUDE.md'), 'utf8'), 'b-content\n');
});

test('syncProjectKb: N concurrent calls for the SAME root coalesce to one GET, and the latch re-arms after __resetSyncState', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-coalesce-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  withEnv(t, 'TASK_BACKEND', undefined);

  let listHits = 0;
  const srv = await startServer((pathname) => {
    if (pathname === '/api/projects/p7/knowledge') { listHits++; return { status: 200, body: { files: [] } }; }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());
  writeConfig(root, { TASK_BACKEND: 'api', API_BASE_URL: serverUrl(srv), API_TOKEN: 'tok', API_PROJECT_ID: 'p7' });

  // Same shape as two Electron windows binding one project (main/window-state.js) — each
  // bind calls syncProjectKb independently, with no coordination above this layer.
  const results = await Promise.all([
    syncProjectKb(root, 'window-bind-1'),
    syncProjectKb(root, 'window-bind-2'),
    syncProjectKb(root, 'window-bind-3'),
  ]);
  assert.strictEqual(listHits, 1, 'three concurrent binds to the same project produced exactly one remote-versions fetch');
  for (const r of results) assert.deepStrictEqual(r, results[0]);

  __resetSyncState(root);
  const again = await syncProjectKb(root, 'window-bind-4');
  assert.strictEqual(listHits, 2, 'after a reset the same root syncs again — the latch suppressed the extras, it did not permanently one-shot the root');
  assert.strictEqual(again.status, 'synced');
});

test('pushFile: a lease held by another instance blocks the PUT, and the retrying waiter wins once it\'s released', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-lock-waiter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let held = true;
  let putHits = 0;
  let acquireAttemptsWhileHeld = 0;
  const srv = await startBodyServer((pathname, method, body, headers) => {
    const instance = headers['x-tipatask-instance'];
    if (pathname === lockUrl('CLAUDE.md') && method === 'POST') {
      if (held) {
        acquireAttemptsWhileHeld++;
        return { status: 409, body: { error: 'locked', lock_held: true, retry_after_seconds: 0, lock_expires_at: 'later', same_user: true } };
      }
      return {
        status: 200,
        body: { file_key: 'CLAUDE.md', version: 5, content: 'remote', locked_by: 1, locked_instance: instance, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 },
      };
    }
    if (pathname === lockUrl('CLAUDE.md') && method === 'DELETE') {
      return { status: 200, body: { released: true } };
    }
    if (pathname === docUrl('CLAUDE.md') && method === 'PUT') {
      putHits++;
      return { status: 200, body: { file_key: 'CLAUDE.md', version: 6 } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  // B tries with no wait budget while A holds it — rejects immediately, no PUT ever reaches
  // the server.
  await assert.rejects(
    () => pushFile(serverUrl(srv), 'p', 'tok', 'CLAUDE.md', 'attempt', 5, root, { instanceId: 'instance-b', lockWaitMs: 0 }),
    (err) => { assert.strictEqual(err.lockHeld, true); return true; },
  );
  assert.strictEqual(putHits, 0, 'no PUT reached the server while the lease was held');
  assert.strictEqual(acquireAttemptsWhileHeld, 1);

  // B retries with a real wait budget while genuinely racing A's release: the retry loop's
  // jittered backoff floors at 500ms (retry_after_seconds:0 clamps up to it), which gives real
  // wall-clock room for the release below to land mid-wait rather than before B even starts.
  const waiterPromise = pushFile(serverUrl(srv), 'p', 'tok', 'CLAUDE.md', 'attempt-2', 5, root, { instanceId: 'instance-b', lockWaitMs: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  held = false; // A releases while B is mid-retry-loop

  const result = await waiterPromise;
  assert.deepStrictEqual(result, { version: 6, locked: true });
  assert.strictEqual(putHits, 1);
});

test('pushFile: two concurrent calls on the SAME file_key in one process both PUT — the documented in-process gap, pinned as real behavior', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-lock-same-key-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let acquireCount = 0;
  let putHits = 0;
  const srv = await startBodyServer((pathname, method) => {
    if (pathname === lockUrl('CLAUDE.md') && method === 'POST') {
      acquireCount++;
      // Same-instance acquire always renews rather than blocking (probe-kb-lock.js step 3:
      // "re-acquiring with the SAME instance id must renew, not 409") — both of these calls
      // default to this process's own INSTANCE_ID, so the server has no basis to tell them
      // apart. This IS the arch doc's "Known gap": nothing in pushFile mutexes two truly
      // concurrent calls racing one file_key inside one process.
      return {
        status: 200,
        body: { file_key: 'CLAUDE.md', version: 5, content: 'remote', locked_by: 1, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 },
      };
    }
    if (pathname === lockUrl('CLAUDE.md') && method === 'DELETE') {
      return { status: 200, body: { released: true } };
    }
    if (pathname === docUrl('CLAUDE.md') && method === 'PUT') {
      putHits++;
      return { status: 200, body: { file_key: 'CLAUDE.md', version: 5 + putHits } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  await Promise.all([
    pushFile(serverUrl(srv), 'p', 'tok', 'CLAUDE.md', 'content-1', 5, root, {}),
    pushFile(serverUrl(srv), 'p', 'tok', 'CLAUDE.md', 'content-2', 5, root, {}),
  ]);

  assert.strictEqual(acquireCount, 2, 'both calls independently acquired — same-instance acquire never blocks');
  assert.strictEqual(putHits, 2, 'both PUTs landed — nothing in-process serializes two concurrent pushFile calls on one key (accepted gap, see tt-knowledge-sync.md)');
});

test('pushFile: concurrent pushes on different file_keys under one root both persist in the version cache (no lost update)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-cache-rmw-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const srv = await startBodyServer((pathname, method) => {
    for (const key of ['a.md', 'b.md']) {
      if (pathname === lockUrl(key) && method === 'POST') {
        return { status: 200, body: { file_key: key, version: 1, content: 'remote', locked_by: 1, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 } };
      }
      if (pathname === lockUrl(key) && method === 'DELETE') return { status: 200, body: { released: true } };
      if (pathname === docUrl(key) && method === 'PUT') return { status: 200, body: { file_key: key, version: 2 } };
    }
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  await Promise.all([
    pushFile(serverUrl(srv), 'p', 'tok', 'a.md', 'content-a', 1, root, {}),
    pushFile(serverUrl(srv), 'p', 'tok', 'b.md', 'content-b', 1, root, {}),
  ]);

  // recordPushed's read-modify-write of knowledge-versions.json is fully synchronous once
  // called, so two concurrent pushFile calls interleaving at their network-I/O await points
  // can never tear each other's write — this pins that invariant.
  const cache = getLocalVersions(root);
  assert.strictEqual(cache['a.md'].version, 2, 'a.md\'s push was not lost to a concurrent read-modify-write on the shared cache file');
  assert.strictEqual(cache['b.md'].version, 2, 'b.md\'s push was not lost either');
});

test('pushFile: a corrupt local version cache fails soft — push still succeeds and rewrites a clean cache', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-kb-cache-corrupt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
  // Simulates the torn-read scenario knowledge-sync.js's own saveLocalVersions comment
  // documents: one autopush hook process racing the forked server on this same file.
  fs.writeFileSync(path.join(root, '.tipatask', 'knowledge-versions.json'), '{not valid json', 'utf8');

  const srv = await startBodyServer((pathname, method) => {
    if (pathname === lockUrl('CLAUDE.md') && method === 'POST') {
      return { status: 200, body: { file_key: 'CLAUDE.md', version: 5, content: 'remote', locked_by: 1, locked_at: 'now', lock_expires_at: 'later', ttl_seconds: 600 } };
    }
    if (pathname === lockUrl('CLAUDE.md') && method === 'DELETE') return { status: 200, body: { released: true } };
    if (pathname === docUrl('CLAUDE.md') && method === 'PUT') return { status: 200, body: { file_key: 'CLAUDE.md', version: 6 } };
    return { status: 404, body: {} };
  });
  t.after(() => srv.close());

  assert.deepStrictEqual(getLocalVersions(root), {}, 'a corrupt cache read returns {} (its catch) rather than throwing');

  const result = await pushFile(serverUrl(srv), 'p', 'tok', 'CLAUDE.md', 'content', 0, root, {});
  assert.deepStrictEqual(result, { version: 6, locked: true });
  assert.strictEqual(getLocalVersions(root)['CLAUDE.md'].version, 6, 'the cache is rewritten clean after a successful push');
});
