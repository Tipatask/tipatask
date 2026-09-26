'use strict';

// C1040 — shared one-shot headless Claude spawn helper.
// Lifts the spawn/parse/timeout pattern that was already copy-pasted three times
// (objective-summarizer.js summarizeOldTurns, claude-session.js spawnEfficiencyAnalysis
// + spawnHeartbeat) into one reusable function. Those three call sites are left as-is —
// deduping them onto this helper is a separate cleanup, not part of C1040.

const { spawn: cpSpawn } = require('node:child_process');
const config = require('./config');
const { augmentPathEnv } = require('./spawn-utils');

// (TPT295) Every proc still running. They are detached — their own process group — so the signal
// that stops the server never reaches them; the shutdown reaper kills them via killAllHeadlessProcs().
const _liveProcs = new Set();

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
 * @returns {Promise<string|object|null>}
 */
function runHeadlessClaude(prompt, opts = {}) {
  const model = opts.model || 'claude-opus-5';
  const timeoutMs = opts.timeoutMs || 120000;
  const cwd = opts.cwd || config.PROJECT_ROOT;

  return new Promise((resolve) => {
    let proc;
    let done = false;
    let stdout = '';

    const killTimer = setTimeout(() => {
      if (done) return;
      done = true;
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
      setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} } }, 2000);
      console.warn(`[headless-claude] timed out after ${timeoutMs}ms — pid ${proc && proc.pid}`);
      resolve(null);
    }, timeoutMs);

    try {
      proc = cpSpawn(config.CLAUDE_BIN, [
        '-p', '--model', model, '--output-format', 'json',
      ], { cwd, env: augmentPathEnv({ TERM: 'dumb' }), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (spawnErr) {
      clearTimeout(killTimer);
      console.warn(`[headless-claude] spawn failed: ${spawnErr.message}`);
      resolve(null);
      return;
    }
    _liveProcs.add(proc);
    const forget = () => _liveProcs.delete(proc);
    proc.once('close', forget);
    proc.once('error', forget);

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
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
    console.log(`[headless-claude] Killed pid ${proc.pid} reason=${reason}`);
  }
  return procs;
}

module.exports = { runHeadlessClaude, killAllHeadlessProcs };
