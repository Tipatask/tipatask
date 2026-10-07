'use strict';

// TPT559 — detectCli() must report a version for a Windows .cmd launcher. Node >= 22 refuses a
// shell-less execFileSync of a .cmd/.bat (EINVAL), so _probeVersion() runs it through cmd.exe
// via spawn-utils.js winExecSpec(). On a POSIX host the win32 branch is exercised in a child
// process with process.platform forced to 'win32' (pattern from spawn-utils-windows.test.js)
// and a stub `cmd.exe` shell script standing in for ComSpec; the stub checks the exact
// `/d /s /c "<quoted line>"` argv it receives, so a quoting mistake surfaces as version: null.
// On a real Windows host the same scenario runs in-process against the real cmd.exe.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const DETECT = path.join(__dirname, 'detect.js');
const MARK = '__TPT559__';

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExec(file, body) {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function runWin32Child(script, env) {
  const prelude = `
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const detect = require(${JSON.stringify(DETECT)});
  `;
  const out = execFileSync(process.execPath, ['-e', prelude + script], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemRoot: path.join(os.tmpdir(), 'tt-tpt559-no-such-sysroot'),
      HOME: path.join(os.tmpdir(), 'tt-tpt559-no-such-home'),
      ...env,
    },
  });
  const line = out.split(/\r?\n/).find(l => l.startsWith(MARK));
  assert.ok(line, `child printed no result line:\n${out}`);
  return JSON.parse(line.slice(MARK.length));
}

test('forced win32: detectCli({force:true}) reports the version of a stub claude.cmd via cmd.exe /d /s /c', {
  skip: IS_WIN && 'POSIX-script stubs; the real-cmd.exe case below covers Windows',
}, () => {
  const root = tmpdir('tt-tpt559-detect-');
  try {
    const npmDir = path.join(root, 'npm');
    const toolDir = path.join(root, 'tools');
    fs.mkdirSync(npmDir);
    fs.mkdirSync(toolDir);
    const claudeCmd = path.join(npmDir, 'claude.cmd');
    writeExec(claudeCmd, '@echo never-run-directly\r\n');
    writeExec(path.join(toolDir, 'where'), '#!/bin/sh\nexit 1\n');
    writeExec(path.join(toolDir, 'reg'), '#!/bin/sh\necho ERROR >&2\nexit 1\n');
    // What winExecSpec must hand cmd.exe: the whole line quoted once more (cmd's /s strips it).
    const expectedLine = `""${claudeCmd}" "--version""`;
    writeExec(path.join(toolDir, 'cmd.exe'), [
      '#!/bin/sh',
      `expected='${expectedLine}'`,
      'if [ "$#" = 4 ] && [ "$1" = "/d" ] && [ "$2" = "/s" ] && [ "$3" = "/c" ] && [ "$4" = "$expected" ]; then',
      '  echo 9.9.9-stub',
      'else',
      '  echo "bad cmd.exe argv: $*" >&2',
      '  exit 1',
      'fi',
      '',
    ].join('\n'));
    const result = runWin32Child(`
      process.stdout.write(${JSON.stringify(MARK)} + JSON.stringify(detect.detectCli({ force: true })) + '\\n');
    `, { PATH: toolDir, CLAUDE_BIN: claudeCmd, ComSpec: path.join(toolDir, 'cmd.exe') });
    assert.deepEqual(result.claude, { found: true, path: claudeCmd, version: '9.9.9-stub' });
    assert.equal(result.codex.found, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('win32 host: detectCli({force:true}) reports the version of a real stub claude.cmd through cmd.exe', {
  skip: !IS_WIN && 'needs a real cmd.exe',
}, () => {
  const root = tmpdir('tt-tpt559-detect-win-');
  try {
    const claudeCmd = path.join(root, 'claude.cmd');
    fs.writeFileSync(claudeCmd, '@echo 9.9.9-stub\r\n');
    process.env.CLAUDE_BIN = claudeCmd;
    delete require.cache[DETECT];
    delete require.cache[require.resolve('../server/spawn-utils')];
    const { detectCli } = require(DETECT);
    const result = detectCli({ force: true });
    assert.deepEqual(result.claude, { found: true, path: claudeCmd, version: '9.9.9-stub' });
  } finally {
    delete process.env.CLAUDE_BIN;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
