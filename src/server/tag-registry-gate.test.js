'use strict';

// C1439 — unit tests for tag-registry-gate.js: the pure decision layer behind the
// objective-save / createTask tag-registration guard. No network, no fs — every
// function here takes plain data and returns/throws, so these run under bare
// `node --test` with zero scaffolding.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  foldTagName,
  parseTagRegistryResponse,
  buildTagIndex,
  resolveTagNames,
  unregisteredTagError,
  selectTasksToWrite,
} = require('./tag-registry-gate');

test('foldTagName trims and lowercases; non-strings fold to empty', () => {
  assert.equal(foldTagName('  Config  '), 'config');
  assert.equal(foldTagName('bugfix'), 'bugfix');
  assert.equal(foldTagName(undefined), '');
  assert.equal(foldTagName(null), '');
});

test('parseTagRegistryResponse: {tags:[...]} returns the rows, {tags:[]} is a legitimate empty registry (does not throw)', () => {
  assert.deepEqual(parseTagRegistryResponse({ tags: ['a', 'b'] }, 2), ['a', 'b']);
  assert.deepEqual(parseTagRegistryResponse({ tags: [] }, 2), []);
});

test('parseTagRegistryResponse throws TAG_REGISTRY_UNREADABLE on a 404 sentinel, a non-JSON body, or a malformed shape — never silently degrades to []', () => {
  const cases = [
    { _notFound: true },        // apiRequest's 404 sentinel
    'not json',                 // cli/http.js's JSON.parse-failure fallback (raw string body)
    null,
    undefined,
    {},                         // no `tags` key at all
    { tags: 'oops' },           // tags present but not an array
  ];
  for (const data of cases) {
    assert.throws(
      () => parseTagRegistryResponse(data, 2),
      (err) => err.code === 'TAG_REGISTRY_UNREADABLE' && /project 2/.test(err.message),
      `expected TAG_REGISTRY_UNREADABLE for ${JSON.stringify(data)}`
    );
  }
});

test('buildTagIndex + resolveTagNames: trim/case-fold matching returns the CANONICAL db spelling, not the incoming spelling', () => {
  const rows = [{ name: 'Config', description: 'x' }, 'bugfix'];
  const index = buildTagIndex(rows);
  const { unknown, canonical } = resolveTagNames(['config', ' BugFix '], index);
  assert.deepEqual(unknown, []);
  assert.equal(canonical.get('config'), 'Config');
  assert.equal(canonical.get(' BugFix '), 'bugfix');
});

test('resolveTagNames: registry read ok + empty registry + no task tags -> no unknowns (does not throw)', () => {
  const index = buildTagIndex([]);
  const { unknown } = resolveTagNames([], index);
  assert.deepEqual(unknown, []);
});

test('resolveTagNames: a tag genuinely absent from the registry is reported unknown, verbatim (untrimmed) spelling', () => {
  const index = buildTagIndex(['bugfix']);
  const { unknown, canonical } = resolveTagNames(['config'], index);
  assert.deepEqual(unknown, ['config']);
  assert.equal(canonical.size, 0);
});

test('buildTagIndex: extraKnown (this save\'s own new_tags/tagRegistrations) counts as known, fold-normalized, before the registry read confirms it', () => {
  const index = buildTagIndex([], [{ name: '  tt-new-module  ' }]);
  const { unknown, canonical } = resolveTagNames(['tt-new-module'], index);
  assert.deepEqual(unknown, []);
  assert.equal(canonical.get('tt-new-module'), 'tt-new-module');
});

test('buildTagIndex: a registered row wins over an extraKnown entry with the same folded name', () => {
  const index = buildTagIndex(['Config'], [{ name: 'config' }]);
  assert.equal(index.get('config'), 'Config');
});

test('unregisteredTagError: message names the tag(s), the project id, the registry size, and the registration guidance', () => {
  const err = unregisteredTagError(['config', 'nope'], { projectId: 2, registrySize: 273 });
  assert.match(err.message, /Unregistered tag\(s\) "config", "nope"/);
  assert.match(err.message, /project 2/);
  assert.match(err.message, /273 tags/);
  assert.match(err.message, /ensure_project_tag/);
  assert.match(err.message, /create_system_tag/);
});

test('selectTasksToWrite: excludes an unchanged carried-over task (the objective-parent-task.js `tags: []` scenario) but includes new/modified/live-less tasks', () => {
  const tasksDiffer = (incoming, live) => {
    if (!live) return true;
    return JSON.stringify(incoming.tags || []) !== JSON.stringify(live.tags || []);
  };
  const parsedById = new Map([
    ['C1', { id: 'C1', tags: ['stale-deleted-tag'] }],   // unchanged carried-over — must be EXCLUDED
    ['C2', { id: 'C2', tags: ['bugfix'] }],               // changed — included
    ['C3', { id: 'C3', tags: ['feature'] }],              // brand new (in newTaskIdSet) — included even though unchanged vs its own reservation placeholder
    ['C4', { id: 'C4', tags: ['config'] }],               // no live twin at all — included
  ]);
  const liveById = new Map([
    ['C1', { id: 'C1', tags: ['stale-deleted-tag'] }],
    ['C2', { id: 'C2', tags: ['old-tag'] }],
    ['C3', { id: 'C3', tags: ['feature'] }],
  ]);
  const newTaskIdSet = new Set(['C3']);

  const result = selectTasksToWrite(parsedById, liveById, newTaskIdSet, tasksDiffer);
  const ids = result.map(([id]) => id);
  assert.deepEqual(ids.sort(), ['C2', 'C3', 'C4']);
});

// ── TPT623: automatic registration of unknown tags ──

const { buildAutoRegistrations, sanitizeAutoDescription } = require('./tag-registry-gate');

test('buildAutoRegistrations keeps real descriptions and reports the rest as undescribed', () => {
  const described = new Map([
    ['logo-design', '  "Work on the product\'s logo mark and brand symbol."  '],
    ['pricing', 'Auto-registered by createTask'],
    ['empty', '   '],
  ]);
  const { registrations, undescribed } = buildAutoRegistrations(['logo-design', 'pricing', 'empty', 'missing'], described);
  assert.deepEqual(registrations, [{ name: 'logo-design', description: 'Work on the product\'s logo mark and brand symbol.' }]);
  assert.deepEqual(undescribed, ['pricing', 'empty', 'missing']);
});

test('buildAutoRegistrations never auto-registers tt-* tags', () => {
  const { registrations, undescribed } = buildAutoRegistrations(['tt-api-foo', 'TT-Bar'], { 'tt-api-foo': 'A real description.', 'TT-Bar': 'Another one.' });
  assert.deepEqual(registrations, []);
  assert.deepEqual(undescribed, ['tt-api-foo', 'TT-Bar']);
});

test('buildAutoRegistrations matches model output case-insensitively and trims names', () => {
  const { registrations } = buildAutoRegistrations([' Logo-Design '], { 'logo-design': 'Brand symbol work.' });
  assert.deepEqual(registrations, [{ name: 'Logo-Design', description: 'Brand symbol work.' }]);
});

test('sanitizeAutoDescription collapses whitespace and caps length', () => {
  assert.equal(sanitizeAutoDescription('a\n  b'), 'a b');
  assert.equal(sanitizeAutoDescription(42), '');
  assert.equal(sanitizeAutoDescription('x'.repeat(500)).length, 200);
});

test('unregisteredTagError appends an optional note', () => {
  const err = unregisteredTagError(['a'], { projectId: 7, note: 'Automatic description failed.' });
  assert.match(err.message, /then retry\. Automatic description failed\.$/);
});
