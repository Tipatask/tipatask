'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LEGACY_STATUSES,
  LEGACY_ROLE_NAMES,
  rolesFromStatuses,
  fetchStatusRoles,
  fetchStatusNames,
  fetchStatusContext,
  isClosedName,
  activeNames,
  sanitizeStatusName,
} = require('./status-roles');

test('rolesFromStatuses: legacy 5 maps to the legacy role names', () => {
  assert.deepEqual(rolesFromStatuses(LEGACY_STATUSES), LEGACY_ROLE_NAMES);
});

test('rolesFromStatuses: renamed registry resolves by role flag, not name', () => {
  const rows = [
    { name: 'Backlog', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
    { name: 'Doing', is_workflow_start: false, is_in_progress: true, is_workflow_complete: false, is_workflow_canceled: false },
    { name: 'Shipped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false },
    { name: 'Dropped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: true },
  ];
  assert.deepEqual(rolesFromStatuses(rows), { start: 'Backlog', in_progress: 'Doing', complete: 'Shipped', canceled: 'Dropped' });
});

test('rolesFromStatuses: a registry missing a role falls back to the legacy name for just that role', () => {
  const rows = [
    { name: 'Backlog', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
    // no is_in_progress holder, no is_workflow_complete holder, no is_workflow_canceled holder
  ];
  assert.deepEqual(rolesFromStatuses(rows), { start: 'Backlog', in_progress: 'in_progress', complete: 'completed', canceled: 'canceled' });
});

test('rolesFromStatuses: a registry with no is_workflow_canceled column at all (pre-C1187 API) degrades that one role to legacy', () => {
  const rows = [
    { name: 'Backlog', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false },
    { name: 'Doing', is_workflow_start: false, is_in_progress: true, is_workflow_complete: false },
    { name: 'Shipped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: true },
  ];
  assert.deepEqual(rolesFromStatuses(rows), { start: 'Backlog', in_progress: 'Doing', complete: 'Shipped', canceled: 'canceled' });
});

test('rolesFromStatuses: empty array or non-array input never throws, always full legacy map', () => {
  assert.deepEqual(rolesFromStatuses([]), LEGACY_ROLE_NAMES);
  assert.deepEqual(rolesFromStatuses(null), LEGACY_ROLE_NAMES);
  assert.deepEqual(rolesFromStatuses(undefined), LEGACY_ROLE_NAMES);
});

test('fetchStatusRoles: no backend, or a backend with no getStatuses, degrades to legacy', async () => {
  assert.deepEqual(await fetchStatusRoles(null), LEGACY_ROLE_NAMES);
  assert.deepEqual(await fetchStatusRoles({}), LEGACY_ROLE_NAMES);
});

test('fetchStatusRoles: a rejecting getStatuses() never throws, degrades to legacy', async () => {
  const backend = { async getStatuses() { throw new Error('network down'); } };
  assert.deepEqual(await fetchStatusRoles(backend), LEGACY_ROLE_NAMES);
});

test('fetchStatusRoles: forwards opts (e.g. {refresh:true}) to backend.getStatuses', async () => {
  let seenOpts = null;
  const backend = { async getStatuses(opts) { seenOpts = opts; return LEGACY_STATUSES; } };
  await fetchStatusRoles(backend, { refresh: true });
  assert.deepEqual(seenOpts, { refresh: true });
});

test('fetchStatusNames: happy path returns the registry names in order', async () => {
  const rows = [{ name: 'Backlog' }, { name: 'Doing' }, { name: 'Shipped' }];
  const backend = { async getStatuses() { return rows; } };
  assert.deepEqual(await fetchStatusNames(backend), ['Backlog', 'Doing', 'Shipped']);
});

test('fetchStatusNames: empty/failing registry degrades to the legacy 5 names', async () => {
  assert.deepEqual(await fetchStatusNames({ async getStatuses() { return []; } }), LEGACY_STATUSES.map(s => s.name));
  assert.deepEqual(await fetchStatusNames({ async getStatuses() { throw new Error('x'); } }), LEGACY_STATUSES.map(s => s.name));
});

test('isClosedName / activeNames: complete role and canceled role are both closed (C1187 — fully role-derivable)', () => {
  const roles = { start: 'pending', in_progress: 'in_progress', complete: 'completed', canceled: 'canceled' };
  assert.equal(isClosedName('completed', roles), true);
  assert.equal(isClosedName('canceled', roles), true);
  assert.equal(isClosedName('pending', roles), false);
  assert.equal(isClosedName('in_progress', roles), false);
  assert.equal(isClosedName('on_fire', roles), false);
  assert.deepEqual(
    activeNames(['pending', 'in_progress', 'on_fire', 'completed', 'canceled'], roles),
    ['pending', 'in_progress', 'on_fire']
  );
});

test('isClosedName / activeNames: renamed complete AND canceled statuses are still recognized by role, not name', () => {
  const roles = { start: 'Backlog', in_progress: 'Doing', complete: 'Shipped', canceled: 'Dropped' };
  assert.equal(isClosedName('Shipped', roles), true);
  assert.equal(isClosedName('Dropped', roles), true);
  assert.equal(isClosedName('completed', roles), false); // not this project's complete name
  assert.equal(isClosedName('canceled', roles), false); // not this project's canceled name — the old name-residue is gone
  assert.deepEqual(activeNames(['Backlog', 'Doing', 'Shipped', 'Dropped'], roles), ['Backlog', 'Doing']);
});

test('fetchStatusContext: no backend degrades to a fully-populated legacy context', async () => {
  const ctx = await fetchStatusContext(null);
  assert.deepEqual(ctx.roles, LEGACY_ROLE_NAMES);
  assert.deepEqual(ctx.names, LEGACY_STATUSES.map(s => s.name));
  assert.deepEqual([...ctx.active].sort(), ['in_progress', 'on_fire', 'pending']);
  assert.deepEqual([...ctx.closed].sort(), ['canceled', 'completed']);
  assert.equal(ctx.isClosed('completed'), true);
  assert.equal(ctx.isClosed('canceled'), true);
  assert.equal(ctx.isClosed('on_fire'), false);
});

test('fetchStatusContext: a rejecting getStatuses() never throws, degrades to legacy context', async () => {
  const backend = { async getStatuses() { throw new Error('network down'); } };
  const ctx = await fetchStatusContext(backend);
  assert.deepEqual(ctx.roles, LEGACY_ROLE_NAMES);
  assert.deepEqual([...ctx.active].sort(), ['in_progress', 'on_fire', 'pending']);
});

test('fetchStatusContext: renamed registry resolves active/closed by role, single getStatuses() call', async () => {
  let calls = 0;
  const rows = [
    { name: 'Backlog', is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
    { name: 'Doing', is_workflow_start: false, is_in_progress: true, is_workflow_complete: false, is_workflow_canceled: false },
    { name: 'on_fire', is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
    { name: 'Shipped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false },
    { name: 'Dropped', is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: true },
  ];
  const backend = { async getStatuses() { calls++; return rows; } };
  const ctx = await fetchStatusContext(backend);
  assert.equal(calls, 1);
  assert.deepEqual(ctx.roles, { start: 'Backlog', in_progress: 'Doing', complete: 'Shipped', canceled: 'Dropped' });
  assert.deepEqual([...ctx.active].sort(), ['Backlog', 'Doing', 'on_fire']);
  assert.deepEqual([...ctx.closed].sort(), ['Dropped', 'Shipped']);
  assert.equal(ctx.isClosed('Dropped'), true);
  assert.equal(ctx.isClosed('canceled'), false); // literal name residue gone — 'canceled' isn't even in this registry
});

test('sanitizeStatusName: strips control chars/newlines and caps length, preserves ordinary names byte-for-byte', () => {
  assert.equal(sanitizeStatusName('Doing'), 'Doing');
  assert.equal(sanitizeStatusName('  Doing  '), 'Doing');
  assert.equal(sanitizeStatusName('Line1\nLine2'), 'Line1 Line2');
  assert.equal(sanitizeStatusName('a'.repeat(100)).length, 64);
  assert.equal(sanitizeStatusName(null), '');
  assert.equal(sanitizeStatusName(undefined), '');
  // Deliberately NOT stripped — see the function's own comment: the sanitized value is
  // also the literal string an agent PATCHes back as the status.
  assert.equal(sanitizeStatusName('In "QA"'), 'In "QA"');
});
