'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { reflowChunk, carveReflowLines, resetReflow } = require('./screen-reflow');

test('reflowChunk is identity on plain text with embedded \\n / \\r (no escapes)', () => {
  const session = {};
  assert.equal(reflowChunk(session, 'hello\nworld\n'), 'hello\nworld\n');
  assert.equal(reflowChunk(session, 'a\r\nb'), 'a\r\nb');
});

test('reflowChunk breaks a new row on ESC[r;cH when the row differs from the tracked row', () => {
  const session = {};
  // Row tracking starts at 1 by default, so the FIRST ESC[1;1H is a no-op position match (no
  // spurious leading blank line for content that starts at the top) — the break only appears
  // once the row actually changes.
  const out = reflowChunk(session, '\x1b[1;1Hfirst\x1b[2;1Hsecond');
  assert.equal(out, 'first\nsecond');
});

test('reflowChunk does NOT break a row when ESC[r;cH targets the same row (column move only)', () => {
  const session = {};
  const out = reflowChunk(session, '\x1b[1;1Hfirst\x1b[1;10Htab-stop');
  // same row (1) -> no extra '\n'; column 10 is padded with spaces from col 6 (after "first")
  assert.doesNotMatch(out, /\n/);
  assert.equal(out, 'first    tab-stop');
});

test('reflowChunk ESC[<n>C / ESC[<n>G pad with spaces and never insert a row break', () => {
  const session = {};
  const out = reflowChunk(session, 'ab\x1b[3Ccd\x1b[10Gef');
  assert.doesNotMatch(out, /\n/);
  assert.equal(out, 'ab   cd  ef');
});

test('reflowChunk ESC[<n>A/B/E/F and ESC[<n>d each insert exactly one row break', () => {
  for (const seq of ['\x1b[1A', '\x1b[1B', '\x1b[1E', '\x1b[1F', '\x1b[5d']) {
    const session = {};
    const out = reflowChunk(session, `x${seq}y`);
    assert.equal((out.match(/\n/g) || []).length, 1, `expected exactly one row break for ${JSON.stringify(seq)}`);
  }
});

test('reflowChunk drops SGR/color codes and other non-positional CSI without affecting row/col', () => {
  const session = {};
  const out = reflowChunk(session, '\x1b[1;1H\x1b[1m\x1b[38;5;39mbold-blue\x1b[0m\x1b[2Kmore');
  assert.equal(out, 'bold-bluemore');
});

test('reflowChunk drops a recognized 2-char escape (e.g. ESC M, Reverse Index) without throwing', () => {
  const session = {};
  const out = reflowChunk(session, 'before\x1bMafter');
  assert.equal(out, 'beforeafter');
});

test('reflowChunk drops a lone/unrecognized ESC byte only, same failure mode as stripAnsi()', () => {
  // ESC 'c' (RIS) falls outside stripAnsi()'s own 2-char-escape class ([@-Z\\-_]) too — parity
  // with the legacy stream means this reflow module must not silently "fix" that gap; only the
  // ESC byte itself is dropped, the following literal char survives.
  const session = {};
  const out = reflowChunk(session, 'before\x1bcafter');
  assert.equal(out, 'beforecafter');
});

test('reflowChunk carries cursor row/col across a chunk boundary that falls between complete units', () => {
  const session = {};
  const frame = '\x1b[1;1Hfirst\x1b[2;1Hsecond';
  const whole = reflowChunk({}, frame);
  // Split right after the first unit completes (before the second escape starts) — the
  // realistic PTY-flush boundary this carry exists for (one screen row per chunk). Splitting
  // mid-escape-sequence is a separate, much rarer failure mode shared with the legacy
  // stripAnsi() stream (which has no cross-chunk escape-continuation handling at all either,
  // outside the dedicated OSC case in stripOscChunk()) and is out of scope here.
  const splitAt = frame.indexOf('\x1b[2;1H');
  const c1 = reflowChunk(session, frame.slice(0, splitAt));
  const c2 = reflowChunk(session, frame.slice(splitAt));
  assert.equal(c1 + c2, whole);
  assert.equal(session._attentionRow, 2);
});

test('reflowChunk stateless mode (session=null) matches a fresh stateful pass, and never throws', () => {
  const frame = '\x1b[3;2HPick a build target?\x1b[5;2H\x1b[38;5;39m❯\x1b[39m\x1b[5;4H1. Docker image';
  assert.equal(reflowChunk(null, frame), reflowChunk({}, frame));
  assert.equal(reflowChunk(undefined, frame), reflowChunk({}, frame));
});

test('reflowChunk returns empty string for non-string/empty input', () => {
  assert.equal(reflowChunk({}, ''), '');
  assert.equal(reflowChunk({}, undefined), '');
  assert.equal(reflowChunk({}, null), '');
});

test('resetReflow sets row/col back to 1 so the next chunk is not glued to stale position', () => {
  const session = {};
  reflowChunk(session, '\x1b[9;1Hnine');
  assert.equal(session._attentionRow, 9);
  resetReflow(session);
  assert.equal(session._attentionRow, 1);
  assert.equal(session._attentionCol, 1);
  // A fresh ESC[1;1H after reset should NOT insert a spurious leading row break (row already 1).
  const out = reflowChunk(session, '\x1b[1;1Hfresh');
  assert.equal(out, 'fresh');
});

test('resetReflow is a no-op (does not throw) when session is null/undefined', () => {
  assert.doesNotThrow(() => resetReflow(null));
  assert.doesNotThrow(() => resetReflow(undefined));
});

// ── carveReflowLines — cross-chunk carry, same discipline as carveAttentionLines() ──

test('carveReflowLines carries a partial row across chunks and completes it', () => {
  const session = { _attentionRowCarry: '' };
  const first = carveReflowLines(session, 'Pick a build tar');
  assert.deepEqual(first, ['Pick a build tar']); // provisional carry line
  assert.equal(session._attentionRowCarry, 'Pick a build tar');
  const second = carveReflowLines(session, 'get?\n');
  assert.deepEqual(second, ['Pick a build target?']);
  assert.equal(session._attentionRowCarry, '');
});

test('carveReflowLines splits on \\r\\n, \\n, and bare \\r alike', () => {
  const session = { _attentionRowCarry: '' };
  assert.deepEqual(carveReflowLines(session, 'a\r\nb\nc\rd'), ['a', 'b', 'c', 'd']);
});

test('carveReflowLines caps an unterminated carry at 4096 chars', () => {
  const session = { _attentionRowCarry: '' };
  carveReflowLines(session, 'x'.repeat(5000));
  assert.equal(session._attentionRowCarry.length, 4096);
});

test('carveReflowLines tolerates a missing/null session (no carry persisted, still splits correctly)', () => {
  assert.deepEqual(carveReflowLines(null, 'a\nb\nc'), ['a', 'b', 'c']);
});

// ── End-to-end reflow reproduction of the C1066 bug shape ──
// Generic content — deliberately NOT the reported task's own wording (see tt-terminal-attention-
// detection.md's note on why fixtures/tests must not hardcode this task's own phrasing).

test('reflowChunk + carveReflowLines recovers per-row lines from a cursor-addressed multi-option frame', () => {
  const frame = '\x1b[H\x1b[2K\x1b[1B\x1b[2K\x1b[1B\x1b[H'
    + '\x1b[3;2H\x1b[1mPick a build target for the release pipeline?\x1b[22m'
    + '\x1b[5;2H\x1b[38;5;39m❯\x1b[39m\x1b[5;4H1. Docker image (Recommended)'
    + '\x1b[6;6HBuilds and pushes to the registry.'
    + '\x1b[7;4H2. Static binary'
    + '\x1b[8;4H3. Skip build';
  const session = {};
  const reflowed = reflowChunk(session, frame);
  const lines = carveReflowLines(session, reflowed).filter((l) => l.trim());
  assert.deepEqual(lines, [
    ' Pick a build target for the release pipeline?',
    ' ❯ 1. Docker image (Recommended)',
    '     Builds and pushes to the registry.',
    '   2. Static binary',
    '   3. Skip build',
  ]);
});
