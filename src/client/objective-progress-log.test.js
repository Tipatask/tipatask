import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  MAX_LOG_ENTRIES, appendProgressLog, formatProgressLine, noteTurnBoundary,
  pushThinking, flushThinking, replayProgressLog, progressStatusLine, stageLogText,
} = await import('./objective-progress-log.js');

function fakeCs() {
  return {};
}

test('noteTurnBoundary does not push a separator for the first turn', () => {
  const cs = fakeCs();
  noteTurnBoundary(cs);
  assert.deepEqual(cs.progressLog, []);
  assert.equal(cs._turnCount, 1);
});

test('noteTurnBoundary pushes a numbered separator from the second turn onward', () => {
  const cs = fakeCs();
  noteTurnBoundary(cs);
  appendProgressLog(cs, { kind: 'spawned', text: 'spawned', elapsedMs: 0 });
  noteTurnBoundary(cs);
  const sep = cs.progressLog.find(e => e.kind === 'turn');
  assert.ok(sep);
  assert.equal(sep.turnIndex, 2);
});

test('appendProgressLog ring-buffers to MAX_LOG_ENTRIES', () => {
  const cs = fakeCs();
  noteTurnBoundary(cs);
  for (let i = 0; i < MAX_LOG_ENTRIES + 50; i++) {
    appendProgressLog(cs, { kind: 'tool', text: `tool-${i}`, elapsedMs: i });
  }
  assert.equal(cs.progressLog.length, MAX_LOG_ENTRIES);
  // Oldest entries trimmed — the buffer should hold the most recent ones.
  assert.equal(cs.progressLog[cs.progressLog.length - 1].text, `tool-${MAX_LOG_ENTRIES + 49}`);
});

test('tool / tool-end pairing computes duration from elapsedMs', () => {
  const cs = fakeCs();
  noteTurnBoundary(cs);
  appendProgressLog(cs, { kind: 'tool', text: 'batch_grep_tags', toolName: 'batch_grep_tags', elapsedMs: 1000 });
  appendProgressLog(cs, { kind: 'tool-end', text: 'batch_grep_tags', toolName: 'batch_grep_tags', elapsedMs: 5600 });
  const last = cs.progressLog[cs.progressLog.length - 1];
  assert.equal(last.kind, 'tool-end');
  assert.equal(last.text, 'batch_grep_tags (4.6s)');
});

test('tool-end with no matching open tool logs without a duration suffix', () => {
  const cs = fakeCs();
  noteTurnBoundary(cs);
  appendProgressLog(cs, { kind: 'tool-end', text: 'mystery', elapsedMs: 100 });
  const last = cs.progressLog[cs.progressLog.length - 1];
  assert.equal(last.text, 'mystery');
});

test('pushThinking coalesces small chunks and flushes on newline', () => {
  const cs = fakeCs();
  noteTurnBoundary(cs);
  pushThinking(cs, 'Let me check ');
  pushThinking(cs, 'the file.\n');
  assert.equal(cs.progressLog.length, 1);
  assert.equal(cs.progressLog[0].kind, 'thinking');
  assert.equal(cs.progressLog[0].text, 'Let me check the file.');
  assert.equal(cs._thinkingPending, '');
});

test('pushThinking flushes once the char threshold is crossed', () => {
  const cs = fakeCs();
  noteTurnBoundary(cs);
  pushThinking(cs, 'x'.repeat(250));
  assert.equal(cs.progressLog.length, 1);
  assert.equal(cs.progressLog[0].text.length, 250);
});

test('flushThinking is a no-op with nothing pending', () => {
  const cs = fakeCs();
  noteTurnBoundary(cs);
  flushThinking(cs);
  assert.deepEqual(cs.progressLog, []);
});

test('appendProgressLog flushes pending thinking first so log order matches wall-clock order', () => {
  const cs = fakeCs();
  noteTurnBoundary(cs);
  pushThinking(cs, 'still thinking about it');
  appendProgressLog(cs, { kind: 'tool', text: 'get_task', elapsedMs: 500 });
  assert.equal(cs.progressLog.length, 2);
  assert.equal(cs.progressLog[0].kind, 'thinking');
  assert.equal(cs.progressLog[1].kind, 'tool');
});

test('formatProgressLine renders a turn separator distinctly from a normal entry', () => {
  const sep = formatProgressLine({ kind: 'turn', turnIndex: 3 });
  assert.match(sep, /turn 3/);
  const normal = formatProgressLine({ kind: 'tool', text: 'get_task', elapsedMs: 1234 });
  assert.match(normal, /\+1\.2s/);
  assert.match(normal, /get_task/);
});

test('replayProgressLog writes every buffered entry, in order, to the given term', () => {
  const cs = fakeCs();
  noteTurnBoundary(cs);
  appendProgressLog(cs, { kind: 'spawned', text: 'spawned', elapsedMs: 0 });
  appendProgressLog(cs, { kind: 'tool', text: 'get_task', elapsedMs: 500 });
  const written = [];
  const fakeTerm = { write: (s) => written.push(s) };
  replayProgressLog(fakeTerm, cs);
  assert.equal(written.length, 2);
  assert.match(written[0], /spawned/);
  assert.match(written[1], /get_task/);
});

test('appendProgressLog live-writes to cs.term when attached', () => {
  const cs = fakeCs();
  noteTurnBoundary(cs);
  const written = [];
  cs.term = { write: (s) => written.push(s) };
  let scrolled = false;
  cs.termScroll = () => { scrolled = true; };
  appendProgressLog(cs, { kind: 'spawned', text: 'spawned', elapsedMs: 0 });
  assert.equal(written.length, 1);
  assert.equal(scrolled, true);
});

test('progressStatusLine reflects current chip stage and elapsed time', () => {
  const cs = fakeCs();
  noteTurnBoundary(cs);
  cs.progressStage = 'Reading architectures…';
  // elapsedMs on the entry is the server-reported value at push time — the status line's own
  // elapsedMs is a live clientElapsed() read (wall-clock since turn start), so it won't match
  // an arbitrary stored value; just assert it's a sane non-negative number.
  appendProgressLog(cs, { kind: 'tool', text: 'get_tag_architectures', elapsedMs: 12400 });
  const status = progressStatusLine(cs);
  assert.equal(status.stage, 'Reading architectures…');
  assert.ok(typeof status.elapsedMs === 'number' && status.elapsedMs >= 0);
  assert.ok(status.sinceLastSignalMs != null && status.sinceLastSignalMs >= 0);
});

test('progressStatusLine returns null for a missing chatState', () => {
  assert.equal(progressStatusLine(null), null);
});

test('stageLogText maps stage keys to short display text', () => {
  assert.equal(stageLogText('spawned'), 'spawned');
  assert.equal(stageLogText('cli-init'), 'cli-init');
  assert.equal(stageLogText('tool', 'mcp__tipatask-local__batch_grep_tags'), 'batch_grep_tags');
  assert.equal(stageLogText('tool-end', 'mcp__tipatask__get_task'), 'get_task');
});
