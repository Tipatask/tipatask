'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan } = require('./merge-plan');

function tb(key, title = `T ${key}`) { return { branch: `task/${key}`, taskKey: key, suffix: null, headSha: 'x', task: { title } }; }
const repos = [
  { id: 'root', relPath: '', relToParent: null, path: '/p', kind: 'root', depth: 0, parentId: null, currentBranch: 'master', target: 'master', checks: { test: 'npm test', build: null }, taskBranches: [tb('TPT10'), tb('TPT2')] },
  { id: 'ai/todo/server', relPath: 'ai/todo/server', relToParent: 'ai/todo/server', path: '/p/ai/todo/server', kind: 'nested', depth: 1, parentId: 'root', currentBranch: 'master', target: 'master', checks: { test: 'npm test', build: 'npm run build' }, taskBranches: [tb('TPT2'), tb('TPT1')] },
];
const sig = (steps) => steps.map(s => `${s.kind}:${s.repoId}:${s.branch || s.nestedRelPath || ''}`);

test('buildPlan: nested first, key order (TPT2 < TPT10), gitlink bump before root merges, verify after, checks last nested-first', () => {
  const steps = buildPlan({ repos, selections: [{ repoId: 'root', branch: 'task/TPT10' }, { repoId: 'root', branch: 'task/TPT2' }, { repoId: 'ai/todo/server', branch: 'task/TPT2' }, { repoId: 'ai/todo/server', branch: 'task/TPT1' }], checks: { test: true, build: true, baseline: true } });
  assert.deepEqual(sig(steps), [
    'baseline:ai/todo/server:', 'merge:ai/todo/server:task/TPT1', 'merge:ai/todo/server:task/TPT2',
    'baseline:root:', 'gitlink-bump:root:ai/todo/server', 'merge:root:task/TPT2', 'merge:root:task/TPT10', 'verify-gitlinks:root:',
    'checks:ai/todo/server:', 'checks:root:',
  ]);
  assert.deepEqual(steps.map(s => s.index), steps.map((_, i) => i));
  assert.ok(steps.every(s => s.status === 'pending' && typeof s.label === 'string'));
  assert.equal(steps.find(s => s.kind === 'gitlink-bump').keys.join(','), 'TPT1,TPT2');
  assert.equal(steps.find(s => s.branch === 'task/TPT2' && s.repoId === 'root').message, 'Merge task/TPT2: T TPT2');
});

test('buildPlan: nested-only selection still bumps the root gitlink; no checks when disabled; empty selection → []', () => {
  const steps = buildPlan({ repos, selections: [{ repoId: 'ai/todo/server', branch: 'task/TPT1' }], checks: { test: false, build: false, baseline: false } });
  assert.deepEqual(sig(steps), ['merge:ai/todo/server:task/TPT1', 'gitlink-bump:root:ai/todo/server', 'verify-gitlinks:root:']);
  assert.deepEqual(buildPlan({ repos, selections: [] }), []);
  assert.deepEqual(buildPlan({ repos, selections: [{ repoId: 'root', branch: 'task/none' }] }), []);
});

test('buildPlan: target specs add checkout-target / create steps', () => {
  const steps = buildPlan({ repos, selections: [{ repoId: 'root', branch: 'task/TPT2' }], targets: { root: { createBranch: 'release/x' } }, checks: { test: false, build: false, baseline: false } });
  assert.deepEqual(sig(steps), ['checkout-target:root:', 'merge:root:task/TPT2']);
  assert.equal(steps[0].create, true); assert.equal(steps[0].target, 'release/x'); assert.equal(steps[1].target, 'release/x');
  const sw = buildPlan({ repos, selections: [{ repoId: 'root', branch: 'task/TPT2' }], targets: { root: { branch: 'develop' } }, checks: {} });
  assert.equal(sw[0].kind, 'checkout-target'); assert.equal(sw[0].create, false);
  const same = buildPlan({ repos, selections: [{ repoId: 'root', branch: 'task/TPT2' }], targets: { root: { branch: 'master' } }, checks: {} });
  assert.equal(same[0].kind, 'merge', 'target == current branch → no checkout step');
});
