'use strict';

// (TPT9002) terminal-copy.js — the server-side table behind the project-language [Task App]
// notices and watchdog texts. Mirrors the client's i18n.test.js parity rules.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { LOCALES, normalizeLocale, terminalCopy } = require('./terminal-copy');

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every locale defines exactly the keys en defines, non-empty, and uk never repeats the English text', () => {
  const enKeys = Object.keys(LOCALES.en);
  assert.ok(enKeys.length > 50, 'the table covers every server notice');
  for (const [locale, table] of Object.entries(LOCALES)) {
    if (locale === 'en') continue;
    assert.deepEqual(enKeys.filter((k) => !Object.hasOwn(table, k)), [], `${locale} is missing keys present in en`);
    assert.deepEqual(Object.keys(table).filter((k) => !Object.hasOwn(LOCALES.en, k)), [], `${locale} defines keys en lacks`);
  }
  for (const key of enKeys) {
    for (const [locale, table] of Object.entries(LOCALES)) {
      assert.ok(table[key].trim(), `${locale}.${key} must be a non-empty string`);
    }
    assert.notEqual(LOCALES.uk[key], LOCALES.en[key], `uk.${key} must not be the English text`);
  }
});

test('every translation keeps exactly the placeholders its English template uses', () => {
  for (const key of Object.keys(LOCALES.en)) {
    assert.deepEqual(placeholders(LOCALES.uk[key]), placeholders(LOCALES.en[key]), `uk.${key} placeholders`);
  }
});

test('normalizeLocale: known locales pass through, anything else is en', () => {
  assert.equal(normalizeLocale('uk'), 'uk');
  assert.equal(normalizeLocale('en'), 'en');
  for (const bad of ['xx', '', null, undefined, 42, 'UK', 'constructor']) assert.equal(normalizeLocale(bad), 'en');
});

test('terminalCopy: locale table, then en, then the bare key; every placeholder occurrence is substituted', () => {
  assert.equal(terminalCopy('uk', 'notice.plan.approved'), LOCALES.uk['notice.plan.approved']);
  assert.equal(terminalCopy('xx', 'notice.plan.approved'), LOCALES.en['notice.plan.approved']);
  assert.equal(terminalCopy(undefined, 'notice.plan.approved'), LOCALES.en['notice.plan.approved']);
  assert.equal(terminalCopy('uk', 'no.such.key'), 'no.such.key');
  assert.equal(terminalCopy('en', 'watchdog.treeRss', { count: 3, rssMb: 42 }), '3 descendant processes using 42 MiB');
  assert.equal(terminalCopy('en', 'watchdog.warn.loadOne', { n: 1 }), '1 session active.');
  assert.equal(terminalCopy('uk', 'watchdog.warn.loadMany', { n: 8 }), 'Активних сесій: 8.');
  // A missing param leaves its placeholder (the client's t() rule), never "undefined".
  assert.equal(terminalCopy('en', 'watchdog.tree'), '{count} descendant processes');
});

test('the English table is the wording the server always printed', () => {
  assert.equal(LOCALES.en['notice.plan.alreadyApproved'], 'Plan is already approved.');
  assert.equal(LOCALES.en['watchdog.resumed'], 'Session resumed. The watchdog pauses it again only if it keeps growing.');
  assert.equal(
    terminalCopy('en', 'notice.planning.command', { command: '/approve-plan' }),
    'Planning mode. Review the plan, then type /approve-plan and press Enter to continue.',
  );
  assert.equal(
    terminalCopy('en', 'notice.completion.blocked', { reason: '[{"code":"unmerged_branch"}]' }),
    'Completion verification blocked: [{"code":"unmerged_branch"}]. Recheck live VCS settings and use tipatask-local complete_task after required merges and checks.',
  );
});

// (TPT9008) refreshErrorCopy(): a coded token-refresh failure in the session language, else the
// English sentence token-refresh.js produced (uncoded, unknown code, or a code missing its params).
test('refreshErrorCopy: names a coded refresh failure in the locale, keeps anything else verbatim', () => {
  const { refreshErrorCopy } = require('./terminal-copy');
  const rejected = { refreshError: 'token refresh rejected (HTTP 503)', refreshCode: 'rejected', refreshParams: { status: 503 } };
  assert.equal(refreshErrorCopy('en', rejected), 'token refresh rejected (HTTP 503)');
  assert.equal(refreshErrorCopy('uk', rejected), LOCALES.uk['notice.token.refreshError.rejected'].replace('{status}', '503'));
  assert.equal(refreshErrorCopy('uk', { refreshError: 'refresh returned no newer token', refreshCode: 'not_newer' }),
    LOCALES.uk['notice.token.refreshError.not_newer']);
  assert.equal(refreshErrorCopy('xx', { refreshError: 'x', refreshCode: 'request_timeout' }), LOCALES.en['notice.token.refreshError.request_timeout']);
  for (const detail of [
    { refreshError: 'offline' },
    { refreshError: 'offline', refreshCode: 'from_a_newer_server' },
    { refreshError: 'token refresh rejected (HTTP 503)', refreshCode: 'rejected' },
    { refreshError: 'boom', refreshCode: 'constructor' },
  ]) assert.equal(refreshErrorCopy('uk', detail), detail.refreshError);
  assert.equal(refreshErrorCopy('uk', null), '');
});
