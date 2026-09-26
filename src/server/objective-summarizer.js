'use strict';

const { spawn: cpSpawn } = require('node:child_process');
const config = require('./config');
const { augmentPathEnv } = require('./spawn-utils');

/**
 * Heuristic fallback when Haiku call fails or times out.
 * Truncates user text to ~100 chars as summary.
 */
function heuristicSummary(turnPairs) {
  return turnPairs.map(({ turnNum, userText }) => ({
    turn: turnNum,
    summary: (userText || '').slice(0, 100).replace(/\s+/g, ' ').trim() || '(empty)',
  }));
}

/**
 * Batch-summarize old turn-pairs via a single Haiku call.
 * Returns array of { turn: N, summary: "..." } objects, one per input pair.
 * Falls back to heuristicSummary on timeout/parse failure.
 *
 * @param {Array<{ turnNum: number, userText: string, assistantText: string }>} turnPairs
 * @param {{ onSpawn?: (proc: import('node:child_process').ChildProcess) => void }} [opts]
 *   onSpawn receives the Haiku child right after spawn, so the owning chat can kill it on teardown
 *   (a killed proc resolves with the heuristic fallback like any other failure).
 * @returns {Promise<Array<{ turn: number, summary: string }>>}
 */
async function summarizeOldTurns(turnPairs, { onSpawn } = {}) {
  if (!turnPairs || turnPairs.length === 0) return [];
  if (!config.OBJECTIVE_HISTORY_COMPRESS_ENABLED) return heuristicSummary(turnPairs);

  const turnsBlock = turnPairs.map(({ turnNum, userText, assistantText }) =>
    `Turn ${turnNum}:\nUser: ${(userText || '').slice(0, 1000)}\nAssistant: ${(assistantText || '').slice(0, 2000)}`
  ).join('\n\n---\n\n');

  const prompt = [
    `Summarize each conversation turn below into a single JSON object: {"turn": N, "summary": "..."}`,
    `Rules: ≤120 chars per summary. Focus on decisions made, cards accepted/rejected, blockers, key facts.`,
    `Output ONLY a JSON array like: [{"turn":1,"summary":"..."},{"turn":2,"summary":"..."}]`,
    `No prose, no code block, no extra fields.`,
    ``,
    turnsBlock,
  ].join('\n');

  return new Promise((resolve) => {
    let proc;
    let done = false;
    let stdout = '';

    const timeoutMs = config.OBJECTIVE_HISTORY_COMPRESS_TIMEOUT_MS;
    const killTimer = setTimeout(() => {
      if (done) return;
      done = true;
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
      setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} } }, 1000);
      console.warn(`[objective:compress] Haiku summarize timed out after ${timeoutMs}ms — using heuristic fallback`);
      resolve(heuristicSummary(turnPairs));
    }, timeoutMs);

    try {
      proc = cpSpawn(config.CLAUDE_BIN, [
        '-p', '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json',
      ], { cwd: config.PROJECT_ROOT, env: augmentPathEnv({ TERM: 'dumb' }), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (spawnErr) {
      clearTimeout(killTimer);
      console.warn(`[objective:compress] Failed to spawn Haiku: ${spawnErr.message} — using heuristic fallback`);
      resolve(heuristicSummary(turnPairs));
      return;
    }
    if (typeof onSpawn === 'function') onSpawn(proc);

    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      console.warn(`[objective:compress] Haiku proc error: ${err.message} — using heuristic fallback`);
      resolve(heuristicSummary(turnPairs));
    });
    proc.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      try {
        let text = stdout.trim();
        try { const outer = JSON.parse(text); if (outer.result) text = outer.result; } catch {}
        const block = text.match(/```json\s*([\s\S]*?)```/i);
        const jsonStr = (block ? block[1] : text).trim();
        const parsed = JSON.parse(jsonStr);
        if (!Array.isArray(parsed)) throw new Error('not array');
        // Validate and normalise
        const result = turnPairs.map(({ turnNum }) => {
          const found = parsed.find(r => r && r.turn === turnNum);
          return found && typeof found.summary === 'string'
            ? { turn: turnNum, summary: found.summary.slice(0, 150) }
            : heuristicSummary([{ turnNum, userText: '' }])[0];
        });
        resolve(result);
      } catch (parseErr) {
        console.warn(`[objective:compress] Haiku response parse failed (${parseErr.message}) — using heuristic fallback`);
        resolve(heuristicSummary(turnPairs));
      }
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

module.exports = { summarizeOldTurns, heuristicSummary };
