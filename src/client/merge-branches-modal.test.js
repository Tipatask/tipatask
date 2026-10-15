import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

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
  assert.match(SRC, /const opts = \{ prompt, relaunch: true \}/, '(TPT663) relaunch replaces a retained exited session instead of reattaching to it');
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

// ── (TPT663) Resolve with agent under a vm harness (task-finish.test.js pattern): module source with
// the imports stripped runs in its own context, so the non-exported `_resolveWithAgent` and the
// job state fed through handleMergeWsMessage are reachable. No DOM: `close()` and the WS handler
// are document-safe while no overlay is mounted, which is the exact state the hand-off runs in.
const model = await import('./merge-branches-model.js');

function harness(overrides = {}) {
  const calls = { openTerminal: [], openAgentSelectorModal: [], clipboard: [], toasts: [] };
  const env = {
    window: { TipTask: {
      openTerminal: (...args) => { calls.openTerminal.push(args); },
      openAgentSelectorModal: (...args) => { calls.openAgentSelectorModal.push(args); },
    } },
    navigator: { clipboard: { writeText: async text => { calls.clipboard.push(text); } } },
    setTimeout, clearTimeout, console,
    state: {
      activeSessions: new Set(), exitedSessions: new Set(['TPT1']),
      taskTitleById: new Map([['TPT1', 'Feature one']]), taskStatusById: new Map([['TPT1', 'completed']]),
      availableAgents: ['claude'], sessionAgent: 'claude',
    },
    api: { merge: {} },
    t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    tc: key => key,
    escapeAttr: v => String(v),
    showToast: (msg, kind) => { calls.toasts.push([msg, kind || 'info']); },
    showProgressToast: () => ({ update() {}, done() {}, fail() {} }),
    showActionConfirm: async () => true,
    activateDialogFocus: () => ({ close() {} }),
    pushNotification: () => {},
    MAX_DESC_LEN: 6000,
    ...model,
    ...overrides,
  };
  vm.createContext(env);
  vm.runInContext(SRC.replace(/^import [\s\S]*?;\n/gm, '').replace(/^export /gm, ''), env);
  env.handleMergeWsMessage({ type: 'merge:conflict', jobId: 'j1', conflict: { taskKey: 'TPT1', repoId: 'root', branch: 'task/TPT1', conflictedPaths: ['a.js'], handoffPrompt: 'Resolve the merge conflict for TPT1.' } });
  calls.toasts.length = 0;
  return { env, calls };
}

test('an exited-session task takes the launch path: no clipboard, openTerminal gets { prompt, relaunch: true } and the real status', async () => {
  const { env, calls } = harness();
  await env._resolveWithAgent();
  assert.deepEqual(calls.clipboard, [], 'an exited session is not a resume — the prompt travels on the WS URL');
  // JSON compare: the opts object is created inside the vm realm (its own Object.prototype).
  assert.equal(JSON.stringify(calls.openTerminal), JSON.stringify([['TPT1', 'Feature one', '', 'completed', { prompt: 'Resolve the merge conflict for TPT1.', relaunch: true }]]));
  assert.equal(calls.openAgentSelectorModal.length, 0);
  assert.deepEqual(calls.toasts, [['merge.resumeHint', 'info']]);
});

test('a live session keeps the clipboard fallback; relaunch still rides along (wantsRelaunch ignores it for a live session)', async () => {
  const { env, calls } = harness();
  env.state.activeSessions.add('TPT1');
  await env._resolveWithAgent();
  assert.deepEqual(calls.clipboard, ['Resolve the merge conflict for TPT1.']);
  assert.equal(JSON.stringify(calls.openTerminal), JSON.stringify([['TPT1', 'Feature one', '', 'completed', { prompt: 'Resolve the merge conflict for TPT1.', relaunch: true }]]));
  assert.deepEqual(calls.toasts, [['merge.promptCopiedResume', 'info'], ['merge.resumeHint', 'info']]);
});

test('with several agents and no session agent the picker receives the same { prompt, relaunch: true } opts', async () => {
  const { env, calls } = harness({ state: {
    activeSessions: new Set(), exitedSessions: new Set(['TPT1']),
    taskTitleById: new Map([['TPT1', 'Feature one']]), taskStatusById: new Map([['TPT1', 'completed']]),
    availableAgents: ['claude', 'codex'], sessionAgent: null,
  } });
  await env._resolveWithAgent();
  assert.equal(calls.openTerminal.length, 0);
  assert.equal(JSON.stringify(calls.openAgentSelectorModal), JSON.stringify([['TPT1', 'Feature one', '', 'completed', { prompt: 'Resolve the merge conflict for TPT1.', relaunch: true }]]));
});

test('the prompt on the launch opts is capped at MAX_DESC_LEN while the clipboard copy stays whole', async () => {
  const long = 'x'.repeat(50);
  const { env, calls } = harness({ MAX_DESC_LEN: 10 });
  env.handleMergeWsMessage({ type: 'merge:conflict', jobId: 'j1', conflict: { taskKey: 'TPT1', handoffPrompt: long } });
  env.state.activeSessions.add('TPT1');
  await env._resolveWithAgent();
  assert.deepEqual(calls.clipboard, [long]);
  assert.equal(calls.openTerminal[0][4].prompt, model.truncatePrompt(long, 10));
  assert.equal(calls.openTerminal[0][4].relaunch, true);
});
