import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';

// (TPT345) merge-branches-modal.js imports cleanly under node (module scope only declares
// state; every DOM access is inside a function) — the import itself catches a broken specifier
// or syntax error. The panel's wiring to the shared confirm dialog, the terminal opener and the
// escaping helpers is guarded at the source level, same pattern as agents-modal.test.js.
const SRC = fs.readFileSync(new URL('./merge-branches-modal.js', import.meta.url), 'utf8');
const modal = await import('./merge-branches-modal.js');

test('the modal module imports cleanly and exports its public surface', () => {
  assert.equal(typeof modal.openMergeBranchesModal, 'function');
  assert.equal(typeof modal.closeMergeBranchesModal, 'function');
  assert.equal(typeof modal.handleMergeWsMessage, 'function');
  assert.equal(typeof modal._resetMergeModalForTests, 'function');
});

test('handleMergeWsMessage ignores non-merge frames and claims merge frames without a DOM', () => {
  modal._resetMergeModalForTests();
  assert.equal(modal.handleMergeWsMessage({ type: 'tasks-updated' }), false);
  assert.equal(modal.handleMergeWsMessage(null), false);
  assert.equal(modal.handleMergeWsMessage({ type: 'reindex-kb-progress' }), false);
  // No document here: a progress frame must still be absorbed (state only), never throw.
  assert.equal(modal.handleMergeWsMessage({ type: 'merge:progress', jobId: 'j1', stepIndex: 0, total: 2, step: { index: 0, kind: 'merge', repoId: 'root', label: 'x', status: 'running' } }), true);
  assert.equal(modal.handleMergeWsMessage({ type: 'merge:progress', jobId: 'j1', step: { index: 0, kind: 'merge', repoId: 'root', label: 'x', status: 'running' } }), true, 'idempotent re-delivery');
  modal._resetMergeModalForTests();
});

test('outer overlay uses its own .merge-modal class, never .setup-modal (setup-modal.js removes that on repaint)', () => {
  assert.match(SRC, /_overlay\.className = 'merge-modal'/);
  assert.doesNotMatch(SRC, /className = 'setup-modal'/);
  assert.doesNotMatch(SRC, /querySelector\('\.setup-modal'\)/);
});

test('publish and cleanup are confirmed through showActionConfirm before calling the API', () => {
  assert.match(SRC, /import \{ showActionConfirm \} from '\.\/action-confirm\.js'/);
  const publishIdx = SRC.indexOf('api.merge.publish(');
  const cleanupIdx = SRC.indexOf('api.merge.cleanup(');
  const abortIdx = SRC.indexOf('api.merge.abort(');
  assert.ok(publishIdx > 0 && cleanupIdx > 0 && abortIdx > 0);
  for (const idx of [publishIdx, cleanupIdx, abortIdx]) {
    const fnStart = SRC.lastIndexOf('async function ', idx);
    const body = SRC.slice(fnStart, idx);
    assert.match(body, /showActionConfirm\(\{/, 'confirm dialog precedes the API call in the same function');
  }
  assert.doesNotMatch(SRC, /\b(alert|confirm|prompt)\(/, 'no native dialogs');
});

test('Resolve with agent opens the task terminal through window.TipTask with a verbatim prompt', () => {
  assert.match(SRC, /window\.TipTask\?\.openTerminal/);
  assert.match(SRC, /const opts = \{ prompt \}/);
  assert.match(SRC, /truncatePrompt\(c\.handoffPrompt \|\| '', MAX_DESC_LEN\)/);
  assert.doesNotMatch(SRC, /from '\.\/console-modal\.js'/, 'no static console-modal import (xterm CSS chain under node)');
  assert.match(SRC, /state\.activeSessions\?\.has\?\.\(taskKey\)/, 'resume case copies the prompt instead');
});

test('every server-supplied string is escaped before landing in innerHTML', () => {
  for (const expr of ['c.handoffPrompt', 'p.paths.map((x) => `<li>${escapeAttr(x)}', '(c.conflictedPaths || []).map((p) => `<li>${escapeAttr(p)}', 'escapeAttr(cmds)', 'escapeAttr(b.message)', 'escapeAttr(s.label']) {
    assert.ok(SRC.includes(expr), `expected ${expr} in source`);
  }
  assert.match(SRC, /escapeAttr\(c\.handoffPrompt \|\| ''\)/);
});

test('opening the panel always refetches merge status (server is the source of truth for the job)', () => {
  const openIdx = SRC.indexOf('export function openMergeBranchesModal');
  const openBody = SRC.slice(openIdx, SRC.indexOf('export function closeMergeBranchesModal'));
  assert.match(openBody, /_load\(\)/);
  const loadIdx = SRC.indexOf('async function _load(');
  const loadBody = SRC.slice(loadIdx, SRC.indexOf('// ── Render'));
  assert.match(loadBody, /api\.merge\.status\(/);
  assert.match(loadBody, /status\.job/);
});

test('every await inside the modal is followed by the owningOverlay guard', () => {
  const fnRe = /async function (_\w+)\(/g;
  let match;
  const missing = [];
  while ((match = fnRe.exec(SRC))) {
    const start = match.index;
    const next = SRC.indexOf('\nasync function ', start + 1);
    const body = SRC.slice(start, next === -1 ? SRC.length : next);
    if (match[1] === '_copy') continue;
    if (/await /.test(body) && !/_overlay (!==|===) owningOverlay/.test(body)) missing.push(match[1]);
  }
  assert.deepEqual(missing, [], 'async functions awaiting without the stale-overlay guard');
});
