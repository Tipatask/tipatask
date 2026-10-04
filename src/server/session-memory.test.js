'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parsePsOutput } = require('./process-group');
const { createSessionQueue } = require('./session-queue');
const { sessionDiagnostics, createSessionMemoryTracker, MAX_HISTORY, MAX_SESSIONS } = require('./session-memory');
const terminal = (pid, extra = {}) => ({ type: 'terminal', taskAgent: 'codex', alive: true, ptyPid: pid, ...extra });
const ps = parsePsOutput('10 10 1 100 S\n10 11 10 200 S\n10 12 11 300 S\n20 20 1 400 S\n20 21 20 0 S\n30 30 1 999 Z');
const isRunning = createSessionQueue().isRunning;

test('PID union deduplicates overlapping session trees and excludes zombies', () => {
  const s = new Map([['a', terminal(10)], ['b', terminal(11)]]);
  const d = sessionDiagnostics(ps, s, isRunning);
  assert.equal(d.rows[0].currentRssBytes, 600 * 1024);
  assert.equal(d.rows[1].currentRssBytes, 500 * 1024);
  assert.equal(d.rows[0].observableRssBytes, 600 * 1024);
  assert.equal(d.rows[1].observableRssBytes, 0, 'shared PIDs cannot retire two launch reservations');
  assert.equal(d.unionRssBytes, 600 * 1024);
  assert.equal(d.pidCount, 3);
  assert.equal(d.admissionSlots, 2);
});
test('paused, completed-live, headless and launching entries separate slots from memory', () => {
  const s = new Map([
    ['paused', terminal(10, { _pause: {} })],
    ['done', terminal(11, { _completionEmitted: true })],
    ['chat', { type: 'taskChat', providerType: 'pi', alive: true, proc: { pid: 20 },
      _heartbeatProc: { pid: 21 }, _helperProcs: new Set([{ pid: 21 }]) }],
    ['launch', terminal(null, { alive: false, _launching: true })],
    ['queued', terminal(null, { alive: false, _queued: true })],
  ]);
  const d = sessionDiagnostics(ps, s, isRunning);
  assert.equal(d.admissionSlots, 2);
  assert.equal(d.memoryOwningSessions, 3);
  assert.equal(d.rows[0].paused, true);
  assert.equal(d.rows[1].completed, true);
  assert.equal(d.rows[2].currentRssBytes, 400 * 1024);
  assert.equal(d.rows[3].currentRssBytes, null);
  assert.equal(d.unionRssBytes, null, 'unobserved launch is not zero');
  s.delete('launch');
  assert.equal(sessionDiagnostics(ps, s, isRunning).unionRssBytes, 1000 * 1024);
});
test('zero differs from missing RSS, absent root, failed snapshot and empty registry', () => {
  const s = new Map([['zero', terminal(21)]]);
  assert.equal(sessionDiagnostics(ps, s).unionRssBytes, 0);
  const missing = { ...ps, rssOf: new Map(ps.rssOf) };
  missing.rssOf.delete(21);
  assert.equal(sessionDiagnostics(missing, s).unionRssBytes, null);
  assert.equal(sessionDiagnostics(null, s).unionRssBytes, null);
  assert.equal(sessionDiagnostics(ps, new Map()).unionRssBytes, 0);
  assert.equal(sessionDiagnostics(null, new Map()).unionRssBytes, null);
  assert.equal(sessionDiagnostics(ps, new Map([['gone', terminal(999)]])).unionRssBytes, null);
});
test('same-group orphan stays attributable while root lives; escaped orphan is excluded', () => {
  const p = parsePsOutput('10 10 1 100 S\n10 11 1 200 S\n99 12 1 300 S');
  assert.equal(sessionDiagnostics(p, new Map([['a', terminal(10)]])).unionRssBytes, 300 * 1024);
});

function harness(historyFile) {
  let time = 1000;
  const tracker = createSessionMemoryTracker({ now: () => time, historyFile });
  const s = terminal(10);
  const live = new Map([['a', s]]);
  const sample = value => tracker.sample({ rows: [{ session: s, currentRssBytes: value }] }, time, live)[0];
  return { tracker, s, live, sample, advance: ms => { time += ms; } };
}
test('complete lifetime peak freezes at completion while completed-live diagnostics continue', () => {
  const h = harness();
  h.tracker.begin(h.s);
  assert.equal(h.sample(100).peakMinusCurrentBytes, 0);
  h.advance(5000);
  assert.equal(h.sample(60).peakMinusCurrentBytes, 40);
  h.tracker.end(h.s, 'completed');
  const done = h.tracker.getHistory()[0];
  assert.equal(done.completeLifetime, true);
  assert.equal(done.peakRssBytes, 100);
  h.advance(5000);
  assert.equal(h.sample(300).peakRssBytes, 300);
  h.tracker.end(h.s, 'exited');
  h.tracker.end(h.s, 'terminated');
  assert.deepEqual(h.tracker.getHistory(), [done]);
  assert.equal(h.tracker.activeCount(), 0);
});
test('exit before completion can be classified later without losing measured task peak', () => {
  const h = harness();
  h.tracker.begin(h.s);
  h.sample(50);
  h.tracker.end(h.s, 'exited');
  assert.equal(h.tracker.getHistory()[0].completeLifetime, false);
  h.advance(5000);
  h.tracker.end(h.s, 'completed');
  assert.equal(h.tracker.getHistory().length, 1);
  assert.equal(h.tracker.getHistory()[0].completeLifetime, true);
});
for (const mode of ['midway', 'missing', 'stale', 'short', 'terminated', 'shutdown']) {
  test(`${mode} run never becomes complete lifetime training data`, () => {
    const h = harness();
    if (mode !== 'midway') h.tracker.begin(h.s);
    if (mode !== 'short') h.sample(50);
    if (mode === 'missing') { h.advance(5000); assert.equal(h.sample(null).peakMinusCurrentBytes, null); }
    if (mode === 'stale') { h.advance(16000); h.sample(40); }
    h.tracker.end(h.s, ['terminated', 'shutdown'].includes(mode) ? mode : 'completed');
    assert.equal(h.tracker.getHistory()[0].completeLifetime, false);
  });
}
test('restarts and provider switches do not mix peaks; disappeared sessions finalize partial', () => {
  const h = harness();
  h.tracker.begin(h.s);
  h.sample(500);
  h.tracker.begin(h.s);
  assert.equal(h.sample(10).peakRssBytes, 10);
  h.s.taskAgent = 'pi';
  assert.equal(h.sample(20).peakRssBytes, 20);
  assert.equal(h.sample(15).provider, 'pi');
  h.live.clear();
  h.tracker.sample({ rows: [] }, 1000, h.live);
  assert.equal(h.tracker.activeCount(), 0);
  assert.equal(h.tracker.getHistory().at(-1).reason, 'lost');
});
test('history persists bounded allowlisted records; malformed storage and write failures stay nonfatal', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'history.json');
  const h = harness(file);
  h.s.prompt = 'secret-prompt';
  h.s.env = { API_TOKEN: 'secret-token' };
  for (let i = 0; i < MAX_HISTORY + 3; i++) {
    h.tracker.begin(h.s); h.sample(i); h.tracker.end(h.s, 'completed'); h.tracker.end(h.s, 'exited'); h.advance(1);
  }
  const recovered = createSessionMemoryTracker({ historyFile: file }).getHistory();
  assert.equal(recovered.length, MAX_HISTORY);
  assert.equal(recovered.at(-1).peakRssBytes, MAX_HISTORY + 2);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('secret'));
  assert.ok(fs.statSync(file).size < 512 * 1024);
  fs.writeFileSync(file, 'invalid');
  assert.equal(createSessionMemoryTracker({ historyFile: file }).storageStatus(), 'unavailable');
  const bad = harness(path.join(file, 'cannot-write'));
  bad.tracker.begin(bad.s); bad.sample(1); bad.tracker.end(bad.s, 'completed');
  assert.equal(bad.tracker.storageStatus(), 'unavailable');
  assert.equal(bad.tracker.getHistory().length, 1);
});
test('active tracking and diagnostic rows are bounded and truncation is explicit', () => {
  const h = harness();
  const entries = new Map();
  for (let i = 0; i < MAX_SESSIONS + 3; i++) { const s = terminal(10); h.tracker.begin(s); entries.set(i, s); }
  assert.equal(h.tracker.activeCount(), MAX_SESSIONS);
  const d = sessionDiagnostics(ps, entries, isRunning);
  assert.equal(d.rows.length, MAX_SESSIONS);
  assert.equal(d.truncated, true);
  assert.equal(d.unionRssBytes, null);
  h.tracker.stop();
  assert.equal(h.tracker.activeCount(), 0);
});
