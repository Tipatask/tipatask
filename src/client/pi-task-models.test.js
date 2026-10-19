import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { piTaskModelIds, piOnlyToolLess, piTaskPinHint } from './pi-task-models.js';
import { t } from './i18n.js';

// Which configured Pi rows the task-start pickers may offer. Entries mirror the server's
// providers/registry.js listObjectiveProviders() pi entry: `configuredModels` (row ids, row order)
// and `toolLessModels` (the ids whose PI_MODELS row sets tools: false).
const pi = (configuredModels, toolLessModels = []) => ({ id: 'pi', configuredModels, toolLessModels });
const claude = { id: 'claude', configuredModels: [], toolLessModels: [] };

test('piTaskModelIds: the configured rows minus the tool-less ones, in row order', () => {
  assert.deepEqual(piTaskModelIds([claude, pi(['recraft-v3', 'a/b', 'c/d'], ['recraft-v3'])]), ['a/b', 'c/d']);
  assert.deepEqual(piTaskModelIds([pi(['a/b', 'recraft-v3'], ['recraft-v3'])]), ['a/b']);
  assert.deepEqual(piTaskModelIds([pi(['a/b', 'c/d'])]), ['a/b', 'c/d'], 'no tool-less row: every row');
});

test('piTaskModelIds: trims, de-dupes and tolerates older or missing payloads', () => {
  assert.deepEqual(piTaskModelIds([pi([' a/b ', 'a/b', '', null, 'c/d'], [' c/d'])]), ['a/b']);
  assert.deepEqual(piTaskModelIds([{ id: 'pi', configuredModels: ['a/b'] }]), ['a/b'], 'a payload without toolLessModels');
  assert.deepEqual(piTaskModelIds([claude]), []);
  assert.deepEqual(piTaskModelIds([]), []);
  assert.deepEqual(piTaskModelIds(null), []);
  assert.deepEqual(piTaskModelIds([null, { id: 'pi' }]), []);
});

test('piOnlyToolLess: true only when rows are configured and none of them can run a task', () => {
  assert.equal(piOnlyToolLess([pi(['recraft-v3'], ['recraft-v3'])]), true);
  assert.equal(piOnlyToolLess([claude, pi(['recraft-v3', 'x'], ['x', 'recraft-v3'])]), true);
  assert.equal(piOnlyToolLess([pi(['recraft-v3', 'a/b'], ['recraft-v3'])]), false);
  assert.equal(piOnlyToolLess([pi([], [])]), false, 'nothing configured says nothing');
  assert.equal(piOnlyToolLess([claude]), false, 'no pi entry loaded yet');
  assert.equal(piOnlyToolLess(undefined), false);
});

test('Pi task choices retain full model identity and match tool flags case-insensitively', () => {
  const kimi = 'openrouter/moonshotai/kimi-k3';
  const custom = 'custom/Moonshot/Kimi-K3';
  assert.deepEqual(piTaskModelIds([pi([kimi, custom, ' Provider/Image '], ['provider/IMAGE'])]), [kimi, custom]);
  assert.equal(piOnlyToolLess([pi(['Provider/Image'], ['provider/image'])]), true);
});

test('piTaskPinHint: removed and tool-less pins name the first task-capable row', () => {
  const providers = [pi(['image', 'provider/first', 'provider/second'], ['image'])];
  for (const pin of ['removed', 'image']) {
    assert.equal(piTaskPinHint(providers, pin, t), 'Can’t run tasks — starts on provider/first');
  }
  assert.equal(piTaskPinHint([pi(['provider/second', 'provider/first'])], 'removed', t),
    'Can’t run tasks — starts on provider/second');
});

test('piTaskPinHint: no warning for a runnable pin, an unset pin, or unknown rows', () => {
  for (const pin of ['provider/model', ' PROVIDER/MODEL ', '', null, undefined]) {
    assert.equal(piTaskPinHint([pi(['provider/model'])], pin, t), '');
  }
  for (const providers of [null, undefined, [], [claude], [{ id: 'pi' }], [pi([])], [pi(['', null])]]) {
    assert.equal(piTaskPinHint(providers, 'removed', t), '');
  }
});

test('piTaskPinHint: no task-capable rows asks for a compatible model without claiming a fallback', () => {
  for (const pin of ['image', 'removed']) {
    assert.equal(piTaskPinHint([pi(['image'], ['image'])], pin, t),
      'Can’t run tasks — choose a model with tool support');
  }
});

// The real pickers are driven by pi-task-pickers.behavior.test.js. These pin the wiring it cannot
// reach: the bulk-bar picker (built inside initBulkActionBar) and the terminal header seed.
const modal = readFileSync(new URL('./console-modal.js', import.meta.url), 'utf8');
const board = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');
const editor = readFileSync(new URL('./task-edit-modal.js', import.meta.url), 'utf8');

function fnBody(source, header) {
  const start = source.indexOf(header);
  assert.ok(start > -1, `${header} not found`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `end of ${header} not found`);
  return source.slice(start, end);
}

test('console-modal.js: the launch modal builds its Pi rows from the task-capable list', () => {
  assert.match(fnBody(modal, 'function _piTaskModels() {'), /return piTaskModelIds\(state\.objectiveProviders\);/);
  assert.match(fnBody(modal, 'function _buildAgentSelectorButtons() {'), /const configured = _piTaskModels\(\);/);
  assert.match(fnBody(modal, 'function _isPiProviderUsable() {'), /if \(piOnlyToolLess\(state\.objectiveProviders\)\) return false;/);
});

test('console-modal.js: the terminal header seeds Pi with the picked row, else the first task-capable one', () => {
  assert.match(modal, /const initialModel = initialAgentId === 'pi' \? \(opts\.model \|\| _piTaskModels\(\)\[0\] \|\| _providerDefaultModel\('pi'\)\) : '';/);
});

test('task-board.js: the bulk agent lists come from _taskStartAgentIds()', () => {
  assert.match(fnBody(board, 'function _taskStartAgentIds() {'), /return piOnlyToolLess\(state\.objectiveProviders\) \? ids\.filter\(id => id !== 'pi'\) : ids;/);
  assert.match(board, /const ids = _taskStartAgentIds\(\);\s*slot\.innerHTML = renderAgentPicker\('bulkAgent', '', false, ids\);/);
  assert.match(fnBody(board, 'export function showBulkAgentStartModal('), /const agents = opts\.agents \|\| _taskStartAgentIds\(\);/);
});

test('task-edit-modal.js: both Agent picker renders use the shared option builder', () => {
  assert.equal((editor.match(/commands\._taskAgentPickerOptions\(\)/g) || []).length, 2);
});
