import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const readSource = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const editor = readSource('task-edit-modal.js');
const cards = readSource('task-card.js');

function sliceFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `expected to find ${signature}`);
  const candidates = [
    src.indexOf('\nfunction ', start + signature.length),
    src.indexOf('\nexport function ', start + signature.length),
  ].filter(index => index !== -1);
  const end = candidates.length ? Math.min(...candidates) : src.length;
  return src.slice(start, end);
}

test('task edit modal omits Chain while preserving remaining context actions', () => {
  const render = sliceFunction(editor, 'function _renderTaskEditModal()');
  assert.doesNotMatch(render, /data-action="chain"|_CHAIN_SVG|btn\.chain|tooltip\.chain/);
  for (const action of ['start', 'stop', 'reiterate', 'delete']) {
    assert.match(render, new RegExp(`data-action="${action}"`), `${action} button must remain rendered`);
  }
});

test('task edit modal handler omits Chain while preserving remaining action branches', () => {
  const handlers = sliceFunction(editor, 'function _attachModalHandlers(modal)');
  assert.doesNotMatch(handlers, /action === 'chain'|applyRelatedHighlight/);
  for (const action of ['start', 'stop', 'reiterate', 'delete']) {
    assert.match(handlers, new RegExp(`action === '${action}'`), `${action} handler must remain wired`);
  }
  assert.match(handlers, /callbacks\.onStart/);
  assert.match(handlers, /terminateSessionFromCard/);
  assert.match(handlers, /showReiterateModal/);
  assert.match(handlers, /showDeleteConfirmModal/);
});

test('confirmed saved-preview cards open the same Chain-free task edit modal', () => {
  const interactions = sliceFunction(cards, 'export function setupCardInteractions(appEl)');
  assert.match(interactions, /const isRealKey = isConfirmed && isTaskKeyLike\(taskId\)/);
  assert.match(interactions, /if \(isRealKey\) \{[\s\S]*_onOpenTaskEditModal\(taskId\)/);
  assert.doesNotMatch(sliceFunction(editor, 'function _renderTaskEditModal()'), /data-action="chain"/);
});
