import assert from 'node:assert/strict';
import { test } from 'node:test';

// (TPT345) Pure-model coverage for the Merge task branches panel. merge-branches-model.js has no
// DOM and no imports, so everything the modal decides (defaults, blocker gating, step upserts,
// view derivation, wire shapes) is unit-tested here under plain node.
const m = await import('./merge-branches-model.js');

const status = {
  git: { version: '2.45.2', mergeTreeSupported: true },
  vcs: { type: 'git', worktree: true, commit: true, pr: false },
  job: null,
  repos: [
    {
      id: 'root', relPath: '', kind: 'root', currentBranch: 'main', mainBranch: 'main', target: 'main',
      canCreateBranch: true, otherBranches: ['dev'], dirtyFiles: [], blockers: [],
      taskBranches: [
        { branch: 'task/TPT2', taskKey: 'TPT2', task: { key: 'TPT2', title: 'Two', status: 'completed', isComplete: true, isClosed: true }, worktree: { path: '/r/.worktrees/TPT2', dirty: false, dirtyFiles: [] }, ahead: 2, behind: 0, blockers: [], selectedByDefault: true },
        { branch: 'task/TPT10', taskKey: 'TPT10', task: { key: 'TPT10', title: 'Ten', status: 'pending', isComplete: false, isClosed: false }, worktree: null, ahead: 1, behind: 3, blockers: [{ code: 'TASK_NOT_COMPLETED', severity: 'warn', message: 'not done' }], selectedByDefault: false },
        { branch: 'task/TPT3', taskKey: 'TPT3', task: null, worktree: { path: '/r/.worktrees/TPT3', dirty: true, dirtyFiles: ['a.js'] }, ahead: 0, behind: 0, blockers: [{ code: 'ALREADY_MERGED', severity: 'info', message: 'merged' }], selectedByDefault: false },
      ],
    },
    {
      id: 'ai/todo/server', relPath: 'ai/todo/server', kind: 'nested', currentBranch: 'main', mainBranch: 'main', target: 'main',
      canCreateBranch: true, otherBranches: [], dirtyFiles: [{ status: ' M', path: 'x.js' }], blockers: [],
      taskBranches: [
        { branch: 'task/TPT2', taskKey: 'TPT2', task: { key: 'TPT2', title: 'Two', status: 'completed', isComplete: true, isClosed: true }, worktree: { path: '/r/ai/todo/server/.worktrees/TPT2', dirty: true, dirtyFiles: ['y.js'] }, ahead: 1, behind: 0, blockers: [{ code: 'WORKTREE_DIRTY_COMPLETED', severity: 'block', message: 'dirty', action: { type: 'commit-worktree', message: 'TPT2 Two' } }], selectedByDefault: true },
      ],
    },
  ],
};

test('orderedRepos puts nested repos first and the root last', () => {
  const ids = m.orderedRepos(status.repos).map((r) => r.id);
  assert.deepEqual(ids, ['ai/todo/server', 'root']);
  const deep = m.orderedRepos([{ id: 'root', kind: 'root' }, { id: 'a', kind: 'nested', relPath: 'a' }, { id: 'a/b', kind: 'nested', relPath: 'a/b' }]);
  assert.deepEqual(deep.map((r) => r.id), ['a/b', 'a', 'root']);
});

test('defaultSelections selects only selectedByDefault branches and the server target', () => {
  const sel = m.defaultSelections(status);
  assert.deepEqual(sel, [
    { repoId: 'root', target: 'main', createBranch: null, branches: ['task/TPT2'] },
    { repoId: 'ai/todo/server', target: 'main', createBranch: null, branches: ['task/TPT2'] },
  ]);
});

test('toggleBranch / setTarget return new arrays and never mutate the input', () => {
  const sel = m.defaultSelections(status);
  const next = m.toggleBranch(sel, 'root', 'task/TPT10', true);
  assert.notEqual(next, sel);
  assert.deepEqual(sel[0].branches, ['task/TPT2']);
  assert.deepEqual(next[0].branches, ['task/TPT2', 'task/TPT10']);
  const off = m.toggleBranch(next, 'root', 'task/TPT2', false);
  assert.deepEqual(off[0].branches, ['task/TPT10']);
  const tgt = m.setTarget(off, 'root', { target: 'dev' });
  assert.equal(tgt[0].target, 'dev');
  assert.equal(tgt[0].createBranch, null);
  const created = m.setTarget(tgt, 'root', { createBranch: 'release/x' });
  assert.equal(created[0].createBranch, 'release/x');
  assert.equal(off[0].target, 'main', 'earlier arrays untouched');
});

test('selectionSignature is stable under branch and repo order', () => {
  const a = [{ repoId: 'root', target: 'main', createBranch: null, branches: ['task/B', 'task/A'] }, { repoId: 'n', target: 'main', createBranch: null, branches: [] }];
  const b = [{ repoId: 'n', target: 'main', createBranch: null, branches: [] }, { repoId: 'root', target: 'main', createBranch: null, branches: ['task/A', 'task/B'] }];
  assert.equal(m.selectionSignature(a), m.selectionSignature(b));
  assert.notEqual(m.selectionSignature(a), m.selectionSignature(m.toggleBranch(a, 'root', 'task/C', true)));
  assert.notEqual(m.selectionSignature(a), m.selectionSignature(m.setTarget(a, 'root', { target: 'dev' })));
});

test('selectedCount and canCreateBranch', () => {
  assert.equal(m.selectedCount(m.defaultSelections(status)), 2);
  assert.equal(m.canCreateBranch({ canCreateBranch: false }), false);
  assert.equal(m.canCreateBranch({ currentBranch: 'main', mainBranch: 'main' }), true);
  assert.equal(m.canCreateBranch({ currentBranch: 'dev', mainBranch: 'main' }), false);
});

test('toWireSelections / toWireTargets produce the server request shapes', () => {
  let sel = m.defaultSelections(status);
  sel = m.setTarget(sel, 'root', { createBranch: ' release/1 ' });
  assert.deepEqual(m.toWireSelections(sel), [{ repoId: 'root', branch: 'task/TPT2' }, { repoId: 'ai/todo/server', branch: 'task/TPT2' }]);
  assert.deepEqual(m.toWireTargets(sel), { root: { createBranch: 'release/1' }, 'ai/todo/server': { branch: 'main' } });
});

test('collectBlockers unions status + dry-run blockers for selected branches only', () => {
  const sel = m.defaultSelections(status);
  const dryRun = { supported: true, repos: [{ id: 'root', target: 'main', versusTarget: [], pairwise: [], blockers: [{ code: 'MAIN_DIRTY_OVERLAP', severity: 'block', message: 'overlap', paths: ['a.js'] }], branchBlockers: { 'task/TPT2': [{ code: 'WORKTREE_DIRTY', severity: 'warn', message: 'w' }], 'task/TPT10': [{ code: 'TASK_NOT_COMPLETED', severity: 'warn', message: 'x' }] } }] };
  const blockers = m.collectBlockers(status, dryRun, sel);
  const codes = blockers.map((b) => `${b.repoId}:${b.branch || '-'}:${b.code}`).sort();
  assert.deepEqual(codes, [
    'ai/todo/server:task/TPT2:WORKTREE_DIRTY_COMPLETED',
    'root:-:MAIN_DIRTY_OVERLAP',
    'root:task/TPT2:WORKTREE_DIRTY',
  ], 'unselected TPT10 / TPT3 blockers are not collected');
  // Applying the same dry run twice does not duplicate entries.
  assert.equal(m.collectBlockers(status, dryRun, sel).length, blockers.length);
});

test('summarizeBlockers gates on severity, never on the code', () => {
  const list = [
    { code: 'WHATEVER_NEW_CODE', severity: 'block' },
    { code: 'TASK_NOT_COMPLETED', severity: 'warn' },
    { code: 'GITLINK_DRIFT', severity: 'info' },
  ];
  const s = m.summarizeBlockers(list);
  assert.equal(s.canRun, false);
  assert.equal(s.hard.length, 1);
  assert.equal(s.warnings.length, 1);
  assert.equal(s.infos.length, 1);
  assert.equal(m.summarizeBlockers(list.slice(1)).canRun, true);
  assert.equal(m.summarizeBlockers([]).canRun, true);
});

test('conflictRows / hasConflicts / branchConflictPaths read a dry-run payload', () => {
  const dryRun = { supported: true, repos: [{ id: 'root', target: 'main', versusTarget: [{ branch: 'task/A', clean: true, conflicts: [] }, { branch: 'task/B', clean: false, conflicts: ['kb.md'] }], pairwise: [{ a: 'task/A', b: 'task/B', clean: false, conflicts: ['x.js'] }] }] };
  assert.equal(m.hasConflicts(dryRun), true);
  assert.equal(m.hasConflicts({ repos: [{ id: 'root', versusTarget: [{ branch: 'task/A', clean: true, conflicts: [] }] }] }), false);
  assert.deepEqual(m.conflictRows(dryRun).map((r) => r.kind), ['target', 'pair']);
  assert.deepEqual(m.branchConflictPaths(dryRun, 'root', 'task/B').sort(), ['kb.md', 'x.js']);
  assert.deepEqual(m.branchConflictPaths(dryRun, 'root', 'task/A'), ['x.js']);
  assert.deepEqual(m.branchConflictPaths(dryRun, 'nope', 'task/A'), []);
});

test('upsertStep is idempotent and keeps index order', () => {
  let steps = m.upsertStep([], { index: 2, kind: 'merge', status: 'pending' });
  steps = m.upsertStep(steps, { index: 0, kind: 'baseline', status: 'done' });
  steps = m.upsertStep(steps, { index: 2, kind: 'merge', status: 'running' });
  const again = m.upsertStep(steps, { index: 2, kind: 'merge', status: 'running' });
  assert.deepEqual(steps.map((s) => [s.index, s.status]), [[0, 'done'], [2, 'running']]);
  assert.deepEqual(again, steps);
  assert.deepEqual(m.upsertStep(steps, null), steps);
});

test('appendLog caps at max and ignores empty lines', () => {
  let log = [];
  for (let i = 0; i < 12; i++) log = m.appendLog(log, `l${i}`, 10);
  assert.equal(log.length, 10);
  assert.equal(log[0], 'l2');
  assert.deepEqual(m.appendLog(['a'], ''), ['a']);
});

test('viewForJob maps job state to a panel view', () => {
  assert.equal(m.viewForJob(null), null);
  assert.equal(m.viewForJob({ state: 'conflict' }), 'conflict');
  assert.equal(m.viewForJob({ state: 'done' }), 'done');
  assert.equal(m.viewForJob({ state: 'failed' }), 'error');
  assert.equal(m.viewForJob({ state: 'aborted' }), 'error');
  assert.equal(m.viewForJob({ state: 'running', currentStep: 1, steps: [{ index: 1, kind: 'merge', status: 'running' }] }), 'running');
  assert.equal(m.viewForJob({ state: 'running', currentStep: 3, steps: [{ index: 3, kind: 'checks', status: 'running' }] }), 'checks');
  assert.equal(m.viewForJob({ state: 'running', steps: [{ index: 0, kind: 'baseline', status: 'running' }] }), 'checks');
});

test('truncatePrompt uses the console-modal suffix and respects the cap', () => {
  const text = 'x'.repeat(50);
  assert.equal(m.truncatePrompt(text, 100), text);
  const cut = m.truncatePrompt(text, 10);
  assert.equal(cut, 'x'.repeat(10) + '... (truncated)');
  assert.equal(m.truncatePrompt(null, 10), '');
});

test('cleanupPayload turns merged keys into {repoId, branch} selections', () => {
  const p = m.cleanupPayload({ root: ['TPT2', 'task/TPT3'], 'ai/todo/server': [{ taskKey: 'TPT2' }] });
  assert.deepEqual(p, { selections: [{ repoId: 'root', branch: 'task/TPT2' }, { repoId: 'root', branch: 'task/TPT3' }, { repoId: 'ai/todo/server', branch: 'task/TPT2' }] });
  assert.deepEqual(m.cleanupPayload(null), { selections: [] });
});

test('publishEligible follows vcs.pr', () => {
  assert.equal(m.publishEligible(status), false);
  assert.equal(m.publishEligible({ vcs: { pr: true } }), true);
  assert.equal(m.publishEligible(null), false);
});

test('branchStateKey precedence: merged > dirty > closed/open > orphan', () => {
  const [b2, b10, b3] = status.repos[0].taskBranches;
  assert.equal(m.branchStateKey(b2), 'closed');
  assert.equal(m.branchStateKey(b10), 'open');
  assert.equal(m.branchStateKey(b3), 'merged');
  assert.equal(m.branchStateKey({ ahead: 1, worktree: { dirty: true }, task: { isClosed: true } }), 'dirty');
  assert.equal(m.branchStateKey({ ahead: 1, worktree: null, task: null }), 'orphan');
});

test('mergedRows orders by repo execution order then numeric key', () => {
  const rows = m.mergedRows({ root: ['TPT10', 'TPT2'], 'ai/todo/server': ['TPT2'] }, status.repos);
  assert.deepEqual(rows.map((r) => `${r.repoId}:${r.key}`), ['ai/todo/server:TPT2', 'root:TPT2', 'root:TPT10']);
});

test('checksSummary aggregates new/pre-existing failures and build status', () => {
  const s = m.checksSummary({
    root: { test: { status: 1, failures: ['a', 'b'], newFailures: ['b'], preExisting: ['a'], blocking: true }, build: { status: 0 } },
    'ai/todo/server': { test: { status: 0, failures: [], newFailures: [], preExisting: [], blocking: false }, build: { status: 2 } },
  });
  assert.deepEqual(s, { ran: true, newFailures: 1, preExisting: 1, blocking: true, buildFailed: true });
  assert.equal(m.checksSummary(null).ran, false);
});
