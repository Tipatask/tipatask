import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRecordingTime, waveLevelFromRms, smoothWaveLevel, advanceWavePhase, waveOffset, wavePoints,
  placeVoiceWidget, WAVE_FLOOR_DB, WAVE_CEILING_DB, WIDGET_BASE_BOTTOM, WIDGET_GAP, WIDGET_MAX_WIDTH,
} from './voice-widget.js';

// (TPT9165) The recording widget's pure math: timer text, wave level and curve, placement.

const dbToRms = db => 10 ** (db / 20);

test('the timer reads mm:ss from 00:00 and keeps counting minutes past the hour', () => {
  assert.equal(formatRecordingTime(0), '00:00');
  assert.equal(formatRecordingTime(999), '00:00');
  assert.equal(formatRecordingTime(1000), '00:01');
  assert.equal(formatRecordingTime(30_000), '00:30');
  assert.equal(formatRecordingTime(65_400), '01:05');
  assert.equal(formatRecordingTime(3_600_000), '60:00');
  assert.equal(formatRecordingTime(6_000_000), '100:00');
  assert.equal(formatRecordingTime(-5), '00:00');
  assert.equal(formatRecordingTime(Number.NaN), '00:00');
});

test('a quiet room maps to a flat line; speech fills the canvas in proportion to loudness', () => {
  for (const rms of [0, -1, Number.NaN, dbToRms(WAVE_FLOOR_DB), 0.002]) assert.equal(waveLevelFromRms(rms), 0, `rms ${rms}`);
  assert.equal(waveLevelFromRms(dbToRms(WAVE_CEILING_DB)), 1);
  assert.equal(waveLevelFromRms(0.9), 1);
  const speech = waveLevelFromRms(dbToRms(-30));
  assert.ok(speech > 0.4 && speech < 0.8, `normal speech is ${speech}`);
  let last = 0;
  for (let db = WAVE_FLOOR_DB; db <= WAVE_CEILING_DB; db += 2) {
    const level = waveLevelFromRms(dbToRms(db));
    assert.ok(level >= last, `level rises with loudness at ${db} dB`);
    last = level;
  }
});

test('the shown level rises fast, falls slower, and settles on exactly zero in silence', () => {
  const up = smoothWaveLevel(0, 1, 70);
  const down = smoothWaveLevel(1, 0, 70);
  assert.ok(up > 0.6, `attack reaches ${up} in 70ms`);
  assert.ok(1 - down < 0.25, `release only drops to ${down} in 70ms`);
  assert.equal(smoothWaveLevel(0.5, 1, 0), 0.5, 'no time, no change');
  // Frame-rate independent: two 8ms frames land where one 16ms frame does.
  assert.ok(Math.abs(smoothWaveLevel(smoothWaveLevel(0.2, 0.9, 8), 0.9, 8) - smoothWaveLevel(0.2, 0.9, 16)) < 1e-9);
  let level = 1;
  let frames = 0;
  while (level > 0 && frames < 1000) { level = smoothWaveLevel(level, 0, 16); frames++; }
  assert.equal(level, 0);
  assert.ok(frames * 16 < 2500, `flat after ${frames * 16}ms of silence`);
});

test('the curve drifts faster when loud', () => {
  assert.ok(advanceWavePhase(0, 1, 100) > advanceWavePhase(0, 0, 100));
  assert.ok(advanceWavePhase(0, 0, 100) > 0, 'a quiet line still drifts');
  assert.equal(advanceWavePhase(3, 0.5, -10), 3);
});

test('the curve is pinned to the centre line at both ends and never leaves its band', () => {
  for (const phase of [0, 1.3, 7.9, 120]) {
    assert.ok(Math.abs(waveOffset(0, phase)) < 1e-9);
    assert.ok(Math.abs(waveOffset(1, phase)) < 1e-9);
    for (let x = 0; x <= 1; x += 0.01) assert.ok(Math.abs(waveOffset(x, phase)) <= 1, `x ${x} phase ${phase}`);
  }
});

test('wave points: level 0 is the flat centre line, full level stays inside the padded canvas', () => {
  const flat = wavePoints(400, 40, 0, 2.5);
  assert.deepEqual(flat[0], [0, 20]);
  assert.deepEqual(flat.at(-1), [400, 20]);
  assert.ok(flat.every(([, y]) => y === 20));

  let widest = 0;
  for (const phase of [0, 0.7, 1.9, 4.2]) {
    const points = wavePoints(400, 40, 1, phase, { pad: 4 });
    const swing = Math.max(...points.map(([, y]) => Math.abs(y - 20)));
    assert.ok(swing <= 16 + 1e-9, `swing ${swing} at phase ${phase}`);
    widest = Math.max(widest, swing);
    assert.deepEqual(points.at(-1), [400, 20]);
    for (let i = 1; i < points.length; i++) assert.ok(points[i][0] > points[i - 1][0], 'x strictly increases');
  }
  assert.ok(widest > 8, `a full-level wave swings ${widest}px`);
  const clamped = wavePoints(400, 40, 3, 0.7, { pad: 4 });
  assert.deepEqual(clamped, wavePoints(400, 40, 1, 0.7, { pad: 4 }), 'level is clamped to 1');
});

const viewport = { viewportWidth: 1280, viewportHeight: 900, height: 72 };
const rect = (left, top, right, bottom) => ({ left, top, right, bottom });

test('with nothing in the way the card rests at the bottom centre at min(720px, 90vw)', () => {
  assert.deepEqual(placeVoiceWidget({ ...viewport }), { bottom: WIDGET_BASE_BOTTOM, width: WIDGET_MAX_WIDTH });
  assert.deepEqual(placeVoiceWidget({ ...viewport, viewportWidth: 600 }), { bottom: WIDGET_BASE_BOTTOM, width: 540 });
});

test('a bottom-docked composer across the centre lifts the card just above it', () => {
  const composer = rect(330, 700, 1230, 884);
  assert.deepEqual(placeVoiceWidget({ ...viewport, obstacles: [composer] }), { bottom: 900 - 700 + WIDGET_GAP, width: 720 });
  // The empty-state composer near the top is no obstacle.
  assert.deepEqual(placeVoiceWidget({ ...viewport, obstacles: [rect(330, 120, 1230, 420)] }), { bottom: WIDGET_BASE_BOTTOM, width: 720 });
});

test('the notification column narrows a lifted card instead of being covered', () => {
  const composer = rect(330, 700, 1230, 884);
  const stack = rect(936, 420, 1256, 816);
  const placed = placeVoiceWidget({ ...viewport, obstacles: [composer, stack] });
  assert.equal(placed.bottom, 212);
  assert.equal(placed.width, 2 * (936 - WIDGET_GAP - 640));
  // On a wide window the same stack sits clear of the full-width card.
  const wide = placeVoiceWidget({ ...viewport, viewportWidth: 1440, obstacles: [rect(410, 700, 1310, 884), rect(1096, 420, 1416, 816)] });
  assert.deepEqual(wide, { bottom: 212, width: 720 });
});

test('a resting card clears the notification stack above it', () => {
  // #tt-notif-stack's lowest card starts at 5.25rem (84px) from the bottom: the 72px card at 16px reaches 88px.
  const stack = rect(936, 500, 1256, 900 - 84);
  const placed = placeVoiceWidget({ ...viewport, obstacles: [stack] });
  assert.equal(placed.bottom, WIDGET_BASE_BOTTOM);
  assert.ok(640 + placed.width / 2 + WIDGET_GAP <= 936, 'its right edge stays a gap away from the stack');
});

test('an obstacle too wide to narrow around lifts the card above it', () => {
  const errorToast = rect(712, 830, 1256, 868);
  assert.deepEqual(placeVoiceWidget({ ...viewport, obstacles: [errorToast] }), { bottom: 900 - 830 + WIDGET_GAP, width: 720 });
});

test('a card that would have to climb past 60% of the window stays at its resting place', () => {
  const tallForm = rect(200, 200, 1080, 880);
  assert.deepEqual(placeVoiceWidget({ ...viewport, obstacles: [tallForm] }), { bottom: WIDGET_BASE_BOTTOM, width: 720 });
});

test('obstacles to the left of the centre narrow the card symmetrically too', () => {
  const placed = placeVoiceWidget({ ...viewport, obstacles: [rect(20, 820, 380, 870)] });
  assert.equal(placed.bottom, WIDGET_BASE_BOTTOM);
  assert.equal(placed.width, 2 * (640 - WIDGET_GAP - 380));
});
