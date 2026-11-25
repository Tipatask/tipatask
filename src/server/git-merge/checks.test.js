'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const fx = require('./test-fixture');
const { parseTap, parseSpec, parseTestOutput, diffFailures, compareChecks, resolveNodeForChecks, runCheck, runRepoChecks, OutputCapture } = require('./checks');

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

// What `node --test` prints into a pipe from Node 23 on, where the spec reporter is the default:
// taken from a Node 24 run of a fixture with a failed, passed, skipped and todo test, a suite, a
// subtest and a test file that fails to load. A failed test is listed again under "failing tests:".
const SPEC_OUTPUT = [
  '✖ always fails (0.262208ms)',
  '✔ passes (0.053584ms)',
  '﹣ skipped one (0.030334ms) # not here',
  '⚠ todo one (0.029792ms) # TODO',
  '✖ name with (parens) and 12ms inside (0.029167ms)',
  '▶ a suite',
  '  ✖ nested fails (0.047459ms)',
  '  ✔ nested passes (0.025458ms)',
  '✖ a suite (0.424958ms)',
  '▶ parent',
  '  ✖ child fails (0.041042ms)',
  '✖ parent (0.1305ms)',
  "Error: Cannot find module './does-not-exist'",
  'Node.js v24.16.0',
  '✖ broken.test.js (20.774584ms)',
  'ℹ tests 10', 'ℹ suites 1', 'ℹ pass 2', 'ℹ fail 6', 'ℹ cancelled 0', 'ℹ skipped 1', 'ℹ todo 1', 'ℹ duration_ms 34.617542',
  '',
  '✖ failing tests:',
  '',
  'test at a.test.js:2:1',
  '✖ always fails (0.262208ms)',
  '  Error: x',
  '      at TestContext.<anonymous> (/repo/a.test.js:2:38)',
  '',
  'test at a.test.js:5:1',
  '⚠ todo one (0.029792ms) # TODO',
  '  Error: later',
  '',
  'test at a.test.js:8:3',
  '✖ nested fails (0.047459ms)',
  '  Error: z',
  '',
  'test at broken.test.js:1:1',
  '✖ broken.test.js (20.774584ms)',
  "  'test failed'",
].join('\n');
const SPEC_FAILURES = ['always fails', 'name with (parens) and 12ms inside', 'nested fails', 'a suite', 'child fails', 'parent', 'broken.test.js'];

test('parseSpec: failed rows by name, nested and file-level, listed once; skipped, todo and the section header are not failures', () => {
  const r = parseSpec(SPEC_OUTPUT);
  assert.deepEqual(r.failures, SPEC_FAILURES);
  assert.equal(r.hasSpec, true);
  assert.equal(r.notOk, 10, 'three failures are printed twice');
  assert.equal(r.ok, 2);
  assert.equal(r.passed, 2); assert.equal(r.failed, 6);
  const clean = parseSpec(['✔ a (1.5ms)', '✔ b (2ms)', 'ℹ tests 2', 'ℹ pass 2', 'ℹ fail 0'].join('\n'));
  assert.deepEqual([clean.failures, clean.hasSpec, clean.ok, clean.passed, clean.failed], [[], true, 2, 2, 0]);
});

test('parseSpec: coloured and CRLF output is read the same way', () => {
  const coloured = SPEC_OUTPUT.split('\n').map(line => (line.includes('✖') ? `\u001b[31m${line}\u001b[39m` : `\u001b[90m${line}\u001b[0m`)).join('\r\n');
  const r = parseSpec(coloured);
  assert.deepEqual(r.failures, SPEC_FAILURES);
  assert.equal(r.hasSpec, true); assert.equal(r.failed, 6);
});

test('parseSpec: only node:test output with its totals is recognised', () => {
  // mocha's spec reporter shares the pass glyph and prints a duration for a slow test.
  const mocha = ['  suite', '    ✔ fast test', '    ✔ slow test (45ms)', '    1) broken test', '', '  2 passing (60ms)', '  1 failing'].join('\n');
  assert.equal(parseSpec(mocha).hasSpec, false);
  assert.deepEqual([parseTestOutput(mocha).hasTap, parseTestOutput(mocha).format], [false, null]);
  // A run killed before its totals, and totals that count failures no row names.
  assert.equal(parseSpec('✖ always fails (0.2ms)\n✔ passes (0.1ms)\n').hasSpec, false);
  assert.equal(parseSpec('✔ passes (0.1ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\n').hasSpec, false);
  for (const text of ['', null, undefined, 'Error: boom\n', 'ℹ pass 2\nℹ fail 0\n']) assert.equal(parseSpec(text).hasSpec, false, String(text));
  // An unrecognised failing run is judged by its exit code.
  const base = { test: { status: 1, failures: ['a'], hasTap: true } };
  assert.equal(compareChecks(base, { test: { status: 1, ...parseTestOutput(mocha) } }).blocking, true);
});

test('parseTestOutput: one result for TAP, spec, or both in one run', () => {
  const tapText = ['TAP version 13', 'not ok 1 - always fails', 'ok 2 - passes', '    not ok 1 - nested fails', 'not ok 3 - a suite', '# pass 1', '# fail 2'].join('\n');
  const tap = parseTestOutput(tapText);
  assert.deepEqual([tap.failures, tap.hasTap, tap.format, tap.passed, tap.failed], [['always fails', 'nested fails', 'a suite'], true, 'tap', 1, 2]);
  assert.deepEqual({ ...tap, format: undefined }, { ...parseTap(tapText), format: undefined }, 'TAP alone keeps the TAP parser result');
  const spec = parseTestOutput(SPEC_OUTPUT);
  assert.deepEqual([spec.failures, spec.hasTap, spec.format, spec.passed, spec.failed], [SPEC_FAILURES, true, 'spec', 2, 6]);
  const both = parseTestOutput(`${tapText}\n${SPEC_OUTPUT}`);
  assert.equal(both.format, 'tap+spec');
  assert.deepEqual(both.failures, ['always fails', 'nested fails', 'a suite', 'name with (parens) and 12ms inside', 'child fails', 'parent', 'broken.test.js']);
  assert.deepEqual([both.passed, both.failed, both.hasTap], [3, 8, true]);
  // The same failing tests are pre-existing in either format, so a reporter switch between the
  // baseline and the post-merge run does not make them new.
  const report = compareChecks({ test: { status: 1, ...tap } }, { test: { status: 1, ...parseTestOutput(SPEC_OUTPUT.replace(/^.*(?:parens|child fails|parent|broken).*$/gm, '').replace('fail 6', 'fail 2')) } });
  assert.deepEqual(report.test.newFailures, []);
  assert.equal(report.blocking, false);
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
  const el = await resolveNodeForChecks({ projectRoot: path.resolve(__dirname, '../../..'), isElectron: true, exec, isWin: false });
  assert.equal(el.source, 'mcp-node');
  assert.equal(el.node, '/fake/nvm/v22/bin/node');
  assert.ok(calls[0][0].endsWith(path.join('bin', 'mcp-node')));
  assert.equal(el.npmCli, null, 'fake dir has no npm-cli.js → falls back to npm on PATH');
  const none = await resolveNodeForChecks({ projectRoot: '/nowhere', isElectron: true, exec: (c, a, o, cb) => cb(new Error('nope')) });
  assert.equal(none.node, null); assert.match(none.error, /No Node\.js/);
});

// TPT575 — Windows: bin/mcp-node.cmd and npm.cmd are batch files Node >= 22 will not run shell-less.
test('resolveNodeForChecks (win32): mcp-node.cmd runs through cmd.exe; npm-cli.js is found beside node.exe', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-tpt575-checks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const node = path.join(dir, 'nodejs', 'node.exe');
  const npmCli = path.join(dir, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  fs.mkdirSync(path.dirname(npmCli), { recursive: true });
  fs.writeFileSync(node, '');
  fs.writeFileSync(npmCli, '');
  const calls = [];
  const exec = (cmd, args, opts, cb) => { calls.push({ cmd, args, opts }); cb(null, node, ''); };
  const projectRoot = path.resolve(__dirname, '../../..');
  const win = await resolveNodeForChecks({ projectRoot, isElectron: true, exec, isWin: true });
  assert.equal(path.win32.basename(calls[0].cmd).toLowerCase(), 'cmd.exe');
  assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(calls[0].args[3], /mcp-node\.cmd" "-e" "process\.stdout\.write\(process\.execPath\)""$/);
  assert.equal(calls[0].opts.windowsVerbatimArguments, true);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.timeout, 15_000);
  assert.equal(win.node, node);
  assert.equal(win.npmCli, npmCli, 'Windows installers keep npm in node_modules beside node.exe');
  const posix = await resolveNodeForChecks({ projectRoot, isElectron: true, exec: (c, a, o, cb) => cb(null, node, ''), isWin: false });
  assert.equal(posix.npmCli, null, 'POSIX looks only in <prefix>/lib/node_modules');
});

function captureSpawn() {
  const calls = [];
  const children = new Map();
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 4300 + calls.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    calls.push({ command, args, options });
    children.set(child.pid, child);
    return child;
  };
  return { calls, children, spawnFn };
}

test('runCheck (win32): without npm-cli.js, cmd.exe runs npm.cmd; with it, node runs npm directly; a timeout taskkills the tree', async () => {
  const { calls, children, spawnFn } = captureSpawn();
  const trees = [];
  const killTree = pid => { trees.push(pid); setImmediate(() => children.get(pid).emit('close', null)); return true; };
  const viaCmd = runCheck({ repoPath: 'C:\\repo', script: 'test', node: 'C:\\nodejs\\node.exe', npmCli: null, isWin: true, spawnFn, killTree });
  setImmediate(() => children.get(4300).emit('close', 0));
  assert.equal((await viaCmd).status, 0);
  assert.equal(path.win32.basename(calls[0].command).toLowerCase(), 'cmd.exe');
  assert.deepEqual(calls[0].args, ['/d', '/s', '/c', '""npm.cmd" "test""']);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.equal(calls[0].options.detached, false);
  assert.equal(calls[0].options.windowsHide, true);

  const npmCli = 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  const keepAlive = setInterval(() => {}, 1000); // runCheck's own timeout timer is unref'd
  const direct = await runCheck({ repoPath: 'C:\\repo', script: 'build', node: 'C:\\nodejs\\node.exe', npmCli, isWin: true, spawnFn, killTree, timeoutMs: 5 })
    .finally(() => clearInterval(keepAlive));
  assert.equal(calls[1].command, 'C:\\nodejs\\node.exe');
  assert.deepEqual(calls[1].args, [npmCli, 'run', 'build']);
  assert.equal(calls[1].options.windowsVerbatimArguments, undefined);
  assert.equal(calls[1].options.detached, false);
  assert.equal(direct.timedOut, true);
  assert.deepEqual(trees, [4301]);
});

test('runCheck (POSIX): npm runs detached in its own group, no cmd.exe', async () => {
  const { calls, children, spawnFn } = captureSpawn();
  const pending = runCheck({ repoPath: '/repo', script: 'test', node: '/usr/bin/node', npmCli: null, isWin: false, spawnFn });
  setImmediate(() => children.get(4300).emit('close', 0));
  assert.equal((await pending).status, 0);
  assert.equal(calls[0].command, 'npm');
  assert.deepEqual(calls[0].args, ['test']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsVerbatimArguments, undefined);
});

// `node --test` writes TAP into a pipe up to Node 22 and the spec reporter from Node 23 on. The
// default follows the Node that runs this suite; the two named reporters run on every version,
// so both formats are read end to end whichever Node that is.
for (const [label, flag, format] of [['the default reporter', '', null], ['the TAP reporter', ' --test-reporter=tap', 'tap'], ['the spec reporter', ' --test-reporter=spec', 'spec']])
test(`integration (${label}): baseline records a pre-existing failure, post-merge reports only the new one`, async (t) => {
  if (fx.skipUnless(t)) return;
  const resolved = await resolveNodeForChecks({ projectRoot: null, isElectron: false });
  if (!resolved.node) { t.skip(resolved.error); return; }
  const f = fx.buildFixture(t);
  const repo = f.nested;
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'nested', private: true, scripts: { test: `node --test${flag}` } }));
  fs.writeFileSync(path.join(repo, 'always.test.js'), "const {test}=require('node:test');test('always fails',()=>{throw new Error('x')});test('passes',()=>{});\n");
  f.git(repo, ['add', '-A']); f.git(repo, ['commit', '-q', '-m', 'tests']);
  const repoDesc = { id: 'ai/todo/server', path: repo, checks: { test: 'npm test', build: null } };
  const baseline = await runRepoChecks({ repo: repoDesc, enabled: { test: true, build: false }, resolved, timeoutMs: 120_000 });
  assert.equal(baseline.test.status !== 0, true);
  assert.equal(baseline.test.hasTap, true, 'per-test results are recognised');
  if (format) assert.equal(baseline.test.format, format);
  assert.deepEqual(baseline.test.failures.filter(n => !n.endsWith('.test.js')), ['always fails']);
  fs.writeFileSync(path.join(repo, 'fresh.test.js'), "const {test}=require('node:test');test('new one',()=>{throw new Error('y')});\n");
  const post = await runRepoChecks({ repo: repoDesc, enabled: { test: true, build: false }, resolved, timeoutMs: 120_000 });
  const rep = compareChecks(baseline, post);
  assert.deepEqual(rep.test.newFailures.filter(n => !n.endsWith('.test.js')), ['new one']);
  assert.deepEqual(rep.test.preExisting.filter(n => !n.endsWith('.test.js')), ['always fails']);
  assert.equal(rep.blocking, true);
});
