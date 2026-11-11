'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const ENV_KEYS = ['TIPATASK_DESKTOP_URL', 'TIPATASK_DESKTOP_TOKEN', 'TIPATASK_DESKTOP_LOCALE', 'ELECTRON_RUN_AS_NODE'];

function binaryPath(root, arch = process.arch) {
  return path.join(root, 'dist', `computer-use-${arch}`).replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
}

async function buildNative(root, arch = process.arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported macOS architecture.');
  const output = binaryPath(root, arch);
  const source = path.join(root, 'src', 'server', 'computer-use-native.swift');
  if (root.includes('app.asar')) return output;
  try { if (fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) return output; } catch { /* build */ }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const tmp = `${output}.${process.pid}.tmp`;
  try {
    await run('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', '-target', `${arch === 'x64' ? 'x86_64' : arch}-apple-macosx14.4`, source, '-o', tmp], { timeout: 60000, maxBuffer: 1024 * 1024 });
    fs.renameSync(tmp, output);
  } finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
  return output;
}

async function detectDesktop(provider, config, { platform = process.platform, build = buildNative } = {}) {
  if (platform !== 'darwin') return { available: false, provider, reasonCode: 'platform', reason: 'Computer use needs macOS 14.4 or later.' };
  try {
    const root = config.SERVER_ROOT || path.resolve(__dirname, '../..');
    const binary = await build(root);
    const { stdout } = await run(binary, ['--check'], { timeout: 5000 });
    if (JSON.parse(stdout).protocol !== 1) throw new Error('Unsupported helper protocol');
    return nativeComputerUse(provider, root, binary);
  } catch {
    return { available: false, provider, reasonCode: 'runtime', reason: 'Computer use needs the Task App native helper and macOS 14.4+. Update/reinstall Task App; source checkouts also need Xcode Command Line Tools (xcode-select --install), then restart this task.' };
  }
}

function nativeComputerUse(provider, root, binary) {
  return Object.freeze({ available: true, provider, backend: 'tipatask', serverName: 'computer-use', builtin: false,
      server: Object.freeze({ command: process.execPath, args: Object.freeze([path.join(root, 'src/server/computer-use-mcp.js'), binary]), env_vars: ENV_KEYS, tool_timeout_sec: 150 }),
      toolPrefix: provider === 'pi' ? 'computer-use__' : null,
      planTools: require('./computer-use').PLAN_TOOLS });
}

function desktopEnv(gate) {
  return { TIPATASK_DESKTOP_URL: gate?.url || '', TIPATASK_DESKTOP_TOKEN: gate?.token || '', TIPATASK_DESKTOP_LOCALE: gate?.locale || 'en', ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
}

module.exports = { buildNative, detectDesktop, nativeComputerUse, binaryPath, desktopEnv, ENV_KEYS };
