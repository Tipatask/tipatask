import assert from 'node:assert/strict';
import { test } from 'node:test';

const { serializeBoardFilters, sanitizeBoardFilters } = await import('./board-filter-prefs.js');

test('serializeBoardFilters: plain state → plain object, Sets → arrays', () => {
  const state = {
    searchQuery: 'auth',
    humanFilterActive: true,
    statusFilter: new Set(['in_progress', 'on_fire']),
    activeTagFilters: new Set(['tt-web-board']),
    assigneeScope: 'all',
    assigneeFilter: new Set([7, 'none']),
  };
  assert.deepEqual(serializeBoardFilters(state), {
    search: 'auth',
    human: true,
    statuses: ['in_progress', 'on_fire'],
    tags: ['tt-web-board'],
    assigneeScope: 'all',
    assignees: [7, 'none'],
  });
});

test('serializeBoardFilters: empty/defaults', () => {
  const state = { searchQuery: '', humanFilterActive: false, statusFilter: new Set(), activeTagFilters: new Set() };
  assert.deepEqual(serializeBoardFilters(state), {
    search: '', human: false, statuses: [], tags: [], assigneeScope: 'me', assignees: [],
  });
});

test('serializeBoardFilters: assigneeScope anything but "all" serializes to "me"', () => {
  const state = { searchQuery: '', humanFilterActive: false, statusFilter: new Set(), activeTagFilters: new Set(), assigneeScope: undefined };
  assert.equal(serializeBoardFilters(state).assigneeScope, 'me');
});

test('sanitizeBoardFilters: round-trips a well-formed saved value', () => {
  const saved = {
    search: 'auth', human: true, statuses: ['in_progress'], tags: ['tt-web-board'],
    assigneeScope: 'all', assignees: [7, 'none'],
  };
  const known = ['pending', 'in_progress', 'on_fire', 'completed', 'canceled'];
  assert.deepEqual(sanitizeBoardFilters(saved, known), saved);
});

test('sanitizeBoardFilters: drops a status name absent from the current registry', () => {
  const saved = { search: '', human: false, statuses: ['in_progress', 'archived'], tags: [] };
  const known = ['pending', 'in_progress', 'on_fire', 'completed', 'canceled'];
  assert.deepEqual(sanitizeBoardFilters(saved, known).statuses, ['in_progress']);
});

test('sanitizeBoardFilters: does NOT filter tags against the known-status list', () => {
  const saved = { search: '', human: false, statuses: [], tags: ['stale-tag', 'another'] };
  assert.deepEqual(sanitizeBoardFilters(saved, ['pending']).tags, ['stale-tag', 'another']);
});

test('sanitizeBoardFilters: null/undefined saved value → empty defaults, no throw', () => {
  const known = ['pending'];
  const empty = { search: '', human: false, statuses: [], tags: [], assigneeScope: 'me', assignees: [] };
  assert.deepEqual(sanitizeBoardFilters(null, known), empty);
  assert.deepEqual(sanitizeBoardFilters(undefined, known), empty);
});

test('sanitizeBoardFilters: malformed/legacy blob is tolerated field-by-field', () => {
  const garbage = { search: 42, human: 'yes', statuses: 'not-an-array', tags: null, extra: 'ignored' };
  assert.deepEqual(sanitizeBoardFilters(garbage, ['pending']), {
    search: '', human: true, statuses: [], tags: [], assigneeScope: 'me', assignees: [],
  });
});

test('sanitizeBoardFilters: no known-statuses list (undefined) drops every saved status', () => {
  const saved = { search: '', human: false, statuses: ['in_progress'], tags: [] };
  assert.deepEqual(sanitizeBoardFilters(saved).statuses, []);
});

// ── C1407: assigneeScope / assignees ──

test('sanitizeBoardFilters: assigneeScope other than "all" (including missing) coerces to "me"', () => {
  const known = ['pending'];
  assert.equal(sanitizeBoardFilters({ assigneeScope: 'all' }, known).assigneeScope, 'all');
  assert.equal(sanitizeBoardFilters({ assigneeScope: 'bogus' }, known).assigneeScope, 'me');
  assert.equal(sanitizeBoardFilters({}, known).assigneeScope, 'me');
});

test('sanitizeBoardFilters: assignees keeps finite numbers and the "none" sentinel, drops junk', () => {
  const known = ['pending'];
  const saved = { assignees: [7, 'none', 'not-a-number', null, NaN, 3.5] };
  assert.deepEqual(sanitizeBoardFilters(saved, known).assignees, [7, 'none', 3.5]);
});

test('sanitizeBoardFilters: assignees is NOT filtered against the known-status list (a removed member is an unchecked row, not a silent empty board)', () => {
  const known = ['pending'];
  const saved = { assignees: [999] }; // member no longer on the project
  assert.deepEqual(sanitizeBoardFilters(saved, known).assignees, [999]);
});

test('sanitizeBoardFilters: legacy blob with neither assigneeScope nor assignees defaults both, no throw', () => {
  const legacy = { search: 'x', human: true, statuses: [], tags: [] }; // pre-C1407 shape
  const result = sanitizeBoardFilters(legacy, ['pending']);
  assert.equal(result.assigneeScope, 'me');
  assert.deepEqual(result.assignees, []);
});
