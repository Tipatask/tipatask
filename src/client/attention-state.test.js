// (C1387) Unit tests for the single funnel that owns state.attentionSessions/attentionDetails.
// No jsdom (not a dependency, see package.json) — hand-rolled `document`/card mocks, same style
// as attention-ws.test.js / attention-notifications.test.js.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const stateModule = await import('./state.js');
const state = stateModule.default;
const {
  isAttentionRaised, attentionClass, isTerminalOpenFor,
  raiseAttention, clearAttention, mergeSessionsSnapshot,
  pruneClosedAttention, syncAttentionClasses, isOpenSuppressed, _resetAttentionState,
} = await import('./attention-state.js');

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    toggle(name, on) { if (on) set.add(name); else set.delete(name); },
    add(name) { set.add(name); },
    remove(name) { set.delete(name); },
    contains(name) { return set.has(name); },
  };
}

function makeCard(id) {
  return { dataset: { id }, classList: makeClassList() };
}

function makeHost(cards) {
  return { querySelectorAll: () => cards };
}

beforeEach(() => {
  state.attentionSessions = new Set();
  state.attentionDetails = new Map();
  state.activeSessions = new Set();
  state.exitedSessions = new Set();
  state.sessionMeta = new Map();
  state.activeTerminal = null;
  _resetAttentionState();
});

test('raiseAttention adds the flag and detail', () => {
  raiseAttention('C1', { kind: 'toolApproval', promptText: 'Allow ls?', agent: 'codex' });
  assert.equal(isAttentionRaised('C1'), true);
  assert.deepEqual(state.attentionDetails.get('C1'), { kind: 'toolApproval', promptText: 'Allow ls?', agent: 'codex' });
  assert.equal(attentionClass('C1'), ' needs-attention');
  assert.equal(attentionClass('C2'), '');
});

test('raiseAttention lifts a past open/closed suppression — a genuinely new prompt always wins', () => {
  clearAttention('C1', 'opened');
  assert.equal(isOpenSuppressed('C1'), true);
  raiseAttention('C1', { kind: 'attention', promptText: 'again' });
  assert.equal(isOpenSuppressed('C1'), false);
  assert.equal(isAttentionRaised('C1'), true);
});

test('clearAttention removes the flag and detail', () => {
  raiseAttention('C1', { kind: 'attention', promptText: 'x' });
  clearAttention('C1', 'session-ended');
  assert.equal(isAttentionRaised('C1'), false);
  assert.equal(state.attentionDetails.has('C1'), false);
});

test('clearAttention("opened"/"closed") arms the suppression; other reasons do not', () => {
  raiseAttention('C1');
  clearAttention('C1', 'opened');
  assert.equal(isOpenSuppressed('C1'), true);

  raiseAttention('C2');
  clearAttention('C2', 'session-ended');
  assert.equal(isOpenSuppressed('C2'), false);
});

test('isTerminalOpenFor reflects state.activeTerminal', () => {
  assert.equal(isTerminalOpenFor('C1'), false);
  state.activeTerminal = { taskId: 'C1' };
  assert.equal(isTerminalOpenFor('C1'), true);
  assert.equal(isTerminalOpenFor('C2'), false);
});

// ── mergeSessionsSnapshot ──

test('mergeSessionsSnapshot adds a flag the server reports', () => {
  mergeSessionsSnapshot({ sessions: ['C1'], exited: [], attention: ['C1'], attentionDetails: { C1: { kind: 'attention', promptText: 'x' } } });
  assert.equal(isAttentionRaised('C1'), true);
  assert.deepEqual(state.attentionDetails.get('C1'), { kind: 'attention', promptText: 'x' });
});

test('mergeSessionsSnapshot never drops a flag merely because this snapshot omits it from attention[]', () => {
  // Simulates the in-flight race: a flag raised locally (e.g. an attention-needed frame that
  // landed while a /api/sessions request was already in flight) must survive a response whose
  // `attention[]` predates that raise.
  raiseAttention('C1', { kind: 'attention', promptText: 'x' });
  mergeSessionsSnapshot({ sessions: ['C1'], exited: [], attention: [], attentionDetails: {} });
  assert.equal(isAttentionRaised('C1'), true);
});

test('mergeSessionsSnapshot removes a flag only when the session is gone from BOTH sessions and exited', () => {
  raiseAttention('C1', { kind: 'attention', promptText: 'x' });
  mergeSessionsSnapshot({ sessions: [], exited: ['C1'], attention: [], attentionDetails: {} });
  assert.equal(isAttentionRaised('C1'), true, 'still exited, session known — keep');

  mergeSessionsSnapshot({ sessions: [], exited: [], attention: [], attentionDetails: {} });
  assert.equal(isAttentionRaised('C1'), false, 'gone from both — the one case a snapshot is authoritative about');
});

test('mergeSessionsSnapshot does not resurrect a flag the user dismissed by opening the terminal', () => {
  raiseAttention('C1', { kind: 'attention', promptText: 'x' });
  clearAttention('C1', 'opened'); // server keeps _attentionBroadcasted latched (C1356) — still in attention[]
  mergeSessionsSnapshot({ sessions: ['C1'], exited: [], attention: ['C1'], attentionDetails: {} });
  assert.equal(isAttentionRaised('C1'), false);
});

test('mergeSessionsSnapshot merges attentionDetails rather than replacing — never blanks a live detail', () => {
  raiseAttention('C1', { kind: 'toolApproval', promptText: 'Allow ls?', agent: 'codex' });
  // Post attention-seen: server still lists C1 in attention[] but drops attentionDetails[C1]
  // (ws-handlers.js nulls only _attentionLastBroadcast, not _attentionBroadcasted).
  mergeSessionsSnapshot({ sessions: ['C1'], exited: [], attention: ['C1'], attentionDetails: {} });
  assert.deepEqual(state.attentionDetails.get('C1'), { kind: 'toolApproval', promptText: 'Allow ls?', agent: 'codex' });
});

test('mergeSessionsSnapshot still wholesale-replaces activeSessions/exitedSessions/sessionMeta', () => {
  state.activeSessions = new Set(['stale']);
  mergeSessionsSnapshot({ sessions: ['C1'], exited: ['C2'], attention: [], sessionMeta: { C1: { agent: 'claude' } } });
  assert.deepEqual([...state.activeSessions], ['C1']);
  assert.deepEqual([...state.exitedSessions], ['C2']);
  assert.deepEqual(state.sessionMeta.get('C1'), { agent: 'claude' });
});

test('the suppression ledger is garbage-collected once the session is gone from both lists', () => {
  raiseAttention('C1');
  clearAttention('C1', 'opened');
  assert.equal(isOpenSuppressed('C1'), true);
  mergeSessionsSnapshot({ sessions: [], exited: [], attention: [] });
  assert.equal(isOpenSuppressed('C1'), false);
});

// ── pruneClosedAttention ──

test('pruneClosedAttention drops a closed task with no live session', () => {
  raiseAttention('C1');
  pruneClosedAttention(new Map([['C1', 'completed']]), (s) => s === 'completed');
  assert.equal(isAttentionRaised('C1'), false);
  assert.equal(isOpenSuppressed('C1'), true);
});

test('pruneClosedAttention keeps a closed task that still has a live terminal session', () => {
  raiseAttention('C1');
  state.activeSessions.add('C1');
  pruneClosedAttention(new Map([['C1', 'completed']]), (s) => s === 'completed');
  assert.equal(isAttentionRaised('C1'), true);
});

test('pruneClosedAttention leaves a task outside the given status map alone', () => {
  raiseAttention('C1');
  pruneClosedAttention(new Map(), (s) => s === 'completed');
  assert.equal(isAttentionRaised('C1'), true);
});

// ── syncAttentionClasses ──

test('syncAttentionClasses re-applies the ring after a simulated full re-render, including a card with no Start button', () => {
  raiseAttention('C1');
  const c1 = makeCard('C1');
  const c2 = makeCard('C2'); // never raised — must stay off
  const c3 = makeCard('C3'); // stands in for a buttonless (objective/human-assigned) card
  syncAttentionClasses(makeHost([c1, c2, c3]));
  assert.equal(c1.classList.contains('needs-attention'), true);
  assert.equal(c2.classList.contains('needs-attention'), false);
  assert.equal(c3.classList.contains('needs-attention'), false);

  // Simulate app.innerHTML = ... — brand new card nodes, all classes gone.
  const rebuilt1 = makeCard('C1');
  const rebuilt3 = makeCard('C3');
  raiseAttention('C3'); // a new prompt arrived on the buttonless card during the "re-render"
  syncAttentionClasses(makeHost([rebuilt1, rebuilt3]));
  assert.equal(rebuilt1.classList.contains('needs-attention'), true);
  assert.equal(rebuilt3.classList.contains('needs-attention'), true);
});

test('syncAttentionClasses strips the ring from a card whose flag was cleared', () => {
  raiseAttention('C1');
  const card = makeCard('C1');
  syncAttentionClasses(makeHost([card]));
  assert.equal(card.classList.contains('needs-attention'), true);
  clearAttention('C1', 'opened');
  syncAttentionClasses(makeHost([card]));
  assert.equal(card.classList.contains('needs-attention'), false);
});

test('syncAttentionClasses is a no-op with no host and does not throw', () => {
  assert.doesNotThrow(() => syncAttentionClasses(null));
});

test('missing terminals retain metadata and lose attention across repeated snapshots', () => {
  state.activeSessions.add('T1');
  state.sessionMeta.set('T1', { agent: 'codex', type: 'terminal', startedAt: 123, alive: true });
  raiseAttention('T1', { promptText: 'old prompt' });
  mergeSessionsSnapshot({ sessions: [], exited: [] });
  mergeSessionsSnapshot({ sessions: [], exited: [] });
  assert.equal(state.activeSessions.size, 0);
  assert.equal(state.lostSessions.has('T1'), true);
  assert.equal(state.sessionMeta.get('T1').agent, 'codex');
  assert.equal(state.sessionMeta.get('T1').alive, false);
  assert.equal(isAttentionRaised('T1'), false);
  assert.equal(attentionClass('T1'), ' session-lost');
  const card = makeCard('T1');
  syncAttentionClasses(makeHost([card]));
  assert.equal(card.classList.contains('session-lost'), true);
  assert.equal(card.classList.contains('needs-attention'), false);
});

test('server loss records hydrate cold clients; live/exited sessions win and clear loss', () => {
  const loss = { reason: 'signal:SIGTERM', at: '2026-09-30T12:00:00.000Z' };
  const snapshot = { projectPath: '/a', sessions: [], lost: ['T1'], lostDetails: { T1: loss },
    sessionMeta: { T1: { agent: 'claude', type: 'terminal' } } };
  mergeSessionsSnapshot(snapshot);
  assert.deepEqual(state.lostSessions.get('T1'), loss);
  mergeSessionsSnapshot({ ...snapshot, sessions: ['T1'] });
  assert.equal(state.lostSessions.size, 0);
  assert.equal(state.activeSessions.has('T1'), true);
  mergeSessionsSnapshot({ ...snapshot, sessions: [], exited: ['T1'] });
  assert.equal(state.lostSessions.size, 0);
  mergeSessionsSnapshot(snapshot);
  assert.equal(state.lostSessions.size, 0, 'old record cannot resurrect after recovery');
});

test('project changes clear lost rows and missing objective sessions never become terminal losses', () => {
  mergeSessionsSnapshot({ projectPath: '/a', sessions: ['T1', 'obj-1'], sessionMeta: { 'obj-1': { type: 'objective' } } });
  mergeSessionsSnapshot({ projectPath: '/a', sessions: [] });
  assert.deepEqual([...state.lostSessions.keys()], ['T1']);
  mergeSessionsSnapshot({ projectPath: '/b', sessions: [] });
  assert.equal(state.lostSessions.size, 0);
});
