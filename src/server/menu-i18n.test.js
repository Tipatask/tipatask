'use strict';

// (C1388) Tests ../../main/menu-i18n.js from here for the same reason as
// window-registry.test.js — npm test only globs 'src/**/*.test.js', main/ sits
// outside it. menu-i18n.js has zero electron dependency (plain data + t()-style
// lookup), so no Module._load faking needed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { LOCALES, setMenuLocale, getMenuLocale, mt } = require('../../main/menu-i18n');

test('every locale defines at least every key en defines (mirrors src/client/i18n.test.js\'s parity rule)', () => {
  const enKeys = new Set(Object.keys(LOCALES.en));
  for (const [locale, table] of Object.entries(LOCALES)) {
    if (locale === 'en') continue;
    const localeKeys = new Set(Object.keys(table));
    const missing = [...enKeys].filter((k) => !localeKeys.has(k));
    assert.deepEqual(missing, [], `${locale} is missing keys present in en`);
  }
});

test('setMenuLocale rejects an unknown locale, falling back to en', () => {
  setMenuLocale('uk');
  assert.equal(getMenuLocale(), 'uk');
  setMenuLocale('xx-not-a-locale');
  assert.equal(getMenuLocale(), 'en');
});

test('mt() resolves the active locale, falls back to en for a missing key, and to the bare key as a last resort', () => {
  setMenuLocale('uk');
  assert.equal(mt('menu.project'), LOCALES.uk['menu.project']);
  setMenuLocale('en');
  assert.equal(mt('menu.project'), LOCALES.en['menu.project']);
  assert.equal(mt('menu.totally-made-up-key'), 'menu.totally-made-up-key');
});

test('confirm.quitButtons / confirm.closeProjectButtons stay two-element arrays in every locale (dialog.showMessageBox button order is load-bearing — defaultId/cancelId index into this array)', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    assert.equal(table['confirm.quitButtons'].length, 2, `${locale} confirm.quitButtons`);
    assert.equal(table['confirm.closeProjectButtons'].length, 2, `${locale} confirm.closeProjectButtons`);
  }
});

// (TPT345) Menu items that open a dialog end with an ellipsis (Settings…, Rename Project…);
// the Merge task branches item opens the merge panel and must follow the same convention.
test('menu.mergeTaskBranches ends with an ellipsis in every locale', () => {
  for (const [locale, table] of Object.entries(LOCALES)) {
    assert.ok(typeof table['menu.mergeTaskBranches'] === 'string' && table['menu.mergeTaskBranches'].endsWith('…'), `${locale} menu.mergeTaskBranches`);
  }
});
