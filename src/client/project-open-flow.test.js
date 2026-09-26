import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideOpenAction } from './project-open-flow.js';

// (C1388) decideOpenAction() is the pure decision core of the unified "Open / Create
// Project" flow (template.html's openOrCreateProject()). No DOM, no IPC — the truth
// table below is what actually decides whether a second window/setup-picker spawns.

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

test('unconfigured folder, not already open — ask Connect-existing vs Create-new', () => {
  assert.deepEqual(
    decideOpenAction({ pick: { path: '/p', needsSetup: true }, alreadyOpen: false }),
    { action: 'choose-setup-kind', path: '/p' },
  );
});
