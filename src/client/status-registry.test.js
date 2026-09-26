import assert from 'node:assert/strict';
import { test } from 'node:test';

const registry = await import('./status-registry.js');
const {
  statusNames, statusRoles, statusLabel, statusOrder, statusColor, statusRoleToken,
  startName, inProgressName, completeName, canceledName,
  isStartName, isInProgressName, isCompleteName, isCanceledName,
  isClosedName, isActiveName, activeNames, rolesFromStatuses,
  loadStatuses, refreshStatuses, resetStatuses, seedStatuses, getStatuses,
  LEGACY_STATUSES, LEGACY_ROLE_NAMES,
} = registry;

const { LOCALES, setLocale, getLocale } = await import('./i18n.js');

// server-side twin, imported cross-dir (CJS -> ESM interop, same trick dep-priority.test.js
// relies on) — used only to assert the two legacy copies stay in sync.
const server = await import('../server/status-roles.js');

// Every test resets to the legacy seed first so tests don't leak state onto each other —
// resetStatuses() is itself one of the behaviors under test, exercised implicitly by every
// other test's setup.
function reset() {
  resetStatuses();
}

// ── Legacy-seed identity (regression fence) ──
// This is what keeps utils.test.js's ['pending', undefined] assertion and
// attention-notifications.test.js's 'in_progress' fallback assertions green with zero
// edits — both call startName()/inProgressName() pre-fetch and expect the legacy values.

test('legacy seed: statusNames() is the exact legacy 5, in registry order', () => {
  reset();
  assert.deepEqual(statusNames(), ['pending', 'in_progress', 'on_fire', 'completed', 'canceled']);
});

test('legacy seed: role name getters resolve to the legacy literals', () => {
  reset();
  assert.equal(startName(), 'pending');
  assert.equal(inProgressName(), 'in_progress');
  assert.equal(completeName(), 'completed');
  assert.equal(canceledName(), 'canceled');
});

test('legacy seed: statusLabel for the legacy 5 matches the en locale table exactly', () => {
  reset();
  for (const name of ['pending', 'in_progress', 'on_fire', 'completed', 'canceled']) {
    assert.equal(statusLabel(name), LOCALES.en[`status.${name}`]);
  }
});

// ── Server-twin parity ──

test('server-twin parity: client LEGACY_STATUSES matches server LEGACY_STATUSES (plus is_workflow_canceled)', () => {
  assert.deepEqual(LEGACY_STATUSES, server.LEGACY_STATUSES);
});

test('server-twin parity: client LEGACY_ROLE_NAMES matches server LEGACY_ROLE_NAMES', () => {
  assert.deepEqual(LEGACY_ROLE_NAMES, server.LEGACY_ROLE_NAMES);
});

test('server-twin parity: rolesFromStatuses(server.LEGACY_STATUSES) resolves to LEGACY_ROLE_NAMES on both sides', () => {
  assert.deepEqual(rolesFromStatuses(server.LEGACY_STATUSES), LEGACY_ROLE_NAMES);
  assert.deepEqual(server.rolesFromStatuses(LEGACY_STATUSES), server.LEGACY_ROLE_NAMES);
});

// ── isClosedName / isActiveName / activeNames ──

test('isClosedName: legacy registry — complete and canceled roles are closed, everything else active', () => {
  reset();
  assert.equal(isClosedName('completed'), true);
  assert.equal(isClosedName('canceled'), true);
  assert.equal(isClosedName('pending'), false);
  assert.equal(isClosedName('in_progress'), false);
  assert.equal(isClosedName('on_fire'), false);
  assert.deepEqual(activeNames(), ['pending', 'in_progress', 'on_fire']);
});

test('isClosedName: renamed registry WITH the is_workflow_canceled flag resolves by role, not literal name', () => {
  seedStatuses([
    { name: 'Backlog', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false, display_order: 0 },
    { name: 'Doing', is_workflow_start: false, is_in_progress: true, is_workflow_complete: false, is_workflow_canceled: false, display_order: 1 },
    { name: 'Shipped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false, display_order: 2 },
    { name: 'Dropped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: true, display_order: 3 },
  ]);
  assert.equal(isClosedName('Dropped'), true);
  assert.equal(isClosedName('canceled'), false); // literal-name residue is gone
  assert.equal(isClosedName('Shipped'), true);
  assert.deepEqual(activeNames(), ['Backlog', 'Doing']);
  reset();
});

test('isClosedName: renamed registry WITHOUT the is_workflow_canceled column (pre-C1187 API/file backend) still recognizes a literal "canceled" name via the legacy role fallback', () => {
  seedStatuses([
    { name: 'Backlog', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, display_order: 0 },
    { name: 'Doing', is_workflow_start: false, is_in_progress: true, is_workflow_complete: false, display_order: 1 },
    { name: 'canceled', is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, display_order: 2 },
  ]);
  // No row holds is_workflow_canceled -> rolesFromStatuses() falls back to the legacy
  // 'canceled' role name, which happens to exist in this registry -> still closed.
  assert.equal(isClosedName('canceled'), true);
  reset();
});

test('isActiveName: on_fire is active on both the legacy and a renamed registry (no role of its own)', () => {
  reset();
  assert.equal(isActiveName('on_fire'), true);
  seedStatuses([
    { name: 'Backlog', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false, display_order: 0 },
    { name: 'on_fire', is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false, display_order: 1 },
    { name: 'Shipped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false, display_order: 2 },
  ]);
  assert.equal(isActiveName('on_fire'), true);
  reset();
});

// ── isStartName / isInProgressName / isCompleteName / isCanceledName ──

test('role predicates resolve correctly on a renamed registry', () => {
  seedStatuses([
    { name: 'Backlog', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false, display_order: 0 },
    { name: 'Doing', is_workflow_start: false, is_in_progress: true, is_workflow_complete: false, is_workflow_canceled: false, display_order: 1 },
    { name: 'Shipped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false, display_order: 2 },
    { name: 'Dropped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: true, display_order: 3 },
  ]);
  assert.equal(isStartName('Backlog'), true);
  assert.equal(isInProgressName('Doing'), true);
  assert.equal(isCompleteName('Shipped'), true);
  assert.equal(isCanceledName('Dropped'), true);
  assert.equal(isStartName('pending'), false); // not this project's start name
  reset();
});

// ── statusLabel ──

test('statusLabel: humanizes a custom status name', () => {
  reset();
  assert.equal(statusLabel('qa_review'), 'Qa Review');
});

test('statusLabel: never leaks the raw i18n key for a name with no translation table entry (the bug a naive t() call would cause)', () => {
  reset();
  assert.notEqual(statusLabel('qa_review'), 'status.qa_review');
});

test('statusLabel: empty/falsy name returns empty string', () => {
  assert.equal(statusLabel(''), '');
  assert.equal(statusLabel(null), '');
  assert.equal(statusLabel(undefined), '');
});

test('statusLabel: is locale-live for the legacy 5, unaffected for custom names', () => {
  reset();
  const original = getLocale();
  try {
    setLocale('uk');
    assert.equal(statusLabel('pending'), LOCALES.uk['status.pending']);
    assert.equal(statusLabel('qa_review'), 'Qa Review');
  } finally {
    setLocale(original);
  }
});

// ── statusOrder ──

test('statusOrder: registry display_order wins when the name is in the loaded registry', () => {
  seedStatuses([
    { name: 'Backlog', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false, display_order: 0 },
    { name: 'Doing', is_workflow_start: false, is_in_progress: true, is_workflow_complete: false, is_workflow_canceled: false, display_order: 1 },
  ]);
  assert.equal(statusOrder('Backlog'), 0);
  assert.equal(statusOrder('Doing'), 1);
  reset();
});

test('statusOrder: legacy board-sort fallback for a legacy name absent from a renamed registry', () => {
  seedStatuses([
    { name: 'Backlog', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false, display_order: 0 },
  ]);
  assert.equal(statusOrder('on_fire'), 0); // LEGACY_STATUS_ORDER.on_fire
  assert.equal(statusOrder('completed'), 3);
  reset();
});

test('statusOrder: unknown name (not in registry, not legacy) falls back to 999', () => {
  reset();
  assert.equal(statusOrder('totally_unknown_status'), 999);
});

// ── statusColor / statusRoleToken ──

test('statusColor: resolves each role to its swatch hex, falls back to overlay1 for an unknown color token', () => {
  reset();
  assert.equal(statusColor('in_progress'), '#89b4fa'); // blue
  assert.equal(statusColor('completed'), '#a6e3a1'); // green
  seedStatuses([{ name: 'Weird', color: 'not-a-real-token', is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false, display_order: 0 }]);
  assert.equal(statusColor('Weird'), '#7f849c'); // overlay1 fallback
  reset();
});

test('statusRoleToken: maps every role plus "other" for a non-role status', () => {
  reset();
  assert.equal(statusRoleToken('pending'), 'start');
  assert.equal(statusRoleToken('in_progress'), 'in-progress');
  assert.equal(statusRoleToken('completed'), 'complete');
  assert.equal(statusRoleToken('canceled'), 'canceled');
  assert.equal(statusRoleToken('on_fire'), 'other');
});

// ── Fail-soft refresh ──
// Under plain `node --test` there is no `window`, so api-client.js's ipc is null and
// api.statuses.list() falls through to a relative-URL fetch() — which Node's fetch
// rejects immediately ("Failed to parse URL"). This deterministically exercises the
// real failure path with no server/mocking needed.

test('loadStatuses/refreshStatuses: a failing fetch never throws and never reverts a previously-seeded custom registry', async () => {
  seedStatuses([
    { name: 'Backlog', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false, display_order: 0 },
  ]);
  assert.equal(startName(), 'Backlog');
  await assert.doesNotReject(refreshStatuses());
  assert.equal(startName(), 'Backlog'); // unchanged — fail-soft kept the seeded rows
  reset();
});

test('loadStatuses: first call on a cold (legacy-seeded) registry degrades gracefully on fetch failure', async () => {
  reset();
  await assert.doesNotReject(loadStatuses());
  assert.deepEqual(statusNames(), ['pending', 'in_progress', 'on_fire', 'completed', 'canceled']);
});

// ── seedStatuses / resetStatuses / getStatuses ──

test('seedStatuses: adopts the given rows synchronously, no HTTP', () => {
  seedStatuses([
    { name: 'Todo', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false, display_order: 0 },
    { name: 'Done', is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false, display_order: 1 },
  ]);
  assert.deepEqual(statusNames(), ['Todo', 'Done']);
  assert.equal(startName(), 'Todo');
  assert.equal(completeName(), 'Done');
  reset();
});

test('seedStatuses: an empty array is rejected — never adopts an empty registry', () => {
  seedStatuses([{ name: 'Todo', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false, display_order: 0 }]);
  seedStatuses([]);
  assert.deepEqual(statusNames(), ['Todo']); // unchanged
  reset();
});

test('resetStatuses: returns to the exact legacy seed after a custom registry was loaded', () => {
  seedStatuses([{ name: 'Todo', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false, display_order: 0 }]);
  resetStatuses();
  assert.deepEqual(statusNames(), ['pending', 'in_progress', 'on_fire', 'completed', 'canceled']);
  assert.deepEqual(statusRoles(), LEGACY_ROLE_NAMES);
});

test('getStatuses: returns a copy, not the live internal array', () => {
  reset();
  const rows = getStatuses();
  rows.push({ name: 'injected' });
  assert.equal(statusNames().includes('injected'), false);
});
