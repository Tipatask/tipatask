'use strict';

// TPT345 — async child-process runner for the merge flow. execFile with an argv array
// (never a shell string), bounded output, explicit timeout, never rejects. Mirrors the
// house shape in process-group.js's snapshotProcesses() (injectable `exec` for tests);
// the sync spawnSync runner in src/mcp/git-worktree.js stays sync because the MCP tool
// path is sync-safe — this server-side flow must not block the event loop.

const { execFile } = require('node:child_process');

const GIT_ENV_OVERRIDES = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  LANG: 'C',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
});
// Inherited from a git hook or an agent's shell these would redirect every command at the
// wrong repo — strip unconditionally.
const GIT_ENV_STRIP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX'];

function buildGitEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of GIT_ENV_STRIP) delete env[k];
  return { ...env, ...GIT_ENV_OVERRIDES, ...extra };
}

class GitError extends Error {
  constructor(message, { args, status, stderr, stdout, cwd } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = 'GIT_FAILED';
    this.args = args;
    this.status = status;
    this.stderr = stderr;
    this.stdout = stdout;
    this.cwd = cwd;
  }
}

// Resolves { status, stdout, stderr, error, timedOut }. `error` is set for spawn
// failures (ENOENT) and timeouts; a non-zero exit is NOT an error here — callers read
// `status`. `input` (string) is written to stdin then closed (gh --body-file -).
function runCommand(command, args, { cwd, timeoutMs = 30_000, maxBytes = 4 * 1024 * 1024, env, signal, exec = execFile, input } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = exec(command, args, {
        cwd,
        env: env || buildGitEnv(),
        encoding: 'utf8',
        maxBuffer: maxBytes,
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        windowsHide: true,
      }, (err, stdout, stderr) => {
        const out = stdout ? String(stdout) : '';
        const errOut = stderr ? String(stderr) : '';
        if (!err) return finish({ status: 0, stdout: out, stderr: errOut, error: null, timedOut: false });
        const timedOut = !!(err.killed && err.signal) || err.code === 'ETIMEDOUT';
        if (typeof err.code === 'number') {
          return finish({ status: err.code, stdout: out, stderr: errOut, error: null, timedOut: false });
        }
        return finish({ status: null, stdout: out, stderr: errOut, error: err, timedOut });
      });
    } catch (err) {
      return finish({ status: null, stdout: '', stderr: '', error: err, timedOut: false });
    }
    if (signal && child) {
      const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (child && child.stdin) {
      if (typeof input === 'string') child.stdin.end(input);
      else child.stdin.end();
    }
  });
}

function runGit(args, opts = {}) {
  return runCommand('git', args, opts);
}

// Throws GitError on non-zero exit / spawn failure; resolves trimmed stdout otherwise.
async function gitOk(args, opts = {}) {
  const r = await runGit(args, opts);
  if (r.error) {
    throw new GitError(`git ${args[0]} failed: ${r.timedOut ? 'timed out' : r.error.message}`, { args, status: r.status, stderr: r.stderr, stdout: r.stdout, cwd: opts.cwd });
  }
  if (r.status !== 0) {
    throw new GitError(`git ${args.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 500)}`, { args, status: r.status, stderr: r.stderr, stdout: r.stdout, cwd: opts.cwd });
  }
  return r.stdout.replace(/\n$/, '');
}

function parseGitVersion(raw) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(raw || ''));
  if (!m) return { raw: String(raw || '').trim(), major: 0, minor: 0, patch: 0, mergeTreeSupported: false };
  const major = Number(m[1]); const minor = Number(m[2]); const patch = Number(m[3] || 0);
  return { raw: `${major}.${minor}.${patch}`, major, minor, patch, mergeTreeSupported: major > 2 || (major === 2 && minor >= 38) };
}

let _versionPromise = null;
// Cached per process — the binary does not change under us.
function gitVersion({ exec, refresh = false } = {}) {
  if (!_versionPromise || refresh) {
    _versionPromise = runGit(['--version'], { exec, timeoutMs: 10_000 }).then((r) => {
      if (r.error || r.status !== 0) return { raw: null, major: 0, minor: 0, patch: 0, mergeTreeSupported: false, error: r.error ? r.error.message : `exit ${r.status}` };
      return parseGitVersion(r.stdout);
    });
  }
  return _versionPromise;
}

module.exports = { runCommand, runGit, gitOk, gitVersion, parseGitVersion, buildGitEnv, GitError, GIT_ENV_OVERRIDES, GIT_ENV_STRIP };
