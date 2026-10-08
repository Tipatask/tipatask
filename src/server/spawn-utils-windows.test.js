'use strict';

// TPT558 — Windows launcher resolution in spawn-utils.js. On win32 `where <name>` lists the
// extensionless npm sh shim first, fs.access(X_OK) degrades to F_OK, and the process keeps a
// PATH captured at startup. These tests are hermetic: no real `where`/`reg.exe`, no Windows
// host needed. Pure helpers are exercised in-process; the resolver order is exercised in a
// child process with process.platform forced to 'win32' before spawn-utils.js is required,
// with stub `where`/`reg` scripts on PATH (pattern from resolve-bin-bundled.test.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');
const BaseTaskAgent = require('./task-agent/base-agent');

const {
  selectWindowsLauncher, winLauncherExts, parseRegQueryPath, expandWindowsEnv,
  readWindowsRegistryPathDirs, _findExecutable, winExecSpec,
  readPathEnv, setPathEnv, prependPathEnv,
} = require('./spawn-utils');

const SPAWN_UTILS = path.join(__dirname, 'spawn-utils.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExec(file, body) {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

// --- selectWindowsLauncher ----------------------------------------------------------------

test('selectWindowsLauncher: bare shim + .cmd + .ps1 -> the .cmd', () => {
  const lines = ['C:\\npm\\claude', 'C:\\npm\\claude.cmd', 'C:\\npm\\claude.ps1'];
  assert.equal(selectWindowsLauncher(lines, { pathext: '.COM;.EXE;.BAT;.CMD;.VBS;.JS' }), 'C:\\npm\\claude.cmd');
});

test('selectWindowsLauncher: a later .exe outranks an earlier .cmd; ties keep PATH order', () => {
  assert.equal(
    selectWindowsLauncher(['C:\\npm\\codex.cmd', 'C:\\Program Files\\Codex\\codex.exe'], { pathext: '.EXE;.CMD' }),
    'C:\\Program Files\\Codex\\codex.exe'
  );
  assert.equal(
    selectWindowsLauncher(['C:\\a\\claude.cmd', 'C:\\b\\claude.cmd'], { pathext: '.EXE;.CMD' }),
    'C:\\a\\claude.cmd'
  );
});

test('selectWindowsLauncher: only shim/.ps1/.js lines -> empty, so the caller falls through', () => {
  assert.equal(selectWindowsLauncher(['C:\\npm\\claude', 'C:\\npm\\claude.ps1', 'C:\\npm\\claude.js'], { pathext: '.EXE;.CMD;.JS' }), '');
  assert.equal(selectWindowsLauncher('', { pathext: '.EXE;.CMD' }), '');
  assert.equal(selectWindowsLauncher('\r\n\r\n', { pathext: '.EXE;.CMD' }), '');
});

test('selectWindowsLauncher: PATHEXT without .CMD drops .cmd candidates; string input is split', () => {
  assert.equal(selectWindowsLauncher('C:\\npm\\claude.cmd\r\nC:\\x\\claude.bat\r\n', { pathext: '.EXE;.BAT' }), 'C:\\x\\claude.bat');
  assert.deepEqual(winLauncherExts('.COM;.EXE;.BAT;.CMD'), ['.exe', '.cmd', '.bat', '.com']);
  assert.deepEqual(winLauncherExts(''), ['.exe', '.cmd', '.bat', '.com']);
  assert.deepEqual(winLauncherExts('.VBS;.JS'), ['.exe', '.cmd', '.bat', '.com'], 'no launcher ext in PATHEXT -> full default list');
});

// --- _findExecutable (win32 order) --------------------------------------------------------

test('_findExecutable(win32): dir holding claude, claude.cmd, claude.ps1 resolves to claude.cmd', () => {
  const dir = tmpdir('tt-tpt558-find-');
  try {
    for (const name of ['claude', 'claude.cmd', 'claude.ps1']) writeExec(path.join(dir, name), '');
    const found = _findExecutable(path.join(dir, 'claude'), { isWin: true, exts: ['.exe', '.cmd', '.bat', '.com'] });
    assert.equal(found, path.join(dir, 'claude.cmd'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_findExecutable(win32): .exe beats .cmd; a path already carrying a launcher ext is probed as-is', () => {
  const dir = tmpdir('tt-tpt558-exe-');
  try {
    for (const name of ['codex', 'codex.cmd', 'codex.exe']) writeExec(path.join(dir, name), '');
    const opts = { isWin: true, exts: ['.exe', '.cmd', '.bat', '.com'] };
    assert.equal(_findExecutable(path.join(dir, 'codex'), opts), path.join(dir, 'codex.exe'));
    assert.equal(_findExecutable(path.join(dir, 'codex.cmd'), opts), path.join(dir, 'codex.cmd'));
    assert.equal(_findExecutable(path.join(dir, 'nope'), opts), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_findExecutable(win32): bare name is the last resort (explicit *_BIN pointing at an odd file)', () => {
  const dir = tmpdir('tt-tpt558-bare-');
  try {
    writeExec(path.join(dir, 'claude'), '');
    assert.equal(
      _findExecutable(path.join(dir, 'claude'), { isWin: true, exts: ['.exe', '.cmd'] }),
      path.join(dir, 'claude')
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_findExecutable(posix): execute bit decides, no extension probing', () => {
  const dir = tmpdir('tt-tpt558-posix-');
  try {
    fs.writeFileSync(path.join(dir, 'claude'), '');
    fs.chmodSync(path.join(dir, 'claude'), 0o644);
    writeExec(path.join(dir, 'claude.cmd'), '');
    assert.equal(_findExecutable(path.join(dir, 'claude'), { isWin: false }), null);
    fs.chmodSync(path.join(dir, 'claude'), 0o755);
    assert.equal(_findExecutable(path.join(dir, 'claude'), { isWin: false }), path.join(dir, 'claude'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- registry Path helpers ----------------------------------------------------------------

const HKCU_OUT = [
  '',
  'HKEY_CURRENT_USER\\Environment',
  '    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp',
  '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;%APPDATA%\\npm;',
  '',
].join('\r\n');

const HKLM_OUT = [
  '',
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  '    Path    REG_SZ    C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\nodejs\\;c:\\users\\anton\\appdata\\roaming\\NPM',
  '',
].join('\r\n');

test('parseRegQueryPath: REG_EXPAND_SZ / REG_SZ values, case-insensitive, absent -> empty', () => {
  assert.equal(parseRegQueryPath(HKCU_OUT), '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;%APPDATA%\\npm;');
  assert.equal(parseRegQueryPath(HKLM_OUT), 'C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\nodejs\\;c:\\users\\anton\\appdata\\roaming\\NPM');
  assert.equal(parseRegQueryPath('    path    reg_sz    C:\\x'), 'C:\\x');
  assert.equal(parseRegQueryPath('ERROR: The system was unable to find the specified registry key or value.'), '');
  assert.equal(parseRegQueryPath(''), '');
  assert.equal(parseRegQueryPath(null), '');
});

test('expandWindowsEnv: %VAR% expands case-insensitively, unknown names stay verbatim', () => {
  const env = { AppData: 'C:\\Users\\a\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\a' };
  assert.equal(
    expandWindowsEnv('%APPDATA%\\npm;%userprofile%\\.local\\bin;%NOPE%\\x', env),
    'C:\\Users\\a\\AppData\\Roaming\\npm;C:\\Users\\a\\.local\\bin;%NOPE%\\x'
  );
  assert.equal(expandWindowsEnv('', env), '');
});

test('readWindowsRegistryPathDirs: user dirs first, expanded, split, de-duped case-insensitively', () => {
  const calls = [];
  const exec = (args) => {
    calls.push(args.join(' '));
    if (args[1].startsWith('HKCU')) return HKCU_OUT;
    if (args[1].startsWith('HKLM')) return HKLM_OUT;
    throw new Error('unexpected key');
  };
  const env = { APPDATA: 'C:\\Users\\anton\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\anton' };
  const dirs = readWindowsRegistryPathDirs({ exec, env });
  assert.deepEqual(dirs, [
    'C:\\Users\\anton\\AppData\\Local\\Microsoft\\WindowsApps',
    'C:\\Users\\anton\\AppData\\Roaming\\npm',
    'C:\\Windows\\system32',
    'C:\\Windows',
    'C:\\Program Files\\nodejs\\',
  ]);
  assert.deepEqual(calls, [
    'query HKCU\\Environment /v Path',
    'query HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment /v Path',
  ]);
});

test('readWindowsRegistryPathDirs: a failing hive contributes nothing, the other still counts', () => {
  const exec = (args) => {
    if (args[1].startsWith('HKLM')) throw Object.assign(new Error('reg failed'), { status: 1 });
    return HKCU_OUT;
  };
  const dirs = readWindowsRegistryPathDirs({ exec, env: { APPDATA: 'C:\\R', USERPROFILE: 'C:\\U' } });
  assert.deepEqual(dirs, ['C:\\U\\AppData\\Local\\Microsoft\\WindowsApps', 'C:\\R\\npm']);
  assert.deepEqual(readWindowsRegistryPathDirs({ exec: () => { throw new Error('no reg'); } }), []);
});

test('readWindowsRegistryPathDirs: never spawns off win32 without an injected exec', () => {
  assert.deepEqual(readWindowsRegistryPathDirs({ isWin: false }), []);
});

// --- resolver order in a forced-win32 child ----------------------------------------------
// The child forces process.platform = 'win32' BEFORE requiring spawn-utils.js (its IS_WIN /
// PROBE_DIRS / launcher list are module-load constants), puts a stub `where` (and `reg`) on
// PATH, and points SystemRoot at a non-existent dir so the registry reader falls back to the
// bare `reg` command instead of an absolute System32\reg.exe.

function runWin32Child(script, env) {
  const prelude = `
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const su = require(${JSON.stringify(SPAWN_UTILS)});
  `;
  return execFileSync(process.execPath, ['-e', prelude + script], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemRoot: path.join(os.tmpdir(), 'tt-tpt558-no-such-sysroot'),
      HOME: path.join(os.tmpdir(), 'tt-tpt558-no-such-home'),
      ...env,
    },
  }).trim();
}

test('forced win32: `where` listing shim + .cmd + .ps1 -> resolveBin/resolveBinAsync return the .cmd', () => {
  const root = tmpdir('tt-tpt558-where-');
  try {
    const npmDir = path.join(root, 'npm');
    const toolDir = path.join(root, 'tools');
    fs.mkdirSync(npmDir);
    fs.mkdirSync(toolDir);
    for (const name of ['claude', 'claude.cmd', 'claude.ps1']) writeExec(path.join(npmDir, name), '');
    writeExec(path.join(toolDir, 'where'), [
      '#!/bin/sh',
      `printf '%s\\n' "${npmDir}/claude" "${npmDir}/claude.cmd" "${npmDir}/claude.ps1"`,
      '',
    ].join('\n'));
    writeExec(path.join(toolDir, 'reg'), '#!/bin/sh\necho ERROR >&2\nexit 1\n');
    const out = runWin32Child(`
      const sync = su.resolveBin('claude');
      su.clearBinCache('claude');
      su.resolveBinAsync('claude').then((async) => {
        process.stdout.write(JSON.stringify({ sync, async }));
      });
    `, { PATH: toolDir });
    assert.deepEqual(JSON.parse(out), {
      sync: path.join(npmDir, 'claude.cmd'),
      async: path.join(npmDir, 'claude.cmd'),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forced win32: shim-only `where` falls through to a registry Path dir; that dir lands in the augmented PATH', () => {
  const root = tmpdir('tt-tpt558-reg-');
  try {
    const shimDir = path.join(root, 'shim');      // what `where` sees: only the bare shim
    const npmDir = path.join(root, 'npm');        // reachable only through the registry Path
    const toolDir = path.join(root, 'tools');
    for (const d of [shimDir, npmDir, toolDir]) fs.mkdirSync(d);
    writeExec(path.join(shimDir, 'codex'), '');
    writeExec(path.join(npmDir, 'codex'), '');
    writeExec(path.join(npmDir, 'codex.cmd'), '');
    writeExec(path.join(toolDir, 'where'), `#!/bin/sh\nprintf '%s\\n' "${shimDir}/codex"\n`);
    // HKCU answers with a %VAR%-bearing REG_EXPAND_SZ value; HKLM fails like a locked-down hive.
    writeExec(path.join(toolDir, 'reg'), [
      '#!/bin/sh',
      'case "$2" in',
      "  HKCU*) printf '%s\\n' '' 'HKEY_CURRENT_USER\\\\Environment' '    Path    REG_EXPAND_SZ    %TT_TEST_NPM_DIR%;%TT_TEST_NPM_DIR%' '' ;;",
      '  *) echo "ERROR: The system was unable to find the specified registry key or value." >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'));
    const out = runWin32Child(`
      const found = su.resolveBin('codex');
      const augmented = su.augmentPathEnv({}).PATH;
      const regDirs = su.readWindowsRegistryPathDirs();
      process.stdout.write(JSON.stringify({ found, augmented, regDirs }));
    `, { PATH: toolDir, TT_TEST_NPM_DIR: npmDir });
    const result = JSON.parse(out);
    assert.equal(result.found, path.join(npmDir, 'codex.cmd'));
    assert.deepEqual(result.regDirs, [npmDir], 'HKCU dirs de-duped, HKLM failure ignored');
    const parts = result.augmented.split(';');
    assert.ok(parts.includes(npmDir), `registry dir missing from augmented PATH: ${result.augmented}`);
    assert.equal(parts.indexOf(toolDir) < parts.indexOf(npmDir), true, 'registry dirs are appended after the inherited PATH');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forced win32: clearBinCache() with no name re-reads the registry and rebuilds the augmented PATH', () => {
  const root = tmpdir('tt-tpt558-rescan-');
  try {
    const toolDir = path.join(root, 'tools');
    const lateDir = path.join(root, 'late');
    fs.mkdirSync(toolDir);
    fs.mkdirSync(lateDir);
    writeExec(path.join(toolDir, 'where'), '#!/bin/sh\nexit 1\n');
    // The stub answers with the dir only once a marker file exists — "installed after startup".
    writeExec(path.join(toolDir, 'reg'), [
      '#!/bin/sh',
      `if [ -f "${root}/installed" ]; then printf '%s\\n' '    Path    REG_SZ    ${lateDir}'; else exit 1; fi`,
      '',
    ].join('\n'));
    const out = runWin32Child(`
      const before = su.augmentPathEnv({}).PATH;
      require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'installed'))}, '');
      const stale = su.augmentPathEnv({}).PATH;
      su.clearBinCache();
      const after = su.augmentPathEnv({}).PATH;
      process.stdout.write(JSON.stringify({ before, stale, after }));
    `, { PATH: toolDir });
    const { before, stale, after } = JSON.parse(out);
    assert.equal(before.split(';').includes(lateDir), false);
    assert.equal(stale, before, 'memoized until a forced re-detection');
    assert.equal(after.split(';').includes(lateDir), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- winExecSpec (TPT559) -----------------------------------------------------------------
// Node >= 22 refuses execFile() of a .cmd/.bat without a shell (EINVAL); the probe callers
// (src/cli/detect.js, setup.js's checkClaudeHealth) run such launchers through cmd.exe.

const CMD = 'C:\\Windows\\System32\\cmd.exe';
const WIN_ENV = { ComSpec: CMD, SystemRoot: 'C:\\Windows' };

test('winExecSpec(win32): a .exe passes through untouched', () => {
  const bin = 'C:\\Program Files\\Codex\\codex.exe';
  assert.deepEqual(winExecSpec(bin, ['--version'], { isWin: true, env: WIN_ENV }), {
    command: bin, args: ['--version'], options: {},
  });
});

test('winExecSpec(win32): a .cmd is wrapped as cmd.exe /d /s /c "<quoted line>" with verbatim args', () => {
  const bin = 'C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd';
  const spec = winExecSpec(bin, ['--version'], { isWin: true, env: WIN_ENV });
  assert.equal(spec.command, CMD);
  assert.deepEqual(spec.args, ['/d', '/s', '/c', `""${bin}" "--version""`]);
  assert.deepEqual(spec.options, { windowsVerbatimArguments: true });
});

test('winExecSpec(win32): a path with spaces stays one quoted token; .bat and upper-case .CMD wrap too', () => {
  const spaced = 'C:\\Program Files\\Codex Tools\\codex.cmd';
  assert.deepEqual(
    winExecSpec(spaced, ['auth', 'status'], { isWin: true, env: WIN_ENV }).args,
    ['/d', '/s', '/c', `""${spaced}" "auth" "status""`]
  );
  assert.equal(winExecSpec('C:\\x\\tool.bat', [], { isWin: true, env: WIN_ENV }).command, CMD);
  assert.equal(winExecSpec('C:\\x\\TOOL.CMD', [], { isWin: true, env: WIN_ENV }).command, CMD);
  assert.deepEqual(winExecSpec('C:\\x\\tool.bat', undefined, { isWin: true, env: WIN_ENV }).args[3], '""C:\\x\\tool.bat""');
});

test('winExecSpec: off win32 even a .cmd passes through; args always come back as an array', () => {
  assert.deepEqual(winExecSpec('/opt/x/claude.cmd', ['--version'], { isWin: false, env: WIN_ENV }), {
    command: '/opt/x/claude.cmd', args: ['--version'], options: {},
  });
  assert.deepEqual(winExecSpec('/usr/local/bin/claude', undefined, { isWin: false }).args, []);
});

test('winExecSpec(win32): a double quote or line break in any part is rejected', () => {
  assert.throws(() => winExecSpec('C:\\x\\a.cmd', ['--flag="v"'], { isWin: true, env: WIN_ENV }), /unquotable/);
  assert.throws(() => winExecSpec('C:\\x\\a.cmd', ['line\nbreak'], { isWin: true, env: WIN_ENV }), /unquotable/);
  assert.throws(() => winExecSpec('C:\\x\\we"ird.cmd', [], { isWin: true, env: WIN_ENV }), /unquotable/);
});

test('winExecSpec(win32): cmd.exe comes from ComSpec, else SystemRoot\\System32, else bare cmd.exe', () => {
  assert.equal(winExecSpec('C:\\x\\a.cmd', [], { isWin: true, env: { ComSpec: 'D:\\alt\\cmd.exe' } }).command, 'D:\\alt\\cmd.exe');
  assert.equal(winExecSpec('C:\\x\\a.cmd', [], { isWin: true, env: { SystemRoot: 'C:\\WINDOWS' } }).command, 'C:\\WINDOWS\\System32\\cmd.exe');
  assert.equal(winExecSpec('C:\\x\\a.cmd', [], { isWin: true, env: { windir: 'C:\\WINDOWS' } }).command, 'C:\\WINDOWS\\System32\\cmd.exe');
  assert.equal(winExecSpec('C:\\x\\a.cmd', [], { isWin: true, env: {} }).command, 'cmd.exe');
});

// --- BaseTaskAgent.runCliProbe (TPT565) ---------------------------------------------------
// The server-side detect probes (ClaudeAgent/CodexAgent.detect() -> runCliProbe()) used to
// spawn a .cmd launcher with `shell: true`, which hands cmd.exe the path UNQUOTED — any
// launcher under a path with a space failed and both agents reported "not logged in". The
// probe now builds its argv through winExecSpec(); `spawnImpl` captures the exact spawn.

function captureSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.end('{"loggedIn":true}');
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
}

test('runCliProbe(win32): a .cmd launcher in a path with a space spawns cmd.exe /d /s /c "<quoted line>"', async () => {
  const calls = [];
  const bin = 'C:\\Users\\Anton M\\AppData\\Roaming\\npm\\claude.cmd';
  const env = { PATH: 'C:\\x' };
  const result = await BaseTaskAgent.runCliProbe(bin, ['auth', 'status'], { spawnImpl: captureSpawn(calls), isWin: true, env });
  assert.equal(calls.length, 1);
  const { command, args, options } = calls[0];
  assert.equal(path.win32.basename(command).toLowerCase(), 'cmd.exe');
  assert.deepEqual(args, ['/d', '/s', '/c', `""${bin}" "auth" "status""`]);
  assert.equal(options.windowsVerbatimArguments, true);
  assert.equal(options.shell, undefined, 'never shell: true — that is what left the path unquoted');
  assert.equal(options.windowsHide, true);
  assert.equal(options.env, env, 'probe env passes through untouched');
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(result.error, null);
  assert.equal(result.status, 0);
  assert.equal(result.output, '{"loggedIn":true}');
});

test('runCliProbe(win32): a plain .exe is spawned verbatim — no cmd.exe wrapper, no quoting', async () => {
  const calls = [];
  const bin = 'C:\\Program Files\\Codex\\codex.exe';
  await BaseTaskAgent.runCliProbe(bin, ['login', 'status'], { spawnImpl: captureSpawn(calls), isWin: true });
  const { command, args, options } = calls[0];
  assert.equal(command, bin);
  assert.deepEqual(args, ['login', 'status']);
  assert.equal(options.windowsVerbatimArguments, undefined);
  assert.equal(options.shell, undefined);
});

test('runCliProbe: without isWin the real platform decides, and an unquotable .cmd argv resolves as an error', async () => {
  const calls = [];
  const bin = '/opt/x/claude.cmd';
  await BaseTaskAgent.runCliProbe(bin, ['--version'], { spawnImpl: captureSpawn(calls) });
  if (process.platform === 'win32') {
    assert.equal(path.win32.basename(calls[0].command).toLowerCase(), 'cmd.exe');
  } else {
    assert.equal(calls[0].command, bin);
    assert.deepEqual(calls[0].args, ['--version']);
  }
  const rejected = await BaseTaskAgent.runCliProbe('C:\\x\\a.cmd', ['--flag="v"'], { spawnImpl: captureSpawn([]), isWin: true });
  assert.match(rejected.error?.message || '', /unquotable/);
  assert.equal(rejected.status, null);
});

// --- single PATH key (TPT566) -------------------------------------------------------------
// process.env's key is spelled `Path` on Windows; `{ ...process.env, PATH: x }` therefore hands a
// child both a stale `Path` and the new `PATH`, and which one cmd.exe honours is undefined.
// setPathEnv()/prependPathEnv() collapse every spelling into the one canonical `PATH` key.

const pathKeys = (env) => Object.keys(env).filter(k => k.toLowerCase() === 'path');

test('setPathEnv(win32): `Path` is replaced by exactly one `PATH` key; other vars untouched', () => {
  const env = setPathEnv({ Path: 'C:\\x', FOO: '1' }, 'C:\\y', { isWin: true });
  assert.deepEqual(pathKeys(env), ['PATH']);
  assert.equal(env.PATH, 'C:\\y');
  assert.equal(env.FOO, '1');
  assert.deepEqual(pathKeys(setPathEnv({ Path: 'a', PATH: 'b', path: 'c' }, 'd', { isWin: true })), ['PATH']);
  assert.equal(setPathEnv({}, 'C:\\z', { isWin: true }).PATH, 'C:\\z');
});

test('prependPathEnv(win32): env { Path: "C:\\\\x" } -> one PATH key, prepended dir first', () => {
  const env = prependPathEnv({ Path: 'C:\\x' }, 'C:\\nvm\\v22', { isWin: true });
  assert.deepEqual(pathKeys(env), ['PATH']);
  assert.deepEqual(env.PATH.split(';'), ['C:\\nvm\\v22', 'C:\\x']);
  // Both spellings present: the exact `PATH` value is the one kept and prepended to.
  const dup = prependPathEnv({ Path: 'C:\\stale', PATH: 'C:\\live' }, 'C:\\nvm', { isWin: true });
  assert.deepEqual(pathKeys(dup), ['PATH']);
  assert.deepEqual(dup.PATH.split(';'), ['C:\\nvm', 'C:\\live']);
  // Falsy dir: value unchanged, duplicates still collapsed.
  const noop = prependPathEnv({ Path: 'C:\\x' }, null, { isWin: true });
  assert.deepEqual(noop, { PATH: 'C:\\x' });
  assert.equal(prependPathEnv({}, 'C:\\only', { isWin: true }).PATH, 'C:\\only');
  assert.equal(readPathEnv({ Path: 'C:\\p' }, { isWin: true }), 'C:\\p');
  assert.equal(readPathEnv({}, { isWin: true }), '');
});

test('setPathEnv/prependPathEnv(posix): names are case-sensitive, so a `Path` variable is left alone', () => {
  const env = setPathEnv({ Path: 'keep', PATH: 'old' }, 'new', { isWin: false });
  assert.deepEqual(env, { Path: 'keep', PATH: 'new' });
  const pre = prependPathEnv({ Path: 'keep', PATH: '/usr/bin' }, '/nvm/bin', { isWin: false });
  assert.deepEqual(pre, { Path: 'keep', PATH: '/nvm/bin:/usr/bin' });
  assert.equal(readPathEnv({ Path: 'keep' }, { isWin: false }), '');
});

test('forced win32: augmentPathEnv() collapses an inherited `Path` and an extras `Path` into one PATH key', () => {
  const root = tmpdir('tt-tpt566-path-');
  try {
    const toolDir = path.join(root, 'tools');
    fs.mkdirSync(toolDir);
    writeExec(path.join(toolDir, 'where'), '#!/bin/sh\nexit 1\n');
    writeExec(path.join(toolDir, 'reg'), '#!/bin/sh\nexit 1\n');
    const out = runWin32Child(`
      const keys = (env) => Object.keys(env).filter(k => k.toLowerCase() === 'path');
      const inherited = su.augmentPathEnv({});
      const viaExtras = su.augmentPathEnv({ Path: 'C:\\\\stale' });
      process.stdout.write(JSON.stringify({
        inheritedKeys: keys(inherited), inheritedPath: inherited.PATH,
        extrasKeys: keys(viaExtras), extrasPath: viaExtras.PATH,
      }));
    `, { PATH: undefined, Path: toolDir }); // the child's process.env carries only `Path`, as on Windows
    const result = JSON.parse(out);
    assert.deepEqual(result.inheritedKeys, ['PATH']);
    assert.ok(result.inheritedPath.split(';').includes(toolDir), `inherited Path dir missing: ${result.inheritedPath}`);
    assert.deepEqual(result.extrasKeys, ['PATH']);
    assert.equal(result.extrasPath.includes('C:\\stale'), false, 'an extras `Path` never leaks into the env');
    assert.equal(result.extrasPath, result.inheritedPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
