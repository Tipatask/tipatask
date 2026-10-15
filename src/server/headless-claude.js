'use strict';

// C1040 — shared one-shot headless Claude spawn helper.
// Lifts the spawn/parse/timeout pattern that was already copy-pasted three times
// (objective-summarizer.js summarizeOldTurns, claude-session.js spawnEfficiencyAnalysis
// + spawnHeartbeat) into one reusable function. Those three call sites are left as-is —
// deduping them onto this helper is a separate cleanup, not part of C1040.

const { spawn: cpSpawn } = require('node:child_process');
const config = require('./config');
const { augmentPathEnv, cliSpawnSpec, writeSpawnArgFile } = require('./spawn-utils');
const { killWindowsChildTree } = require('./process-group');

// (TPT701) A server map with no servers. `--mcp-config <this> --strict-mcp-config` keeps a
// tool-less one-shot from discovering the cwd project's or the user's MCP servers — inline JSON
// on POSIX, a file on win32 where a cmd.exe-wrapped claude.cmd cannot carry the double quotes
// (same split as claude-session.js mcpConfigArg()).
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
function emptyMcpConfigArg() {
  if (process.platform === 'win32') return writeSpawnArgFile(config.USER_DATA_ROOT, EMPTY_MCP_CONFIG, '.json') || EMPTY_MCP_CONFIG;
  return EMPTY_MCP_CONFIG;
}

// argv of a one-shot `claude -p` call. `toolless` appends `--tools ''` (no built-in tools) and
// the empty strict MCP config (no MCP servers); both flags are variadic, so they come last and
// the prompt stays on stdin — nothing positional may follow them.
function buildHeadlessClaudeArgs({ model = 'claude-opus-5', toolless = false } = {}) {
  const args = ['-p', '--model', model, '--output-format', 'json'];
  if (toolless) args.push('--tools', '', '--mcp-config', emptyMcpConfigArg(), '--strict-mcp-config');
  return args;
}

// (TPT295) Every proc still running. They are detached — their own process group — so the signal
// that stops the server never reaches them; the shutdown reaper kills them via killAllHeadlessProcs().
const _liveProcs = new Set();

// Signals a proc and everything it started. POSIX: its process group (it was spawned detached),
// else the proc alone. win32 has no process groups and claude.cmd's CLI may run as a grandchild
// (under the npm shim's node.exe or cmd.exe), so the whole tree is taskkilled instead (TPT575).
function signalProc(proc, sig) {
  if (process.platform === 'win32') { killWindowsChildTree(proc); return; }
  try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch {} }
}

// Registers a detached one-shot proc so killAllHeadlessProcs() reaps it on server shutdown.
// Shared with providers/one-shot.js (TPT623), whose Codex/Gemini/Pi one-shots are the same
// kind of detached child.
function trackHeadlessProc(proc) {
  _liveProcs.add(proc);
  const forget = () => _liveProcs.delete(proc);
  proc.once('close', forget);
  proc.once('error', forget);
}

/**
 * Spawn a one-shot, non-interactive `claude -p` call and resolve its text result.
 * Never throws — resolves `null` on spawn error, non-zero exit, timeout, or a result
 * that isn't valid JSON when `opts.parseJson` is set.
 *
 * @param {string} prompt - piped to stdin
 * @param {object} [opts]
 * @param {string} [opts.model='claude-opus-5']
 * @param {number} [opts.timeoutMs=120000]
 * @param {string} [opts.cwd=config.PROJECT_ROOT]
 * @param {boolean} [opts.parseJson=false] - strip a ```json fence and JSON.parse the result
 * @param {boolean} [opts.toolless=false] - no built-in tools, no MCP servers (TPT701)
 * @param {object} [opts.env] - complete child env; default augmentPathEnv({ TERM: 'dumb' })
 * @param {Function} [opts.spawn] - child_process.spawn replacement (tests)
 * @returns {Promise<string|object|null>}
 */
function runHeadlessClaude(prompt, opts = {}) {
  const model = opts.model || 'claude-opus-5';
  const timeoutMs = opts.timeoutMs || 120000;
  const cwd = opts.cwd || config.PROJECT_ROOT;
  const spawnImpl = typeof opts.spawn === 'function' ? opts.spawn : cpSpawn;

  return new Promise((resolve) => {
    let proc;
    let done = false;
    let stdout = '';

    const killTimer = setTimeout(() => {
      if (done) return;
      done = true;
      signalProc(proc, 'SIGTERM');
      setTimeout(() => signalProc(proc, 'SIGKILL'), 2000);
      console.warn(`[headless-claude] timed out after ${timeoutMs}ms — pid ${proc && proc.pid}`);
      resolve(null);
    }, timeoutMs);

    try {
      const env = opts.env || augmentPathEnv({ TERM: 'dumb' });
      // A Windows claude.cmd runs as the program its npm shim launches (else via cmd.exe), never
      // detached there; POSIX spawns CLAUDE_BIN exactly as before (TPT575).
      const spec = cliSpawnSpec(config.CLAUDE_BIN, buildHeadlessClaudeArgs({ model, toolless: !!opts.toolless }), { env, isWin: process.platform === 'win32' });
      proc = spawnImpl(spec.command, spec.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, ...spec.options });
    } catch (spawnErr) {
      clearTimeout(killTimer);
      console.warn(`[headless-claude] spawn failed: ${spawnErr.message}`);
      resolve(null);
      return;
    }
    trackHeadlessProc(proc);

    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      console.warn(`[headless-claude] proc error: ${err.message}`);
      resolve(null);
    });
    proc.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      let text = stdout.trim();
      try {
        const outer = JSON.parse(text);
        // (TPT701) An error envelope ("is_error": true — auth, quota, bad model…) carries the
        // error text in `result`; no caller wants that back as the model's answer.
        if (outer && outer.is_error === true) {
          console.warn(`[headless-claude] claude reported an error result${outer.subtype ? ` (${outer.subtype})` : ''}`);
          resolve(null);
          return;
        }
        if (typeof outer.result === 'string') text = outer.result;
      } catch { /* stdout wasn't the --output-format json envelope — use raw text */ }

      if (!opts.parseJson) { resolve(text); return; }

      try {
        const block = text.match(/```json\s*([\s\S]*?)```/i);
        const jsonStr = (block ? block[1] : text).trim();
        resolve(JSON.parse(jsonStr));
      } catch (parseErr) {
        console.warn(`[headless-claude] result JSON parse failed: ${parseErr.message}`);
        resolve(null);
      }
    });

    if (proc.stdin && typeof proc.stdin.on === 'function') proc.stdin.on('error', () => {});
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// (TPT295) Server shutdown only (shutdown-reaper.js): SIGTERMs the group of every live proc and
// returns them. The caller exits right after, so no run ever resumes to persist a partial result.
function killAllHeadlessProcs(reason) {
  const procs = [..._liveProcs];
  _liveProcs.clear();
  for (const proc of procs) {
    signalProc(proc, 'SIGTERM');
    console.log(`[headless-claude] Killed pid ${proc.pid} reason=${reason}`);
  }
  return procs;
}

module.exports = { runHeadlessClaude, killAllHeadlessProcs, trackHeadlessProc, signalProc, buildHeadlessClaudeArgs, emptyMcpConfigArg, EMPTY_MCP_CONFIG };
