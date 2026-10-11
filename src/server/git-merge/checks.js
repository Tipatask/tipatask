'use strict';

// TPT345 — post-merge project checks (`npm test` / `npm run build`) with a baseline run on
// the target before merging, so pre-existing (flaky) failures are reported as caveats and
// only NEW failures block. Runs npm through a Node that satisfies the pinned engines
// version (C1566): this server may itself be Electron, whose process.execPath is not
// node — then bin/mcp-node (the same resolver every hook spawn uses) picks one.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { killProcessGroup, killWindowsChildTree } = require('../process-group');
const { resolveSpawnServerRoot, augmentPathEnv, cliSpawnSpec, winExecSpec } = require('../spawn-utils');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const NOT_OK_RE = /^\s*not ok\s+\d+\s*-?\s*(.*?)\s*(?:#\s*(?:SKIP|TODO).*)?$/i;
const OK_RE = /^\s*ok\s+\d+/;
const PLAN_RE = /^#\s*(pass|fail)\s+(\d+)/;

// TAP (node --test's non-TTY default): every `not ok N - name` line, deduplicated. Names
// keep their leading indentation stripped, so nested subtests and file-level rows both
// count. `hasTap` false = no ok/not ok lines at all → callers fall back to exit code.
function parseTap(text) {
  const failures = [];
  const seen = new Set();
  let ok = 0; let notOk = 0; let hasTap = false;
  let passed = null; let failed = null;
  for (const line of String(text || '').split('\n')) {
    const m = NOT_OK_RE.exec(line);
    if (m) {
      hasTap = true; notOk++;
      const name = m[1] || `(unnamed #${notOk})`;
      if (!seen.has(name)) { seen.add(name); failures.push(name); }
      continue;
    }
    if (OK_RE.test(line)) { hasTap = true; ok++; continue; }
    const p = PLAN_RE.exec(line);
    if (p) { if (p[1] === 'pass') passed = Number(p[2]); else failed = Number(p[2]); }
  }
  return { failures, ok, notOk, hasTap, passed, failed };
}

function diffFailures(baseline = [], post = []) {
  const base = new Set(baseline);
  const after = new Set(post);
  return {
    newFailures: post.filter(n => !base.has(n)),
    preExisting: post.filter(n => base.has(n)),
    fixed: baseline.filter(n => !after.has(n)),
  };
}

function nodeMajor(execPath) {
  return execPath === process.execPath ? Number(process.versions.node.split('.')[0]) : null;
}

// { node, binDir, npmCli, source }. Prefers this process's own node (dev run under nvm
// 22); under Electron (or a too-old node) asks bin/mcp-node for one. npmCli is the
// npm-cli.js next to that node when present, so npm runs under the same binary without a
// shebang lookup: <prefix>/lib/node_modules (nvm/fnm on POSIX) or, on Windows, beside
// node.exe in node_modules (the official installer, nvm-windows and fnm all use that layout).
async function resolveNodeForChecks({ projectRoot, exec = execFile, isElectron = !!process.versions.electron, execPath = process.execPath, minMajor = 22, isWin = process.platform === 'win32' } = {}) {
  let node = null; let source = null;
  if (!isElectron && (nodeMajor(execPath) === null || nodeMajor(execPath) >= minMajor)) {
    node = execPath; source = 'process';
  } else {
    const serverRoot = resolveSpawnServerRoot(projectRoot);
    if (serverRoot) {
      const wrapper = path.join(serverRoot, 'bin', isWin ? 'mcp-node.cmd' : 'mcp-node');
      const found = await new Promise((resolve) => {
        try {
          // bin/mcp-node.cmd is a batch file Node >= 22 will not execFile shell-less (EINVAL):
          // on Windows it runs through cmd.exe (TPT575).
          const spec = cliSpawnSpec(wrapper, ['-e', 'process.stdout.write(process.execPath)'], { isWin });
          exec(spec.command, spec.args, { encoding: 'utf8', timeout: 15_000, windowsHide: true, ...spec.options }, (err, stdout) => resolve(err ? null : String(stdout || '').trim()));
        } catch { resolve(null); }
      });
      if (found) { node = found; source = 'mcp-node'; }
    }
  }
  if (!node) return { node: null, binDir: null, npmCli: null, source: null, error: 'No Node.js >= ' + minMajor + ' found for project checks (set TIPATASK_NODE)' };
  const binDir = path.dirname(node);
  const candidates = [path.join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  if (isWin) candidates.push(path.join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const candidate = candidates.find(c => fs.existsSync(c));
  const npmCli = candidate ? path.resolve(candidate) : null;
  return { node, binDir, npmCli, source, error: null };
}

class OutputCapture {
  constructor(maxBytes) { this.max = maxBytes; this.head = ''; this.tail = ''; this.total = 0; this.truncated = false; }
  push(chunk) {
    const s = String(chunk);
    this.total += s.length;
    const half = Math.floor(this.max / 2);
    if (this.head.length < half) { this.head += s.slice(0, half - this.head.length); }
    this.tail = (this.tail + s).slice(-half);
    if (this.total > this.max) this.truncated = true;
  }
  text() { return this.truncated ? `${this.head}\n... (output truncated) ...\n${this.tail}` : this.head + this.tail.slice(Math.max(0, this.tail.length - (this.total - this.head.length))); }
}

// Runs one npm script; resolves { status, timedOut, stdout, stderr, tap, durationMs, command }.
// `isWin`/`killTree` are test seams.
function runCheck({ repoPath, script, node, npmCli, binDir, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, onOutput, signal, spawnFn = spawn, isWin = process.platform === 'win32', killTree }) {
  const args = script === 'test' ? ['test'] : ['run', script];
  // Without npm-cli.js the npm launcher runs instead. On Windows that is npm.cmd: a shell-less
  // spawn neither finds it (no PATHEXT lookup) nor may run it (EINVAL), so cmd.exe does both.
  const command = npmCli ? node : (isWin ? 'npm.cmd' : 'npm');
  const argv = npmCli ? [npmCli, ...args] : args;
  const extras = { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', TIPATASK_PROJECT_ROOT: process.env.TIPATASK_PROJECT_ROOT || '' };
  const env = augmentPathEnv(extras);
  // A nested `node --test` inherits the parent runner's context and silently exits 0.
  delete env.NODE_TEST_CONTEXT;
  if (binDir) env.PATH = `${binDir}${path.delimiter}${env.PATH || ''}`;
  if (!extras.TIPATASK_PROJECT_ROOT) delete env.TIPATASK_PROJECT_ROOT;
  const started = Date.now();
  return new Promise((resolve) => {
    const out = new OutputCapture(maxBytes);
    const err = new OutputCapture(Math.floor(maxBytes / 4));
    let child;
    let timedOut = false; let settled = false;
    const done = (status, spawnError) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      const stdout = out.text(); const stderr = err.text();
      resolve({ status, timedOut, stdout, stderr, tap: parseTap(stdout + '\n' + stderr), durationMs: Date.now() - started, command: [command, ...argv].join(' '), error: spawnError ? spawnError.message : null });
    };
    try {
      const spec = !npmCli && isWin ? winExecSpec(command, argv, { isWin, env }) : { command, args: argv, options: {} };
      child = spawnFn(spec.command, spec.args, { cwd: repoPath, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin, windowsHide: true, ...spec.options });
    } catch (e) { return done(null, e); }
    // win32 has no process groups: taskkill the tree — npm, the script it runs and its workers.
    const kill = () => { if (child && child.pid) { if (!isWin) killProcessGroup(child.pid, 'SIGTERM'); else killWindowsChildTree(child, { killTree }); } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    timer.unref?.();
    if (signal) { const onAbort = () => kill(); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    child.stdout?.on('data', (c) => { out.push(c); onOutput?.(String(c)); });
    child.stderr?.on('data', (c) => { err.push(c); onOutput?.(String(c)); });
    child.on('error', (e) => done(null, e));
    child.on('close', (code) => done(code));
  });
}

// One phase for one repo: { test:{status,timedOut,failures,hasTap,output}, build:{...} }.
async function runRepoChecks({ repo, enabled = { test: true, build: true }, resolved, timeoutMs, onOutput, signal, spawnFn }) {
  const result = { test: null, build: null };
  if (!resolved || !resolved.node) return { ...result, error: resolved ? resolved.error : 'node not resolved' };
  const scripts = repo.checks || {};
  if (enabled.test && scripts.test) {
    const r = await runCheck({ repoPath: repo.path, script: 'test', node: resolved.node, npmCli: resolved.npmCli, binDir: resolved.binDir, timeoutMs, onOutput, signal, spawnFn });
    result.test = { status: r.status, timedOut: r.timedOut, failures: r.tap.failures, hasTap: r.tap.hasTap, passed: r.tap.passed, failed: r.tap.failed, durationMs: r.durationMs, output: (r.stdout + (r.stderr ? '\n' + r.stderr : '')).slice(-20000), error: r.error };
  }
  if (enabled.build && scripts.build && !(signal && signal.aborted)) {
    const r = await runCheck({ repoPath: repo.path, script: 'build', node: resolved.node, npmCli: resolved.npmCli, binDir: resolved.binDir, timeoutMs, onOutput, signal, spawnFn });
    result.build = { status: r.status, timedOut: r.timedOut, durationMs: r.durationMs, output: (r.stdout + (r.stderr ? '\n' + r.stderr : '')).slice(-20000), error: r.error };
  }
  return result;
}

// Combines a baseline phase result with the post-merge one into the report the panel shows.
function compareChecks(baseline, post) {
  const report = { test: null, build: null, blocking: false };
  if (post && post.test) {
    const baseFailures = baseline && baseline.test ? baseline.test.failures : [];
    const d = diffFailures(baseFailures, post.test.failures);
    const hadBaseline = !!(baseline && baseline.test);
    const exitBlocking = post.test.status !== 0 && !post.test.hasTap; // no TAP → judge by exit code
    const blocking = d.newFailures.length > 0 || (!hadBaseline && post.test.status !== 0) || exitBlocking || !!post.test.timedOut;
    report.test = { ...post.test, stdoutTail: post.test.output, baselineFailures: baseFailures, newFailures: d.newFailures, preExisting: d.preExisting, fixed: d.fixed, hadBaseline, blocking };
    if (blocking) report.blocking = true;
  }
  if (post && post.build) {
    const blocking = post.build.status !== 0 || !!post.build.timedOut;
    report.build = { ...post.build, stdoutTail: post.build.output, blocking };
    if (blocking) report.blocking = true;
  }
  if (post && post.error) { report.error = post.error; }
  return report;
}

module.exports = { parseTap, diffFailures, resolveNodeForChecks, runCheck, runRepoChecks, compareChecks, OutputCapture, DEFAULT_TIMEOUT_MS };
