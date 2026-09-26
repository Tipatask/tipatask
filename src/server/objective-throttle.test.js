'use strict';

// C1031 — regression guard for the objective-chat throttle under the chat-model-selector.
// The invariant under test: queue/circuit state is keyed by taskId ONLY. Switching provider
// or model mid-conversation (providers/dispatch.js applyModelSelection) mutates
// session.providerType/session.selectedModel and never taskId, so it must not be able to
// double-book a slot, bypass OBJECTIVE_MAX_CONCURRENT, or double-drain a queued entry.
//
// Isolation: objective-throttle.js is a process singleton with no reset hook. `node --test`
// runs each test FILE in its own process, so only within-file isolation matters. Every test
// here restores config.OBJECTIVE_MAX_CONCURRENT and drains its own taskIds via recordAbort()
// in a finally block. NOTE: no test here may call recordTimeout() — that mutates
// _state.consecutiveTimeouts/circuitState/openedAt, and once the circuit is 'open' there is
// no public way back to 'closed' (openedAt is private, only requestTurn's elapsed-time check
// reads it). Adding a circuit-breaker test REQUIRES a test-only reset export first.

const assert = require('node:assert/strict');
const test = require('node:test');

const config = require('./config');
const throttle = require('./objective-throttle');

function assertIdle(label) {
  const s = throttle.getStatus();
  assert.equal(s.active, 0, `${label}: leaked active slot(s) from an earlier test`);
  assert.equal(s.pending, 0, `${label}: leaked pending entr(ies) from an earlier test`);
  assert.equal(s.circuitState, 'closed', `${label}: circuit not closed`);
}

test('active slots are keyed by taskId alone — a provider switch reuses the same slot', () => {
  assertIdle('start');
  const taskId = 'obj-c1031-reuse';
  const ran = [];
  // Same session object, provider/model changed between turns — exactly what
  // applyModelSelection() does on the second reply.
  const session = { providerType: 'claude', selectedModel: 'claude-opus-5' };
  try {
    assert.deepEqual(throttle.requestTurn(taskId, () => ran.push('claude-turn')), { ok: true });
    assert.equal(throttle.getStatus().active, 1);
    throttle.recordSuccess(taskId);
    assert.equal(throttle.getStatus().active, 0);

    session.providerType = 'gemini';
    session.selectedModel = 'gemini-2.5-pro';
    assert.deepEqual(throttle.requestTurn(taskId, () => ran.push('gemini-turn')), { ok: true });
    assert.equal(throttle.getStatus().active, 1,
      'a provider switch must occupy the SAME taskId slot, not a second one');
    assert.deepEqual(ran, ['claude-turn', 'gemini-turn']);
  } finally {
    throttle.recordAbort(taskId);
  }
  assertIdle('end');
});

test('two overlapping requestTurn calls for one taskId never occupy two slots', () => {
  assertIdle('start');
  const taskId = 'obj-c1031-idempotent';
  try {
    throttle.requestTurn(taskId, () => {});   // provider = claude
    assert.equal(throttle.getStatus().active, 1);
    throttle.requestTurn(taskId, () => {});   // provider switched to codex, same task
    assert.equal(throttle.getStatus().active, 1,
      '_state.active is a Set of taskId — provider/model are not part of the key');
    throttle.recordSuccess(taskId);
    assert.equal(throttle.getStatus().active, 0, 'one release frees the taskId completely');
  } finally {
    throttle.recordAbort(taskId);
  }
  assertIdle('end');
});

test('OBJECTIVE_MAX_CONCURRENT is not bypassed by a provider switch', () => {
  assertIdle('start');
  const orig = config.OBJECTIVE_MAX_CONCURRENT;
  config.OBJECTIVE_MAX_CONCURRENT = 1;
  const ran = [];
  try {
    // Task A holds the only slot on claude.
    assert.deepEqual(throttle.requestTurn('obj-c1031-A', () => ran.push('A')), { ok: true });
    assert.equal(throttle.getStatus().active, 1);

    // Task B picks a different provider on its reply — must still queue.
    assert.deepEqual(throttle.requestTurn('obj-c1031-B', () => ran.push('B')), { ok: true });
    assert.deepEqual(ran, ['A'], 'B must not run while the single slot is taken');
    assert.equal(throttle.getStatus().active, 1);
    assert.equal(throttle.getStatus().pending, 1);
  } finally {
    throttle.recordAbort('obj-c1031-A');   // drains B synchronously
    throttle.recordAbort('obj-c1031-B');
    config.OBJECTIVE_MAX_CONCURRENT = orig;
  }
  assertIdle('end');
});

test('a queued turn drains exactly once on recordSuccess', () => {
  assertIdle('start');
  const orig = config.OBJECTIVE_MAX_CONCURRENT;
  config.OBJECTIVE_MAX_CONCURRENT = 1;
  let bRuns = 0;
  try {
    throttle.requestTurn('obj-c1031-A', () => {});
    throttle.requestTurn('obj-c1031-B', () => { bRuns++; });
    assert.equal(bRuns, 0);
    assert.equal(throttle.getStatus().pending, 1);

    throttle.recordSuccess('obj-c1031-A');
    assert.equal(bRuns, 1, 'the queued entry runs when the slot frees');
    assert.equal(throttle.getStatus().active, 1);
    assert.equal(throttle.getStatus().pending, 0);

    // A duplicate/stray release (e.g. a provider emitter firing twice) must not re-drain.
    throttle.recordSuccess('obj-c1031-A');
    assert.equal(bRuns, 1, 'a queued entry must never run twice');
    assert.equal(throttle.getStatus().active, 1);
  } finally {
    throttle.recordAbort('obj-c1031-A');
    throttle.recordAbort('obj-c1031-B');
    config.OBJECTIVE_MAX_CONCURRENT = orig;
  }
  assertIdle('end');
});

test('a runFn that returns early must release its slot (C1031 defect B contract)', () => {
  assertIdle('start');
  const orig = config.OBJECTIVE_MAX_CONCURRENT;
  config.OBJECTIVE_MAX_CONCURRENT = 1;
  try {
    // Mirrors the fixed claude-session.js spawnObjectiveTurn empty-history early return:
    // requestTurn() has ALREADY added taskId to _state.active before invoking runFn, so a
    // runFn that bails without reaching recordSuccess/recordTimeout must call recordAbort.
    throttle.requestTurn('obj-c1031-A', () => { throttle.recordAbort('obj-c1031-A'); });
    assert.equal(throttle.getStatus().active, 0, 'an early-returning runFn must free its slot');

    let bRan = false;
    throttle.requestTurn('obj-c1031-B', () => { bRan = true; });
    assert.equal(bRan, true, 'the next turn must not be blocked by a leaked slot');
  } finally {
    throttle.recordAbort('obj-c1031-A');
    throttle.recordAbort('obj-c1031-B');
    config.OBJECTIVE_MAX_CONCURRENT = orig;
  }
  assertIdle('end');
});

test("recordAbort never starts the aborted task's own queued turn (TPT294)", () => {
  assertIdle('start');
  const orig = config.OBJECTIVE_MAX_CONCURRENT;
  config.OBJECTIVE_MAX_CONCURRENT = 1;
  const ran = [];
  try {
    throttle.requestTurn('obj-tpt294-A', () => ran.push('A1'));       // takes the only slot
    throttle.requestTurn('obj-tpt294-A', () => ran.push('A2-queued')); // same task, queued behind itself
    throttle.requestTurn('obj-tpt294-B', () => ran.push('B'));         // another task, queued
    assert.deepEqual(ran, ['A1']);
    assert.equal(throttle.getStatus().pending, 2);

    // Kill/teardown of A: releasing A's slot must not drain A's own queued turn into it.
    throttle.recordAbort('obj-tpt294-A');
    assert.deepEqual(ran, ['A1', 'B'], "A's queued turn is purged; the freed slot goes to B");
    assert.equal(throttle.getStatus().pending, 0);
    assert.equal(throttle.getStatus().active, 1);
  } finally {
    throttle.recordAbort('obj-tpt294-A');
    throttle.recordAbort('obj-tpt294-B');
    config.OBJECTIVE_MAX_CONCURRENT = orig;
  }
  assertIdle('end');
});
