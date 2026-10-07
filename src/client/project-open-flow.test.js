import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideOpenAction, isUnboundWindow } from './project-open-flow.js';

// (C1388) decideOpenAction() is the pure decision core of the unified "Open / Create
// Project" flow (template.html's openOrCreateProject()). No DOM, no IPC — the truth
// table below is what actually decides whether a second window or the project wizard spawns.

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

test('unconfigured folder, not already open — open the project wizard directly (TPT557)', () => {
  assert.deepEqual(
    decideOpenAction({ pick: { path: '/p', needsSetup: true }, alreadyOpen: false }),
    { action: 'open-wizard', path: '/p' },
  );
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
