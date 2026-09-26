import assert from 'node:assert/strict';
import { test } from 'node:test';

const { floatTo16LE, frameLevel } = await import('./pcm.js');

test('floatTo16LE: clamps to [-1, 1] and maps full-scale/mid-range samples correctly', () => {
  const input = new Float32Array([0, 1, -1, 0.5, -0.5, 2, -2]); // last two exercise clamping
  const buf = floatTo16LE(input);
  const view = new DataView(buf);
  assert.equal(buf.byteLength, 14);
  assert.equal(view.getInt16(0, true), 0);
  assert.equal(view.getInt16(2, true), 0x7fff);
  assert.equal(view.getInt16(4, true), -0x8000);
  assert.ok(Math.abs(view.getInt16(6, true) - 0x7fff * 0.5) < 2);
  assert.ok(Math.abs(view.getInt16(8, true) - (-0x8000 * 0.5)) < 2);
  assert.equal(view.getInt16(10, true), 0x7fff); // clamped from 2
  assert.equal(view.getInt16(12, true), -0x8000); // clamped from -2
});

test('floatTo16LE: empty input produces an empty buffer, not a crash', () => {
  const buf = floatTo16LE(new Float32Array(0));
  assert.equal(buf.byteLength, 0);
});

test('frameLevel: silence reports rms=0, peak=0', () => {
  const { rms, peak } = frameLevel(new Float32Array([0, 0, 0, 0]));
  assert.equal(rms, 0);
  assert.equal(peak, 0);
});

test('frameLevel: full-scale samples report rms and peak of 1', () => {
  const { rms, peak } = frameLevel(new Float32Array([1, -1, 1, -1]));
  assert.equal(rms, 1);
  assert.equal(peak, 1);
});

test('frameLevel: mixed amplitudes compute correct rms and peak', () => {
  const input = new Float32Array([0.5, -0.5, 0.1, -0.9]);
  const { rms, peak } = frameLevel(input);
  // Compare against float32-precision samples (not the double-precision literals) — Float32Array
  // storage itself introduces ~1e-7 relative error, well outside a double-precision tolerance.
  const expectedRms = Math.sqrt(Array.from(input).reduce((sum, v) => sum + v * v, 0) / input.length);
  assert.ok(Math.abs(rms - expectedRms) < 1e-6);
  assert.ok(Math.abs(peak - 0.9) < 1e-6);
});

test('frameLevel: empty input reports silence, not NaN/throw', () => {
  const { rms, peak } = frameLevel(new Float32Array(0));
  assert.equal(rms, 0);
  assert.equal(peak, 0);
});
