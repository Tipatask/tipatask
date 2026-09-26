import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  filterAudioInputs,
  labelsUnlocked,
  buildInputDeviceOptions,
  audioConstraintsFor,
  shouldRetryWithDefault,
} from './voice-devices.js';

const LABELS = {
  defaultLabel: 'System default',
  unnamedLabel: (n) => `Microphone ${n}`,
  missingLabel: 'Saved device (not connected)',
};

test('filterAudioInputs keeps only real audioinput devices', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Default - Mic' },
    { kind: 'audioinput', deviceId: 'communications', label: 'Communications - Mic' },
    { kind: 'audioinput', deviceId: '', label: '' },
    { kind: 'audiooutput', deviceId: 'speaker1', label: 'Speakers' },
    { kind: 'audioinput', deviceId: 'mic1', label: 'USB Mic' },
    { kind: 'videoinput', deviceId: 'cam1', label: 'Webcam' },
  ];
  assert.deepEqual(filterAudioInputs(devices), [{ kind: 'audioinput', deviceId: 'mic1', label: 'USB Mic' }]);
});

test('filterAudioInputs handles null/undefined input', () => {
  assert.deepEqual(filterAudioInputs(null), []);
  assert.deepEqual(filterAudioInputs(undefined), []);
});

test('labelsUnlocked false on empty list', () => {
  assert.equal(labelsUnlocked([]), false);
});

test('labelsUnlocked false when any label blank', () => {
  assert.equal(labelsUnlocked([{ deviceId: 'a', label: 'Mic A' }, { deviceId: 'b', label: '' }]), false);
});

test('labelsUnlocked true when every device has a label', () => {
  assert.equal(labelsUnlocked([{ deviceId: 'a', label: 'Mic A' }, { deviceId: 'b', label: 'Mic B' }]), true);
});

test('buildInputDeviceOptions: no saved id selects System default', () => {
  const inputs = [{ deviceId: 'mic1', label: 'USB Mic' }];
  const opts = buildInputDeviceOptions(inputs, '', LABELS);
  assert.deepEqual(opts, [
    { value: '', label: 'System default', selected: true },
    { value: 'mic1', label: 'USB Mic', selected: false, title: 'USB Mic' },
  ]);
});

test('buildInputDeviceOptions: saved id selects the matching row, not default', () => {
  const inputs = [{ deviceId: 'mic1', label: 'USB Mic' }, { deviceId: 'mic2', label: 'Built-in' }];
  const opts = buildInputDeviceOptions(inputs, 'mic2', LABELS);
  assert.equal(opts.find(o => o.value === '').selected, false);
  assert.equal(opts.find(o => o.value === 'mic2').selected, true);
});

test('buildInputDeviceOptions: unnamed device falls back to indexed label', () => {
  const inputs = [{ deviceId: 'mic1', label: '' }];
  const opts = buildInputDeviceOptions(inputs, '', LABELS);
  assert.equal(opts[1].label, 'Microphone 1');
  assert.equal(opts[1].title, '');
});

test('buildInputDeviceOptions: saved id absent from list appends a selected missing row', () => {
  const inputs = [{ deviceId: 'mic1', label: 'USB Mic' }];
  const opts = buildInputDeviceOptions(inputs, 'gone', LABELS);
  assert.equal(opts.length, 3);
  assert.deepEqual(opts[2], { value: 'gone', label: 'Saved device (not connected)', selected: true });
  assert.equal(opts[0].selected, false);
  assert.equal(opts[1].selected, false);
});

test('audioConstraintsFor: empty id -> plain true', () => {
  assert.equal(audioConstraintsFor(''), true);
  assert.equal(audioConstraintsFor(null), true);
});

test('audioConstraintsFor: id -> exact constraint', () => {
  assert.deepEqual(audioConstraintsFor('mic1'), { deviceId: { exact: 'mic1' } });
});

test('shouldRetryWithDefault: retries on device-gone/unreadable errors', () => {
  for (const name of ['NotFoundError', 'OverconstrainedError', 'ConstraintNotSatisfiedError', 'NotReadableError', 'AbortError']) {
    assert.equal(shouldRetryWithDefault({ name }), true, name);
  }
});

test('shouldRetryWithDefault: never retries on permission denial', () => {
  assert.equal(shouldRetryWithDefault({ name: 'NotAllowedError' }), false);
  assert.equal(shouldRetryWithDefault({ name: 'SecurityError' }), false);
});

test('shouldRetryWithDefault: falsy error does not retry', () => {
  assert.equal(shouldRetryWithDefault(null), false);
  assert.equal(shouldRetryWithDefault(undefined), false);
});
