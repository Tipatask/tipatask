'use strict';

// C1230 — unit tests for kb-auto-reindex.js's fireAutoReindexWithBroadcast() force-once
// routing: never-indexed → forceReindexOnStartup path; already-indexed → the ordinary
// fireAutoReindex path unchanged; TIPATASK_KB_AUTOREINDEX kill switch still honored even
// though forceReindexOnStartup itself calls fireAutoReindex with manual:true (which
// bypasses that switch internally — the switch must be re-checked one layer up here).
//
// kb-reindex.js/knowledge-sync.js/websocket.js are all require()'d LAZILY inside
// fireAutoReindexWithBroadcast (module-load cycle avoidance, same pattern as the rest of
// this file's siblings) — so requiring them once here and monkeypatching an exported
// function reference is picked up on the next call, no mocking library needed. Every test
// restores what it patched in t.after().

const { test } = require('node:test');
const assert = require('node:assert');

const kbReindex = require('./kb-reindex');
const knowledgeSync = require('../cli/knowledge-sync');
const websocket = require('./websocket');
const { fireAutoReindexWithBroadcast } = require('./kb-auto-reindex');

function patch(obj, key, fn) {
  const orig = obj[key];
  obj[key] = fn;
  return () => { obj[key] = orig; };
}

function withEnv(t, key, value) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; });
}

test('fireAutoReindexWithBroadcast: never-indexed routes through forceReindexOnStartup, forwards forced:true, broadcasts the result', async (t) => {
  withEnv(t, 'TIPATASK_KB_AUTOREINDEX', undefined);
  const forceCalls = [];
  const onStartFrames = [];
  const resultFrames = [];

  t.after(patch(kbReindex, 'hasNeverBeenReindexed', async () => true));
  t.after(patch(kbReindex, 'forceReindexOnStartup', async (opts) => {
    forceCalls.push(opts);
    opts.onStart({ tagCount: 0, fileCount: 0, staleCount: 0 });
    opts.onProgress({ phase: 'analyze', done: 1, total: 1 });
    return { status: 'ran', ok: true, stamped: true, result: { tagsUpdated: 2, filesUpdated: 1, skipped: 0, errors: [] } };
  }));
  t.after(patch(websocket, 'broadcastToProject', (to, type, payload) => {
    if (type === 'reindex-kb-auto') onStartFrames.push(payload);
  }));
  t.after(patch(websocket, 'broadcastKbReindexResult', (to, payload) => {
    resultFrames.push({ to, ...payload });
  }));
  // Never called in this test — proves the ordinary path is fully bypassed.
  t.after(patch(knowledgeSync, 'fireAutoReindex', async () => { throw new Error('fireAutoReindex must not be called on the force-once path'); }));

  const res = await fireAutoReindexWithBroadcast({ rootPath: '/r', projectPath: '/p', backend: {}, label: 'boot' });

  assert.strictEqual(forceCalls.length, 1);
  assert.strictEqual(forceCalls[0].label, 'boot+force-once');
  assert.strictEqual(forceCalls[0].rootPath, '/r');
  assert.strictEqual(onStartFrames.length, 1);
  assert.strictEqual(onStartFrames[0].forced, true, 'client needs forced:true to avoid the misleading "found 0 stale" copy');
  assert.strictEqual(onStartFrames[0].label, 'boot+force-once');
  assert.strictEqual(resultFrames.length, 1);
  assert.strictEqual(resultFrames[0].to, '/p');
  assert.strictEqual(resultFrames[0].tagsUpdated, 2);
  assert.strictEqual(resultFrames[0].filesUpdated, 1);
  assert.strictEqual(res.status, 'ran');
  assert.strictEqual(res.stamped, true);
});

test('fireAutoReindexWithBroadcast: already-indexed uses the ordinary fireAutoReindex path, never touches forceReindexOnStartup', async (t) => {
  withEnv(t, 'TIPATASK_KB_AUTOREINDEX', undefined);
  const autoCalls = [];

  t.after(patch(kbReindex, 'hasNeverBeenReindexed', async () => false));
  t.after(patch(kbReindex, 'forceReindexOnStartup', async () => { throw new Error('forceReindexOnStartup must not be called when already indexed'); }));
  t.after(patch(knowledgeSync, 'fireAutoReindex', async (rootPath, label, opts) => {
    autoCalls.push({ rootPath, label, opts });
    return { ok: true, status: 'clean', tagCount: 0, fileCount: 0, staleCount: 0 };
  }));

  const res = await fireAutoReindexWithBroadcast({ rootPath: '/r', projectPath: '/p', backend: {}, label: 'ws' });

  assert.strictEqual(autoCalls.length, 1);
  assert.strictEqual(autoCalls[0].label, 'ws', 'unforced label must be untouched — no "+force-once" suffix');
  assert.strictEqual(res.status, 'clean');
});

test('fireAutoReindexWithBroadcast: TIPATASK_KB_AUTOREINDEX=0 skips force-once even for a never-indexed project, without calling hasNeverBeenReindexed at all', async (t) => {
  withEnv(t, 'TIPATASK_KB_AUTOREINDEX', '0');
  const hasNeverCalls = [];
  const autoCalls = [];

  // forceReindexOnStartup's own fireAutoReindex(manual:true) call bypasses this kill
  // switch internally (the switch check inside fireAutoReindex is itself gated `!manual`)
  // — this test proves kb-auto-reindex.js re-checks it BEFORE even asking whether the
  // project was ever indexed, so a never-indexed project still gets skipped-disabled.
  t.after(patch(kbReindex, 'hasNeverBeenReindexed', async () => { hasNeverCalls.push(1); return true; }));
  t.after(patch(kbReindex, 'forceReindexOnStartup', async () => { throw new Error('must not be called — kill switch'); }));
  t.after(patch(knowledgeSync, 'fireAutoReindex', async (rootPath, label) => {
    autoCalls.push(label);
    return { ok: true, status: 'skipped-disabled' };
  }));

  const res = await fireAutoReindexWithBroadcast({ rootPath: '/r', projectPath: '/p', backend: {}, label: 'spawn' });

  assert.strictEqual(hasNeverCalls.length, 0, 'the kill switch must short-circuit before the hasNeverBeenReindexed GET');
  assert.strictEqual(autoCalls.length, 1);
  assert.strictEqual(autoCalls[0], 'spawn');
  assert.strictEqual(res.status, 'skipped-disabled');
});

test('fireAutoReindexWithBroadcast: a throwing hasNeverBeenReindexed fails closed to the ordinary path (never crashes a trigger)', async (t) => {
  withEnv(t, 'TIPATASK_KB_AUTOREINDEX', undefined);
  const autoCalls = [];

  t.after(patch(kbReindex, 'hasNeverBeenReindexed', async () => { throw new Error('network blip'); }));
  t.after(patch(kbReindex, 'forceReindexOnStartup', async () => { throw new Error('must not be called'); }));
  t.after(patch(knowledgeSync, 'fireAutoReindex', async (rootPath, label) => { autoCalls.push(label); return { ok: true, status: 'clean' }; }));

  const res = await fireAutoReindexWithBroadcast({ rootPath: '/r', projectPath: '/p', backend: {}, label: 'ws' });

  assert.strictEqual(autoCalls.length, 1);
  assert.strictEqual(res.status, 'clean');
});
