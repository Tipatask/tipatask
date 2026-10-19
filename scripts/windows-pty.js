'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MACHINES = { x64: 0x8664, arm64: 0xaa64 };
const WINDOWS_PTY_BINARIES = [
  'conpty.node', 'conpty_console_list.node', 'pty.node', 'winpty.dll', 'winpty-agent.exe',
  'conpty/conpty.dll', 'conpty/OpenConsole.exe',
];
const WINDOWS_PTY_SCRIPTS = [
  'index.js', 'utils.js', 'windowsTerminal.js', 'windowsPtyAgent.js',
  'windowsConoutConnection.js', 'conpty_console_list_agent.js',
  'worker/conoutSocketWorker.js', 'shared/conout.js',
];

function assertWindowsPtyBinaries(directory, arch) {
  if (!Object.hasOwn(MACHINES, arch)) throw new Error(`Unsupported Windows node-pty architecture: ${arch}`);
  const problems = [];
  for (const name of WINDOWS_PTY_BINARIES) {
    const file = path.join(directory, name);
    try {
      if (!fs.statSync(file).isFile()) throw new Error('not a regular file');
      const bytes = fs.readFileSync(file);
      const pe = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1;
      if (bytes.toString('ascii', 0, 2) !== 'MZ' || pe < 64 || pe + 26 > bytes.length
          || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0'
          || bytes.readUInt16LE(pe + 4) !== MACHINES[arch]
          || bytes.readUInt16LE(pe + 24) !== 0x20b) {
        throw new Error(`expected PE32+ ${arch} binary`);
      }
    } catch (error) {
      problems.push(`${file}: ${error.code || error.message}`);
    }
  }
  if (problems.length) throw new Error(`Windows node-pty runtime is incomplete or incompatible:\n  ${problems.join('\n  ')}`);
}

function assertWindowsPtySource(sourceRoot, arch) {
  const root = path.join(sourceRoot, 'node_modules', 'node-pty');
  const installed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package-lock.json'), 'utf8'));
  const wanted = lock.packages?.['node_modules/node-pty']?.version;
  if (!wanted || installed.version !== wanted) {
    throw new Error(`Windows node-pty version ${installed.version} does not match lockfile ${wanted}`);
  }
  assertWindowsPtyBinaries(path.join(root, 'prebuilds', `win32-${arch}`), arch);
}

module.exports = { MACHINES, WINDOWS_PTY_BINARIES, WINDOWS_PTY_SCRIPTS,
  assertWindowsPtyBinaries, assertWindowsPtySource };
