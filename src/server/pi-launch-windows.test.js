'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const plain = value => JSON.parse(JSON.stringify(value));

function load(file, processOverrides, mocks = {}, consoleOverrides = {}) {
  const filename = path.join(__dirname, file);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id),
    process: { platform: 'win32', execPath: process.execPath, env: {}, versions: {}, pid: process.pid, ...processOverrides },
    console: { log() {}, error() {}, warn() {}, debug() {}, ...consoleOverrides },
    setTimeout, clearTimeout, Buffer, Date,
  }, { filename });
  return module.exports;
}

// (TPT9047) The staged Windows verification deadlines — runtime (`node.exe --version`), import
// (one ESM file printing Pi's VERSION) and cli (`cli.js --version`, a full import of Pi's tree).
const STAGE = { runtime: 5000, import: 15000, cli: 60000 };
const isImportStage = args => args[0] === '--input-type=module';
const isRuntimeStage = args => args.length === 1 && args[0] === '--version';

// Each execFile call answers by stage: a bare `--version` is the runtime's Node version (bundled:
// `bundledVersion`; system: the entry's `version`), an `--input-type=module -e` import is the
// `imports` outcome, and `cli.js --version` the `outcomes` one (shared counter across runtimes, a
// system entry's own `output` winning). 'timeout' never answers; an Error is the spawn failure.
function fixture(t, { outcomes = ['0.84.1'], imports = ['0.84.1'], bundledVersion = 'v22.22.1',
  fallback = true, platform = 'win32', system = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-pi-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, 'resources');
  const pkg = path.join(resources, 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const cli = path.join(pkg, 'dist', 'cli.js');
  const node = path.join(resources, 'pi', 'node_modules', 'tipatask-node', 'node.exe');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '0.84.1' }));
  if (fallback) {
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '');
  }
  const calls = [], kills = [];
  const execPath = path.join(root, 'TipATask.exe');
  const nvmRoot = path.join(root, 'nvm');
  const systemNodes = system.map((entry, index) => {
    const dir = entry.source === 'nvm' ? path.join(nvmRoot, `v${entry.version.replace(/^v/, '')}`)
      : path.join(root, `${entry.source || 'path'}-${index}`);
    const command = path.join(dir, 'node.exe');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(command, '');
    return { ...entry, command, dir };
  });
  let piCalls = 0, importCalls = 0;
  const su = load('spawn-utils.js', { platform, execPath, resourcesPath: resources, env: {
    Path: ['C:\\Windows', ...systemNodes.filter(n => !n.source || n.source === 'path').map(n => n.dir)].join(';'),
    NVM_HOME: nvmRoot, ELECTRON_RUN_AS_NODE: '1',
  } }, {
    'node:os': { ...os, homedir: () => path.join(root, 'home') },
    'node:child_process': {
      execFileSync: (command, args) => args[1] === 'HKCU\\Environment'
        ? `    Path    REG_SZ    ${systemNodes.filter(n => n.source === 'registry').map(n => n.dir).join(';')}` : '',
      execFile(command, args, options, cb) {
        calls.push({ command, args: plain(args), options: plain(options) });
        const nodeCheck = systemNodes.find(n => n.command === command);
        let output;
        if (isRuntimeStage(args)) output = nodeCheck ? nodeCheck.version : bundledVersion;
        else if (isImportStage(args)) {
          output = nodeCheck?.import ?? imports[Math.min(importCalls, imports.length - 1)];
          importCalls++;
        } else {
          output = nodeCheck?.output ?? outcomes[Math.min(piCalls, outcomes.length - 1)];
          piCalls++;
        }
        const child = { pid: 123456, kill() {} };
        const respond = value => cb(value instanceof Error ? value : null, typeof value === 'string' ? value : '', '');
        if (output?.delay) setTimeout(() => respond(output.stdout), output.delay);
        else if (output !== 'timeout') queueMicrotask(() => respond(output));
        return child;
      },
    },
    './process-group': {
      killProcessGroup() { assert.fail('Windows runtime cleanup must take the child tree'); },
      killWindowsChildTree(child) { kills.push([child.pid, 'tree']); return true; },
    },
  });
  const serverRoot = path.join(resources, 'app.asar');
  return { su, root, cli, node, calls, kills, execPath, serverRoot, systemNodes };
}

const stagesOf = calls => calls.map(c => isRuntimeStage(c.args) ? 'runtime' : isImportStage(c.args) ? 'import' : 'cli');

test('packaged Windows Pi: console Node is verified in stages before and after resolution; checks coalesce and cache', async t => {
  const f = fixture(t);
  assert.equal(f.su.resolvePiLaunch(f.serverRoot).command, f.node, 'even the first sync launch must avoid the GUI executable');
  const [a, b] = await Promise.all([f.su.resolvePiLaunchAsync(f.serverRoot), f.su.resolvePiLaunchAsync(f.serverRoot)]);
  assert.equal(a, b);
  assert.equal(a.command, f.node);
  assert.equal(a.piVersion, '0.84.1', 'the verified launch carries the version cli.js printed');
  assert.deepEqual(stagesOf(f.calls), ['runtime', 'import', 'cli'], 'cheap stages first, the full Pi import last');
  assert.deepEqual(f.calls[0].args, ['--version']);
  assert.match(f.calls[1].args[2], /import\("file:.*config\.js"\)\.then\(m => process\.stdout\.write\(String\(m\.VERSION\)\)\)/);
  assert.equal(f.calls[1].args.includes('--version'), false, 'after -e, --version would print Node\'s version instead');
  assert.deepEqual(f.calls[2].args, [f.cli, '--version']);
  for (const [index, stage] of ['runtime', 'import', 'cli'].entries()) {
    const call = f.calls[index];
    assert.equal(call.command, f.node);
    assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, '');
    assert.equal(call.options.env.PI_SKIP_VERSION_CHECK, '1');
    assert.deepEqual(Object.keys(call.options.env).filter(k => /^path$/i.test(k)), ['PATH']);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.maxBuffer, 64 * 1024);
    assert.equal(call.options.timeout, STAGE[stage], `${stage} stage deadline`);
  }
  assert.equal(a.runtimeChecks.length, 1);
  assert.deepEqual(plain(a.runtimeChecks[0].stages.map(s => [s.stage, s.timeoutMs, s.exit, s.output])),
    [['runtime', 5000, 0, 'v22.22.1'], ['import', 15000, 0, '0.84.1'], ['cli', 60000, 0, '0.84.1']]);
  assert.ok(a.runtimeChecks[0].stages.every(s => Number.isInteger(s.elapsedMs) && s.elapsedMs >= 0), 'every stage is timed');
  assert.equal(a.runtimeChecks[0].nodeVersion, 'v22.22.1');
  assert.equal(a.runtimeChecks[0].stage, 'cli', 'the entry summarizes its last stage');
  assert.equal(f.calls.some(call => call.command === f.execPath), false, 'a GUI version check cannot certify terminal I/O');
  await f.su.resolvePiLaunchAsync(f.serverRoot);
  assert.equal(f.calls.length, 3);
  f.su.clearBinCache('pi');
  await f.su.resolvePiLaunchAsync(f.serverRoot);
  assert.equal(f.calls.length, 6, 'Re-Check revalidates runtime');
});

for (const output of ['', 'TipATask 0.9.15', Object.assign(new Error('denied'), { code: 'EPERM' })]) {
  test(`packaged Windows Pi: bundled cli stage ${String(output) || 'silent exit 0'} falls back to system node.exe`, async t => {
    const f = fixture(t, { outcomes: [output], system: [{ version: 'v22.22.1', output: '0.84.1' }] });
    const launch = await f.su.resolvePiLaunchAsync(f.serverRoot);
    assert.equal(launch.command, f.systemNodes[0].command);
    assert.deepEqual(plain(launch.argsPrefix), [f.cli]);
    assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '');
    assert.deepEqual(stagesOf(f.calls), ['runtime', 'import', 'cli', 'runtime', 'import', 'cli']);
    assert.equal(launch.runtimeChecks.length, 2);
    assert.equal(launch.runtimeChecks[0].stage, 'cli', 'the bundled runtime failed at the cli stage, not before');
    assert.equal(launch.runtimeChecks[0].stages.length, 3);
    assert.equal(launch.runtimeChecks[1].stage, 'cli');
    assert.equal(launch.runtimeChecks[1].timeoutMs, 60000);
    assert.equal(launch.runtimeChecks[1].nodeVersion, 'v22.22.1');
    assert.equal(f.calls[5].options.env.ELECTRON_RUN_AS_NODE, '');
    assert.equal(f.su.resolvePiLaunch(f.serverRoot).command, launch.command, 'sync consumers reuse verified fallback');
  });
}

test('packaged Windows Pi: a wrong import-stage version stops before the full cli import', async t => {
  const f = fixture(t, { imports: ['0.83.0'], system: [{ version: 'v22.22.1', import: '0.84.1', output: '0.84.1' }] });
  const launch = await f.su.resolvePiLaunchAsync(f.serverRoot);
  assert.equal(launch.command, f.systemNodes[0].command);
  assert.deepEqual(stagesOf(f.calls), ['runtime', 'import', 'runtime', 'import', 'cli']);
  assert.equal(launch.runtimeChecks[0].stage, 'import');
  assert.match(launch.runtimeChecks[0].output, /expected Pi 0\.84\.1, got 0\.83\.0/);
});

test('packaged Windows Pi: a bundled Node below the engine floor is rejected at the runtime stage', async t => {
  const f = fixture(t, { bundledVersion: 'v20.19.0', system: [{ version: 'v22.22.1', output: '0.84.1' }] });
  const launch = await f.su.resolvePiLaunchAsync(f.serverRoot);
  assert.equal(launch.command, f.systemNodes[0].command);
  assert.deepEqual(stagesOf(f.calls), ['runtime', 'runtime', 'import', 'cli']);
  assert.equal(launch.runtimeChecks[0].stage, 'runtime');
  assert.match(launch.runtimeChecks[0].output, /Node v20\.19\.0 does not satisfy >=22\.19\.0/);
});

test('packaged Windows Pi: unverified fallback or missing node fails with actionable evidence, even after exit 0', async t => {
  for (const fallback of [true, false]) {
    const f = fixture(t, { outcomes: [''], fallback });
    await assert.rejects(f.su.resolvePiLaunchAsync(f.serverRoot), error => {
      assert.equal(error.code, 'EPI_RUNTIME');
      if (fallback) assert.equal(error.probe.status, 0);
      assert.match(error.probe.output, /Expected Pi 0.84.1;/);
      assert.equal(error.runtimeChecks.some(check => check.runtime === 'electron'), false);
      assert.match(error.message, /bundled-node/);
      assert.match(error.message, /system-node .*not found/);
      assert.equal(error.launch.command, f.node);
      assert.equal(error.runtimeChecks.length, 2);
      if (fallback) {
        assert.match(error.message, /bundled-node \(.*node\.exe\) cli stage \d+ms\/60000ms: empty output/);
        assert.equal(error.stage, 'cli');
        assert.equal(error.timeoutMs, 60000);
        assert.equal(error.runtime, 'bundled-node');
        assert.equal(error.stageOutput, 'empty output');
      } else {
        assert.match(error.message, /bundled node.exe is missing/);
        assert.equal(error.stage, null, 'no stage ran');
      }
      return true;
    });
  }
});

// Each stage's deadline is its own: the timer that fires names the stage, takes the captured
// child tree, and the recorded check carries the stage, the elapsed time and the kill result.
for (const [stage, before, fixtureOpts] of [
  ['runtime', [], { bundledVersion: 'timeout' }],
  ['import', ['runtime'], { imports: ['timeout'] }],
  ['cli', ['runtime', 'import'], { outcomes: ['timeout'] }],
]) {
  test(`packaged Windows Pi: bundled ${stage} stage timeout trips at ${STAGE[stage]}ms, takes the child tree, then tries system Node`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const f = fixture(t, { ...fixtureOpts, system: [{ version: 'v22.22.1', import: '0.84.1', output: '0.84.1' }] });
    const pending = f.su.resolvePiLaunchAsync(f.serverRoot);
    for (let i = 0; i <= before.length; i++) await new Promise(setImmediate);
    assert.deepEqual(stagesOf(f.calls), [...before, stage]);
    t.mock.timers.tick(STAGE[stage] - 1);
    assert.deepEqual(f.kills, []);
    t.mock.timers.tick(1);
    const launch = await pending;
    assert.equal(launch.command, f.systemNodes[0].command);
    assert.deepEqual(f.kills, [[123456, 'tree']]);
    const failed = launch.runtimeChecks[0];
    assert.equal(failed.runtime, 'bundled-node');
    assert.equal(failed.stage, stage);
    assert.equal(failed.timeoutMs, STAGE[stage]);
    assert.equal(failed.elapsedMs, STAGE[stage]);
    assert.equal(failed.output, 'ETIMEDOUT');
    assert.equal(failed.stages.at(-1).killed, true, 'the tree kill result is recorded');
    assert.equal(failed.stages.length, before.length + 1, 'no later stage runs after a timeout');
    assert.deepEqual(stagesOf(f.calls), [...before, stage, 'runtime', 'import', 'cli']);
  });
}

test('packaged Windows Pi: standalone cli stage timeout is bounded at sixty seconds and names the stage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const f = fixture(t, { outcomes: ['timeout'] });
  const pending = assert.rejects(f.su.resolvePiLaunchAsync(f.serverRoot), error => {
    assert.equal(error.code, 'EPI_RUNTIME');
    assert.match(error.message, /bundled-node \(.*\) cli stage 60000ms\/60000ms: ETIMEDOUT/);
    assert.equal(error.stage, 'cli');
    assert.equal(error.elapsedMs, 60000);
    assert.equal(error.timeoutMs, 60000);
    return true;
  });
  for (let i = 0; i < 3; i++) await new Promise(setImmediate);
  t.mock.timers.tick(59999);
  assert.deepEqual(f.kills, []);
  t.mock.timers.tick(1);
  await pending;
  assert.deepEqual(f.kills, [[123456, 'tree']]);
});

for (const source of ['path', 'registry', 'nvm']) {
  test(`packaged Windows Pi: system node.exe from ${source} runs staged CLI after bundled runtimes fail`, async t => {
    const f = fixture(t, { outcomes: ['wrong Pi version', '0.84.1'],
      system: [{ source, version: 'v22.22.1' }] });
    const launch = await f.su.resolvePiLaunchAsync(f.serverRoot);
    assert.equal(launch.command, f.systemNodes[0].command);
    assert.equal(launch.piVersion, '0.84.1');
    assert.equal(launch.runtimeChecks.length, 2);
    assert.equal(launch.runtimeChecks[1].runtime, 'system-node');
    assert.equal(launch.runtimeChecks[1].stage, 'cli');
    assert.equal(launch.runtimeChecks[1].timeoutMs, 60000);
    assert.equal(launch.runtimeChecks[1].nodeVersion, 'v22.22.1');
    assert.deepEqual(stagesOf(f.calls), ['runtime', 'import', 'cli', 'runtime', 'import', 'cli']);
    assert.deepEqual(f.calls[3].args, ['--version']);
    assert.deepEqual(f.calls[5].args, [f.cli, '--version']);
    for (const call of f.calls.slice(3)) {
      assert.equal(call.command, f.systemNodes[0].command);
      assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, '');
      assert.equal(call.options.maxBuffer, 64 * 1024);
    }
    assert.equal(f.su.resolvePiLaunch(f.serverRoot), launch);
    assert.equal(await f.su.resolvePiLaunchAsync(f.serverRoot), launch);
    assert.equal(f.calls.length, 6);
  });
}

test('packaged Windows Pi: missing bundled node.exe still permits a system runtime', async t => {
  const f = fixture(t, { fallback: false, outcomes: ['0.84.1'],
    system: [{ source: 'path', version: 'v22.19.0' }] });
  const launch = await f.su.resolvePiLaunchAsync(f.serverRoot);
  assert.equal(launch.command, f.systemNodes[0].command);
  assert.match(launch.runtimeChecks[0].output, /bundled node.exe is missing/);
  assert.deepEqual(plain(launch.runtimeChecks[0].stages), []);
  assert.equal(f.calls.length, 3);
});

test('packaged Windows Pi: upgrading the selected system Node invalidates its verified cache', async t => {
  const f = fixture(t, { outcomes: [''], system: [{ version: 'v22.22.1', output: '0.84.1' }] });
  await f.su.resolvePiLaunchAsync(f.serverRoot);
  assert.equal(f.calls.length, 6);
  fs.writeFileSync(f.systemNodes[0].command, 'upgraded executable');
  const launch = await f.su.resolvePiLaunchAsync(f.serverRoot);
  assert.equal(launch.command, f.systemNodes[0].command);
  assert.equal(f.calls.length, 12);
});

test('packaged Windows Pi: reject old, malformed, and prerelease Node versions and continue searching', async t => {
  const f = fixture(t, { fallback: false, outcomes: ['0.84.1'], system: [
    { source: 'path', version: 'v20.19.0' },
    { source: 'path', version: 'v22.18.99' },
    { source: 'path', version: 'v22.19.0-rc.1' },
    { source: 'registry', version: 'TipATask 0.9.15' },
    { source: 'nvm', version: 'v24.0.0' },
  ] });
  const launch = await f.su.resolvePiLaunchAsync(f.serverRoot);
  assert.equal(launch.command, f.systemNodes[4].command);
  for (const node of f.systemNodes.slice(0, 4)) {
    const calls = f.calls.filter(c => c.command === node.command);
    assert.equal(calls.length, 1, 'Rejected Node never loads cli.js');
    assert.deepEqual(calls[0].args, ['--version']);
  }
  assert.equal(launch.runtimeChecks.filter(c => /does not satisfy >=22.19.0/.test(c.output)).length, 4);
  assert.equal(launch.runtimeChecks.filter(c => c.stage === 'runtime').length, 4);
});

test('packaged Windows Pi: all-failed message names every attempted executable and requires exact Pi stdout', async t => {
  const f = fixture(t, { outcomes: ['0.84.0'], system: [
    { source: 'path', version: 'v22.22.1', output: 'Pi 0.84.1' },
    { source: 'registry', version: 'v22.22.1', output: '0.84.1\nextra output' },
  ] });
  await assert.rejects(f.su.resolvePiLaunchAsync(f.serverRoot), error => {
    assert.equal(error.code, 'EPI_RUNTIME');
    for (const command of [f.node, ...f.systemNodes.map(n => n.command)]) {
      assert.ok(error.message.includes(command), `Missing attempted executable: ${command}`);
    }
    assert.equal(error.runtimeChecks.length, 3);
    assert.deepEqual(plain(error.runtimeChecks.map(c => c.stage)), ['cli', 'cli', 'cli']);
    assert.equal(error.runtime, 'system-node', 'the summary names the last attempt that ran a stage');
    assert.match(error.message, /expected Pi 0\.84\.1, got 0\.84\.0/);
    return true;
  });
});

test('packaged Windows Pi: system Node version timeout is bounded and tree-killed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { fallback: false, outcomes: [''], system: [{ version: 'timeout' }] });
  const pending = assert.rejects(f.su.resolvePiLaunchAsync(f.serverRoot), /system-node \(.*\) runtime stage \d+ms\/5000ms: ETIMEDOUT/);
  await new Promise(setImmediate);
  t.mock.timers.tick(5000);
  await pending;
  assert.deepEqual(f.kills, [[123456, 'tree']]);
  assert.deepEqual(f.calls.at(-1).args, ['--version']);
});

test('Pi diagnostic --agent pi on win32 prints every runtime stage with its deadline and timing', async t => {
  const f = fixture(t, { outcomes: ['', '0.84.1'], system: [{ version: 'v22.22.1' }] });
  const lines = [];
  const script = load('../../scripts/probe-agent-detect.js', {}, {
    './check-node-version': {},
    'node:os': { ...os, homedir: () => path.join(f.root, 'home') },
    'node:child_process': { execFile: (command, args, options, cb) => {
      queueMicrotask(() => cb(Object.assign(new Error('missing'), { code: 'ENOENT' }), ''));
      return { pid: 123456, kill() {} };
    } },
    '../src/server/spawn-utils': { ...f.su, PROBE_DIRS: [],
      resolveBin: () => null, resolveBinAsync: async () => null, resolveBundledBin: () => null,
      readWindowsRegistryPathDirs: () => [],
      resolvePiLaunch: () => f.su.resolvePiLaunch(f.serverRoot),
      resolvePiLaunchAsync: () => f.su.resolvePiLaunchAsync(f.serverRoot),
    },
    '../src/server/task-agent/base-agent': { runCliProbe: async (command, args, { env }) => {
      assert.equal(command, f.systemNodes[0].command);
      assert.deepEqual(plain(args), [f.cli, '--version']);
      assert.equal(env.ELECTRON_RUN_AS_NODE, '');
      return { status: 0, output: '0.84.1' };
    } },
    '../src/server/task-agent': { getTaskAgent: () => ({ detect: async () => ({ available: true }) }) },
    '../src/server/config': {},
  }, { log: line => lines.push(line) });
  await script.main(['--agent', 'pi']);
  const output = lines.join('\n');
  assert.match(output, /runtime 1\s+bundled-node/);
  assert.match(output, /runtime 2\s+system-node/);
  assert.doesNotMatch(output, /runtime \d+\s+electron/);
  assert.match(output, /verified Pi\s+0\.84\.1/);
  assert.equal((output.match(/stage runtime\s+ok \d+ms \(limit 5000ms\): v22\.22\.1/g) || []).length, 2);
  assert.equal((output.match(/stage import\s+ok \d+ms \(limit 15000ms\): 0\.84\.1/g) || []).length, 2);
  assert.match(output, /stage cli\s+FAILED \d+ms \(limit 60000ms\): empty output/);
  assert.match(output, /stage cli\s+ok \d+ms \(limit 60000ms\): 0\.84\.1/);
  assert.ok(output.includes(f.systemNodes[0].command));
  assert.match(output, /available\s+true/);
});

test('packaged Pi on POSIX keeps Electron launch without Windows validation', async t => {
  const f = fixture(t, { platform: 'darwin' });
  assert.equal((await f.su.resolvePiLaunchAsync(f.serverRoot)).command, f.execPath);
  assert.deepEqual(f.calls, []);
});

function agentHarness(t, { launch, probe } = {}) {
  const f = fixture(t);
  const su = require('./spawn-utils');
  const logs = [];
  const config = { SIMPLE_MODE: false, PROJECT_ROOT: f.root, USER_DATA_ROOT: f.root, PI_MODEL: 'openrouter/test' };
  const Agent = load('task-agent/pi-agent.js', {}, {
    '../config': config,
    '../static-context': { getStaticBundle: () => '', getTaskStartupGrepBundle: () => '' },
    '../spawn-utils': { ...su,
      resolvePiLaunchAsync: async () => { if (launch instanceof Error) throw launch; return launch; },
      augmentPathEnv: extras => ({ ...extras, PATH: path.dirname(launch?.command || '') }),
      cliSpawnSpec: (bin, args, opts) => { const spec = su.cliSpawnSpec(bin, args, { ...opts, isWin: true }); logs.push(spec); return spec; },
    },
    './base-agent': class extends require('./task-agent/base-agent') {
      static runCliProbe() { return Promise.resolve(probe); }
    },
  });
  const agent = new Agent();
  agent.localizeSpawnPrompt = async (cfg, prompt, id, opts) => ({ prompt, opts });
  agent._resolveMcpBridge = () => null;
  agent._buildAppendSystemPrompt = () => 'system\n"quoted" %PATH%' + 'x'.repeat(40000);
  agent.buildPrompt = prompt => prompt;
  return { ...f, agent, config, logs };
}

test('Pi task on Windows resolves npm pi.cmd into node.exe + cli.js and carries full prompts in files', async t => {
  const f = fixture(t);
  const prefix = path.join(f.root, 'npm');
  const script = path.join(prefix, 'node_modules', 'pi', 'cli.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '');
  fs.writeFileSync(path.join(prefix, 'node.exe'), '');
  const bin = path.join(prefix, 'pi.cmd');
  fs.writeFileSync(bin, '@SET "_prog=node"\n"%_prog%" "%~dp0\\node_modules\\pi\\cli.js" %*\n');
  const h = agentHarness(t, { launch: { command: bin, argsPrefix: [], env: {} } });
  const kickoff = 'Work on task T1.\n"quoted" %PATH% & | < >';
  const spec = await h.agent.getSpawnSpec(h.config, kickoff, 'T1', { projectPath: h.root });
  assert.equal(spec.command, path.join(prefix, 'node.exe'));
  assert.equal(spec.args[0], script);
  assert.equal(spec.args.includes('--approve'), true);
  assert.equal(fs.readFileSync(spec.args.at(-1).slice(1), 'utf8'), kickoff);
  assert.match(fs.readFileSync(spec.args[spec.args.indexOf('--append-system-prompt') + 1], 'utf8'), /^system\n"quoted" %PATH%x{40000}$/);
  assert.ok(spec.args.join(' ').length < 8191);
});

test('Pi task on Windows custom checkout wrapper uses cmd.exe with prompt file paths', async t => {
  const f = fixture(t);
  const bin = path.join(f.root, 'pi.cmd');
  fs.writeFileSync(bin, '@echo off\ncall mcp-node.cmd %*');
  const h = agentHarness(t, { launch: { command: bin, argsPrefix: [], env: {} } });
  const spec = await h.agent.getSpawnSpec(h.config, 'Work on task T1.\n"line"', 'T1', { projectPath: h.root });
  assert.match(spec.command, /cmd\.exe$/);
  assert.deepEqual(plain(spec.args.slice(0, 3)), ['/d', '/s', '/c']);
  assert.ok(spec.args[3].length < 8191);
  assert.equal(spec.args[3].includes('\n'), false);
});

for (const probe of [
  { error: { code: 'ENOENT' }, status: null, output: '' },
  { error: { code: 'EPERM' }, status: null, output: '' },
  { error: null, status: 1, output: '' },
  { error: null, status: 2, output: 'startup failed\nstderr detail' },
]) {
  test(`Pi detection retains bin/exit/output for ${probe.error?.code || `exit ${probe.status}`}`, async t => {
    const bin = 'C:\\Program Files\\Pi\\pi.cmd';
    const h = agentHarness(t, { launch: { command: bin, argsPrefix: [], env: {} }, probe });
    const result = await h.agent.detect({});
    assert.equal(result.available, false);
    assert.deepEqual(plain(result.detail), { bin, exit: probe.status, output: probe.output || probe.error?.code || '' });
  });
}

test('Pi detection retains detail when resolution fails or no launcher exists', async t => {
  const missing = agentHarness(t, { launch: null });
  assert.deepEqual(plain((await missing.agent.detect({})).detail), { bin: null, exit: null, output: '' });
  const launch = { command: 'TipATask.exe' };
  const error = Object.assign(new Error('runtime did not run cli.js'), {
    launch, probe: { status: 0, output: 'Expected Pi 0.84.1; empty output' },
  });
  const h = agentHarness(t, { launch: error });
  const result = await h.agent.detect({});
  assert.equal(result.available, false);
  assert.deepEqual(plain(result.detail), { bin: launch.command, exit: 0, output: error.probe.output });
});

// (TPT9047) A packaged Windows launch that verifyPackagedPiLaunch() already proved (it ran
// `cli.js --version` and carries `piVersion`) is trusted as-is: no second full Pi import.
test('Pi detection reuses the staged Windows verification instead of probing cli.js again', async t => {
  const f = fixture(t);
  const launch = { command: f.node, argsPrefix: [f.cli], env: { ELECTRON_RUN_AS_NODE: '' }, piVersion: '0.84.1', runtimeChecks: [] };
  const h = agentHarness(t, { launch, probe: null });
  let probed = false;
  h.agent.constructor.__proto__.runCliProbe = () => { probed = true; return Promise.resolve({ status: 1, output: 'must not run' }); };
  const result = await h.agent.detect({});
  assert.equal(result.available, true);
  assert.deepEqual(plain(result.detail), { bin: f.node, version: '0.84.1' });
  assert.equal(probed, false);
});

test('Pi detection still probes an unverified launch (POSIX bundle, PI_BIN, system pi)', async t => {
  const h = agentHarness(t, { launch: { command: '/usr/local/bin/pi', argsPrefix: [], env: {} }, probe: { error: null, status: 0, output: '0.84.1' } });
  const result = await h.agent.detect({});
  assert.equal(result.available, true);
  assert.deepEqual(plain(result.detail), { bin: '/usr/local/bin/pi', version: '0.84.1' });
});

test('Pi detection turns a staged Windows verification failure into the localized runtime_failed reason', async t => {
  const f = fixture(t);
  const error = Object.assign(new Error('Pi runtime verification failed (expected Pi 0.84.1; bundled-node (node.exe) cli stage 60000ms/60000ms: ETIMEDOUT; system-node (node.exe): system node.exe not found (requires >=22.19.0))'), {
    code: 'EPI_RUNTIME', launch: { command: f.node }, stage: 'cli', elapsedMs: 60000, timeoutMs: 60000,
    runtime: 'bundled-node', stageOutput: 'ETIMEDOUT',
    probe: { error: { code: 'ETIMEDOUT' }, status: null, output: 'Expected Pi 0.84.1; bundled-node (node.exe) cli stage 60000ms/60000ms: ETIMEDOUT' },
  });
  const h = agentHarness(t, { launch: error });
  const result = await h.agent.detect({});
  assert.equal(result.available, false);
  assert.equal(result.reasonCode, 'runtime_failed');
  assert.deepEqual(plain(result.reasonParams), { stage: 'cli', elapsedMs: 60000, timeoutMs: 60000, runtime: 'bundled-node', output: 'ETIMEDOUT' });
  assert.equal(result.reason, 'Pi runtime check failed at the cli stage after 60000 ms (limit 60000 ms, bundled-node): ETIMEDOUT');
  assert.deepEqual(plain(result.detail), { bin: f.node, exit: null, output: error.probe.output });
  // The localized terminal line renders from the same params in every bundled language.
  const { LOCALES } = await import('../client/i18n.js');
  for (const lang of Object.keys(LOCALES)) {
    const key = 'terminal.error.ESTART.runtime_failed.pi';
    assert.ok(LOCALES[lang][key], `${lang} has ${key}`);
    for (const name of ['label', 'stage', 'elapsedMs', 'timeoutMs', 'runtime', 'output']) {
      assert.ok(LOCALES[lang][key].includes(`{${name}}`), `${lang} ${key} fills {${name}}`);
    }
  }
});

// (TPT9047) A verification failure that never ran a stage (no bundled node.exe, no system Node)
// keeps the generic probe_failed_output sentence with the full message.
test('Pi detection keeps probe_failed_output for a stageless Windows verification failure', async t => {
  const error = Object.assign(new Error('Pi runtime verification failed (expected Pi 0.84.1; bundled-node (node.exe): bundled node.exe is missing; system-node (node.exe): system node.exe not found (requires >=22.19.0))'), {
    code: 'EPI_RUNTIME', launch: { command: 'node.exe' }, stage: null, probe: { status: null, output: 'Expected Pi 0.84.1; …' },
  });
  const h = agentHarness(t, { launch: error });
  const result = await h.agent.detect({});
  assert.equal(result.reasonCode, 'probe_failed_output');
  assert.equal(result.reasonParams.output, error.message);
});
