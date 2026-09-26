'use strict';

// Pi objective provider emits the shared objective-chat WS event contract. Pi failures
// may arrive as message_end with stopReason:error even when the process exits 0.

const path = require('node:path');
const { spawn: cpSpawn } = require('node:child_process');
const config = require('../config');
const { augmentPathEnv, projectEnvExtras: sharedProjectEnvExtras, resolveNvmBinDir, resolvePiLaunch } = require('../spawn-utils');
const { normalizeProposals } = require('../claude-session');
const { localizeAttachments } = require('../task-agent/attachments');
const throttle = require('../objective-throttle');
const { buildTurnPrompt } = require('./transcript');
const { resolveProviderModel, configForProject } = require('./registry');
const { readProjectConfig, piEntryForModel, piDefaultEntry, piKeyEnvVars } = require('../project-config');
const { piSpawnProvider, preparePiCustomEndpoint } = require('../pi-custom-endpoint');

// Prepend the current node binary's bin/ directory to the spawn PATH so that
// the pi shebang (#!/usr/bin/env node) resolves to the same Node version
// running this server process.
const NODE_BIN_DIR = path.dirname(process.execPath);

function projectEnvExtras(session) {
  return sharedProjectEnvExtras(session && session.projectPath);
}

// (C1101) session.selectedModel still wins (C1030 chat-model-selector), but the
// project-config fallback below it must be the CALLING project's PI_MODEL, not the
// server's startup-project snapshot — otherwise a saved "Other Model" choice is
// invisible in a second project window on the same forked server. Shared by the argv
// builder and the spawn log so they can never disagree.
function piModelFor(session) {
  return resolveProviderModel(session, 'pi', configForProject(session && session.projectPath));
}

// (TPT163) The PI_MODELS row this turn runs on — the one naming the resolved model, else
// row 0, else null (legacy flat-pair / unconfigured project → OpenRouter defaults). Shared by
// the argv builder (--provider) and the spawn env (key env var) so they can never disagree.
function piEntryFor(session) {
  const root = (session && session.projectPath) || config.PROJECT_ROOT;
  let cfg;
  try { cfg = readProjectConfig(root); } catch { cfg = null; }
  if (!cfg) return null;
  return piEntryForModel(cfg, piModelFor(session)) || piDefaultEntry(cfg);
}

// ── Arg builder ──────────────────────────────────────────────────────────────

// Build the CLI argv for a Pi headless turn.
// First turn (no piSessionId): no --session flag.
// Follow-up turns: --session <uuid> resumes the exact previous session.
// Model id is passed verbatim: with an explicit --provider, Pi itself strips a leading
// "<provider>/" from --model (openrouter/deepseek/x → deepseek/x), so a PI_MODELS row
// works with or without the prefix and is never double-prefixed.
// (TPT163) --provider is the row's own provider and is ALWAYS passed explicitly: without it
// Pi infers a provider from a "vendor/" prefix and can land a deepseek/... id on OpenRouter.
// (TPT189) For a `custom` row that is the generated models.json block id (piSpawnProvider). This
// stays a pure argv builder — the file itself is written by spawnPiTurn() via
// preparePiCustomEndpoint(), so calling this directly never touches disk.
function buildPiArgs(session) {
  const args = [
    '--mode', 'json',
    '--provider', piSpawnProvider(piEntryFor(session)),
    // (C1030) session.selectedModel (chat-model-selector) wins over config.PI_MODEL.
    '--model', piModelFor(session),
    '--tools', 'read',
  ];
  if (session.piSessionId) {
    args.push('--session', session.piSessionId);
  }
  return args;
}

// ── Card parser ───────────────────────────────────────────────────────────────

// Extract task-proposal cards from the accumulated turnBuffer.
// Returns { cards, filesAddressed, docUpdates, newTags } or null.
function extractCards(session, emit) {
  const blocks = [...session.turnBuffer.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (blocks.length === 0) return null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const parsed = normalizeProposals(JSON.parse(blocks[i][1]));
      if (parsed && parsed.changes && Array.isArray(parsed.changes)) {
        const cards = parsed.changes;
        const filesAddressed = parsed.files_addressed || [];
        const docUpdates = parsed.doc_updates || [];
        const newTags = Array.isArray(parsed.new_tags) ? parsed.new_tags : [];
        // (C1339) LLM-written scope summary of the whole objective — becomes the title
        // of the auto-created parent task on save.
        const objectiveSummary = typeof parsed.objective_summary === 'string' ? parsed.objective_summary.trim() : null;
        const cardsJson = JSON.stringify(cards);
        if (cardsJson !== session._lastEmittedCardsJson) {
          session._lastEmittedCardsJson = cardsJson;
          emit({ type: 'task-cards', cards, filesAddressed, docUpdates, newTags, objectiveSummary });
          const lastAssistant = [...session.messages].reverse().find(m => m.role === 'assistant');
          if (lastAssistant) {
            lastAssistant.cards = cards;
            lastAssistant.filesAddressed = filesAddressed;
            lastAssistant.docUpdates = docUpdates;
            lastAssistant.newTags = newTags;
            lastAssistant.objectiveSummary = objectiveSummary;
          }
        }
        return { cards, filesAddressed, docUpdates, newTags, objectiveSummary };
      }
    } catch { /* partial JSON in mid-stream — retry on next chunk */ }
  }
  return null;
}

// ── Turn deadline + idle watchdog ─────────────────────────────────────────────

function armTurnDeadline(session, taskId, proc, emit) {
  clearTurnDeadline(session);
  session._turnDeadlineTimer = setTimeout(() => {
    emitPiError(session, taskId, proc, emit, 'turn-deadline', session._retryAttempt || 0);
  }, config.OBJECTIVE_TURN_MAX_MS);
}

function armIdleWatchdog(session, taskId, proc, emit) {
  clearIdleWatchdog(session);
  session._idleWatchdogTimer = setTimeout(() => {
    emitPiError(session, taskId, proc, emit, 'stream-idle-timeout', session._retryAttempt || 0);
  }, config.OBJECTIVE_STREAM_IDLE_MS);
}

function clearTurnDeadline(session) {
  if (session._turnDeadlineTimer) {
    clearTimeout(session._turnDeadlineTimer);
    session._turnDeadlineTimer = null;
  }
}

function clearIdleWatchdog(session) {
  if (session._idleWatchdogTimer) {
    clearTimeout(session._idleWatchdogTimer);
    session._idleWatchdogTimer = null;
  }
}

function clearPiTimers(session) {
  clearTurnDeadline(session);
  clearIdleWatchdog(session);
}

// ── stderr tail ───────────────────────────────────────────────────────────────

const STDERR_TAIL_MAX = 2000;   // rolling buffer kept per turn
const STDERR_DETAIL_MAX = 400;  // slice of it sent in the objective-error frame
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function appendStderrTail(session, text) {
  const next = (session._piStderrTail || '') + text;
  session._piStderrTail = next.length > STDERR_TAIL_MAX ? next.slice(-STDERR_TAIL_MAX) : next;
}

// stopReason:"error"/"aborted" on the assistant message is Pi's only failure signal in
// --mode json. Returns the error text, or null when the event carries no failure.
function assistantErrorOf(event) {
  let msg = event && event.message;
  if (!msg && Array.isArray(event && event.messages)) {
    msg = [...event.messages].reverse().find(m => m && m.role === 'assistant');
  }
  if (!msg || (msg.stopReason !== 'error' && msg.stopReason !== 'aborted')) return null;
  return String(msg.errorMessage || `request ${msg.stopReason}`);
}

// ── Error helper ──────────────────────────────────────────────────────────────

function emitPiError(session, taskId, proc, emit, reason, attempts, extraDetail) {
  if (session._aborted) return; // one objective-error per turn
  throttle.recordTimeout(taskId, reason);
  clearPiTimers(session);
  session._aborted = true;
  // Kill proc group
  if (proc && !proc.killed) {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already dead */ }
    }, 3000);
  }
  // Clean turn buffers
  session.turnBuffer = '';
  session.turnRawSse = '';
  session._resultFinalized = false;
  const model = piModelFor(session);
  // detail = the full provider error (when `reason` had to truncate it) + the stderr tail.
  const tail = [extraDetail, (session._piStderrTail || '').trim()].filter(Boolean).join('\n');
  const detail = tail ? tail.slice(-STDERR_DETAIL_MAX) : undefined;
  console.error(`[pi] objective-error task=${taskId} model=${model} reason=${reason}${tail ? ` stderr=${JSON.stringify(detail)}` : ''}`);
  // C1031 — see claude-session.js emitObjectiveError. model/detail name what failed and why.
  emit({ type: 'objective-error', reason, attempts, provider: 'pi', model, detail });
}

// ── finalizePiTurn ────────────────────────────────────────────────────────────

function finalizePiTurn(session, taskId, code, emit, stats) {
  if (session._resultFinalized) return;
  session._resultFinalized = true;

  clearPiTimers(session);

  const turnIndex = session.messages.filter(m => m.role === 'assistant').length;

  // Parse cards from turnBuffer; push assistant message
  const cardResult = extractCards(session, emit);
  const assistantMsg = {
    role: 'assistant',
    content: session.turnBuffer,
    cards: cardResult ? cardResult.cards : null,
    filesAddressed: cardResult ? cardResult.filesAddressed : [],
    docUpdates: cardResult ? cardResult.docUpdates : [],
    newTags: cardResult ? cardResult.newTags : [],
    objectiveSummary: cardResult ? cardResult.objectiveSummary : null, // C1339
    timestamp: Date.now(),
  };
  session.messages.push(assistantMsg);

  // Build tokens summary from the turn_end assistant message's usage block.
  const tokens = stats ? {
    input: stats.input_tokens || stats.input || 0,
    output: stats.output_tokens || stats.output || 0,
    costUsd: (stats.cost && typeof stats.cost.total === 'number') ? stats.cost.total : null,
  } : null;

  // Emit the canonical end-of-turn triple
  const pendingResult = {
    content: session.turnBuffer,
    tokens,
    filesAddressed: assistantMsg.filesAddressed,
    docUpdates: assistantMsg.docUpdates,
    cards: assistantMsg.cards,
    newTags: assistantMsg.newTags || [],
    objectiveSummary: assistantMsg.objectiveSummary || null, // C1339
    timingMilestones: {},
    turnIndex,
    code: code ?? 0,
  };

  const wsOpen = session.ws && session.ws.readyState === session.ws.OPEN;
  if (wsOpen) {
    emit({ type: 'objective-result', ...pendingResult, showAiStats: config.SHOW_AI_STATS });
    emit({ type: 'chat-ready', turnIndex });
    emit({ type: 'exit', code: code ?? 0, chatContinues: true, showAiStats: config.SHOW_AI_STATS });
  } else {
    // WS closed — buffer for reconnect (mirrors claude-session pendingResult)
    session.pendingResult = pendingResult;
  }

  // Update total token counters
  if (tokens) {
    session.totalTokens.input  += tokens.input  || 0;
    session.totalTokens.output += tokens.output || 0;
  }

  throttle.recordSuccess(taskId);
  session.proc = null;
  session._resultFinalized = false; // reset for next turn
}

// ── spawnPiTurn ───────────────────────────────────────────────────────────────

/**
 * Spawn a Pi CLI headless turn for the given session/task.
 *
 * @param {object}   session  - Session object (same shape as claude-session sessions).
 * @param {string}   taskId   - Task identifier string (for throttle/logging).
 * @param {Function} [emitFn] - Optional emitter fn(frame). When absent, emits directly
 *                              over session.ws so the call signature is identical to
 *                              spawnObjectiveTurn(session, taskId). Pass a capturing fn
 *                              for isolated testing (no WS required).
 * @param {object}   [deps]   - Test seam: { spawn } replaces child_process.spawn.
 */
function spawnPiTurn(session, taskId, emitFn, deps = {}) {
  // Torn-down chat (teardownObjectiveSession): never start another turn; free any slot a throttle
  // drain granted this call (C1031 early-return contract).
  if (session._closed) {
    console.log(`[pi] Spawn skipped for closed session task=${taskId}`);
    throttle.recordAbort(taskId);
    return;
  }
  const spawnFn = deps.spawn || cpSpawn;
  // Build the per-frame emitter — always adds tabId for client routing.
  const emit = emitFn
    ? (frame) => emitFn({ ...frame, tabId: session.tabId })
    : (frame) => {
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ ...frame, tabId: session.tabId }));
        }
      };

  // Reset per-turn state
  session.turnBuffer = '';
  session.turnRawSse = '';
  session._lastEmittedCardsJson = null;
  session._resultFinalized = false;
  session._aborted = false;
  session._piStderrTail = '';

  // (C1112) launch is null only when Pi is unresolvable by any strategy — bundled dependency
  // (checkout), extraResources copy (packaged Electron), PI_BIN override, or system PATH.
  const launch = resolvePiLaunch() || { command: 'pi', argsPrefix: [], env: {} };

  const cwd = session.projectPath || config.PROJECT_ROOT;
  const baseEnv = augmentPathEnv({
    TERM: 'dumb',
    ...projectEnvExtras(session),
    ...launch.env,
  });

  // Prepend the current process's node bin/ dir as a fallback for the rare case launch
  // resolves to a bare system 'pi' found on PATH — the checkout wrapper (bin/pi, via
  // bin/mcp-node) and the packaged extraResources branch (process.execPath +
  // ELECTRON_RUN_AS_NODE) both pick their own interpreter and don't depend on this. Also
  // prepend the nvm bin dir where a system-wide pi may be installed.
  const piNvmBinDir = resolveNvmBinDir(launch.command);
  const pathParts = [NODE_BIN_DIR];
  if (piNvmBinDir) pathParts.push(piNvmBinDir);
  pathParts.push(baseEnv.PATH);
  const env = { ...baseEnv, PATH: pathParts.join(path.delimiter) };

  // C1122 — same row-0 bug as pi-agent.js's getSpawnSpec(): projectEnvExtras() above
  // injects piDefaultEntry(cfg)'s key, but the C1121 chat-model selector already lists
  // every PI_MODELS row (configForProject() unions them in) — so session.selectedModel
  // can legitimately name a non-default row here. Its own key must win — under its own
  // provider's env var (TPT163), and nothing at all for a keyless row (TPT188).
  // (TPT189) A `custom` row additionally needs its models.json written and Pi pointed at it
  // (PI_CODING_AGENT_DIR + the pinned sessions dir); an empty env for every other row, no disk.
  const piEntry = piEntryFor(session);
  Object.assign(env, piKeyEnvVars(piEntry), preparePiCustomEndpoint(cwd, piEntry, env).env);

  const args = buildPiArgs(session);
  const isFirstTurn = !session.piSessionId;

  // Build the prompt text to write to stdin.
  // Pi has no --append-system-prompt equivalent in JSONL mode, so fold into stdin.
  // buildTurnPrompt() applies the shared resume/fresh/handoff context policy — identical for
  // every provider, see providers/transcript.js. Only the transport differs here.
  const { prompt: basePromptBuilt, mode: promptMode } = buildTurnPrompt(session, {
    includeSystemPrompt: true,
    hasProviderSession: !isFirstTurn,
  });
  let basePrompt = basePromptBuilt;
  if (promptMode === 'handoff') {
    console.log(`[pi] task=${taskId} switching to pi — sending full transcript (${basePrompt.length} chars)`);
  }

  // C1255 — fallback turn-start clock for objective-progress elapsedMs when timing is disabled
  // (session.timingMilestones isn't reset at all in that case, so .turnStart could be stale).
  const turnStartedAt = Date.now();
  const elapsed = () => Date.now() - (session.timingMilestones.turnStart || turnStartedAt);
  if (config.OBJECTIVE_TIMING_ENABLED) {
    session.timingMilestones = {
      msgReceivedAt: session.timingMilestones.msgReceivedAt,
      turnStart: turnStartedAt,
      procSpawnedAt: null,
      firstStdoutAt: null,
      claudeInitAt: null,
      firstChunk: null,
      resultAt: null,
      procCloseAt: null,
      turnEnd: null,
      toolCalls: [],
      spans: null,
      bottleneck: null,
    };
  }

  const proc = spawnFn(launch.command, [...launch.argsPrefix, ...args], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  session.proc = proc;

  if (config.OBJECTIVE_TIMING_ENABLED) {
    session.timingMilestones.procSpawnedAt = Date.now();
  }

  emit({ type: 'objective-progress', stage: 'spawned', elapsedMs: elapsed() });
  console.log(`[pi] Spawn task=${taskId} model=${piModelFor(session)} first=${isFirstTurn} mode=${promptMode}`);

  // Write prompt to stdin (after optional image localization).
  // stdin is the safe delivery path for large prompts under --mode json.
  let resultStats = null;
  (async () => {
    let finalPrompt = basePrompt;
    try {
      finalPrompt = (await localizeAttachments({
        taskId,
        prompt: basePrompt,
        projectRoot: session.projectPath || config.PROJECT_ROOT,
      })).prompt;
    } catch (err) {
      console.warn(`[pi] attachment localize failed task=${taskId}: ${err.message}`);
    }
    if (session.proc !== proc) return; // session replaced during download
    try {
      proc.stdin.write(finalPrompt);
      proc.stdin.end();
    } catch { /* proc may have already exited */ }
  })();

  // Arm both timers at spawn — a process that never writes a byte to stdout must still
  // hit the idle window, not only the (much longer) turn deadline.
  armTurnDeadline(session, taskId, proc, emit);
  armIdleWatchdog(session, taskId, proc, emit);
  let thinkingAnnounced = false;

  // ── stdout JSONL loop ──
  // Pi emits NDJSON (one JSON object per line) with no SSE prefix.
  // No "data: " strip, no stream_event/inner unwrap needed.
  let lineBuffer = '';
  proc.stdout.on('data', (chunk) => {
    if (session.proc !== proc || session._aborted) return;
    armIdleWatchdog(session, taskId, proc, emit);

    const str = chunk.toString();
    session.turnRawSse += str;
    lineBuffer += str;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // keep incomplete trailing line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith('{')) continue;
      let event;
      try { event = JSON.parse(trimmed); } catch { continue; }

      if (event.type === 'session') {
        // First line — capture session UUID for --session resume on follow-up turns.
        if (event.id) {
          session.piSessionId = event.id;
          session._providerSwitchPending = false; // (C1030) handoff consumed — future turns resume normally
          console.log(`[pi] session_id=${event.id} version=${event.version}`);
        }
        if (config.OBJECTIVE_TIMING_ENABLED) {
          session.timingMilestones.claudeInitAt = Date.now();
          if (!session.timingMilestones.firstStdoutAt) {
            session.timingMilestones.firstStdoutAt = Date.now();
          }
        }
        emit({ type: 'objective-progress', stage: 'cli-init', elapsedMs: elapsed() });
        // Re-arm right after the header: from here on the wait is on the provider.
        armIdleWatchdog(session, taskId, proc, emit);

      } else if (
        event.type === 'message_update' &&
        event.assistantMessageEvent &&
        /^thinking_/.test(event.assistantMessageEvent.type || '')
      ) {
        // Reasoning models stream thinking deltas (which keep the idle clock alive) long
        // before any text — announce it once so the turn doesn't look frozen on cli-init.
        if (!thinkingAnnounced) {
          thinkingAnnounced = true;
          emit({ type: 'objective-progress', stage: 'model-thinking', elapsedMs: elapsed() });
        }

      } else if (event.type === 'auto_retry_start') {
        const secs = Math.round((event.delayMs || 0) / 1000);
        const detail = `attempt ${event.attempt || '?'}/${event.maxAttempts || '?'} in ${secs}s: ${String(event.errorMessage || 'request failed').slice(0, 300)}`;
        console.warn(`[pi] auto-retry task=${taskId}: ${detail}`);
        emit({ type: 'objective-progress', stage: 'pi-retry', detail, elapsedMs: elapsed() });

      } else if (event.type === 'auto_retry_end') {
        const detail = event.success ? 'recovered' : `gave up: ${String(event.finalError || 'request failed').slice(0, 300)}`;
        emit({ type: 'objective-progress', stage: 'pi-retry-end', detail, elapsedMs: elapsed() });

      } else if (event.type === 'compaction_start' || event.type === 'compaction_end') {
        emit({ type: 'objective-progress', stage: event.type === 'compaction_start' ? 'pi-compaction' : 'pi-compaction-end', elapsedMs: elapsed() });

      } else if (
        event.type === 'message_update' &&
        event.assistantMessageEvent &&
        event.assistantMessageEvent.type === 'text_delta'
      ) {
        // Streaming text delta
        const text = event.assistantMessageEvent.delta || '';
        if (text) {
          if (config.OBJECTIVE_TIMING_ENABLED && !session.timingMilestones.firstChunk) {
            session.timingMilestones.firstChunk = Date.now();
            if (!session.timingMilestones.firstStdoutAt) {
              session.timingMilestones.firstStdoutAt = Date.now();
            }
          }
          session.turnBuffer += text;
          emit({ type: 'data', data: text });
          // Attempt incremental card extraction on each chunk
          extractCards(session, emit);
        }

      } else if (event.type === 'tool_execution_start') {
        // Tool call start
        const toolName = event.name || '';
        emit({ type: 'objective-progress', stage: 'tool', name: toolName, elapsedMs: elapsed() });
        if (config.OBJECTIVE_TIMING_ENABLED) {
          session.timingMilestones.toolCalls.push({ name: toolName, startAt: Date.now() });
        }

      } else if (event.type === 'tool_execution_end') {
        // Tool call end
        emit({ type: 'objective-progress', stage: 'tool-end', elapsedMs: elapsed() });

      } else if (event.type === 'message_end' || event.type === 'agent_end' || event.type === 'turn_end') {
        // A failed provider request only shows up here (stopReason:"error", exit code 0).
        // With text already streamed the turn is kept; with none it is a hard error.
        const failure = assistantErrorOf(event);
        if (failure && !session.turnBuffer.trim()) {
          console.error(`[pi] provider error task=${taskId}: ${failure.slice(0, 300)}`);
          emitPiError(session, taskId, proc, emit, `pi-error:${failure.slice(0, 120)}`, session._retryAttempt || 0,
            failure.length > 120 ? failure : undefined);
          return;
        }
        if (event.type === 'message_end') continue;
        // Final result event — capture usage for token reporting.
        // Finalize on proc close (not here) to ensure all stdout is processed.
        const usage = (event.message && event.message.usage) || event.stats || event.usage || null;
        if (usage) resultStats = usage;
        if (config.OBJECTIVE_TIMING_ENABLED) {
          session.timingMilestones.resultAt = Date.now();
        }

      } else if (event.type === 'error') {
        const reason = (event.message || event.error || 'pi-error').slice(0, 120);
        console.error(`[pi] error event task=${taskId}: ${reason}`);
        emitPiError(session, taskId, proc, emit, `pi-error:${reason}`, session._retryAttempt || 0);
      }
    }
  });

  // ── stderr — never a hard failure by itself (Pi prints warnings there), but it is the
  // only place startup errors appear: keep a rolling tail for emitPiError() and show each
  // line in the Debug Console. Deliberately does NOT reset the idle clock.
  proc.stderr.on('data', (chunk) => {
    if (session.proc !== proc) return;
    const text = chunk.toString().replace(ANSI_RE, '');
    appendStderrTail(session, text);
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      console.warn(`[pi:stderr] task=${taskId}: ${line.slice(0, 300)}`);
      emit({ type: 'objective-progress', stage: 'pi-stderr', detail: line.slice(0, 300), elapsedMs: elapsed() });
    }
  });

  // ── proc close ──
  proc.on('close', (code) => {
    if (session.proc !== proc) return;
    if (config.OBJECTIVE_TIMING_ENABLED) {
      session.timingMilestones.procCloseAt = Date.now();
    }
    clearPiTimers(session);
    console.log(`[pi] proc closed task=${taskId} code=${code}`);
    if (session._aborted) return;
    // Died without producing any text — surface it instead of finalizing an empty turn.
    if (code && !session.turnBuffer.trim()) {
      emitPiError(session, taskId, proc, emit, `pi-exit:${code}`, session._retryAttempt || 0);
      return;
    }
    finalizePiTurn(session, taskId, code, emit, resultStats);
  });

  proc.on('error', (err) => {
    if (session.proc !== proc) return;
    console.error(`[pi] spawn error task=${taskId}: ${err.message}`);
    emitPiError(session, taskId, proc, emit, 'spawn-error', session._retryAttempt || 0);
  });
}

module.exports = { spawnPiTurn, buildPiArgs, emitPiError, assistantErrorOf };
