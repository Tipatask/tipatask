'use strict';

// (TPT9047) Packaged Windows Pi runtime probe. Run with standalone Node on Windows against an
// unpacked or installed app:
//
//   node scripts/probe-packaged-windows-pi.js [appDir] [--launch] [--wait-ms N]
//
// appDir defaults to dist-electron/win-unpacked; an installed app is
// %LOCALAPPDATA%\Programs\TipATask. The checks run inside that app's own Electron runtime
// (TipATask.exe with ELECTRON_RUN_AS_NODE=1, loading only its ASAR), exactly as the task start
// gate does:
//   1. resolvePiLaunchAsync() — the staged verification (runtime → import → cli, each stage
//      timed against its deadline), printed stage by stage; it must settle on a console Node
//      and carry the staged Pi version.
//   2. a forced one-millisecond probe of `cli.js --version` — the deadline must trip, the
//      captured child tree must be taken, and no node.exe child of this process may survive.
//   3. --launch only: Pi itself through node-pty in a scratch directory, as a task terminal
//      would spawn it (no model, no keys: Pi paints its TUI and reports "No models available"),
//      timing the first byte and the TUI banner, then a tree kill and a survivor check.
// Read-only apart from the scratch directory; never touches port 4455 or a running app. Pi may
// try to download fd/rg from GitHub during --launch (its own first-run behaviour).
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const MARKERS = { verify: 'TIPATASK_PI_VERIFY_OK', cleanup: 'TIPATASK_PI_TIMEOUT_CLEANUP_OK', launch: 'TIPATASK_PI_LAUNCH_OK' };

function parseArgs(argv) {
  const opts = { appDir: null, launch: false, waitMs: 20000, inner: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--launch') opts.launch = true;
    else if (arg === '--wait-ms') opts.waitMs = Number(argv[++i]) || opts.waitMs;
    else if (arg === '--inner') opts.inner = argv[++i];
    else if (!arg.startsWith('--')) opts.appDir = arg;
  }
  return opts;
}

function nodeChildrenOf(pid) {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} -and $_.Name -eq 'node.exe' } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return (ps.stdout || '').trim().split(/\r?\n/).filter(Boolean);
}

function printChecks(checks = []) {
  for (const check of checks) {
    console.log(`  ${check.runtime}: ${check.command}${check.nodeVersion ? ` (Node ${check.nodeVersion})` : ''}`);
    if (!check.stages || !check.stages.length) { console.log(`    skipped: ${check.output}`); continue; }
    for (const stage of check.stages) {
      const kill = stage.killed === undefined ? '' : stage.killed ? ' — child tree killed' : ' — child tree kill FAILED';
      console.log(`    ${stage.stage.padEnd(8)} ${stage.ok ? 'ok    ' : 'FAILED'} ${String(stage.elapsedMs ?? '?').padStart(6)}ms / ${stage.timeoutMs}ms  ${stage.output || '(empty)'}${kill}`);
    }
  }
}

// Runs inside the app's Electron runtime (ELECTRON_RUN_AS_NODE=1).
async function inner(resources, { launch, waitMs }) {
  const su = require(path.join(resources, 'app.asar', 'src', 'server', 'spawn-utils.js'));
  const cli = path.join(resources, 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), '..', 'package.json'), 'utf8'));
  console.log(`host ${process.arch} ${os.cpus()[0]?.model || ''} x${os.cpus().length}, electron ${process.versions.electron}, node ${process.versions.node}, Pi ${manifest.version}`);
  console.log(`resources ${resources}`);

  // 1. The staged verification, as the start gate runs it.
  const t0 = Date.now();
  let resolved;
  try { resolved = await su.resolvePiLaunchAsync(); }
  catch (error) {
    console.log(`resolvePiLaunchAsync() FAILED after ${Date.now() - t0}ms: ${error.message}`);
    printChecks(error.runtimeChecks);
    throw error;
  }
  console.log(`resolvePiLaunchAsync() settled in ${Date.now() - t0}ms on ${resolved.command}`);
  printChecks(resolved.runtimeChecks);
  if (!/node\.exe$/i.test(resolved.command)) throw new Error(`Pi must run on a console Node, got ${resolved.command}`);
  if (resolved.piVersion !== manifest.version) throw new Error(`verified Pi ${resolved.piVersion}, staged ${manifest.version}`);
  const cached = await su.resolvePiLaunchAsync();
  if (cached !== resolved) throw new Error('a second resolution must reuse the verified launch');
  console.log(`${MARKERS.verify} version=${resolved.piVersion} runtime=${resolved.runtimeChecks.at(-1).runtime}`);

  // 2. A deadline that cannot be met: the probe must trip, kill the tree and leave nothing behind.
  const before = nodeChildrenOf(process.pid);
  const forced = await su.probePackagedPi({ ...resolved, timeoutMs: 1 }, [cli, '--version']);
  const after = nodeChildrenOf(process.pid);
  console.log(`forced 1ms probe: error=${forced.error?.code} killed=${forced.killed} elapsed=${forced.elapsedMs}ms node.exe children before=${before.length} after=${after.length}`);
  if (forced.error?.code !== 'ETIMEDOUT' || forced.killed !== true) throw new Error('forced timeout did not trip and kill the child tree');
  if (after.length > before.length) throw new Error(`timed-out Pi probe left node.exe children: ${after.join(', ')}`);
  console.log(MARKERS.cleanup);

  if (!launch) return;
  // 3. Pi interactively through node-pty, the task terminal's spawn shape.
  const pty = require(path.join(resources, 'app.asar', 'node_modules', 'node-pty'));
  const cwd = path.join(os.tmpdir(), 'tipatask-pi-probe');
  fs.mkdirSync(cwd, { recursive: true });
  const env = su.augmentPathEnv({ TERM: 'xterm-256color', PI_SKIP_VERSION_CHECK: '1', ...resolved.env });
  const start = Date.now();
  const term = pty.spawn(resolved.command, [...resolved.argsPrefix, '--approve'], { cwd, env, cols: 100, rows: 30, useConpty: true });
  // The banner is matched on ANSI-stripped text: the TUI paints "pi" and "v0.84.1" with
  // colour sequences between them.
  const strip = text => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  let output = '', firstAt = null, bannerAt = null;
  await new Promise(resolve => {
    const done = setTimeout(resolve, waitMs);
    term.onData(data => {
      if (firstAt === null) firstAt = Date.now() - start;
      output += data;
      if (bannerAt === null && /pi v\d+\.\d+/.test(strip(output))) { bannerAt = Date.now() - start; clearTimeout(done); setTimeout(resolve, 500); }
    });
    term.onExit(() => { clearTimeout(done); resolve(); });
  });
  const tree = nodeChildrenOf(process.pid);
  const tk = spawnSync('taskkill', ['/T', '/F', '/PID', String(term.pid)], { encoding: 'utf8', windowsHide: true });
  await new Promise(resolve => setTimeout(resolve, 1500));
  const survivors = nodeChildrenOf(process.pid);
  const plain = strip(output);
  console.log(`launch pid=${term.pid} first byte ${firstAt}ms, TUI banner ${bannerAt}ms, ${output.length} bytes; tree before kill ${tree.length}, taskkill: ${(tk.stdout + tk.stderr).trim().replace(/\r?\n/g, ' | ')}; survivors ${survivors.length}`);
  if (bannerAt === null) throw new Error(`Pi painted no TUI banner within ${waitMs}ms: ${JSON.stringify(plain.slice(0, 600))}`);
  if (survivors.length) throw new Error(`Pi left node.exe children after the tree kill: ${survivors.join(', ')}`);
  console.log(`${MARKERS.launch} banner=${bannerAt}ms`);
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.inner) {
    // Exit explicitly: a node-pty handle outlives the tree kill and would keep the loop alive.
    return inner(opts.inner, opts).then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
  }
  if (process.platform !== 'win32') throw new Error('Packaged Windows Pi probe must run on Windows');
  const appDir = path.resolve(opts.appDir || path.resolve(__dirname, '..', 'dist-electron', 'win-unpacked'));
  const resources = path.join(appDir, 'resources');
  const args = [__filename, '--inner', resources, '--wait-ms', String(opts.waitMs), ...(opts.launch ? ['--launch'] : [])];
  const result = spawnSync(path.join(appDir, 'TipATask.exe'), args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 600000, windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  const expected = [MARKERS.verify, MARKERS.cleanup, ...(opts.launch ? [MARKERS.launch] : [])];
  if (result.status !== 0 || !expected.every(marker => result.stdout?.includes(marker))) {
    throw new Error(`Packaged Windows Pi probe failed (exit ${result.status})`);
  }
  return undefined;
}

if (require.main === module) {
  try { const p = main(); if (p && p.catch) p.catch(error => { console.error(error.message); process.exitCode = 1; }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { main, parseArgs, printChecks, MARKERS };
