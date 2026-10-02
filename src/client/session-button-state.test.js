import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { seedStatuses, resetStatuses } from './status-registry.js';

const { sessionButtonMode, SESSION_BUTTON_MODES } = await import('./session-button-state.js');

const readSource = name => readFileSync(new URL(name, import.meta.url), 'utf8');

// ── Legacy roles (pending/in_progress/on_fire/completed/canceled) ──

test('in_progress + no session -> RESUME (interrupted, restartable)', () => {
  resetStatuses();
  assert.equal(sessionButtonMode('in_progress', {}), SESSION_BUTTON_MODES.RESUME);
});

test('in_progress + exited session (process gone) -> RESUME', () => {
  resetStatuses();
  assert.equal(sessionButtonMode('in_progress', { exited: true }), SESSION_BUTTON_MODES.RESUME);
});

test('in_progress + active session -> RUNNING (spinner)', () => {
  resetStatuses();
  assert.equal(sessionButtonMode('in_progress', { active: true }), SESSION_BUTTON_MODES.RUNNING);
});

test('completed + active session -> RESUME (agent kept going past the status write)', () => {
  resetStatuses();
  assert.equal(sessionButtonMode('completed', { active: true }), SESSION_BUTTON_MODES.RESUME);
});

test('completed + exited session -> RESUME (unchanged "other" case)', () => {
  resetStatuses();
  assert.equal(sessionButtonMode('completed', { exited: true }), SESSION_BUTTON_MODES.RESUME);
});

test('completed + no session -> START', () => {
  resetStatuses();
  assert.equal(sessionButtonMode('completed', {}), SESSION_BUTTON_MODES.START);
});

test('pending + no session -> START', () => {
  resetStatuses();
  assert.equal(sessionButtonMode('pending', {}), SESSION_BUTTON_MODES.START);
});

test('pending + active session -> RESUME (unchanged "other" case)', () => {
  resetStatuses();
  assert.equal(sessionButtonMode('pending', { active: true }), SESSION_BUTTON_MODES.RESUME);
});

test('unknown/blank status + no session -> START (fails open, same as isInProgressName/isCompleteName)', () => {
  resetStatuses();
  assert.equal(sessionButtonMode(undefined, {}), SESSION_BUTTON_MODES.START);
  assert.equal(sessionButtonMode('', {}), SESSION_BUTTON_MODES.START);
});

// ── Role-derived, not literal-name-derived (C1187 discipline) ──

test('mode is resolved from the project\'s custom role names, not hardcoded legacy literals', () => {
  seedStatuses([
    { name: 'todo', display_order: 0, is_workflow_start: true, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: false },
    { name: 'doing', display_order: 1, is_workflow_start: false, is_in_progress: true, is_workflow_complete: false, is_workflow_canceled: false },
    { name: 'shipped', display_order: 2, is_workflow_start: false, is_in_progress: false, is_workflow_complete: true, is_workflow_canceled: false },
    { name: 'dropped', display_order: 3, is_workflow_start: false, is_in_progress: false, is_workflow_complete: false, is_workflow_canceled: true },
  ]);
  try {
    // The literal string 'in_progress' is no longer a real role name in this project (the
    // in-progress role is held by 'doing' instead) — it must NOT be treated as in-progress
    // just because it matches the legacy default. It falls into the unchanged "other" bucket,
    // same as any non-in-progress/non-complete status with an active session: RESUME.
    assert.equal(sessionButtonMode('in_progress', { active: true }), SESSION_BUTTON_MODES.RESUME);
    assert.equal(sessionButtonMode('doing', { active: true }), SESSION_BUTTON_MODES.RUNNING);
    assert.equal(sessionButtonMode('doing', {}), SESSION_BUTTON_MODES.RESUME);
    assert.equal(sessionButtonMode('shipped', { active: true }), SESSION_BUTTON_MODES.RESUME);
    assert.equal(sessionButtonMode('shipped', {}), SESSION_BUTTON_MODES.START);
  } finally {
    resetStatuses();
  }
});

// ── Wiring: callers actually go through the shared helper, not their own re-derivation ──

test('task-board.js updateClaudeButtons() computes the card button from sessionButtonMode()', () => {
  const src = readSource('task-board.js');
  assert.match(src, /import \{ sessionButtonMode, SESSION_BUTTON_MODES \} from '\.\/session-button-state\.js';/);
  const start = src.indexOf('export function updateClaudeButtons(');
  const end = src.indexOf('\ndocument.querySelectorAll(\'.btn-start-discussion\')', start);
  const body = src.slice(start, end);
  assert.match(body, /const mode = sessionButtonMode\(card\?\.dataset\.status, \{ active: isActive, exited: isExited, queued: queuedPosition !== undefined \}\);/);
  assert.match(body, /mode === SESSION_BUTTON_MODES\.RUNNING/);
  assert.match(body, /session-spinner/);
});

test('task-edit-modal.js resolves the footer button from _modalSessionButton()/sessionButtonMode()', () => {
  const src = readSource('task-edit-modal.js');
  assert.match(src, /import \{ sessionButtonMode, SESSION_BUTTON_MODES \} from '\.\/session-button-state\.js';/);
  assert.match(src, /function _modalSessionButton\(task\)/);
  assert.match(src, /const mode = sessionButtonMode\(savedStatus, \{ active, exited, queued: queuedPosition !== undefined \}\);/);
  // reads the SAVED status, not the unsaved draft, so an unsubmitted status-select edit can't
  // flip the button ahead of what clicking Start would actually do (C1316).
  assert.match(src, /const savedStatus = _modalState\?\.lastSaved\?\.status \?\? task\?\.status;/);
});

test('task-card.js refreshCard() repaints the console-control button on a status change', () => {
  const src = readSource('task-card.js');
  assert.match(src, /import \{ showBulkAgentStartModal, terminateSessionFromCard, refreshParentSubtaskLabel, updateClaudeButtons \} from '\.\/task-board\.js';/);
  const start = src.indexOf('export function refreshCard(');
  const end = src.indexOf('\n// ── Sprint regroup', start);
  const body = src.slice(start, end);
  assert.match(body, /const prevStatus = card\.dataset\.status;/);
  assert.match(body, /const statusChanged = prevStatus !== t\.status;/);
  assert.match(body, /if \(statusChanged && card\.querySelector\('\.btn-claude, \.btn-start-discussion'\)\) updateClaudeButtons\(\);/);
});

test('styles.css defines .session-spinner reusing the shared spin keyframe', () => {
  const css = readSource('styles.css');
  assert.match(css, /\.session-spinner\s*\{[^}]*animation:\s*spin\s/);
  assert.match(css, /\.modal-context-btns \.session-spinner\s*\{/);
});

test('i18n.js: btn.show / tooltip.showRunningSession are defined for both locales', () => {
  const i18n = readSource('i18n.js');
  assert.equal((i18n.match(/'btn\.show':/g) || []).length, 2);
  assert.equal((i18n.match(/'tooltip\.showRunningSession':/g) || []).length, 2);
});

// ── (TPT444) QUEUED mode ──

test('sessionButtonMode: a queued start reads QUEUED regardless of status or session flags', () => {
  assert.equal(sessionButtonMode('pending', { queued: true }), SESSION_BUTTON_MODES.QUEUED);
  assert.equal(sessionButtonMode('in_progress', { queued: true, active: true }), SESSION_BUTTON_MODES.QUEUED);
  assert.equal(sessionButtonMode('completed', { queued: true, exited: true }), SESSION_BUTTON_MODES.QUEUED);
  assert.equal(sessionButtonMode('pending', { queued: false }), SESSION_BUTTON_MODES.START);
});

test('task-board.js paints a Queued #N chip with Stop for QUEUED, and the edit modal mirrors it', () => {
  const board = readSource('task-board.js');
  assert.match(board, /queued: queuedPosition !== undefined/);
  assert.match(board, /mode === SESSION_BUTTON_MODES\.QUEUED/);
  assert.match(board, /t\('queue\.badge', \{ position: queuedPosition/);
  assert.match(board, /state\.queuedSessions\.delete\(taskId\); \/\/ \(TPT444\)/);
  const modal = readSource('task-edit-modal.js');
  assert.match(modal, /queued: queuedPosition !== undefined/);
  assert.match(modal, /SESSION_BUTTON_MODES\.QUEUED/);
});

test('i18n.js: queue strings exist in both locales', () => {
  const i18n = readSource('i18n.js');
  for (const key of ['terminal.queued', 'queue.badge', 'tooltip.queuedSession']) {
    assert.equal((i18n.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g')) || []).length, 2, key);
  }
});

test('ws-client treats session-queued as an accepted start; console-modal handles the frame', () => {
  const wsClient = readSource('ws-client.js');
  assert.match(wsClient, /msg\.type === 'session-queued'[\s\S]{0,400}finish\(true, msg\)/);
  const modal = readSource('console-modal.js');
  assert.match(modal, /msg\.type === 'session-queued'/);
  assert.match(modal, /state\.queuedSessions\.set\(taskId, msg\.position\)/);
  assert.match(modal, /state\.queuedSessions\.delete\(taskId\)\) state\.activeSessions\.add\(taskId\)/);
});
