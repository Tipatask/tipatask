import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideOpenAction, isUnboundWindow, normalizeEntry, wizardPresetLocked, OPEN_ENTRY, CREATE_ENTRY } from './project-open-flow.js';

// (C1388) decideOpenAction() is the pure decision core of the Open Project / Create Project
// flow (template.html's openOrCreateProject(entry)). No DOM, no IPC — the truth table below
// is what actually decides whether a second window or the project wizard spawns.

test('no pick (user cancelled the folder picker) — do nothing', () => {
  assert.deepEqual(decideOpenAction({ pick: null, alreadyOpen: false }), { action: 'none' });
});

test('picked path already owned by a live window — focus it, do not touch needsSetup', () => {
  // alreadyOpen wins regardless of what pick.needsSetup says — focusProjectWindow()
  // already succeeded by the time this is computed, so there is nothing left to decide.
  assert.deepEqual(
    decideOpenAction({ pick: { path: '/p', needsSetup: true }, alreadyOpen: true }),
    { action: 'focused' },
  );
  assert.deepEqual(
    decideOpenAction({ pick: { path: '/p', config: {} }, alreadyOpen: true }),
    { action: 'focused' },
  );
});

test('configured project, not already open — open it in a new window', () => {
  assert.deepEqual(
    decideOpenAction({ pick: { path: '/p', config: { TASK_BACKEND: 'api' } }, alreadyOpen: false }),
    { action: 'open-new', path: '/p' },
  );
});

test('unconfigured folder, not already open — open the project wizard directly, carrying the entry (TPT557, TPT9318)', () => {
  assert.deepEqual(
    decideOpenAction({ pick: { path: '/p', needsSetup: true }, alreadyOpen: false, entry: 'open' }),
    { action: 'open-wizard', path: '/p', entry: 'open' },
  );
  assert.deepEqual(
    decideOpenAction({ pick: { path: '/p', needsSetup: true }, alreadyOpen: false, entry: 'create' }),
    { action: 'open-wizard', path: '/p', entry: 'create' },
  );
  // No (or an unknown) entry keeps the full wizard with its Preset step — the pre-split behavior.
  assert.deepEqual(
    decideOpenAction({ pick: { path: '/p', needsSetup: true }, alreadyOpen: false }),
    { action: 'open-wizard', path: '/p', entry: 'create' },
  );
});

// (TPT9318) The two entries differ only for an unconfigured folder: a configured one opens,
// and a folder already owned by a window is focused, whichever menu item or button asked.
for (const entry of [OPEN_ENTRY, CREATE_ENTRY]) {
  test(`${entry} entry: a configured folder still opens, and an open one is focused`, () => {
    assert.deepEqual(
      decideOpenAction({ pick: { path: '/p', config: { TASK_BACKEND: 'api' } }, alreadyOpen: false, entry }),
      { action: 'open-new', path: '/p' },
    );
    assert.deepEqual(
      decideOpenAction({ pick: { path: '/p', config: { TASK_BACKEND: 'api' } }, alreadyOpen: true, entry }),
      { action: 'focused' },
    );
    assert.deepEqual(
      decideOpenAction({ pick: { path: '/p', needsSetup: true }, alreadyOpen: true, entry }),
      { action: 'focused' },
    );
    assert.deepEqual(decideOpenAction({ pick: null, alreadyOpen: false, entry }), { action: 'none' });
  });
}

test('entries: open and create are the menu action strings; only open locks the wizard preset', () => {
  assert.equal(OPEN_ENTRY, 'open');
  assert.equal(CREATE_ENTRY, 'create');
  assert.equal(normalizeEntry('open'), 'open');
  assert.equal(normalizeEntry('create'), 'create');
  for (const other of [undefined, null, '', 'choose', 'OPEN']) assert.equal(normalizeEntry(other), 'create');
  assert.equal(wizardPresetLocked('open'), true);
  for (const other of ['create', undefined, null, 'choose']) assert.equal(wizardPresetLocked(other), false);
});

// (TPT556) isUnboundWindow() — the one definition of "this window has no project". The
// default empty window (no folder) and a folder whose config lacks API_PROJECT_ID are both
// unbound: Get Started must stay reachable and re-auth must be account-only for them.

test('isUnboundWindow: no folder → unbound, whatever the config says', () => {
  assert.equal(isUnboundWindow(), true);
  assert.equal(isUnboundWindow({}), true);
  assert.equal(isUnboundWindow({ projectPath: null, config: { API_PROJECT_ID: '2' } }), true);
  assert.equal(isUnboundWindow({ projectPath: '', config: { API_PROJECT_ID: '2' } }), true);
});

test('isUnboundWindow: folder but no usable API_PROJECT_ID → unbound', () => {
  assert.equal(isUnboundWindow({ projectPath: '/p' }), true);
  assert.equal(isUnboundWindow({ projectPath: '/p', config: null }), true);
  assert.equal(isUnboundWindow({ projectPath: '/p', config: {} }), true);
  assert.equal(isUnboundWindow({ projectPath: '/p', config: { API_PROJECT_ID: '' } }), true);
  assert.equal(isUnboundWindow({ projectPath: '/p', config: { API_PROJECT_ID: '   ' } }), true);
  assert.equal(isUnboundWindow({ projectPath: '/p', config: { API_PROJECT_ID: undefined } }), true);
});

test('isUnboundWindow: folder + API_PROJECT_ID (string or number) → bound', () => {
  assert.equal(isUnboundWindow({ projectPath: '/p', config: { API_PROJECT_ID: '2' } }), false);
  assert.equal(isUnboundWindow({ projectPath: '/p', config: { API_PROJECT_ID: 2 } }), false);
});
