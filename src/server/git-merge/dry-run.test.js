'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./test-fixture');
const { parseMergeTreeOutput, dryRunProject } = require('./dry-run');
const { scanProject } = require('./repo-discovery');

fx.applyFixtureEnvToProcess();

test('parseMergeTreeOutput: clean vs conflicted', () => {
  assert.deepEqual(parseMergeTreeOutput('abc123\n', 0), { treeSha: 'abc123', conflicts: [], clean: true });
  assert.deepEqual(parseMergeTreeOutput('abc123\nsrc/a.js\ndocs/b.md\n\ninfo lines\n', 1), { treeSha: 'abc123', conflicts: ['src/a.js', 'docs/b.md'], clean: false });
});

test('dryRunProject: every branch clean vs target, pairwise TPT2×TPT3 flags the planted kb.md conflict', async (t) => {
  if (fx.skipUnless(t, 'merge-tree')) return;
  const f = fx.buildFixture(t);
  const scan = await scanProject(f.root);
  const sel = [{ repoId: 'root', branch: 'task/TPT1' }, { repoId: 'root', branch: 'task/TPT2' }, { repoId: 'root', branch: 'task/TPT3' }, { repoId: 'ai/todo/server', branch: 'task/TPT1' }];
  const dr = await dryRunProject(scan, sel);
  assert.equal(dr.supported, true);
  const root = dr.repos.find(r => r.id === 'root');
  assert.ok(root.versusTarget.every(v => v.clean && v.conflicts.length === 0));
  const bad = root.pairwise.filter(p => !p.clean);
  assert.deepEqual(bad.map(p => [p.a, p.b, p.conflicts]), [['task/TPT2', 'task/TPT3', ['ai/architecture/kb.md']]]);
  assert.deepEqual(root.summary.conflictingBranches.sort(), ['task/TPT2', 'task/TPT3']);
  const nested = dr.repos.find(r => r.id === 'ai/todo/server');
  assert.equal(nested.pairwise.length, 0);
  assert.equal(nested.versusTarget[0].clean, true);
});

test('dryRunProject: unsupported git reports supported:false instead of throwing', async () => {
  const runner = require('./git-runner');
  const fakeExec = (cmd, args, opts, cb) => { setImmediate(() => cb(null, 'git version 2.30.0\n', '')); return { stdin: { end() {} } }; };
  const v = await runner.gitVersion({ exec: fakeExec, refresh: true });
  assert.equal(v.mergeTreeSupported, false);
  const dr = await dryRunProject({ repos: [] }, [], { exec: fakeExec });
  assert.equal(dr.supported, false);
  assert.match(dr.reason, /2\.30/);
  await runner.gitVersion({ refresh: true }); // restore the real cached version for later tests
});
