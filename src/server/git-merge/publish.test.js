'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fx = require('./test-fixture');
const { scanProject, detectMainBranch } = require('./repo-discovery');
const { publishProject, buildPrBody, buildPrTitle, createPr, forgeRepository } = require('./publish');

fx.applyFixtureEnvToProcess();

test('forge URLs: SSH/HTTPS remotes, credentials stripped, local and unsupported remotes excluded', () => {
  assert.deepEqual(forgeRepository('git@github.com:team/repo.git'), { url: 'https://github.com/team/repo', host: 'github.com' });
  assert.equal(forgeRepository('https://user:secret@gitlab.com/group/sub/repo.git').url, 'https://gitlab.com/group/sub/repo');
  assert.equal(forgeRepository('ssh://git@bitbucket.org/team/repo.git').url, 'https://bitbucket.org/team/repo');
  for (const remote of ['/tmp/repo.git', 'file:///tmp/repo.git', 'https://forge.example/team/repo', 'https://github.com:999/team/repo']) assert.equal(forgeRepository(remote), null);
});

test('publishing records links only after success; metadata failures preserve push/PR results', async () => {
  const calls = [];
  const backend = { async addTaskDevLink(key, link) { calls.push({ key, ...link }); return { dev_link: link }; } };
  const repo = { id: 'root', kind: 'root', path: '/fixture', currentBranch: 'task/TPT1', mainBranch: 'main' };
  const git = async args => {
    if (args[0] === 'push') calls.push({ push: true });
    return { status: 0, stdout: args[0] === 'remote' ? 'git@github.com:team/repo.git' : '', stderr: '' };
  };
  const exec = (_cmd, _args, _opts, cb) => { cb(null, 'https://github.com/team/repo/pull/9\n', ''); return { stdin: { end() {} } }; };
  const options = { repos: [repo], merged: { root: ['TPT1', 'TPT2'] }, backend, git, exec };
  const published = await publishProject(options);
  assert.deepEqual(calls[0], { push: true });
  for (const key of ['TPT1', 'TPT2']) {
    assert.ok(calls.some(row => row.key === key && row.kind === 'branch' && row.url === 'https://github.com/team/repo/tree/task%2FTPT1'));
    assert.ok(calls.some(row => row.key === key && row.kind === 'pr' && row.url === published.repos[0].prUrl));
  }
  assert.deepEqual(published.repos[0].devLinkErrors, []);
  const failed = await publishProject({ ...options, backend: { async addTaskDevLink() { throw new Error('API offline'); } } });
  assert.equal(failed.repos[0].pushed, true);
  assert.equal(failed.repos[0].prUrl, 'https://github.com/team/repo/pull/9');
  assert.ok(failed.repos[0].devLinkErrors.every(row => row.error === 'API offline'));
  calls.length = 0;
  await publishProject({ ...options, git: async () => ({ status: 1, stderr: 'push failed' }) });
  assert.deepEqual(calls, []);
});

function withBareOrigins(f) {
  const bareRoot = path.join(f.home, 'origin-root.git'); const bareNested = path.join(f.home, 'origin-nested.git');
  f.git(f.home, ['init', '-q', '--bare', bareRoot]); f.git(f.home, ['init', '-q', '--bare', bareNested]);
  f.git(f.root, ['remote', 'add', 'origin', bareRoot]); f.git(f.nested, ['remote', 'add', 'origin', bareNested]);
  return { bareRoot, bareNested };
}

test('buildPrBody/Title: keys + titles, never attribution, long lists collapse', () => {
  const body = buildPrBody({ mergedTasks: [{ key: 'TPT1', title: 'One' }, { key: 'TPT2', title: '' }], repoRelPath: 'ai/todo/server' });
  assert.equal(body, 'Merged task branches (ai/todo/server):\n\n- TPT1 — One\n- TPT2\n');
  assert.doesNotMatch(body, /Co-Authored|Generated/);
  assert.equal(buildPrTitle(['TPT1', 'TPT2']), 'Merge TPT1, TPT2');
  assert.equal(buildPrTitle(Array.from({ length: 20 }, (_, i) => `TPT${i}`)), 'Merge 20 task branches');
  assert.equal(buildPrTitle([]), 'Merge task branches');
});

test('publishProject: nested pushed before root, PR skipped when target is main, gh absent → skipped, gh present → URL parsed', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const { bareRoot, bareNested } = withBareOrigins(f);
  const scan = await scanProject(f.root);
  const order = [];
  const ghMissing = (cmd, args, opts, cb) => { order.push(cmd); const e = new Error('ENOENT'); e.code = 'ENOENT'; cb(e, '', ''); return { stdin: { end() {} } }; };
  // target == master, no origin/HEAD → gh fallback for main branch; PR skipped when main === target
  const r1 = await publishProject({ repos: scan.repos, merged: { root: ['TPT1'] }, pr: true, bases: { root: 'master', 'ai/todo/server': 'master' }, exec: ghMissing });
  assert.deepEqual(r1.repos.map(r => [r.repoId, r.pushed, r.prSkipped]), [['ai/todo/server', true, 'target-is-main'], ['root', true, 'target-is-main']]);
  assert.equal(f.git(f.home, ['-C', bareNested, 'rev-parse', 'master']), f.git(f.nested, ['rev-parse', 'HEAD']));
  assert.equal(f.git(f.home, ['-C', bareRoot, 'rev-parse', 'master']), f.git(f.root, ['rev-parse', 'HEAD']));
  // now target a feature branch: PR attempted; gh absent → skipped with a suggested command
  f.git(f.root, ['checkout', '-q', '-b', 'release']); f.git(f.nested, ['checkout', '-q', '-b', 'release']);
  const scan2 = await scanProject(f.root);
  const r2 = await publishProject({ repos: scan2.repos, merged: { root: ['TPT1'] }, pr: true, bases: { root: 'master', 'ai/todo/server': 'master' }, exec: ghMissing });
  assert.equal(r2.repos[1].prSkipped, 'gh-not-found');
  assert.match(r2.repos[1].suggested, /gh pr create --base master --head release/);
  const ghOk = (cmd, args, opts, cb) => { order.push([cmd, ...args].join(' ')); cb(null, 'https://github.com/x/y/pull/7\n', ''); return { stdin: { end(body) { order.push('body:' + body); } } }; };
  const r3 = await publishProject({ repos: scan2.repos, merged: { root: ['TPT1'] }, tasksByKey: f.tasksByKey, pr: true, bases: { root: 'master', 'ai/todo/server': 'master' }, exec: ghOk });
  assert.equal(r3.repos[1].prUrl, 'https://github.com/x/y/pull/7');
  assert.ok(order.some(o => typeof o === 'string' && o.includes('gh pr create --base master --head release --title Merge TPT1')));
  assert.ok(order.some(o => typeof o === 'string' && o.startsWith('body:') && o.includes('TPT1 — Feature one')));
});

test('publishProject: nested push failure skips the root push with an explanation + suggested command', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  withBareOrigins(f);
  f.git(f.nested, ['remote', 'set-url', 'origin', path.join(f.home, 'does-not-exist.git')]);
  const scan = await scanProject(f.root);
  const r = await publishProject({ repos: scan.repos, pr: false });
  assert.equal(r.repos[0].pushed, false); assert.ok(r.repos[0].error); assert.match(r.repos[0].suggested, /git push -u origin master/);
  assert.equal(r.repos[1].pushed, false); assert.match(r.repos[1].error, /nested repository push failed/);
});

test('detectMainBranch: origin/HEAD wins; gh fallback; null when neither', async (t) => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  withBareOrigins(f);
  f.git(f.root, ['push', '-q', '-u', 'origin', 'master']);
  f.git(f.root, ['remote', 'set-head', 'origin', 'master']);
  assert.deepEqual(await detectMainBranch(f.root, { refresh: true }), { mainBranch: 'master', mainBranchSource: 'origin-head' });
  const ghExec = (cmd, args, opts, cb) => { cb(null, 'whitemaster\n', ''); return { stdin: { end() {} } }; };
  assert.deepEqual(await detectMainBranch(f.nested, { refresh: true, exec: ghExec }), { mainBranch: 'whitemaster', mainBranchSource: 'gh' });
  const none = (cmd, args, opts, cb) => { const e = new Error('ENOENT'); e.code = 'ENOENT'; cb(e, '', ''); return { stdin: { end() {} } }; };
  assert.deepEqual(await detectMainBranch(f.nested, { refresh: true, exec: none }), { mainBranch: null, mainBranchSource: null });
  const pr = await createPr({ repo: { path: f.root }, base: 'master', head: 'x', title: 't', body: 'b', exec: (c, a, o, cb) => { cb(Object.assign(new Error('boom'), { code: 1 }), '', 'gh: auth required'); return { stdin: { end() {} } }; } });
  assert.equal(pr.ok, false); assert.match(pr.error, /auth required/);
});
