'use strict';

// The Node-script hook commands in templates/.claude/settings.json choose their runtime in the
// shell: a dev checkout's bin/mcp-node wrapper, else the Task App's own runtime (Electron in Node
// mode, which reads the scripts from app.asar), else one skip line on stderr. Each rendered command
// runs through /bin/sh exactly as Claude Code runs it (`sh -c`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { substitute } = require('./placeholders');

const SERVER_ROOT = path.resolve(__dirname, '../..');
const TEMPLATE = path.join(SERVER_ROOT, 'templates', '.claude', 'settings.json');
const NO_RUNTIME = '[hook] skipped: no Task App runtime\n';
const skip = process.platform === 'win32' ? 'hook commands are POSIX shell' : false;

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-commands-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function executable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

// [{ script, command }] for every Node-script hook, rendered with `serverRoot` as {{SERVER_ROOT}}.
function hookCommands(serverRoot) {
  const settings = JSON.parse(substitute(fs.readFileSync(TEMPLATE, 'utf8'),
    { SERVER_ROOT: serverRoot, SERVER_NODE_WRAPPER: 'mcp-node' }, { warn: msg => assert.fail(msg) }));
  const hooks = [];
  for (const groups of Object.values(settings.hooks)) {
    for (const group of groups) {
      for (const { command } of group.hooks) {
        const match = /"\$R\/scripts\/([\w.-]+\.js)"/.exec(command);
        if (match) hooks.push({ script: match[1], command });
      }
    }
  }
  return hooks;
}

// Explicit env: nothing from the session that runs the tests (a Task App terminal carries
// TIPATASK_TOOL_EXEC itself) may pick a branch. The test guard still loads in Node children.
// Stdin comes from a file, never spawnSync `input`: the skip and wrapper branches exit without
// reading it, and on Linux Node's write into that closed pipe fails with EPIPE.
function run(command, env = {}, input = '{}') {
  const inherited = {};
  for (const key of ['NODE_OPTIONS', 'TIPATASK_TEST_VIOLATIONS']) {
    if (process.env[key]) inherited[key] = process.env[key];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-input-'));
  const inputFile = path.join(dir, 'stdin.json');
  fs.writeFileSync(inputFile, input);
  const fd = fs.openSync(inputFile, 'r');
  let result;
  try {
    result = spawnSync('/bin/sh', ['-c', command], {
      env: { PATH: process.env.PATH, HOME: os.homedir(), ...inherited, ...env },
      stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', timeout: 20000,
    });
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(result.error, undefined);
  return result;
}

test('every Node-script hook resolves its runtime with the same command', { skip }, () => {
  const hooks = hookCommands('/opt/TipATask.app/Contents/Resources/app.asar');
  assert.deepEqual(hooks.map(h => h.script).sort(), [
    'push-kb-on-write.js', 'tool-result-cache.js', 'tool-result-cache.js', 'tool-result-cache.js', 'track-file-access.js',
  ]);
  const shapes = new Set(hooks.map(({ script, command }) => command.split(script).join('<hook>')));
  assert.equal(shapes.size, 1);
  assert.doesNotMatch([...shapes][0], /TIPATASK_SERVER_ROOT=/, 'never re-exports TIPATASK_SERVER_ROOT (C1061)');
});

test('without a runtime each hook prints one skip line and exits 0', { skip }, t => {
  const dir = scratch(t);
  const missingExec = path.join(dir, 'gone', 'TipATask Helper');
  for (const { command } of hookCommands(path.join(dir, 'TipATask.app/Contents/Resources/app.asar'))) {
    for (const env of [{}, { TIPATASK_TOOL_EXEC: process.execPath },
      { TIPATASK_TOOL_EXEC: missingExec, TIPATASK_TOOL_SCRIPT: path.join(dir, 'app.asar/src/cli/task-tools.js') }]) {
      const result = run(command, env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, NO_RUNTIME);
    }
  }
});

test('a dev checkout runs bin/mcp-node from TIPATASK_SERVER_ROOT or the rendered root', { skip }, t => {
  const dir = scratch(t);
  const dev = path.join(dir, 'dev');
  const other = path.join(dir, 'other');
  executable(path.join(dev, 'bin', 'mcp-node'), `printf 'dev %s\\n' "$*"`);
  executable(path.join(other, 'bin', 'mcp-node'), `printf 'other %s\\n' "$*"`);
  const electron = executable(path.join(dir, 'electron'), `printf 'electron %s\\n' "$*"`);
  for (const { script, command } of hookCommands(dev)) {
    assert.equal(run(command).stdout, `dev ${dev}/scripts/${script}\n`);
    assert.equal(run(command, { TIPATASK_SERVER_ROOT: other }).stdout, `other ${other}/scripts/${script}\n`);
    assert.equal(run(command, { TIPATASK_SERVER_ROOT: path.join(dir, 'missing') }).stdout, `dev ${dev}/scripts/${script}\n`);
    // A usable checkout wins over the Task App runtime.
    assert.equal(run(command, {
      TIPATASK_TOOL_EXEC: electron, TIPATASK_TOOL_SCRIPT: '/x/app.asar/src/cli/task-tools.js',
    }).stdout, `dev ${dev}/scripts/${script}\n`);
  }
});

test('in a packaged build Electron runs the script from the root of TIPATASK_TOOL_SCRIPT', { skip }, t => {
  const dir = scratch(t);
  const asar = path.join(dir, 'TipATask.app/Contents/Resources/app.asar');
  const helper = executable(path.join(dir, 'TipATask Helper.app', 'TipATask Helper'),
    `printf '%s|%s|%s|%s\\n' "$#" "$ELECTRON_RUN_AS_NODE" "$1" "$3"`);
  const roots = [
    '/Applications/TipATask.app/Contents/Resources/app.asar',
    'C:\\Program Files\\TipATask\\resources\\app.asar',
  ];
  for (const { script, command } of hookCommands(asar)) {
    for (const root of roots) {
      const sep = root.includes('\\') ? '\\' : '/';
      const toolScript = [root, 'src', 'cli', 'task-tools.js'].join(sep);
      // An inherited asar TIPATASK_SERVER_ROOT (the C1061 leak) cannot run a wrapper either.
      for (const extra of [{}, { TIPATASK_SERVER_ROOT: asar }]) {
        const result = run(command, { TIPATASK_TOOL_EXEC: helper, TIPATASK_TOOL_SCRIPT: toolScript, ...extra });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout, `3|1|-e|${root}/scripts/${script}\n`);
      }
    }
  }
});

test('the runtime guard runs a shipped script, skips one the build lacks, and keeps script errors', { skip }, t => {
  const dir = scratch(t);
  const asar = path.join(dir, 'TipATask.app/Contents/Resources/app.asar');
  const commands = hookCommands(asar);
  const track = commands.find(h => h.script === 'track-file-access.js').command;

  // The checkout's own scripts through this Node (ELECTRON_RUN_AS_NODE is ignored by plain Node).
  const trackDir = path.join(dir, 'tracks');
  const shipped = run(track, {
    TIPATASK_TOOL_EXEC: process.execPath, TIPATASK_TOOL_SCRIPT: path.join(SERVER_ROOT, 'src', 'cli', 'task-tools.js'),
    TIPATASK_TASK_ID: 'T1', TIPATASK_TRACK_DIR: trackDir,
  }, JSON.stringify({ tool_input: { file_path: '/x/notes.md' } }));
  assert.equal(shipped.status, 0, shipped.stderr);
  assert.equal(fs.readFileSync(path.join(trackDir, 'T1.txt'), 'utf8'), '/x/notes.md\n');

  // An older build without the script: one skip line naming it, exit 0.
  const old = path.join(dir, 'old.asar');
  for (const { script, command } of commands) {
    const result = run(command, {
      TIPATASK_TOOL_EXEC: process.execPath, TIPATASK_TOOL_SCRIPT: path.join(old, 'src', 'cli', 'task-tools.js'),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `[hook] skipped: Task App build has no ${old}/scripts/${script}\n`);
  }

  // A script that fails is not a missing script: its error still reaches Claude Code.
  const broken = path.join(dir, 'broken');
  fs.mkdirSync(path.join(broken, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(broken, 'scripts', 'track-file-access.js'), "throw new Error('hook boom');");
  const failed = run(track, {
    TIPATASK_TOOL_EXEC: process.execPath, TIPATASK_TOOL_SCRIPT: path.join(broken, 'src', 'cli', 'task-tools.js'),
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /hook boom/);
});
