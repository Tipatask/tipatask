import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPresetSeedReport } from './preset-seed-report.js';
import { t } from './i18n.js';

// Echoing `t` — returns "key|json(params)" so the assertions see exactly which key and which
// interpolation values were requested without depending on the locale strings.
const echo = (key, params) => (params ? `${key}|${JSON.stringify(params)}` : key);

test('buildPresetSeedReport: a clean seed reports nothing', () => {
  assert.equal(buildPresetSeedReport({ seeded: 5, failed: 0 }, echo), null);
});

test('buildPresetSeedReport: no seed outcome (older main process / open-existing path) reports nothing', () => {
  assert.equal(buildPresetSeedReport(undefined, echo), null);
  assert.equal(buildPresetSeedReport(null, echo), null);
  assert.equal(buildPresetSeedReport('nope', echo), null);
});

test('buildPresetSeedReport: a partial seed reports failed and total counts', () => {
  const r = buildPresetSeedReport({ seeded: 3, failed: 2 }, echo);
  assert.equal(r.title, 'project.presetSeedFailedTitle');
  assert.equal(r.body, 'project.presetSeedFailedBody|{"failed":2,"total":5}');
});

test('buildPresetSeedReport: every def failing (e.g. key reservation failed) still reports', () => {
  const r = buildPresetSeedReport({ seeded: 0, failed: 5 }, echo);
  assert.equal(r.body, 'project.presetSeedFailedBody|{"failed":5,"total":5}');
});

test('buildPresetSeedReport: a thrown seed call reports the error message, not counts', () => {
  const r = buildPresetSeedReport({ seeded: 0, failed: null, error: 'boom' }, echo);
  assert.equal(r.body, 'project.presetSeedErrorBody|{"msg":"boom"}');
});

test('the preset-seed i18n keys resolve in the real locale table (not echoed back as the raw key)', () => {
  for (const key of ['project.presetSeedFailedTitle', 'project.presetSeedFailedBody', 'project.presetSeedErrorBody']) {
    assert.notEqual(t(key, { failed: 1, total: 2, msg: 'x' }), key, `${key} is missing from the en locale`);
  }
});
