'use strict';

// C1337 — unit tests for boot-kb-sync.js's fireBootKbSync(): the server-boot chain that
// replaced index.js's bare fireAutoReindexWithBroadcast call. Extracted specifically so it
// could be tested without requiring index.js (which stands up a real HTTP server).
//
// sync/reindex/invalidateArchForKeys are all injectable DI params on fireBootKbSync
// itself, so these tests pass mocks directly rather than monkeypatching module exports
// (contrast kb-auto-reindex.test.js's patch() helper, needed there because that function
// has no such seams).

const { test } = require('node:test');
const assert = require('node:assert');

const { fireBootKbSync, resolveBootKbRoot } = require('./boot-kb-sync');

function mockConfig(overrides) {
  return { PROJECT_ROOT: '/guessed/bundle/path', BOUND_PROJECT_ROOT: null, SERVER_ROOT: '/dev/server', ...overrides };
}

test('resolveBootKbRoot: a genuinely bound root always wins, asar or not', () => {
  assert.strictEqual(
    resolveBootKbRoot(mockConfig({ BOUND_PROJECT_ROOT: '/real/project', SERVER_ROOT: '/app.asar' })),
    '/real/project',
  );
});

test('resolveBootKbRoot: nothing bound + dev (non-asar) SERVER_ROOT falls back to the PROJECT_ROOT guess', () => {
  assert.strictEqual(
    resolveBootKbRoot(mockConfig({ BOUND_PROJECT_ROOT: null, SERVER_ROOT: '/Users/dev/repo/ai/todo/server' })),
    '/guessed/bundle/path',
  );
});

test('resolveBootKbRoot: nothing bound + packaged (asar) SERVER_ROOT resolves to null — never guesses into the bundle', () => {
  assert.strictEqual(
    resolveBootKbRoot(mockConfig({ BOUND_PROJECT_ROOT: null, SERVER_ROOT: '/Applications/TipATask.app/Contents/Resources/app.asar' })),
    null,
  );
});

test('fireBootKbSync: bound root — pull runs with {push:true}, re-index chained after', async () => {
  const order = [];
  const config = mockConfig({ BOUND_PROJECT_ROOT: '/real/project' });
  const backend = { marker: 'backend' };

  const sync = async (rootPath, label, opts) => {
    order.push('sync');
    assert.strictEqual(rootPath, '/real/project');
    assert.strictEqual(label, 'boot');
    assert.deepStrictEqual(opts, { push: true });
    return { ok: true, status: 'synced', pulledCount: 1, pulledKeys: ['ai/architecture/tt-x.md'], pushed: ['CLAUDE.md'], pushSkipped: [] };
  };
  const invalidateArchForKeys = (keys, rootPath) => {
    order.push('invalidate');
    assert.deepStrictEqual(keys, ['ai/architecture/tt-x.md']);
    assert.strictEqual(rootPath, '/real/project');
  };
  const reindex = async (opts) => {
    order.push('reindex');
    assert.strictEqual(opts.rootPath, '/real/project');
    assert.strictEqual(opts.projectPath, '/real/project');
    assert.strictEqual(opts.backend, backend);
    assert.strictEqual(opts.label, 'boot');
    return { ok: true, status: 'clean' };
  };

  const res = await fireBootKbSync({ config, backend, sync, reindex, invalidateArchForKeys });

  assert.deepStrictEqual(order, ['sync', 'invalidate', 'reindex'], 'pull must resolve, then cache-bust, then re-index — never the other order');
  assert.strictEqual(res.rootPath, '/real/project');
  assert.strictEqual(res.status, 'synced');
  assert.strictEqual(res.pulledCount, 1);
  assert.deepStrictEqual(res.pushed, ['CLAUDE.md']);
});

test('fireBootKbSync: no bound root, packaged SERVER_ROOT — sync is never called, re-index still fires with a null root', async () => {
  const config = mockConfig({ BOUND_PROJECT_ROOT: null, SERVER_ROOT: '/Applications/TipATask.app/Contents/Resources/app.asar' });
  const backend = {};
  let syncCalls = 0;
  let invalidateCalls = 0;
  const reindexCalls = [];

  const sync = async () => { syncCalls++; return { ok: true, status: 'synced' }; };
  const invalidateArchForKeys = () => { invalidateCalls++; };
  const reindex = async (opts) => { reindexCalls.push(opts); return { ok: true, status: 'skipped-no-root' }; };

  const res = await fireBootKbSync({ config, backend, sync, reindex, invalidateArchForKeys });

  assert.strictEqual(syncCalls, 0, 'must never pull into a guessed/bundle root');
  assert.strictEqual(invalidateCalls, 0);
  assert.strictEqual(reindexCalls.length, 1, 're-index still fires (its own guard ladder handles a null root)');
  assert.strictEqual(reindexCalls[0].rootPath, null);
  assert.strictEqual(res.rootPath, null);
  assert.strictEqual(res.status, 'skipped-no-root');
});

test('fireBootKbSync: a skipped-no-creds pull never invalidates the cache, still chains the re-index', async () => {
  const config = mockConfig({ BOUND_PROJECT_ROOT: '/real/project' });
  let invalidateCalls = 0;
  const reindexCalls = [];

  const sync = async () => ({ ok: true, status: 'skipped-no-creds' });
  const invalidateArchForKeys = () => { invalidateCalls++; };
  const reindex = async (opts) => { reindexCalls.push(opts); return { ok: true, status: 'skipped-no-creds' }; };

  const res = await fireBootKbSync({ config, backend: {}, sync, reindex, invalidateArchForKeys });

  assert.strictEqual(invalidateCalls, 0, 'no pulledKeys on a skip — nothing to invalidate');
  assert.strictEqual(reindexCalls.length, 1);
  assert.strictEqual(res.status, 'skipped-no-creds');
});

test('fireBootKbSync: a throwing sync never escapes — helper still resolves, re-index still fires', async () => {
  const config = mockConfig({ BOUND_PROJECT_ROOT: '/real/project' });
  const reindexCalls = [];

  const sync = async () => { throw new Error('transport blew up'); };
  const reindex = async (opts) => { reindexCalls.push(opts); return { ok: true, status: 'clean' }; };

  const res = await fireBootKbSync({ config, backend: {}, sync, reindex, invalidateArchForKeys: () => {} });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 'error');
  assert.match(res.message, /transport blew up/);
  assert.strictEqual(reindexCalls.length, 1, 'a broken pull must not block the re-index');
});

test('fireBootKbSync: a throwing/rejecting re-index never escapes either', async () => {
  const config = mockConfig({ BOUND_PROJECT_ROOT: '/real/project' });
  const sync = async () => ({ ok: true, status: 'synced', pulledCount: 0, pulledKeys: [] });
  const reindex = async () => { throw new Error('reindex blew up'); };

  await assert.doesNotReject(fireBootKbSync({ config, backend: {}, sync, reindex, invalidateArchForKeys: () => {} }));
});
