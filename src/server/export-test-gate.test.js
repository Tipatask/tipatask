'use strict';

// The test gate of the root export-task-app.sh: before a snapshot reaches the public checkout,
// its own unit suite runs on a copy of it, and a red suite refuses the export. The real script
// runs here against a fixture repository whose scripts/run-tests.js is a stand-in runner (one
// "test" per file in cases/), so no real suite starts. Skipped where the exporter is not shipped
// (the public Task App checkout).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fx = require('./git-merge/test-fixture');

const EXPORTER = path.resolve(__dirname, '../../../../../export-task-app.sh');
const MANIFEST = { name: 'tipatask', version: '0.9.2', license: 'Apache-2.0', repository: 'Tipatask/tipatask', engines: { node: '>=22.19.0' } };

// Stand-in for scripts/run-tests.js: node:test-shaped TAP, exit 1 on a failure. It records the
// checkout it ran in and the arguments it got, and writes a file there, the way a real test can.
function standInRunner() {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  fs.appendFileSync(process.env.GATE_RUNS, `${JSON.stringify({ root, modules: fs.realpathSync(path.join(root, 'node_modules')), args: process.argv.slice(2) })}\n`);
  // What `node --test` prints by default from Node 23 on: no TAP row for the gate to read.
  if (process.env.GATE_OUTPUT === 'spec') {
    console.log('\u2716 needs-local.js (1.5ms)\n\u2139 tests 1\n\u2139 pass 0\n\u2139 fail 1');
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(path.join(root, 'written-by-a-test.txt'), 'x');
  const cases = fs.readdirSync(path.join(root, 'cases')).sort();
  let failed = 0;
  console.log('TAP version 13');
  cases.forEach((name, i) => {
    const file = path.join(root, 'cases', name);
    try {
      require(file);
      console.log(`# Subtest: ${name}\nok ${i + 1} - ${name}\n  ---\n  type: 'test'\n  ...`);
    } catch (err) {
      failed++;
      console.log(`# Subtest: ${name}\nnot ok ${i + 1} - ${name}\n  ---\n  type: 'test'\n  location: '${file}:1:1'\n  error: '${err.code}'\n  ...`);
    }
  });
  console.log(`1..${cases.length}\n# tests ${cases.length}\n# pass ${cases.length - failed}\n# fail ${failed}\n# skipped 0`);
  process.exitCode = failed ? 1 : 0;
}

test('the export test gate runs the snapshot suite on a copy and refuses a red one', (t) => {
  if (fx.skipUnless(t)) return;
  if (!fs.existsSync(EXPORTER)) { t.skip('root exporter is not shipped in the public Task App checkout'); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'export-gate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const git = fx.makeGit(home);
  const src = path.join(home, 'src');
  const tmp = path.join(home, 'tmp');
  const runsFile = path.join(home, 'runs.jsonl');
  fs.mkdirSync(tmp);
  const manifestText = JSON.stringify(MANIFEST, null, 2);
  fx.initRepo(git, src, { files: {
    '.gitignore': '/node_modules/\n',
    'package.json': manifestText, 'package-lock.json': JSON.stringify({ ...MANIFEST, lockfileVersion: 3, packages: { '': MANIFEST } }, null, 2),
    'scripts/check-node-version.js': fs.readFileSync(path.join(__dirname, '../../scripts/check-node-version.js')),
    'LICENSE': 'Apache License\n', 'NOTICE': 'Anton Matiienko and Apppixies\n', 'RELEASING.md': 'Release procedure\n',
    'docs/social-preview.jpg': 'fixture', '.github/workflows/test.yml': 'name: test\n', '.github/workflows/build.yml': 'name: build\n',
    'src/helper.js': 'module.exports = 1;\n',
  } });
  const withoutRunner = git(src, ['rev-parse', 'HEAD']);
  fx.commit(git, src, {
    'scripts/run-tests.js': `'use strict';\n(${standInRunner})();\n`,
    'cases/loads-helper.js': "require('../src/helper');\n",
  }, 'Add the unit runner');

  const env = { ...fx.fixtureEnv(home), PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    npm_config_update_notifier: 'false', TMPDIR: `${tmp}${path.sep}`, GATE_RUNS: runsFile };
  delete env.EXPORT_TASK_APP_TEST_GATE;
  const run = (flags, extraEnv = {}) => {
    const result = spawnSync('bash', [EXPORTER, '--src', src, '--no-version-bump', '--no-notes', ...flags],
      { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.error, undefined);
    return result;
  };
  const runs = () => (fs.existsSync(runsFile) ? fs.readFileSync(runsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []);
  const fresh = name => path.join(home, name);

  // A ref from before the runner existed has no suite to run.
  let result = run(['--ref', withoutRunner, '--check-only', '--dest', fresh('none')]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Tests: NOT RUN — the exported ref has no scripts\/run-tests\.js/);

  // No installed dependencies: refused with the two ways out, never silently skipped.
  result = run(['--check-only', '--dest', fresh('none')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /test gate needs the Task App dependencies: run `npm ci` in /);
  assert.match(result.stderr, /--no-tests/);
  assert.deepEqual(runs(), []);
  fs.mkdirSync(path.join(src, 'node_modules'));

  // Green suite: the export goes through; the suite ran in a copy with --src's node_modules.
  const dest = fresh('dest');
  result = run(['--dest', dest, '--no-git']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Tests: running the Task App unit suite on the exported snapshot under Node v\d+\.\d+\.\d+ \(a few minutes/);
  assert.match(result.stdout, /Tests passed: 1 tests, 0 failed, 0 skipped in \d+s under Node v\d+\.\d+\.\d+$/m);
  assert.match(result.stdout, /Tests: passed on the exported snapshot — 1 tests, 0 failed/);
  assert.doesNotMatch(result.stderr, /WARNING: the test gate runs under/, 'a snapshot without .nvmrc pins no Node');
  assert.equal(runs().length, 1);
  const [{ root, modules, args }] = runs();
  assert.deepEqual(args, ['--test-reporter=tap'], 'the gate asks for the format it parses');
  assert.notEqual(root, fs.realpathSync(src), 'the suite never runs in --src');
  assert.equal(modules, fs.realpathSync(path.join(src, 'node_modules')));
  assert.equal(fs.existsSync(root), false, 'the copy is removed afterwards');
  assert.equal(fs.existsSync(path.join(dest, 'scripts/run-tests.js')), true);
  for (const leak of ['written-by-a-test.txt', 'node_modules']) {
    assert.equal(fs.existsSync(path.join(dest, leak)), false, `${leak} must not reach --dest`);
    if (leak !== 'node_modules') assert.equal(fs.existsSync(path.join(src, leak)), false, `${leak} must not reach --src`);
  }

  // The same snapshot again (--check-only, then the real run): the pass is remembered.
  result = run(['--check-only', '--dest', fresh('again')]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /this exact snapshot already passed the unit suite; not run again/);
  assert.match(result.stdout, /Tests: passed on the exported snapshot — 1 tests, 0 failed, 0 skipped in \d+s under Node v[\d.]+ \(an earlier run on this exact snapshot\)/);
  assert.equal(runs().length, 1);

  // A committed test that needs a module only the working tree has: green in --src, red in the
  // snapshot public CI gets. The export is refused and names the test.
  fx.commit(git, src, { 'cases/needs-local.js': "require('../src/local-only');\n" }, 'Add a test of a local module');
  fs.writeFileSync(path.join(src, 'src/local-only.js'), 'module.exports = 2;\n');
  const refused = fresh('refused');
  result = run(['--dest', refused, '--no-git']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEST GATE FAIL: the Task App unit suite fails on the exported snapshot \(2 tests, 1 failed\):/);
  assert.match(result.stderr, /^ {2}needs-local\.js {2}\(cases\/needs-local\.js:1\)$/m);
  assert.doesNotMatch(result.stderr, /loads-helper/);
  assert.match(result.stderr, /test gate failed; nothing was written to .*--no-tests/);
  assert.match(result.stderr, /^Ran under Node v[\d.]+\.$/m);
  const log = /^Full log: (.+)$/m.exec(result.stderr);
  assert.ok(log, 'the full log is kept and named');
  assert.match(fs.readFileSync(log[1], 'utf8'), /not ok 2 - needs-local\.js/);
  assert.equal(fs.existsSync(refused), false);
  assert.equal(runs().length, 2);

  // --no-tests exports that snapshot anyway and says the suite was not run.
  result = run(['--check-only', '--no-tests', '--dest', refused]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Tests: NOT RUN — --no-tests; public CI will be the first run/);

  // An export started by a test of a gate-run suite never starts a suite of its own.
  result = run(['--check-only', '--dest', refused], { EXPORT_TASK_APP_TEST_GATE: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Tests: NOT RUN — this export runs inside another export's test gate/);
  assert.equal(runs().length, 2);

  // A red run whose log has no TAP rows (the default reporter from Node 23 on): reported as such,
  // with the end of the log, never as "0 tests, 0 failed".
  result = run(['--dest', refused, '--no-git'], { GATE_OUTPUT: 'spec' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEST GATE FAIL: the Task App unit suite did not pass on the exported snapshot and its log names no failed test; the log ends:/);
  assert.match(result.stderr, /^ {2}\u2716 needs-local\.js \(1\.5ms\)$/m);
  assert.doesNotMatch(result.stderr, /0 tests, 0 failed/);
  assert.equal(fs.existsSync(refused), false);
  assert.equal(runs().length, 3);

  // ── The Node that runs the suite: the one the snapshot pins in .nvmrc, as public CI does ──
  fs.rmSync(path.join(src, 'cases/needs-local.js'));
  const current = process.version;
  const nvm = path.join(home, 'nvm');
  const calls = path.join(home, 'pinned-node-calls.txt');
  const pinNode = version => fx.commit(git, src, { '.nvmrc': `${version}\n` }, `Pin Node ${version}`);
  const installPinned = (version) => {
    const bin = path.join(nvm, 'versions/node', version, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    // Answers --version as the pinned release and otherwise runs the real node, leaving a trace.
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  };
  const pinnedCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');

  // This shell already runs the pinned version, exactly or by its major: nothing is switched.
  for (const pin of [current.slice(1), current.slice(1).split('.')[0]]) {
    pinNode(pin);
    result = run(['--check-only', '--dest', fresh('same')], { NVM_DIR: nvm });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Tests passed: 1 tests, 0 failed, 0 skipped in`) && result.stdout.includes(`under Node ${current} (.nvmrc)`), result.stdout);
    assert.doesNotMatch(result.stderr, /WARNING: the test gate runs under/);
  }
  assert.equal(pinnedCalls(), '');

  // Another version is pinned and nvm has it: the suite runs under it, whatever this shell has.
  pinNode('99.1.2');
  installPinned('v99.1.2');
  result = run(['--check-only', '--dest', fresh('pinned')], { NVM_DIR: nvm });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`under Node v99.1.2 (.nvmrc; this shell has ${current})`), result.stdout);
  assert.doesNotMatch(result.stderr, /WARNING: the test gate runs under/);
  assert.match(pinnedCalls(), /^scripts\/run-tests\.js --test-reporter=tap$/m, 'the runner starts under the pinned node');
  assert.deepEqual(runs().at(-1).args, ['--test-reporter=tap']);

  // A major-only pin takes the newest installed release of that major.
  pinNode('98');
  installPinned('v98.2.0');
  installPinned('v98.10.1');
  result = run(['--check-only', '--dest', fresh('major')], { NVM_DIR: nvm });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`under Node v98.10.1 (.nvmrc; this shell has ${current})`), result.stdout);

  // The pinned version is not installed: the suite still runs, under this shell's node, and the
  // difference from public CI is said out loud.
  pinNode('97.0.0');
  result = run(['--check-only', '--dest', fresh('missing')], { NVM_DIR: nvm });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes(`WARNING: the test gate runs under Node ${current}, but public CI uses v97.0.0 (.nvmrc) and nvm has no such version here`), result.stderr);
  assert.match(result.stderr, /nvm install 97\.0\.0/);
  assert.ok(result.stdout.includes(`under Node ${current}\n`), result.stdout);

  // A pin that names no version number (an alias) is left to the shell.
  pinNode('lts/krypton');
  result = run(['--check-only', '--dest', fresh('alias')], { NVM_DIR: nvm });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /WARNING: the test gate runs under/);
  assert.ok(result.stdout.includes(`under Node ${current}\n`), result.stdout);
});
