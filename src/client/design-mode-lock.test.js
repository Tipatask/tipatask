import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard live re-enabling of design-mode and model controls after a task
// returns to pending. Initial disabled state is set at render time; status
// changes must resync it without rebuilding the editor.

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EDIT_MODAL_PATH = path.join(CLIENT_DIR, 'task-edit-modal.js');
const editModalSrc = fs.readFileSync(EDIT_MODAL_PATH, 'utf8');

function sliceFunctionBody(src, needle) {
  const start = src.indexOf(needle);
  assert.notEqual(start, -1, `expected to find "${needle}"`);
  const end = src.indexOf('\nfunction ', start + 1);
  const end2 = src.indexOf('\nexport function ', start + 1);
  const stop = [end, end2].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  return stop === undefined ? src.slice(start) : src.slice(start, stop);
}

test('_applyModalLockState() re-syncs agent-model select + design-mode checkbox disabled state', () => {
  const body = sliceFunctionBody(editModalSrc, 'function _applyModalLockState(');
  assert.match(body, /\.modal-agent-model-select/, 'expected the model select to be re-synced here');
  assert.match(body, /\.modal-claude-design-mode/, 'expected the design-mode checkbox to be re-synced here');
  assert.match(body, /isAgentLocked\(/, 'expected the same lock predicate the render path uses');
  // (TPT179) The read-only predicate is _isModalReadOnly() = isTaskReadOnly() (teammate's task,
  // C1407) OR callbacks.readOnly; discuss-preview.test.js pins that it still wraps isTaskReadOnly().
  assert.match(body, /_isModalReadOnly\(/, 'expected the read-only predicate folded into the lock too');
  assert.match(body, /modelSelect\.disabled\s*=/, 'expected the model select .disabled to be reassigned');
  assert.match(body, /designModeCb\.disabled\s*=/, 'expected the design-mode checkbox .disabled to be reassigned');
});

test('status change handler still delegates lock re-sync through _applyModalLockState()', () => {
  const start = editModalSrc.indexOf("statusSelect.addEventListener('change'");
  assert.notEqual(start, -1, 'expected the status change handler');
  const end = editModalSrc.indexOf('\n  });', start);
  const body = editModalSrc.slice(start, end === -1 ? undefined : end);
  assert.match(body, /_applyModalLockState\(modal, _modalState\.draft\)/, 'status handler must call the shared lock re-sync');
});
