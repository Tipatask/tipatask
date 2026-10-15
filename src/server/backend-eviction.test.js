'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBackendEvictor, BACKEND_IDLE_EVICT_MS } = require('./backend-eviction');

function stubBackend({ pending = 0 } = {}) {
  const b = { pending, disposed: 0, getPendingMutationCount: () => b.pending, dispose() { b.disposed++; } };
  return b;
}

// Registry + evictor with a hand-driven clock. `inUse` holds the project paths isInUse() reports.
function harness({ idleMs = 1000 } = {}) {
  const registry = new Map();
  const inUse = new Set();
  const clock = { t: 0 };
  const evicted = [];
  const evictor = createBackendEvictor({
    entries: () => registry,
    isInUse: p => inUse.has(p),
    evict: (p, b) => { evicted.push(p); b.dispose(); registry.delete(p); },
    idleMs,
    now: () => clock.t,
    warn: () => {},
  });
  const add = (p, b = stubBackend()) => { registry.set(p, b); evictor.touch(p); return b; };
  return { registry, inUse, clock, evicted, evictor, add };
}

test('default idle window is five minutes', () => {
  assert.equal(BACKEND_IDLE_EVICT_MS, 5 * 60_000);
});

test('an idle backend is released once the idle window has passed', () => {
  const h = harness();
  const b = h.add('/p/A');
  h.clock.t = 999;
  assert.deepEqual(h.evictor.sweep(), [], 'still inside the idle window');
  h.clock.t = 1000;
  assert.deepEqual(h.evictor.sweep(), ['/p/A']);
  assert.equal(b.disposed, 1);
  assert.equal(h.registry.has('/p/A'), false);
});

test('a backend with pending writes is kept, and its idle clock restarts after the drain', () => {
  const h = harness();
  const b = h.add('/p/A', stubBackend({ pending: 2 }));
  h.clock.t = 50_000;
  assert.deepEqual(h.evictor.sweep(), []);
  assert.equal(b.disposed, 0);
  b.pending = 0; // reconnect drained the queue
  h.clock.t = 50_500;
  assert.deepEqual(h.evictor.sweep(), [], 'idle clock counts from the last sweep that saw the queue non-empty');
  h.clock.t = 51_000;
  assert.deepEqual(h.evictor.sweep(), ['/p/A']);
});

test('a backend whose project is in use (window, session, merge job) is kept', () => {
  const h = harness();
  const b = h.add('/p/A');
  h.inUse.add('/p/A');
  h.clock.t = 10_000;
  assert.deepEqual(h.evictor.sweep(), []);
  h.inUse.delete('/p/A'); // window closed / session ended
  h.clock.t = 10_999;
  assert.deepEqual(h.evictor.sweep(), []);
  h.clock.t = 11_000;
  assert.deepEqual(h.evictor.sweep(), ['/p/A']);
  assert.equal(b.disposed, 1);
});

test('touch() postpones eviction', () => {
  const h = harness();
  h.add('/p/A');
  h.clock.t = 900;
  h.evictor.touch('/p/A');
  h.clock.t = 1500;
  assert.deepEqual(h.evictor.sweep(), []);
  h.clock.t = 1900;
  assert.deepEqual(h.evictor.sweep(), ['/p/A']);
});

test('only idle entries go; busy ones in the same registry stay', () => {
  const h = harness();
  h.add('/p/idle');
  h.add('/p/pending', stubBackend({ pending: 1 }));
  h.add('/p/open');
  h.inUse.add('/p/open');
  h.clock.t = 5000;
  assert.deepEqual(h.evictor.sweep(), ['/p/idle']);
  assert.deepEqual([...h.registry.keys()].sort(), ['/p/open', '/p/pending']);
});

test('an entry never touched starts its clock at the first sweep instead of going at once', () => {
  const h = harness();
  h.registry.set('/p/A', stubBackend());
  h.clock.t = 10_000;
  assert.deepEqual(h.evictor.sweep(), []);
  h.clock.t = 11_000;
  assert.deepEqual(h.evictor.sweep(), ['/p/A']);
});

test('a throwing evict or isInUse never breaks the sweep for other entries', () => {
  const registry = new Map([['/p/bad', stubBackend()], ['/p/good', stubBackend()], ['/p/check', stubBackend()]]);
  const clock = { t: 0 };
  const warnings = [];
  const evictor = createBackendEvictor({
    entries: () => registry,
    isInUse: (p) => { if (p === '/p/check') throw new Error('boom'); return false; },
    evict: (p) => { if (p === '/p/bad') throw new Error('nope'); registry.delete(p); },
    idleMs: 10,
    now: () => clock.t,
    warn: m => warnings.push(m),
  });
  for (const p of registry.keys()) evictor.touch(p);
  clock.t = 100;
  assert.deepEqual(evictor.sweep(), ['/p/good']);
  assert.ok(registry.has('/p/check'), 'isInUse throwing counts as in use');
  assert.equal(warnings.length, 1);
});

test('an unreadable queue counts as pending', () => {
  const h = harness();
  h.add('/p/A', { getPendingMutationCount() { throw new Error('x'); }, dispose() {} });
  h.clock.t = 5000;
  assert.deepEqual(h.evictor.sweep(), []);
});
