#!/usr/bin/env node
'use strict';

// (TPT567) Read-only diagnostic for agent CLI detection. When the Edit Agents card says
// "not found" / "not logged in", this prints WHY, layer by layer, for claude and codex:
//
//   1. every resolveBin() strategy's own answer (env override, bundled, where / login shell,
//      PROBE_DIRS, registry Path, nvm, nvm-windows) — resolveBin() short-circuits on the first
//      hit, so each strategy is re-run here independently;
//   2. the authoritative resolveBin()/resolveBinAsync() result on a cold cache;
//   3. the winExecSpec() command line the login probe actually spawns (cmd.exe wrapper on a
//      Windows .cmd launcher);
//   4. the raw `claude auth status` / `codex login status` probe (same env as detect()):
//      spawn error, exit status, full output;
//   5. the real detect() verdict, including its `detail` payload.
//
// Never starts a server, never touches port 4455, never writes anything. Safe to run while
// the app is open. Works on macOS/Linux too (Windows-only strategies print "n/a").
//
// Usage:
//   npm run probe:agent-detect
//   npm run probe:agent-detect -- --agent claude
//   npm run probe:agent-detect -- --agent codex

require('./check-node-version');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const util = require('node:util');

const su = require('../src/server/spawn-utils');
const BaseTaskAgent = require('../src/server/task-agent/base-agent');
const { getTaskAgent } = require('../src/server/task-agent');
const config = require('../src/server/config');

const IS_WIN = process.platform === 'win32';
const PROBE_ARGS = { claude: ['auth', 'status'], codex: ['login', 'status'] };

function parseArgs(argv) {
  const opts = { agents: ['claude', 'codex'] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent') {
      const id = argv[++i];
      if (!PROBE_ARGS[id]) { console.error(`unknown agent "${id}" — use claude or codex`); process.exit(2); }
      opts.agents = [id];
    }
  }
  return opts;
}

const fmt = (v) => (v === null || v === undefined || v === '' ? '(none)' : typeof v === 'string' ? v : util.inspect(v, { depth: 4, breakLength: 120 }));
const line = (label, value) => console.log(`  ${label.padEnd(26)} ${fmt(value)}`);
const header = (title) => console.log(`\n=== ${title} ===`);

function execLines(command, args) {
  return new Promise((resolve) => {
    let child;
    const backstop = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* exited */ } resolve({ error: 'timeout', lines: [] }); }, 5500);
    try {
      child = execFile(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout) => {
        clearTimeout(backstop);
        resolve({ error: err ? (err.code || err.message) : null, lines: String(stdout || '').split(/\r?\n/).filter(l => l.trim()) });
      });
    } catch (err) {
      clearTimeout(backstop);
      resolve({ error: err.code || err.message, lines: [] });
    }
  });
}

function scanDirs(dirs, name) {
  const hits = [];
  for (const dir of dirs) {
    const found = su._findExecutable(path.join(dir, name));
    if (found) hits.push(found);
  }
  return hits;
}

function nvmUnixHits(name) {
  const root = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    return fs.readdirSync(root).sort().reverse()
      .map(ver => su._findExecutable(path.join(root, ver, 'bin', name))).filter(Boolean);
  } catch { return []; }
}

function nvmWindowsHits(name) {
  const root = process.env.NVM_HOME || path.join(os.homedir(), 'AppData', 'Roaming', 'nvm');
  try {
    return fs.readdirSync(root).filter(v => /^v?\d/.test(v)).sort().reverse()
      .map(ver => su._findExecutable(path.join(root, ver, name))).filter(Boolean);
  } catch { return []; }
}

function printEnvironment() {
  header('environment');
  line('platform', `${process.platform} ${os.release()} (${process.arch})`);
  line('node', `${process.version} @ ${process.execPath}`);
  line('home', os.homedir());
  line('shell', process.env.SHELL || '(unset)');
  line('ComSpec', process.env.ComSpec || '(unset)');
  line('PATHEXT', process.env.PATHEXT || '(unset)');
  line('NVM_HOME', process.env.NVM_HOME || '(unset)');
  // TPT566 — a spawn env must hold exactly one PATH-named key; show how the parent spells it.
  const pathKeys = Object.keys(process.env).filter(k => /^path$/i.test(k));
  line('PATH key spelling(s)', pathKeys.join(', ') || '(none!)');
  line('PATH entries', su.readPathEnv(process.env).split(IS_WIN ? ';' : ':').filter(Boolean).length);
  line('augmented PATH entries', su.augmentedPath().split(IS_WIN ? ';' : ':').filter(Boolean).length);
}

async function printStrategies(name) {
  header(`${name}: resolveBin() strategies (each run independently)`);
  const envKey = `${name.toUpperCase()}_BIN`;
  const envOverride = process.env[envKey];
  line(`0  env ${envKey}`, envOverride ? `${envOverride} → ${fmt(su._findExecutable(envOverride))}` : '(unset)');
  line('0.5 bundled (npm dep)', su.resolveBundledBin(name));

  if (IS_WIN) {
    const where = await execLines('where', [name]);
    line('1  where.exe lines', where.error ? `error: ${where.error}` : where.lines);
    line('   selectWindowsLauncher', where.error ? '(skipped)' : su.selectWindowsLauncher(where.lines));
    line('2  interactive shell', 'n/a on win32');
  } else {
    const login = await execLines('/bin/sh', ['-lc', `command -v ${name}`]);
    line('1  login shell (sh -lc)', login.error ? `error: ${login.error}` : login.lines[0]);
    const userShell = process.env.SHELL;
    if (userShell && userShell !== '/bin/sh') {
      const inter = await execLines(userShell, ['-ilc', `command -v ${name}`]);
      line(`2  ${path.basename(userShell)} -ilc`, inter.error ? `error: ${inter.error}` : inter.lines[0]);
    } else {
      line('2  interactive shell', '(SHELL unset or /bin/sh — skipped)');
    }
  }

  line('3  PROBE_DIRS hits', scanDirs(su.PROBE_DIRS, name));
  if (IS_WIN) {
    const regDirs = su.readWindowsRegistryPathDirs();
    line('3b registry Path dirs', regDirs.length);
    line('   registry Path hits', scanDirs(regDirs, name));
  } else {
    line('3b registry Path', 'n/a off win32');
  }
  line('4a nvm (unix) hits', nvmUnixHits(name));
  line('4b nvm-windows hits', IS_WIN ? nvmWindowsHits(name) : 'n/a off win32');

  su.clearBinCache(name);
  const sync = su.resolveBin(name);
  su.clearBinCache(name);
  const async = await su.resolveBinAsync(name);
  line('→ resolveBin() (sync)', sync);
  line('→ resolveBinAsync()', async);
  if (sync !== async) line('⚠ sync/async differ', `${sync} vs ${async}`);
  return async || sync;
}

async function printProbe(name, bin) {
  header(`${name}: login probe`);
  if (!bin) { console.log('  (no launcher resolved — probe skipped)'); return; }
  let real = bin;
  try { real = fs.realpathSync(bin); } catch { /* keep as-is */ }
  line('launcher', bin);
  if (real !== bin) line('realpath', real);
  try { line('size', `${fs.statSync(real).size} bytes`); } catch { /* unreadable */ }
  const args = PROBE_ARGS[name];
  let spec;
  try {
    spec = su.winExecSpec(bin, args);
  } catch (err) {
    line('winExecSpec', `error: ${err.message}`);
    return;
  }
  line('spawn command', spec.command);
  line('spawn args', spec.args);
  line('spawn options', spec.options);
  const nvmDir = su.resolveNvmBinDir(bin);
  line('nvm bin dir prepended', nvmDir || '(none)');
  // Exactly detect()'s env: augmented PATH as one key, nvm dir (if any) in front.
  const env = su.prependPathEnv(su.augmentPathEnv({}), nvmDir);
  line('env PATH key(s)', Object.keys(env).filter(k => /^path$/i.test(k)).join(', '));
  const t0 = Date.now();
  const probe = await BaseTaskAgent.runCliProbe(bin, args, { env });
  line('probe elapsed', `${Date.now() - t0}ms`);
  line('probe error', probe.error ? (probe.error.code || probe.error.message) : null);
  line('probe exit status', probe.status);
  console.log('  probe output:');
  const out = String(probe.output || '');
  console.log(out ? out.split('\n').map(l => `    | ${l}`).join('\n') : '    | (empty)');
}

async function printDetect(name) {
  header(`${name}: detect() verdict`);
  su.clearBinCache(name);
  const result = await getTaskAgent(name).detect(config);
  line('available', result.available);
  line('reason', result.reason);
  line('detail', result.detail);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  printEnvironment();
  for (const name of opts.agents) {
    const bin = await printStrategies(name);
    await printProbe(name, bin);
    await printDetect(name);
  }
  console.log(`\nelapsed=${Date.now() - t0}ms`);
}

main().catch((err) => {
  console.error('[probe-agent-detect] failed:', err);
  process.exitCode = 1;
});
