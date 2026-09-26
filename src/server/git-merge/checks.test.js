'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fx = require('./test-fixture');
const { parseTap, diffFailures, compareChecks, resolveNodeForChecks, runRepoChecks, OutputCapture } = require('./checks');

fx.applyFixtureEnvToProcess();

test('parseTap: not ok names, nested indentation, SKIP/TODO stripped, dedupe, plan lines, no-TAP detection', () => {
  const tap = [
    'TAP version 13', '# Subtest: a', 'ok 1 - a', '# Subtest: b', '    not ok 1 - inner fails', '    not ok 2 - flaky # SKIP timing',
    'not ok 2 - b', 'not ok 3 - inner fails', '# pass 1', '# fail 2',
  ].join('\n');
  const r = parseTap(tap);
  assert.deepEqual(r.failures, ['inner fails', 'flaky', 'b']);
  assert.equal(r.ok, 1); assert.equal(r.notOk, 4); assert.equal(r.hasTap, true);
  assert.equal(r.passed, 1); assert.equal(r.failed, 2);
  assert.equal(parseTap('Error: boom\n').hasTap, false);
});

test('diffFailures + compareChecks: new vs pre-existing vs fixed; exit-code fallback; build', () => {
  assert.deepEqual(diffFailures(['a', 'b'], ['b', 'c']), { newFailures: ['c'], preExisting: ['b'], fixed: ['a'] });
  const base = { test: { status: 1, failures: ['a'], hasTap: true } };
  const post = { test: { status: 1, failures: ['a'], hasTap: true, output: 'o' }, build: { status: 0, output: '' } };
  const ok = compareChecks(base, post);
  assert.equal(ok.blocking, false); assert.deepEqual(ok.test.preExisting, ['a']); assert.equal(ok.test.hadBaseline, true); assert.equal(ok.test.stdoutTail, 'o');
  const noBase = compareChecks(null, post);
  assert.equal(noBase.blocking, true, 'no baseline + failing → blocking');
  const noTap = compareChecks(base, { test: { status: 2, failures: [], hasTap: false } });
  assert.equal(noTap.blocking, true, 'no TAP → judge by exit code');
  const buildBroke = compareChecks(base, { test: { status: 0, failures: [], hasTap: true }, build: { status: 1 } });
  assert.equal(buildBroke.blocking, true); assert.equal(buildBroke.build.blocking, true);
  assert.equal(compareChecks(null, { test: null, build: null, error: 'no node' }).error, 'no node');
});

test('OutputCapture keeps head + tail under the cap', () => {
  const c = new OutputCapture(20);
  c.push('0123456789'); c.push('abcdefghij'); c.push('KLMNOPQRST');
  assert.equal(c.truncated, true);
  assert.match(c.text(), /^0123456789\n\.\.\. \(output truncated\) \.\.\.\nKLMNOPQRST$/);
  const small = new OutputCapture(100); small.push('abc'); small.push('def');
  assert.equal(small.text(), 'abcdef');
});

test('resolveNodeForChecks: process node when eligible; Electron path asks bin/mcp-node via injected exec', async () => {
  const own = await resolveNodeForChecks({ projectRoot: null, isElectron: false });
  assert.equal(own.node, process.execPath); assert.equal(own.source, 'process');
  const calls = [];
  const exec = (cmd, args, opts, cb) => { calls.push([cmd, args]); cb(null, '/fake/nvm/v22/bin/node', ''); };
  const el = await resolveNodeForChecks({ projectRoot: path.resolve(__dirname, '../../..'), isElectron: true, exec });
  assert.equal(el.source, 'mcp-node');
  assert.equal(el.node, '/fake/nvm/v22/bin/node');
  assert.ok(calls[0][0].endsWith(path.join('bin', process.platform === 'win32' ? 'mcp-node.cmd' : 'mcp-node')));
  assert.equal(el.npmCli, null, 'fake dir has no npm-cli.js → falls back to npm on PATH');
  const none = await resolveNodeForChecks({ projectRoot: '/nowhere', isElectron: true, exec: (c, a, o, cb) => cb(new Error('nope')) });
  assert.equal(none.node, null); assert.match(none.error, /No Node\.js/);
});

test('integration: baseline records a pre-existing failure, post-merge reports only the new one', async (t) => {
  if (fx.skipUnless(t)) return;
  const resolved = await resolveNodeForChecks({ projectRoot: null, isElectron: false });
  if (!resolved.node) { t.skip(resolved.error); return; }
  const f = fx.buildFixture(t);
  const repo = f.nested;
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'nested', private: true, scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(repo, 'always.test.js'), "const {test}=require('node:test');test('always fails',()=>{throw new Error('x')});test('passes',()=>{});\n");
  f.git(repo, ['add', '-A']); f.git(repo, ['commit', '-q', '-m', 'tests']);
  const repoDesc = { id: 'ai/todo/server', path: repo, checks: { test: 'npm test', build: null } };
  const baseline = await runRepoChecks({ repo: repoDesc, enabled: { test: true, build: false }, resolved, timeoutMs: 120_000 });
  assert.equal(baseline.test.status !== 0, true);
  assert.deepEqual(baseline.test.failures.filter(n => !n.endsWith('.test.js')), ['always fails']);
  fs.writeFileSync(path.join(repo, 'fresh.test.js'), "const {test}=require('node:test');test('new one',()=>{throw new Error('y')});\n");
  const post = await runRepoChecks({ repo: repoDesc, enabled: { test: true, build: false }, resolved, timeoutMs: 120_000 });
  const rep = compareChecks(baseline, post);
  assert.deepEqual(rep.test.newFailures.filter(n => !n.endsWith('.test.js')), ['new one']);
  assert.deepEqual(rep.test.preExisting.filter(n => !n.endsWith('.test.js')), ['always fails']);
  assert.equal(rep.blocking, true);
});
