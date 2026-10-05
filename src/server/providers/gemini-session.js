'use strict';

// Gemini CLI provider for objective-chat turns.
// Mirrors claude-session.spawnObjectiveTurn frame contract so ws-handlers.js
// stays provider-agnostic: emits the same WS events (objective-progress, data,
// task-cards, objective-result, chat-ready, exit, objective-error).
//
// Flags confirmed via `gemini --help` (Node 22, @google/gemini-cli ≥ 0.6.1):
//   -p / --prompt    Non-interactive headless mode (prompt appended to stdin).
//   -m / --model     Model name (e.g. gemini-2.5-pro).
//   -o / --output-format  stream-json → JSONL events on stdout.
//   -r / --resume    Resume previous session: "latest" or index number.
//
// stream-json event shapes (per empirical test):
//   {type:"init",   session_id:"<uuid>", model:"..."}
//   {type:"message",role:"assistant",content:"...",delta:true}  (streaming chunk)
//   {type:"message",role:"assistant",content:"...",delta:false} (final message)
//   {type:"result", status:"success"|"error", stats:{total_tokens,input_tokens,output_tokens,...}}

const path = require('node:path');
const { spawn: cpSpawn } = require('node:child_process');
const config = require('../config');
const { augmentPathEnv, projectEnvExtras: sharedProjectEnvExtras } = require('../spawn-utils');
const { normalizeProposals } = require('../claude-session');
const { localizeAttachments } = require('../task-agent/attachments');
const throttle = require('../objective-throttle');
const { buildTurnPrompt } = require('./transcript');
const { resolveProviderModel } = require('./registry');

// Prepend the current node binary's bin/ directory to the spawn PATH so that
// the gemini shebang (#!/usr/bin/env node) resolves to the same Node version
// running this server process — avoids "SyntaxError: Unexpected token" when
// the login-shell PATH points to a Node version too old for the gemini bundle.
const NODE_BIN_DIR = path.dirname(process.execPath);

function projectEnvExtras(session) {
  return sharedProjectEnvExtras(session && session.projectPath);
}

// ── Arg builder ──────────────────────────────────────────────────────────────

// Build the CLI argv for a Gemini headless turn.
// NOTE: Adjust these flags when Gemini CLI changes between versions.
function buildGeminiArgs(session) {
  const args = [
    '--output-format', 'stream-json',
    // (C1030) session.selectedModel (chat-model-selector) wins over config.GEMINI_MODEL.
    '--model', resolveProviderModel(session, 'gemini', config),
    '--approval-mode', 'default',
    '--extensions', 'none',
    '--prompt', '',     // placeholder; actual prompt written to stdin (-p still reads stdin)
  ];
  // Resume this chat's recorded session; concurrent chats must never use "latest".
  // If geminiSessionId is set this is a continuation turn, not the first.
  if (session.geminiSessionId) {
    args.push('--resume', session.geminiSessionId);
  }
  return args;
}

// ── Card parser ───────────────────────────────────────────────────────────────

// Extract task-proposal cards from the accumulated turnBuffer.
// Returns { cards, filesAddressed, docUpdates, newTags } or null.
// Mirrors the logic in claude-session.tryEmitTaskCards but emits through emit().
function extractCards(session, emit) {
  const blocks = [...session.turnBuffer.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (blocks.length === 0) return null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const parsed = normalizeProposals(JSON.parse(blocks[i][1]), session._startStatusName, session._proposalContext || { tasks: null });
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
    emitGeminiError(session, taskId, proc, emit, 'turn-deadline', session._retryAttempt || 0);
  }, config.OBJECTIVE_TURN_MAX_MS);
}

function armIdleWatchdog(session, taskId, proc, emit) {
  clearIdleWatchdog(session);
  session._idleWatchdogTimer = setTimeout(() => {
    emitGeminiError(session, taskId, proc, emit, 'stream-idle-timeout', session._retryAttempt || 0);
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

function clearGeminiTimers(session) {
  clearTurnDeadline(session);
  clearIdleWatchdog(session);
}

// ── Error helper ──────────────────────────────────────────────────────────────

function emitGeminiError(session, taskId, proc, emit, reason, attempts) {
  throttle.recordTimeout(taskId, reason);
  clearGeminiTimers(session);
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
  emit({ type: 'objective-error', reason, attempts, provider: 'gemini' }); // C1031 — see claude-session.js emitObjectiveError
}

// ── finalizeGeminiTurn ────────────────────────────────────────────────────────

function finalizeGeminiTurn(session, taskId, code, emit, stats) {
  if (session._resultFinalized) return;
  session._resultFinalized = true;

  clearGeminiTimers(session);

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

  // Build tokens summary from Gemini result stats
  const tokens = stats ? {
    input: stats.input_tokens || stats.input || 0,
    output: stats.output_tokens || 0,
    costUsd: null,       // Gemini CLI doesn't report cost
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

// ── spawnGeminiTurn ───────────────────────────────────────────────────────────

/**
 * Spawn a Gemini CLI headless turn for the given session/task.
 *
 * @param {object}   session  - Session object (same shape as claude-session sessions).
 * @param {string}   taskId   - Task identifier string (for throttle/logging).
 * @param {Function} [emitFn] - Optional emitter fn(frame). When absent, emits directly
 *                              over session.ws so the call signature is identical to
 *                              spawnObjectiveTurn(session, taskId). Pass a capturing fn
 *                              for isolated testing (no WS required).
 */
function spawnGeminiTurn(session, taskId, emitFn) {
  // Torn-down chat (teardownObjectiveSession): never start another turn; free any slot a throttle
  // drain granted this call (C1031 early-return contract).
  if (session._closed) {
    console.log(`[gemini] Spawn skipped for closed session task=${taskId}`);
    throttle.recordAbort(taskId);
    return;
  }
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

  const cwd = session.projectPath || config.PROJECT_ROOT;
  const baseEnv = augmentPathEnv({
    TERM: 'dumb',
    ...projectEnvExtras(session),
  });
  // Prepend the current process's node bin/ dir so gemini's shebang (#!/usr/bin/env node)
  // resolves to this server's Node version, not a potentially-incompatible system node.
  const env = { ...baseEnv, PATH: `${NODE_BIN_DIR}:${baseEnv.PATH}` };
  env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = require('./gemini-config').prepareGeminiSettings(config.USER_DATA_ROOT);
  delete env.API_TOKEN;
  delete env.TIPATASK_API_TOKEN;

  const args = buildGeminiArgs(session);

  // Build the prompt text to write to stdin.
  // Gemini CLI has no --append-system-prompt equivalent, so fold everything into stdin.
  // buildTurnPrompt() applies the shared resume/fresh/handoff context policy — identical for
  // every provider, see providers/transcript.js. Only the transport differs here.
  const isFirstTurn = !session.geminiSessionId;
  const { prompt: basePromptBuilt, mode: promptMode } = buildTurnPrompt(session, {
    includeSystemPrompt: true,
    hasProviderSession: !isFirstTurn,
  });
  let basePrompt = 'Gemini objective planning: read source/KB only and return proposals. No Tipatask MCP or REST tools are available. Ignore MCP tool schemas and coding-task completion instructions in shared context.\n\n' + basePromptBuilt;
  if (promptMode === 'handoff') {
    console.log(`[gemini] task=${taskId} switching to gemini — sending full transcript (${basePrompt.length} chars)`);
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

  const proc = cpSpawn(config.GEMINI_BIN, args, {
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
  console.log(`[gemini] Spawn task=${taskId} model=${resolveProviderModel(session, 'gemini', config)} first=${isFirstTurn} mode=${promptMode}`);

  // Write prompt to stdin (after optional image localization)
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
      console.warn(`[gemini] attachment localize failed task=${taskId}: ${err.message}`);
    }
    if (session.proc !== proc) return; // session replaced during download
    try {
      proc.stdin.write(finalPrompt);
      proc.stdin.end();
    } catch { /* proc may have already exited */ }
  })();

  // Arm turn deadline
  armTurnDeadline(session, taskId, proc, emit);

  // ── stdout JSONL loop ──
  let lineBuffer = '';
  proc.stdout.on('data', (chunk) => {
    if (session.proc !== proc) return;
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

      if (event.type === 'init') {
        // Capture session id for multi-turn --resume
        if (event.session_id) {
          session.geminiSessionId = event.session_id;
          session._providerSwitchPending = false; // (C1030) handoff consumed — future turns resume normally
          console.log(`[gemini] session_id=${event.session_id} model=${event.model}`);
        }
        if (config.OBJECTIVE_TIMING_ENABLED) {
          const now = Date.now();
          session.timingMilestones.claudeInitAt = now;
        }
        emit({ type: 'objective-progress', stage: 'cli-init', elapsedMs: elapsed() });

      } else if (event.type === 'message' && event.role === 'assistant') {
        // Streaming text delta
        const text = event.content || '';
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

      } else if (event.type === 'tool_use') {
        // Tool call start
        const toolName = event.name || event.tool || '';
        emit({ type: 'objective-progress', stage: 'tool', name: toolName, elapsedMs: elapsed() });

      } else if (event.type === 'tool_result') {
        // Tool call end
        emit({ type: 'objective-progress', stage: 'tool-end', elapsedMs: elapsed() });

      } else if (event.type === 'result') {
        // Turn complete — capture stats for token reporting
        resultStats = event.stats || null;
        if (config.OBJECTIVE_TIMING_ENABLED) {
          session.timingMilestones.resultAt = Date.now();
        }

      } else if (event.type === 'error') {
        const reason = (event.message || event.error || 'gemini-error').slice(0, 120);
        console.error(`[gemini] stderr error event task=${taskId}: ${reason}`);
        emitGeminiError(session, taskId, proc, emit, `stderr:${reason}`, session._retryAttempt || 0);
      }
    }
  });

  // ── stderr — log but don't hard-fail (Gemini emits warnings on stderr) ──
  proc.stderr.on('data', (chunk) => {
    if (session.proc !== proc) return;
    const msg = chunk.toString().trim();
    if (msg) console.warn(`[gemini:stderr] task=${taskId}: ${msg.slice(0, 200)}`);
  });

  // ── proc close ──
  proc.on('close', (code) => {
    if (session.proc !== proc) return;
    if (config.OBJECTIVE_TIMING_ENABLED) {
      session.timingMilestones.procCloseAt = Date.now();
    }
    clearGeminiTimers(session);
    console.log(`[gemini] proc closed task=${taskId} code=${code}`);
    if (session._aborted) return;
    finalizeGeminiTurn(session, taskId, code, emit, resultStats);
  });

  proc.on('error', (err) => {
    if (session.proc !== proc) return;
    console.error(`[gemini] spawn error task=${taskId}: ${err.message}`);
    emitGeminiError(session, taskId, proc, emit, `exit-code-spawn-error`, session._retryAttempt || 0);
  });
}

module.exports = { spawnGeminiTurn, buildGeminiArgs };
