import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createSilenceWatchdog } = await import('./voice-silence.js');

test('never armed: 60s of continuous silence never stops', () => {
  const wd = createSilenceWatchdog({ timeoutMs: 10_000, hintMs: 5_000, maxGapMs: 1_000 });
  let t = 0;
  for (let i = 0; i < 60; i++) {
    t += 1_000;
    const r = wd.update(0, t);
    assert.equal(r.armed, false);
    assert.equal(r.stop, false);
    assert.equal(r.hintSeconds, null);
  }
});

test('speech then silence: stops at exactly timeoutMs of continuous silence', () => {
  const wd = createSilenceWatchdog({ timeoutMs: 10_000, hintMs: 5_000, maxGapMs: 1_000 });
  let r = wd.update(0.5, 0); // one speaking frame arms it
  assert.equal(r.armed, true);
  assert.equal(r.speaking, true);
  for (let ms = 1_000; ms < 10_000; ms += 1_000) {
    r = wd.update(0, ms);
    assert.equal(r.stop, false);
  }
  r = wd.update(0, 10_000);
  assert.equal(r.stop, true);
});

test('speech resets a partially elapsed silence timer', () => {
  const wd = createSilenceWatchdog({ timeoutMs: 10_000, hintMs: 5_000, maxGapMs: 1_000 });
  wd.update(0.5, 0);
  wd.update(0, 1_000);
  wd.update(0, 2_000);
  wd.update(0, 3_000);
  const r = wd.update(0.5, 3_500); // speech resumes before the 10s mark
  assert.equal(r.speaking, true);
  assert.equal(r.stop, false);
  // Silence budget restarted at 3_500 — stop must land at 3_500 + 10_000 = 13_500, not earlier.
  let last;
  let ms;
  for (ms = 4_500; ms <= 13_500; ms += 1_000) {
    last = wd.update(0, ms);
    if (last.stop) break;
  }
  assert.equal(last.stop, true);
  assert.equal(ms, 13_500);
});

test('hintSeconds is null outside the countdown window, set only inside the last hintMs', () => {
  // maxGapMs deliberately larger than every gap below — this test is about the hint threshold,
  // not the tick-gap clamp (covered separately below).
  const wd = createSilenceWatchdog({ timeoutMs: 10_000, hintMs: 5_000, maxGapMs: 10_000 });
  wd.update(0.5, 0);
  const early = wd.update(0, 1_000); // 9s remaining — outside the 5s hint window
  assert.equal(early.hintSeconds, null);
  const boundary = wd.update(0, 5_000); // exactly 5s remaining — inside the window
  assert.equal(boundary.hintSeconds, 5);
  const late = wd.update(0, 9_500); // 0.5s remaining — rounds up to 1
  assert.equal(late.hintSeconds, 1);
});

test('a stalled tick source only contributes maxGapMs, not the full wall-clock gap', () => {
  const wd = createSilenceWatchdog({ timeoutMs: 10_000, hintMs: 5_000, maxGapMs: 500 });
  wd.update(0.5, 0);
  // A single 30s gap (e.g. rAF paused for an occluded window) must not jump straight to stop —
  // it should only ever add maxGapMs (500ms) of silence.
  const r = wd.update(0, 30_000);
  assert.equal(r.stop, false);
});

test('reset() clears armed state and accumulated silence', () => {
  const wd = createSilenceWatchdog({ timeoutMs: 10_000, hintMs: 5_000, maxGapMs: 1_000 });
  wd.update(0.5, 0);
  wd.update(0, 5_000);
  wd.reset();
  assert.equal(wd.armed, false);
  const r = wd.update(0, 20_000); // would have stopped long ago if not reset
  assert.equal(r.stop, false);
  assert.equal(r.armed, false);
});
