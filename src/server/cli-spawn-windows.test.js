'use strict';

// TPT575 — objective-chat and helper CLI spawns from npm's Windows `.cmd` launchers. Node >= 22
// refuses a shell-less spawn of a .cmd/.bat (EINVAL), so every headless CLI spawn builds its argv
// through spawn-utils.js cliSpawnSpec(): an npm cmd-shim runs as the node.exe + script it launches
// (argv verbatim, no cmd.exe), any other batch file through cmd.exe, and on win32 the child is
// never detached and always windowsHide. Values a Windows command line cannot carry go to files
// (writeSpawnArgFile → `claude --append-system-prompt-file`), and kills take the whole tree
// (process-group.js killWindowsChildTree). Hermetic: fixture shims and empty node.exe files in a
// temp dir; the module wiring runs in vm sandboxes whose process.platform is 'win32' (or 'darwin'
// for the POSIX identity checks), with child_process and the tree kill captured — nothing is ever
// spawned or signalled.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const spawnUtils = require('./spawn-utils');
const { resolveWindowsCmdShim, cliSpawnSpec, writeSpawnArgFile, SPAWN_ARG_FILE_MAX_AGE_MS } = spawnUtils;

const BIN_DIR = path.resolve(__dirname, '..', '..', 'bin');
const WIN_OPTIONS = { detached: false, windowsHide: true };
// Arguments a cmd.exe command line cannot carry (quotes, line breaks) or would rewrite (%VAR%,
// metacharacters) — they must reach the CLI unchanged.
const HOSTILE_ARGS = ['--append-system-prompt', 'line 1\n"quoted" %PATH% ^&|<> !x!', '-c', 'model_reasoning_effort="xhigh"', ''];

// npm's cmd-shim output (npm >= 7) for a `#!/usr/bin/env <prog>` bin: byte-for-byte the template in
// npm's node_modules/cmd-shim/lib/index.js. `target` is relative to the shim dir, `\`-separated;
// `vars` are the `@SET` lines an `env -S VAR=… node` shebang produces.
const SHIM_HEAD = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n';
function npmNodeShim(target, { prog = 'node', vars = '' } = {}) {
  return SHIM_HEAD + vars + '\r\n'
    + `IF EXIST "%dp0%\\${prog}.exe" (\r\n`
    + `  SET "_prog=%dp0%\\${prog}.exe"\r\n`
    + ') ELSE (\r\n'
    + `  SET "_prog=${prog}"\r\n`
    + '  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n'
    + ')\r\n'
    + '\r\n'
    + `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
}
// …for a bin with no shebang, which the shim runs directly.
const npmExeShim = target => `${SHIM_HEAD}"%dp0%\\${target}"   %*\r\n`;
// npm <= 6 / yarn v1 (cmd-shim <= 3).
const legacyNodeShim = target => '@IF EXIST "%~dp0\\node.exe" (\r\n'
  + `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*\r\n`
  + ') ELSE (\r\n'
  + '  @SETLOCAL\r\n'
  + '  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n'
  + `  node  "%~dp0\\${target}" %*\r\n`
  + ')';
// pnpm: the legacy shape plus a NODE_PATH the CLI would lose if the shim were bypassed.
const pnpmShim = target => '@SETLOCAL\r\n'
  + '@IF NOT DEFINED NODE_PATH (\r\n'
  + '  @SET "NODE_PATH=C:\\pnpm\\global\\5\\node_modules"\r\n'
  + ') ELSE (\r\n'
  + '  @SET "NODE_PATH=C:\\pnpm\\global\\5\\node_modules;%NODE_PATH%"\r\n'
  + ')\r\n'
  + legacyNodeShim(target);

// The bin script of each CLI's npm package, relative to the npm prefix.
const CLI_SCRIPTS = {
  claude: 'node_modules\\@anthropic-ai\\claude-code\\cli.js',
  codex: 'node_modules\\@openai\\codex\\bin\\codex.js',
  gemini: 'node_modules\\@google\\gemini-cli\\dist\\index.js',
  pi: 'node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js',
};

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-tpt575-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function touch(file, body = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

// An npm global prefix (`%APPDATA%\npm`) holding the four shims and their bin scripts, plus a
// separate Node install dir holding node.exe, for the spawn env's PATH.
function npmFixture(t, { nodeInPrefix = false } = {}) {
  const root = tmpdir(t);
  const prefix = path.join(root, 'npm');
  const nodeDir = path.join(root, 'nodejs');
  const script = name => path.join(prefix, ...CLI_SCRIPTS[name].split('\\'));
  for (const name of Object.keys(CLI_SCRIPTS)) {
    touch(path.join(prefix, `${name}.cmd`), npmNodeShim(CLI_SCRIPTS[name]));
    touch(script(name), '#!/usr/bin/env node\n');
  }
  touch(path.join(nodeDir, 'node.exe'));
  if (nodeInPrefix) touch(path.join(prefix, 'node.exe'));
  return {
    root, prefix, nodeDir, script,
    node: path.join(nodeDir, 'node.exe'),
    env: { PATH: nodeDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    bin: name => path.join(prefix, `${name}.cmd`),
  };
}

// Sandbox values come from another realm; compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));

// ── resolveWindowsCmdShim ───────────────────────────────────────────────────────────────────

test('resolveWindowsCmdShim: an npm >= 7 node shim resolves to the PATH node.exe + the bin script', t => {
  const fx = npmFixture(t);
  for (const name of Object.keys(CLI_SCRIPTS)) {
    assert.deepEqual(resolveWindowsCmdShim(fx.bin(name), { env: fx.env }), { command: fx.node, argsPrefix: [fx.script(name)] }, name);
  }
});

test('resolveWindowsCmdShim: node.exe beside the shim wins over PATH, as the shim\'s own IF EXIST does', t => {
  const fx = npmFixture(t, { nodeInPrefix: true });
  assert.deepEqual(resolveWindowsCmdShim(fx.bin('claude'), { env: fx.env }),
    { command: path.join(fx.prefix, 'node.exe'), argsPrefix: [fx.script('claude')] });
});

test('resolveWindowsCmdShim: PATH lookup — `Path` spelling, quoted and empty entries; the first `node` launcher on PATH decides', t => {
  const fx = npmFixture(t);
  const empty = path.join(fx.root, 'empty');
  fs.mkdirSync(empty);
  assert.equal(resolveWindowsCmdShim(fx.bin('codex'), { env: { Path: `;${empty};"${fx.nodeDir}"` } }).command, fx.node);
  // A node.cmd ahead of node.exe is what cmd.exe would run — not spawnable directly, so no resolution.
  const wrapperDir = path.join(fx.root, 'wrapper');
  touch(path.join(wrapperDir, 'node.cmd'));
  assert.equal(resolveWindowsCmdShim(fx.bin('codex'), { env: { PATH: `${wrapperDir};${fx.nodeDir}` } }), null);
  assert.equal(resolveWindowsCmdShim(fx.bin('codex'), { env: { PATH: empty } }), null, 'no node anywhere');
});

test('resolveWindowsCmdShim: the legacy npm/yarn template and a no-shebang .exe target resolve too', t => {
  const fx = npmFixture(t);
  touch(path.join(fx.prefix, 'legacy.cmd'), legacyNodeShim(CLI_SCRIPTS.claude));
  assert.deepEqual(resolveWindowsCmdShim(path.join(fx.prefix, 'legacy.cmd'), { env: fx.env }),
    { command: fx.node, argsPrefix: [fx.script('claude')] });
  const tool = touch(path.join(fx.prefix, 'node_modules', 'pkg', 'bin', 'tool.exe'));
  touch(path.join(fx.prefix, 'tool.cmd'), npmExeShim('node_modules\\pkg\\bin\\tool.exe'));
  assert.deepEqual(resolveWindowsCmdShim(path.join(fx.prefix, 'tool.cmd'), { env: fx.env }), { command: tool, argsPrefix: [] });
});

test('resolveWindowsCmdShim: anything that is not a plain npm node/exe shim returns null', t => {
  const fx = npmFixture(t);
  const shim = (name, text) => touch(path.join(fx.prefix, name), text);
  const cases = {
    'pnpm NODE_PATH': shim('pnpm.cmd', pnpmShim(CLI_SCRIPTS.claude)),
    '`env -S` variables': shim('vars.cmd', npmNodeShim(CLI_SCRIPTS.claude, { vars: '@SET NODE_OPTIONS=--max-old-space-size=8192\r\n' })),
    'a python shebang': shim('py.cmd', npmNodeShim(CLI_SCRIPTS.claude, { prog: 'python3' })),
    'a missing bin script': shim('gone.cmd', npmNodeShim('node_modules\\gone\\cli.js')),
    'a missing .exe target': shim('noexe.cmd', npmExeShim('node_modules\\gone\\tool.exe')),
    'a .js target run by file association': shim('assoc.cmd', npmExeShim(CLI_SCRIPTS.claude)),
    'no exec line': shim('empty.cmd', '@ECHO off\r\n'),
    'this checkout\'s bin/pi.cmd': path.join(BIN_DIR, 'pi.cmd'),
    'this checkout\'s bin/mcp-node.cmd': path.join(BIN_DIR, 'mcp-node.cmd'),
    'a file that does not exist': path.join(fx.prefix, 'absent.cmd'),
    'a file larger than any shim': shim('huge.cmd', npmNodeShim(CLI_SCRIPTS.claude) + ':: '.padEnd(70 * 1024, 'x')),
  };
  for (const [label, file] of Object.entries(cases)) {
    assert.equal(resolveWindowsCmdShim(file, { env: fx.env }), null, label);
  }
});

// ── cliSpawnSpec ────────────────────────────────────────────────────────────────────────────

test('cliSpawnSpec(win32): an npm shim spawns node.exe + script with the argv verbatim — no cmd.exe, never detached, hidden', t => {
  const fx = npmFixture(t);
  const spec = cliSpawnSpec(fx.bin('claude'), HOSTILE_ARGS, { isWin: true, env: fx.env });
  assert.deepEqual(spec, { command: fx.node, args: [fx.script('claude'), ...HOSTILE_ARGS], options: WIN_OPTIONS });
  // Far past cmd.exe's 8191-character line: only CreateProcess's own limit applies.
  const long = cliSpawnSpec(fx.bin('codex'), ['x'.repeat(20000)], { isWin: true, env: fx.env });
  assert.equal(long.args[1].length, 20000);
});

test('cliSpawnSpec(win32): any other batch launcher runs through cmd.exe; an argument cmd cannot carry throws', t => {
  const fx = npmFixture(t);
  for (const bin of [path.join(BIN_DIR, 'pi.cmd'), touch(path.join(fx.prefix, 'pnpm.cmd'), pnpmShim(CLI_SCRIPTS.pi))]) {
    const spec = cliSpawnSpec(bin, ['--mode', 'json', '--prompt', ''], { isWin: true, env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
    assert.equal(spec.command, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(spec.args, ['/d', '/s', '/c', `""${bin}" "--mode" "json" "--prompt" """`]);
    assert.deepEqual(spec.options, { ...WIN_OPTIONS, windowsVerbatimArguments: true });
    assert.throws(() => cliSpawnSpec(bin, HOSTILE_ARGS, { isWin: true, env: {} }), /unquotable/);
  }
});

test('cliSpawnSpec(win32): a native .exe is spawned as-is, with the win32 options', () => {
  const bin = 'C:\\Users\\a\\.local\\bin\\claude.exe';
  assert.deepEqual(cliSpawnSpec(bin, HOSTILE_ARGS, { isWin: true }), { command: bin, args: HOSTILE_ARGS, options: WIN_OPTIONS });
});

test('cliSpawnSpec(POSIX): the launcher, argv and no options — byte-identical to a plain spawn, even for a .cmd path', t => {
  const fx = npmFixture(t);
  for (const bin of ['/usr/local/bin/claude', fx.bin('claude')]) {
    assert.deepEqual(cliSpawnSpec(bin, HOSTILE_ARGS, { isWin: false, env: fx.env }), { command: bin, args: HOSTILE_ARGS, options: {} });
  }
  assert.deepEqual(cliSpawnSpec('/usr/local/bin/claude', undefined, { isWin: false }).args, []);
});

// ── writeSpawnArgFile ───────────────────────────────────────────────────────────────────────

test('writeSpawnArgFile: content-addressed under spawn-args/; the same text reuses its file and refreshes its mtime', t => {
  const root = tmpdir(t);
  const text = 'READ-ONLY PLANNER\n"quoted" %PATH%\n' + 'x'.repeat(50000);
  const file = writeSpawnArgFile(root, text, '.md');
  assert.equal(path.dirname(file), path.join(root, 'spawn-args'));
  assert.match(path.basename(file), /^[0-9a-f]{32}\.md$/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
  assert.equal(writeSpawnArgFile(root, text, '.md'), file);
  assert.ok(Date.now() - fs.statSync(file).mtimeMs < 60_000, 'reuse refreshes the mtime');
  assert.notEqual(writeSpawnArgFile(root, text + '!', '.md'), file);
  assert.deepEqual(fs.readdirSync(path.join(root, 'spawn-args')).filter(n => n.endsWith('.tmp')), [], 'no temp file left behind');
});

test('writeSpawnArgFile: files unused past the max age are pruned; the file being returned never is', t => {
  const root = tmpdir(t);
  const stale = writeSpawnArgFile(root, 'stale', '.md');
  const kept = writeSpawnArgFile(root, 'kept', '.md');
  const later = Date.now() + SPAWN_ARG_FILE_MAX_AGE_MS + 2 * 60 * 60 * 1000;
  const fresh = new Date(later);
  fs.utimesSync(kept, fresh, fresh);
  const old = new Date(Date.now() - SPAWN_ARG_FILE_MAX_AGE_MS);
  fs.utimesSync(stale, old, old);
  const current = writeSpawnArgFile(root, 'current', '.md', { now: later });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(kept), true);
  assert.equal(fs.existsSync(current), true);
});

test('writeSpawnArgFile: no user-data root, or one that cannot hold the dir, returns null', t => {
  const root = tmpdir(t);
  const file = touch(path.join(root, 'not-a-dir'));
  assert.equal(writeSpawnArgFile('', 'x', '.md'), null);
  assert.equal(writeSpawnArgFile(null, 'x', '.md'), null);
  assert.equal(writeSpawnArgFile(path.join(file, 'nested'), 'x', '.md'), null);
});

// ── module wiring (vm sandboxes) ────────────────────────────────────────────────────────────

function fakeProc(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {}, end() {} };
  proc.kill = () => true;
  return proc;
}

const THROTTLE = { watchTurn: () => () => {}, recordTimeout() {}, recordAbort() {}, recordSuccess() {} };

// Runs src/server/<file> with `platform` as its process.platform. Spawns are captured (never run),
// process.kill is recorded (never sent), and the module's process-group killWindowsChildTree is
// recorded too. `mocks` are keyed by the module's own require ids.
function loadSandboxed(file, { platform, execPath = '/opt/node/bin/node', mocks = {} }) {
  const filename = path.join(__dirname, file);
  const realRequire = createRequire(filename);
  const spawned = [];
  const signals = [];
  const treeKills = [];
  const groupId = file.includes('/') ? '../process-group' : './process-group';
  const all = {
    'node:child_process': { spawn(command, args, options) {
      const proc = fakeProc(93000 + spawned.length);
      proc.spawnCall = { command, args, options };
      spawned.push(proc);
      return proc;
    } },
    [groupId]: { ...realRequire(groupId), killWindowsChildTree: child => { treeKills.push(child.pid); return true; } },
    ...mocks,
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: id => (Object.hasOwn(all, id) ? all[id] : realRequire(id)),
    console: { log() {}, warn() {}, error() {} },
    process: { platform, execPath, env: {}, pid: process.pid, kill: (pid, sig) => { signals.push([pid, sig]); } },
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, Date, Buffer, AbortController, URL,
  }, { filename });
  return { mod: module.exports, spawned, signals, treeKills, call: i => plain(spawned[i].spawnCall) };
}

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

function claudeHarness(t, platform) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_790_000_000_000 });
  const fx = npmFixture(t);
  const userData = path.join(fx.root, 'user-data');
  const project = path.join(fx.root, 'project');
  fs.mkdirSync(project);
  const config = { ...require('./config'), CLAUDE_BIN: fx.bin('claude'), CLAUDE_MODEL: 'claude-test-model',
    USER_DATA_ROOT: userData, PROJECT_ROOT: project, API_PROJECT_ID: '', SIMPLE_MODE: false,
    OBJECTIVE_TIMING_ENABLED: false, OBJECTIVE_DEBUG_STARTUP: false,
    OBJECTIVE_PREWARM_ENABLED: true, OBJECTIVE_PREWARM_TTL_MS: 3600000,
    OBJECTIVE_HEARTBEAT_ENABLED: true, OBJECTIVE_HEARTBEAT_MS: 240000, OBJECTIVE_HEARTBEAT_MAX_PINGS: 3,
    OBJECTIVE_HEARTBEAT_TIMEOUT_MS: 30000, OBJECTIVE_EFFICIENCY_TIMEOUT_MS: 30000 };
  const sb = loadSandboxed('claude-session.js', { platform, mocks: {
    './config': config,
    './objective-throttle': THROTTLE,
    './static-context': { getStaticBundleStats: () => ({ chars: 0, sha: '' }) },
    './arch-cache-prewarm': { prewarmArchCache() {} },
    './task-agent/attachments': { localizeAttachments: async ({ prompt }) => ({ prompt }) },
    'node:fs/promises': { unlink: async () => {}, writeFile: async () => {}, readFile: async () => { throw new Error('absent'); } },
    './spawn-utils': { ...spawnUtils, augmentPathEnv: extras => ({ ...extras, PATH: fx.nodeDir }), projectEnvExtras: () => ({}) },
  } });
  const session = (extra = {}) => ({ type: 'objective', providerType: 'claude', tabId: 'obj-tab', projectPath: project,
    firstPrompt: 'Plan this', messages: [{ role: 'user', content: 'Plan this', timestamp: 0 }],
    timingMilestones: { toolCalls: [], turnStart: 0 }, totalTokens: { input: 0, output: 0 },
    _cachedTagsSerialized: new Set(), tagArchCache: new Map(), ws: null, systemPrompt: 'READ-ONLY PLANNER', ...extra });
  return { ...sb, fx, config, userData, project, session };
}

test('Claude objective turn (win32): node.exe + cli.js; system prompt and empty MCP map as files; never detached; teardown takes the tree', t => {
  const h = claudeHarness(t, 'win32');
  const systemPrompt = 'READ-ONLY PLANNER\n"quoted" %PATH% ^&|<>\n' + 'x'.repeat(40000);
  const session = h.session({ systemPrompt });
  h.mod.spawnObjectiveTurn(session, 'obj-win');
  assert.equal(h.spawned.length, 1);
  const { command, args, options } = h.call(0);
  assert.equal(command, h.fx.node);
  assert.equal(args[0], h.fx.script('claude'));
  assert.equal(args.includes('--append-system-prompt'), false);
  assert.equal(args.some(a => a.includes('READ-ONLY PLANNER')), false, 'the prompt never travels on the command line');
  const promptFile = args[args.indexOf('--append-system-prompt-file') + 1];
  assert.equal(path.dirname(promptFile), path.join(h.userData, 'spawn-args'));
  assert.equal(fs.readFileSync(promptFile, 'utf8'), systemPrompt);
  assert.equal(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'), '{"mcpServers":{}}');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(options.detached, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.windowsVerbatimArguments, undefined, 'no cmd.exe in between');
  assert.equal(options.cwd, h.project);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  h.mod.teardownObjectiveSession(session, 'obj-win', 'test');
  assert.deepEqual(h.treeKills, [h.spawned[0].pid]);
  assert.deepEqual(h.signals, [], 'no POSIX process-group signal on win32');
});

test('Claude objective turn (POSIX): spawn(CLAUDE_BIN, inline argv, { cwd, env, stdio, detached: true }) exactly as before', t => {
  const h = claudeHarness(t, 'darwin');
  const session = h.session({ systemPrompt: 'READ-ONLY PLANNER\nline 2' });
  h.mod.spawnObjectiveTurn(session, 'obj-posix');
  const { command, args, options } = h.call(0);
  assert.equal(command, h.config.CLAUDE_BIN);
  assert.equal(args[0], '--model');
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'READ-ONLY PLANNER\nline 2');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(args.includes('--append-system-prompt-file'), false);
  assert.deepEqual(Object.keys(options), ['cwd', 'env', 'stdio', 'detached']);
  assert.equal(options.detached, true);
  assert.equal(fs.existsSync(path.join(h.userData, 'spawn-args')), false, 'no argv files off win32');
  h.mod.teardownObjectiveSession(session, 'obj-posix', 'test');
  assert.deepEqual(h.signals, [[-h.spawned[0].pid, 'SIGTERM']]);
  assert.deepEqual(h.treeKills, []);
});

test('Claude task chat (win32): the chat prompt and the scoped-MCP fallback go to files as well', t => {
  const h = claudeHarness(t, 'win32');
  const session = h.session({ type: 'taskChat', toolProfile: 'taskChat', taskKey: 'TPT1', systemPrompt: 'TASK CHAT "rules"\nline' });
  h.mod.spawnObjectiveTurn(session, 'taskChat:TPT1');
  const { command, args, options } = h.call(0);
  assert.equal(command, h.fx.node);
  assert.equal(fs.readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8'), 'TASK CHAT "rules"\nline');
  assert.equal(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'), '{"mcpServers":{}}');
  assert.deepEqual({ detached: options.detached, windowsHide: options.windowsHide }, WIN_OPTIONS);
});

test('Claude objective turn: a synchronous spawn failure ends the turn with an objective-error instead of throwing', t => {
  const h = claudeHarness(t, 'win32');
  const frames = [];
  // A batch launcher that is no npm shim runs through cmd.exe, which cannot carry the quoted model
  // name: cliSpawnSpec() throws inside the spawn.
  h.config.CLAUDE_BIN = path.join(BIN_DIR, 'pi.cmd');
  const session = h.session({ selectedModel: 'model "quoted"', ws: { OPEN: 1, readyState: 1, send: text => frames.push(JSON.parse(text)) } });
  assert.doesNotThrow(() => h.mod.spawnObjectiveTurn(session, 'obj-fail'));
  assert.equal(h.spawned.length, 0);
  assert.match(frames.find(f => f.type === 'objective-error').reason, /^spawn-error:winExecSpec: unquotable argument/);
  assert.ok(!session.proc);
});

test('Claude prewarm, cold prewarm, heartbeat and efficiency analysis (win32): same launch; timeouts and kills take the tree', async t => {
  const h = claudeHarness(t, 'win32');
  const session = h.session({ claudeSessionId: 'sess-1', _lastCacheTouchAt: Date.now(), _heartbeatPings: 0 });
  h.mod.prewarmObjective(session, 'obj-pw');
  h.mod.prewarmObjectiveCold(h.project);
  h.mod.armHeartbeat(session, 'obj-pw');
  t.mock.timers.tick(240000);
  assert.equal(h.spawned.length, 3, 'warm prewarm, cold prewarm, heartbeat');
  for (let i = 0; i < 3; i++) {
    const { command, args, options } = h.call(i);
    assert.equal(command, h.fx.node, `spawn ${i}`);
    assert.equal(args[0], h.fx.script('claude'));
    assert.deepEqual({ detached: options.detached, windowsHide: options.windowsHide }, WIN_OPTIONS);
  }
  assert.ok(h.call(0).args.includes('--append-system-prompt-file'), 'warm prewarm carries the session prompt as a file');
  t.mock.timers.tick(30000); // heartbeat timeout
  assert.deepEqual(h.treeKills, [h.spawned[2].pid]);
  h.mod.killAllPrewarms('test');
  assert.deepEqual(h.treeKills, [h.spawned[2].pid, h.spawned[0].pid, h.spawned[1].pid]);

  const analysis = h.mod.spawnEfficiencyAnalysis(session, 99999);
  await settle();
  assert.equal(h.spawned.length, 4);
  assert.equal(h.call(3).command, h.fx.node);
  assert.deepEqual(h.call(3).args, [h.fx.script('claude'), '-p', '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json']);
  t.mock.timers.tick(30000);
  assert.equal(h.treeKills.at(-1), h.spawned[3].pid);
  h.spawned[3].emit('close', 1);
  assert.deepEqual(plain(await analysis), []);
  assert.deepEqual(h.signals, []);
});

function headlessHarness(t, platform, file) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fx = npmFixture(t);
  const config = { CLAUDE_BIN: fx.bin('claude'), PROJECT_ROOT: fx.root,
    OBJECTIVE_HISTORY_COMPRESS_ENABLED: true, OBJECTIVE_HISTORY_COMPRESS_TIMEOUT_MS: 1000 };
  const sb = loadSandboxed(file, { platform, mocks: {
    './config': config,
    './spawn-utils': { ...spawnUtils, augmentPathEnv: extras => ({ ...extras, PATH: fx.nodeDir }) },
  } });
  return { ...sb, fx, config };
}

test('runHeadlessClaude (win32): node.exe + cli.js, never detached; a timeout and the shutdown reaper take the tree', async t => {
  const h = headlessHarness(t, 'win32', 'headless-claude.js');
  const result = h.mod.runHeadlessClaude('describe these tags', { timeoutMs: 1000, model: 'claude-opus-5' });
  const { command, args, options } = h.call(0);
  assert.equal(command, h.fx.node);
  assert.deepEqual(args, [h.fx.script('claude'), '-p', '--model', 'claude-opus-5', '--output-format', 'json']);
  assert.deepEqual({ detached: options.detached, windowsHide: options.windowsHide }, WIN_OPTIONS);
  t.mock.timers.tick(1000);
  assert.equal(await result, null);
  assert.deepEqual(h.treeKills, [h.spawned[0].pid]);
  h.spawned[0].emit('close', null);
  h.mod.runHeadlessClaude('again', { timeoutMs: 60000 });
  h.mod.killAllHeadlessProcs('shutdown');
  assert.deepEqual(h.treeKills, [h.spawned[0].pid, h.spawned[1].pid]);
  assert.deepEqual(h.signals, []);
});

test('runHeadlessClaude (POSIX): spawn(CLAUDE_BIN, argv, { cwd, env, stdio, detached: true }); the timeout signals the group', async t => {
  const h = headlessHarness(t, 'darwin', 'headless-claude.js');
  const result = h.mod.runHeadlessClaude('describe', { timeoutMs: 1000, model: 'claude-opus-5', cwd: '/project' });
  const { command, args, options } = h.call(0);
  assert.equal(command, h.config.CLAUDE_BIN);
  assert.deepEqual(args, ['-p', '--model', 'claude-opus-5', '--output-format', 'json']);
  assert.deepEqual(Object.keys(options), ['cwd', 'env', 'stdio', 'detached']);
  assert.equal(options.detached, true);
  t.mock.timers.tick(1000);
  assert.equal(await result, null);
  assert.deepEqual(h.signals, [[-h.spawned[0].pid, 'SIGTERM']]);
  assert.deepEqual(h.treeKills, []);
});

const HAIKU_ARGV = ['-p', '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json'];

test('summarizeOldTurns (win32): the Haiku compression runs node.exe + cli.js; its timeout takes the tree', async t => {
  const h = headlessHarness(t, 'win32', 'objective-summarizer.js');
  const result = h.mod.summarizeOldTurns([{ turnNum: 1, userText: 'Plan the "release"', assistantText: 'ok' }]);
  const { command, args, options } = h.call(0);
  assert.equal(command, h.fx.node);
  assert.deepEqual(args, [h.fx.script('claude'), ...HAIKU_ARGV]);
  assert.deepEqual({ detached: options.detached, windowsHide: options.windowsHide }, WIN_OPTIONS);
  t.mock.timers.tick(1000);
  assert.equal((await result)[0].turn, 1, 'heuristic fallback');
  assert.deepEqual(h.treeKills, [h.spawned[0].pid]);
  assert.deepEqual(h.signals, []);
});

test('summarizeOldTurns (POSIX): spawn(CLAUDE_BIN, argv, { cwd, env, stdio, detached: true }); the timeout signals the group', async t => {
  const h = headlessHarness(t, 'darwin', 'objective-summarizer.js');
  const result = h.mod.summarizeOldTurns([{ turnNum: 1, userText: 'Plan', assistantText: 'ok' }]);
  const { command, args, options } = h.call(0);
  assert.equal(command, h.config.CLAUDE_BIN);
  assert.deepEqual(args, HAIKU_ARGV);
  assert.deepEqual(Object.keys(options), ['cwd', 'env', 'stdio', 'detached']);
  t.mock.timers.tick(1000);
  assert.equal((await result)[0].turn, 1);
  assert.deepEqual(h.signals, [[-h.spawned[0].pid, 'SIGTERM']]);
  assert.deepEqual(h.treeKills, []);
});

const MCP_OVERRIDE = 'mcp_servers={tipatask={url="https://tt.example.invalid/api/projects/2/mcp",enabled=true}}';

function providerHarness(t, platform, file, { bin, mocks = {}, configExtra = {} } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const fx = npmFixture(t, { nodeInPrefix: file === 'providers/pi-session.js' });
  const userData = path.join(fx.root, 'user-data');
  const project = path.join(fx.root, 'project');
  fs.mkdirSync(project);
  const config = { ...require('./config'), USER_DATA_ROOT: userData, PROJECT_ROOT: project,
    CODEX_BIN: fx.bin('codex'), GEMINI_BIN: fx.bin('gemini'), OBJECTIVE_EFFORT: 'max', OBJECTIVE_TIMING_ENABLED: false,
    OBJECTIVE_STREAM_IDLE_MS: 1000, OBJECTIVE_TURN_MAX_MS: 600000, ...configExtra };
  if (bin) Object.assign(config, bin(fx));
  const frames = [];
  const sb = loadSandboxed(file, { platform, execPath: path.join(fx.nodeDir, 'node.exe'), mocks: {
    '../config': config,
    '../objective-throttle': THROTTLE,
    '../claude-session': { normalizeProposals: x => x },
    '../task-agent/attachments': { localizeAttachments: async ({ prompt }) => ({ prompt }) },
    '../context-manager': { shouldTrimContext: () => false, trimContext() {} },
    './transcript': { buildTurnPrompt: () => ({ prompt: 'plan it', mode: 'fresh' }), buildNudgeMessage: () => 'nudge' },
    '../codex-env': { ...require('./codex-env'), buildCodexEnv: () => ({ env: { PATH: fx.nodeDir } }) },
    '../../codex-mcp-config': { buildScopedCodexMcpOverride: () => MCP_OVERRIDE },
    './gemini-config': { prepareGeminiSettings: () => path.join(userData, 'gemini-settings.json') },
    '../spawn-utils': { ...spawnUtils, augmentPathEnv: extras => ({ ...extras, PATH: 'C:\\Windows\\System32' }), projectEnvExtras: () => ({}) },
    ...(typeof mocks === 'function' ? mocks(fx) : mocks),
  } });
  const session = (extra = {}) => ({ type: 'objective', tabId: 'obj-tab', projectPath: project, firstPrompt: 'plan it',
    messages: [{ role: 'user', content: 'plan it', timestamp: 0 }], timingMilestones: {}, totalTokens: { input: 0, output: 0 },
    turnBuffer: '', turnRawSse: '', ws: { OPEN: 1, readyState: 1, send: text => frames.push(JSON.parse(text)) }, ...extra });
  return { ...sb, fx, config, project, session, frames };
}

test('Codex objective turn (win32): node.exe + codex.js with its quoted `-c` TOML values verbatim; an error event takes the tree', async t => {
  const h = providerHarness(t, 'win32', 'providers/codex-session.js');
  const session = h.session({ providerType: 'codex' });
  h.mod.spawnCodexTurn(session, 'obj-codex');
  await settle();
  const { command, args, options } = h.call(0);
  assert.equal(command, h.fx.node);
  assert.deepEqual(args.slice(0, 4), [h.fx.script('codex'), 'exec', '-c', 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(args.slice(-3), ['-c', MCP_OVERRIDE, '-']);
  assert.deepEqual({ detached: options.detached, windowsHide: options.windowsHide }, WIN_OPTIONS);
  assert.equal(options.windowsVerbatimArguments, undefined, 'no cmd.exe in between');
  h.spawned[0].stdout.emit('data', Buffer.from('{"type":"turn.failed","message":"boom"}\n'));
  assert.deepEqual(h.treeKills, [h.spawned[0].pid]);
  assert.deepEqual(h.signals, []);
});

test('Codex objective turn: a launcher cmd.exe would have to carry the TOML through fails the turn cleanly', async t => {
  const h = providerHarness(t, 'win32', 'providers/codex-session.js', {
    bin: fx => ({ CODEX_BIN: touch(path.join(fx.root, 'custom', 'codex.cmd'), '@echo off\r\nset "X=%~dp0"\r\ncall "%X%real.cmd" %*\r\n') }),
  });
  const session = h.session({ providerType: 'codex' });
  h.mod.spawnCodexTurn(session, 'obj-codex-fail');
  await settle();
  assert.equal(h.spawned.length, 0);
  assert.equal(session._spawning, false);
  assert.match(h.frames.find(f => f.type === 'objective-error').reason, /^spawn-error:winExecSpec: unquotable argument/);
});

test('Codex objective turn (POSIX): spawn(CODEX_BIN, argv, { cwd, env, stdio, detached: true }); errors signal the group', async t => {
  const h = providerHarness(t, 'darwin', 'providers/codex-session.js');
  h.mod.spawnCodexTurn(h.session({ providerType: 'codex' }), 'obj-codex-posix');
  await settle();
  const { command, args, options } = h.call(0);
  assert.equal(command, h.config.CODEX_BIN);
  assert.deepEqual(args.slice(0, 3), ['exec', '-c', 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(Object.keys(options), ['cwd', 'env', 'stdio', 'detached']);
  h.spawned[0].stdout.emit('data', Buffer.from('{"type":"turn.failed","message":"boom"}\n'));
  assert.deepEqual(h.signals, [[-h.spawned[0].pid, 'SIGTERM']]);
  assert.deepEqual(h.treeKills, []);
});

const GEMINI_ARGV = ['--output-format', 'stream-json', '--model', 'gemini-2.5-pro', '--approval-mode', 'default', '--extensions', 'none', '--prompt', ''];

test('Gemini objective turn (win32): this Node goes first on a `;` PATH; node.exe + script with the empty --prompt kept; errors take the tree', t => {
  const h = providerHarness(t, 'win32', 'providers/gemini-session.js');
  h.mod.spawnGeminiTurn(h.session({ providerType: 'gemini', selectedModel: 'gemini-2.5-pro' }), 'obj-gemini');
  const { command, args, options } = h.call(0);
  assert.equal(options.env.PATH, `${h.fx.nodeDir};C:\\Windows\\System32`);
  assert.equal(command, h.fx.node);
  assert.deepEqual(args, [h.fx.script('gemini'), ...GEMINI_ARGV]);
  assert.deepEqual({ detached: options.detached, windowsHide: options.windowsHide }, WIN_OPTIONS);
  h.spawned[0].stdout.emit('data', Buffer.from('{"type":"error","message":"boom"}\n'));
  assert.deepEqual(h.treeKills, [h.spawned[0].pid]);
  assert.deepEqual(h.signals, []);
});

test('Gemini objective turn (POSIX): `:` PATH and spawn(GEMINI_BIN, argv, { cwd, env, stdio, detached: true }) as before', t => {
  const h = providerHarness(t, 'darwin', 'providers/gemini-session.js');
  h.mod.spawnGeminiTurn(h.session({ providerType: 'gemini', selectedModel: 'gemini-2.5-pro' }), 'obj-gemini');
  const { command, args, options } = h.call(0);
  assert.equal(options.env.PATH, `${h.fx.nodeDir}:C:\\Windows\\System32`);
  assert.equal(command, h.config.GEMINI_BIN);
  assert.deepEqual(args, GEMINI_ARGV);
  assert.deepEqual(Object.keys(options), ['cwd', 'env', 'stdio', 'detached']);
  h.spawned[0].stdout.emit('data', Buffer.from('{"type":"error","message":"boom"}\n'));
  assert.deepEqual(h.signals, [[-h.spawned[0].pid, 'SIGTERM']]);
  assert.deepEqual(h.treeKills, []);
});

function piHarness(t, platform, launch) {
  const h = providerHarness(t, platform, 'providers/pi-session.js', {
    mocks: fx => ({
      '../spawn-utils': { ...spawnUtils, augmentPathEnv: extras => ({ ...extras, PATH: '/usr/bin' }), projectEnvExtras: () => ({}),
        resolvePiLaunch: () => launch(fx) },
    }),
  });
  touch(path.join(h.project, '.tipatask', 'config.json'), JSON.stringify({ PI_MODELS: [{ model: 'openrouter/test-model', apiKey: 'sk-or-test' }] }));
  h.start = () => h.mod.spawnPiTurn(h.session({ providerType: 'pi', selectedModel: 'openrouter/test-model' }), 'T1', () => {},
    { resolveMcpBridge: () => null });
  return h;
}

test('Pi objective turn (win32): npm\'s pi.cmd runs as node.exe + cli.js, never detached; the idle watchdog takes the tree', t => {
  const h = piHarness(t, 'win32', fx => ({ command: fx.bin('pi'), argsPrefix: [], env: {} }));
  h.start();
  const { command, args, options } = h.call(0);
  assert.equal(command, path.join(h.fx.prefix, 'node.exe'));
  assert.deepEqual(args.slice(0, 3), [h.fx.script('pi'), '--mode', 'json']);
  assert.deepEqual({ detached: options.detached, windowsHide: options.windowsHide }, WIN_OPTIONS);
  t.mock.timers.tick(1000);
  assert.deepEqual(h.treeKills, [h.spawned[0].pid]);
  assert.deepEqual(h.signals, []);
});

test('Pi objective turn (win32): this checkout\'s bin/pi.cmd, no npm shim, runs through cmd.exe', t => {
  const wrapper = path.join(BIN_DIR, 'pi.cmd');
  const h = piHarness(t, 'win32', () => ({ command: wrapper, argsPrefix: [], env: {} }));
  h.start();
  const { command, args, options } = h.call(0);
  assert.equal(path.win32.basename(command).toLowerCase(), 'cmd.exe');
  assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
  assert.ok(args[3].startsWith(`""${wrapper}" "--mode" "json"`), args[3]);
  assert.deepEqual({ ...WIN_OPTIONS, windowsVerbatimArguments: true },
    { detached: options.detached, windowsHide: options.windowsHide, windowsVerbatimArguments: options.windowsVerbatimArguments });
});

test('Pi objective turn (POSIX): spawn(launch.command, [...argsPrefix, ...argv], { cwd, env, stdio, detached: true })', t => {
  const h = piHarness(t, 'darwin', () => ({ command: '/opt/pi/bin/pi', argsPrefix: ['cli.js'], env: {} }));
  h.start();
  const { command, args, options } = h.call(0);
  assert.equal(command, '/opt/pi/bin/pi');
  assert.deepEqual(args.slice(0, 3), ['cli.js', '--mode', 'json']);
  assert.deepEqual(Object.keys(options), ['cwd', 'env', 'stdio', 'detached']);
  assert.equal(options.detached, true);
  t.mock.timers.tick(1000);
  assert.deepEqual(h.signals, [[-h.spawned[0].pid, 'SIGTERM']]);
  assert.deepEqual(h.treeKills, []);
});
