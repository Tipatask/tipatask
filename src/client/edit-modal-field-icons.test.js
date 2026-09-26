import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// (TPT307) The card-style restyle of the task edit modal changes surfaces only — the Agent input
// must keep its agent logo and the Member Assignee input its avatar (both the installed app's
// behaviour). The icons come from unchanged renderers, so this locks the whole chain:
//
//   Agent   : _renderTaskEditModal -> renderAgentPicker -> ${cur.icon} <- _agentPickerIcon
//   Assignee: _renderTaskEditModal -> _renderMemberCombobox -> renderAssigneeSelection -> _memberAvatarHtml
//
// plus "no stylesheet rule hides them". The DOM behavior suite covers editor controls;
// these checks retain the icon and avatar markup contract.

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(CLIENT_DIR, f), 'utf8');
const taskBoardSrc = read('task-board.js');
const editModalSrc = read('task-edit-modal.js');
const stylesSrc = read('styles.css');

function sliceFunctionBody(src, needle) {
  const start = src.indexOf(needle);
  assert.notEqual(start, -1, `expected to find "${needle}"`);
  const next = [src.indexOf('\nfunction ', start + 1), src.indexOf('\nexport function ', start + 1)]
    .filter((i) => i !== -1)
    .sort((a, b) => a - b)[0];
  return next === undefined ? src.slice(start) : src.slice(start, next);
}

test('Agent input: renderAgentPicker puts the selected agent icon before the label', () => {
  const body = sliceFunctionBody(taskBoardSrc, 'export function renderAgentPicker(');
  const iconAt = body.indexOf('${cur.icon}');
  const labelAt = body.indexOf('agent-picker-label');
  assert.ok(iconAt !== -1, 'renderAgentPicker must render ${cur.icon} inside the trigger');
  assert.ok(labelAt !== -1 && iconAt < labelAt, 'the icon must precede the .agent-picker-label text');
});

test('Agent input: _agentPickerIcon returns an svg icon for every concrete agent', () => {
  const body = sliceFunctionBody(taskBoardSrc, 'function _agentPickerIcon(');
  for (const id of ['claude', 'codex', 'pi', 'human']) {
    assert.match(body, new RegExp(`id === '${id}'\\) return`), `no icon returned for ${id}`);
  }
  assert.match(body, /agent-picker-icon/, 'the Claude icon must carry .agent-picker-icon (sized by CSS)');
});

test('the edit modal still renders the Agent picker and the Member Assignee combobox', () => {
  const body = sliceFunctionBody(editModalSrc, 'function _renderTaskEditModal(');
  assert.match(body, /agentPickerHtml = commands\.renderAgentPicker\('agentAssignee'/);
  assert.match(body, /\$\{agentPickerHtml\}/, 'the Agent row must embed the rendered picker');
  assert.match(body, /commands\._renderMemberCombobox\(\{ id: 'modal-member-combo'/);
});

test('Assignee input: the selection layer renders the member avatar, not just the name', () => {
  const combo = sliceFunctionBody(taskBoardSrc, 'function _renderMemberCombobox(');
  assert.match(combo, /class="assignee-combobox-selection"[^>]*>\$\{renderAssigneeSelection\(member, assignee\)\}/);
  const selection = sliceFunctionBody(taskBoardSrc, 'export function renderAssigneeSelection(');
  assert.match(selection, /_memberAvatarHtml\(member\)/, 'a resolved member must render its avatar');
  const avatar = sliceFunctionBody(taskBoardSrc, 'function _memberAvatarHtml(');
  assert.match(avatar, /class="member-avatar"/);
  assert.match(avatar, /member-avatar--initials/, 'the initials fallback must survive');
});

test('no stylesheet rule hides the agent icon or the member avatar', () => {
  // A literal zero only: `opacity: 0.85` (a dimmed dropdown icon) is fine, `opacity: 0` is not.
  const zero = '0(?:px)?\\s*(?:;|!|$)';
  const hides = new RegExp(`display\\s*:\\s*none|visibility\\s*:\\s*hidden|(?:^|[;\\s])width\\s*:\\s*${zero}|opacity\\s*:\\s*${zero}`);
  const offenders = [];
  for (const m of stylesSrc.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (!/\.agent-picker-icon\b|\.member-avatar\b/.test(selector)) continue;
    if (hides.test(m[2])) offenders.push(`${selector.replace(/\s+/g, ' ')} { ${m[2].trim()} }`);
  }
  assert.deepEqual(offenders, [], `rules hiding the icon/avatar: ${offenders.join(' | ')}`);
});
