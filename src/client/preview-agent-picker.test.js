import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// (TPT197) The objective-chat proposal-edit modal (callbacks.preloadedTask → `isPreviewTask`)
// now shows the Agent picker, Model row and Claude design-mode checkbox, so a planned task can
// be pointed at Claude / Codex / Pi before it is accepted. The Codex browser-tools row stays
// hidden there: its checkboxes write project-level MCP_BROWSER_TOOLS immediately, with no
// draft/Save gating, so exposing it on an unsaved proposal would mutate global config.
//
// These source checks retain the preview-field contract alongside the DOM behavior suite.

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(CLIENT_DIR, f), 'utf8');
const editModalSrc = read('task-edit-modal.js');
const templateSrc = read('template.html');
const chatPreviewSrc = read('chat-task-preview.js');

function sliceFunctionBody(src, needle) {
  const start = src.indexOf(needle);
  assert.notEqual(start, -1, `expected to find "${needle}"`);
  const end = src.indexOf('\nfunction ', start + 1);
  const end2 = src.indexOf('\nexport function ', start + 1);
  const stop = [end, end2].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  return stop === undefined ? src.slice(start) : src.slice(start, stop);
}

test('_renderTaskEditModal() no longer hides the Agent row or Model/design-mode rows for a preview task', () => {
  const body = sliceFunctionBody(editModalSrc, 'function _renderTaskEditModal(');
  const agentRow = body.split('\n').find((l) => l.includes("t('field.agent')"));
  assert.ok(agentRow, 'expected the Agent field row');
  assert.doesNotMatch(agentRow, /isPreviewTask/, 'Agent row must not be gated on isPreviewTask');
  const modelCall = body.split('\n').find((l) => l.includes('_agentModelControlHtml('));
  assert.ok(modelCall, 'expected the _agentModelControlHtml() call');
  assert.doesNotMatch(modelCall, /hidden:\s*isPreviewTask/, 'model/design-mode rows must not be hidden for a preview task');
  assert.match(modelCall, /hideBrowserTools:\s*isPreviewTask/, 'only the Codex browser-tools row stays hidden');
});

test('_renderTaskEditModal() still hides Comments, Notifications, Start and the context-action bar for a preview task', () => {
  const body = sliceFunctionBody(editModalSrc, 'function _renderTaskEditModal(');
  assert.match(body, /data-tab="comments"\$\{isPreviewTask \? ' hidden' : ''\}/);
  assert.match(body, /data-tab="notifications"\$\{isPreviewTask \? ' hidden' : ''\}/);
  assert.match(body, /const showStart = _shouldShowModalStart\(draft\);/);
  assert.match(sliceFunctionBody(editModalSrc, 'function _shouldShowModalStart('), /!callbacks\.preloadedTask/);
  assert.match(body, /class="modal-context-btns"\$\{isPreviewTask \? ' hidden' : ''\}/);
});

test('_agentModelControlHtml() gates the Codex browser-tools row on its own hideBrowserTools flag', () => {
  const body = sliceFunctionBody(editModalSrc, 'function _agentModelControlHtml(');
  assert.match(body, /hideBrowserTools\s*=\s*false/);
  const browserRow = body.split('\n').find((l) => l.includes('modal-codex-browser-row'));
  assert.match(browserRow, /hideBrowserTools/);
});

test('every edit-modal repaint threads hideBrowserTools so an agent switch cannot re-reveal the row', () => {
  const fn = sliceFunctionBody(editModalSrc, 'function _applyModalAgentModelVisibility(');
  assert.match(fn, /hideBrowserTools\s*\|\|\s*a !== 'codex'/);
  // Edit-modal call sites (fieldsRoot = New Task form is intentionally excluded — default false).
  const modalCalls = editModalSrc.split('\n').filter((l) => l.includes('_applyModalAgentModelVisibility(modal'));
  assert.ok(modalCalls.length >= 2, 'expected the edit-modal repaint call sites');
  for (const line of modalCalls) {
    assert.match(line, /hideBrowserTools/, `edit-modal repaint must pass hideBrowserTools: ${line.trim()}`);
  }
  const commit = editModalSrc.slice(editModalSrc.indexOf('const commitAgentChoice'), editModalSrc.indexOf('const switchTab'));
  assert.match(commit, /hideBrowserTools:\s*!!_modalState\.callbacks\.preloadedTask/);
});

test('onSavePreview writes model slots + effort + design mode back onto proposal.task', () => {
  const start = templateSrc.indexOf('onSavePreview: async (draft)');
  assert.notEqual(start, -1, 'expected onSavePreview');
  const body = templateSrc.slice(start, templateSrc.indexOf('closeTaskEditModal(true)', start));
  assert.match(body, /proposal\.task\.agentAssignee\s*=/);
  assert.match(body, /\['claudeModel', 'codexModel', 'piModel', 'effort'\]/);
  assert.match(body, /proposal\.task\[f\]\s*=\s*draft\[f\]\s*\|\|\s*null/);
  assert.match(body, /proposal\.task\.claudeDesignMode\s*=\s*!!draft\.claudeDesignMode/);
});

test('proposal preview cards render the agent badge from task-card.js (display-only, never bound)', () => {
  assert.match(chatPreviewSrc, /import \{[^}]*renderAgentBadge[^}]*\} from '\.\/task-card\.js'/);
  assert.match(chatPreviewSrc, /\$\{renderAgentBadge\(t\)\}/);
  assert.doesNotMatch(chatPreviewSrc, /bindAgentBadge/);
});

// (TPT198) The agent pin a user picks in the proposal-edit modal reaches the API only because
// chat-task-preview.js hands the WHOLE proposal task object to the save payload — there is no
// field whitelist between the modal write-back (onSavePreview above) and api-backend.js's
// _rawUpdateTask/toApi, which is where the camel->snake mapping happens (locked end to end by
// src/server/objective-agent-persist.test.js). Rebuilding the task as a picked-field literal at
// either write site would silently drop agentAssignee / the model slots / claudeDesignMode.
test('new-card save paths pass the whole proposal task into the PUT payload (no field-picked literal)', () => {
  const bulk = chatPreviewSrc.match(/upsertTaskEntry\(data\.tasks,\s*card\.task\)/g) || [];
  const single = chatPreviewSrc.match(/upsertTaskEntry\(data\.tasks,\s*change\.task\)/g) || [];
  assert.equal(bulk.length, 1, 'bulk Save Tasks must upsert card.task whole');
  assert.equal(single.length, 1, 'per-card accept (saveTaskChange) must upsert change.task whole');
  assert.doesNotMatch(chatPreviewSrc, /upsertTaskEntry\(data\.tasks,\s*\{/, 'never upsert a rebuilt object literal');
});

test('modified-card absent-target fallback goes through buildModifiedTaskPatch (the helper that carries the agent pin)', () => {
  assert.match(chatPreviewSrc, /import \{[^}]*buildModifiedTaskPatch[^}]*\} from '\.\/modified-task-merge\.js'/);
  const calls = chatPreviewSrc.match(/api\.tasks\.update\([^,]+,\s*buildModifiedTaskPatch\(/g) || [];
  assert.equal(calls.length, 2, 'both the bulk and per-card fallbacks must build the PATCH via buildModifiedTaskPatch');
});
