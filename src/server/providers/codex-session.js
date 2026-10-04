'use strict';

// Codex emits shared objective-chat WS events. Its JSON output reports completed
// items instead of text deltas, so show progress stages and synthesize the first
// chunk timing milestone on finalization.

const { spawn: cpSpawn } = require('node:child_process');
const config = require('../config');
const { buildCodexEnv, codexEffortArgs, toCodexEffort } = require('../codex-env');
const { normalizeProposals } = require('../claude-session');
const { buildTurnPrompt, buildNudgeMessage } = require('./transcript');
const { localizeAttachments } = require('../task-agent/attachments');
const { shouldTrimContext, trimContext } = require('../context-manager');
const throttle = require('../objective-throttle');
const { toolProfileFor, codexProfileConfigArgs } = require('./tool-profiles');
const { CODEX_TASK_CHAT_FENCE } = require('../task-chat');
const { listProjectMcpServerNames } = require('../../codex-mcp-config');
const taskChatWidgets = require('../task-chat-widgets');

// Codex has no --disallowedTools equivalent — `-s read-only` blocks filesystem/shell
// mutation but NOT MCP tool calls (the project's .codex/config.toml registers the full
// tipatask MCP surface, same as the terminal Codex task agent). This is a prompt-level
// fence only — a determined/confused model could still attempt a write MCP call and get
// whatever error the MCP server itself returns. Documented residual risk (C1029 plan
// Risk 13); mirrors OBJECTIVE_DISALLOWED_TOOLS in claude-session.js.
const CODEX_TOOL_FENCE =
  'You are a read-only PLANNER. Never call create_task, update_task, delete_task, ' +
  'create_task_comment, or create_system_tag — you only propose changes as fenced ```json ' +
  'blocks for a human to review and save. reserve_task_keys is the one exception (it only ' +
  'claims a placeholder id, it never creates/mutates real task content). get_task is allowed ' +
  '(read-only) to load an existing task\'s full description before proposing a modified one.';

const MAX_IMAGE_ATTACH = 8;
const IMAGE_ATTACH_RE = /@(\S+\.(?:png|jpe?g|gif|webp|svg))/gi;

function resolveCodexModel(session) {
  if (!session || session.type === 'specChat') return config.CODEX_MODEL;
  if ((session.providerType || 'claude') !== 'codex') return config.CODEX_MODEL;
  return session.selectedModel || config.CODEX_MODEL;
}

// Pull the local file paths localizeAttachments() already rewrote into the prompt as
// "@<abspath>" refs, so they can ALSO be passed as native `-i` attachments — the prose
// ref alone doesn't guarantee Codex actually looks at the image, native attachment does.
// Image extensions only, by design — C1247's task-attachment localizer (file-attach.js)
// always forces the on-disk extension from the verified Content-Type, so a task_files
// attachment can never spoof an image extension and get swept into -i here.
function extractLocalImagePaths(text, max = MAX_IMAGE_ATTACH) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  IMAGE_ATTACH_RE.lastIndex = 0;
  let m;
  while ((m = IMAGE_ATTACH_RE.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
      if (out.length >= max) break;
    }
  }
  return out;
}

// `otherMcpServers` only matters for a session under a tool profile (task chat): the names of
// every other MCP server in the project's Codex config, which the profile switches off.
function buildCodexArgs(session, { cwd, model, imagePaths, otherMcpServers = [] }) {
  const imgFlags = imagePaths.flatMap(p => ['-i', p]);
  // Headless exec has its own process per turn. These overrides are intentional:
  // effort and the chat tool fence must never become mutable terminal defaults.
  const effortFlags = codexEffortArgs(toCodexEffort(config.OBJECTIVE_EFFORT));
  const profile = toolProfileFor(session, 'codex');
  if (session.codexSessionId) {
    return [
      'exec', 'resume', session.codexSessionId,
      ...effortFlags,
      // `resume` takes no -s; a profiled chat re-states its sandbox as a config override
      // instead of trusting the resumed thread to have kept it.
      ...codexProfileConfigArgs(profile, { resume: true, otherMcpServers }),
      ...(model ? ['-m', model] : []),
      '--json', '--skip-git-repo-check',
      ...imgFlags,
      '-',
    ];
  }
  return [
    'exec',
    ...effortFlags,
    ...codexProfileConfigArgs(profile, { otherMcpServers }),
    ...(model ? ['-m', model] : []),
    '--json', '-s', 'read-only', '--skip-git-repo-check', '-C', cwd,
    ...imgFlags,
    '-',
  ];
}

// ── Card parser (same shape as gemini/pi-session.js) ──────────────────────────

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
    } catch { /* partial JSON mid-stream — retry on next chunk */ }
  }
  return null;
}

// ── Turn deadline + idle watchdog ─────────────────────────────────────────────

function armTurnDeadline(session, taskId, proc, emit) {
  clearTurnDeadline(session);
  session._turnDeadlineTimer = setTimeout(() => {
    emitCodexError(session, taskId, proc, emit, 'turn-deadline', session._retryAttempt || 0);
  }, config.OBJECTIVE_TURN_MAX_MS);
}

// Codex can go quiet between turn.started and the final item.completed for minutes
// (it emits no token deltas) — a longer, Codex-specific idle budget than the
// token-streaming providers share (config.js comment).
function armIdleWatchdog(session, taskId, proc, emit) {
  clearIdleWatchdog(session);
  session._idleWatchdogTimer = setTimeout(() => {
    emitCodexError(session, taskId, proc, emit, 'stream-idle-timeout', session._retryAttempt || 0);
  }, config.OBJECTIVE_CODEX_STREAM_IDLE_MS);
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

function clearCodexTimers(session) {
  clearTurnDeadline(session);
  clearIdleWatchdog(session);
  if (session._workingTicker) {
    clearInterval(session._workingTicker);
    session._workingTicker = null;
  }
}

// ── Error helper ──────────────────────────────────────────────────────────────

function emitCodexError(session, taskId, proc, emit, reason, attempts) {
  throttle.recordTimeout(taskId, reason);
  clearCodexTimers(session);
  session._aborted = true;
  session._spawning = false;
  if (proc && !proc.killed) {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already dead */ }
    }, 3000);
  }
  session.turnBuffer = '';
  session.turnRawSse = '';
  session._resultFinalized = false;
  emit({ type: 'objective-error', reason, attempts, provider: 'codex' }); // C1031 — see claude-session.js emitObjectiveError
}

// ── finalizeCodexTurn ────────────────────────────────────────────────────────

function finalizeCodexTurn(session, taskId, code, emit, usage) {
  if (session._resultFinalized) return;
  session._resultFinalized = true;
  clearCodexTimers(session);

  // Codex never streams a firstChunk — fake it from resultAt (or now) so the
  // model_ttft/streaming spans in the shared timing table never go negative.
  if (config.OBJECTIVE_TIMING_ENABLED && !session.timingMilestones.firstChunk) {
    session.timingMilestones.firstChunk = session.timingMilestones.resultAt || Date.now();
  }

  // A task chat answers in prose: no proposal cards to extract and no "emit JSON" nudge.
  const plainTurn = session.type === 'taskChat';
  const cardResult = plainTurn ? null : extractCards(session, emit);
  if (plainTurn) taskChatWidgets.emitDialogs(session, emit);
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

  // Nudge loop (shared with claude-session.js) — Codex is markedly more likely than
  // Claude to answer with prose/headers instead of a fenced ```json block.
  if (!plainTurn && !cardResult && code === 0 && !session._aborted && (session._nudgeAttempt || 0) < config.OBJECTIVE_MAX_NUDGES) {
    session._nudgeAttempt = (session._nudgeAttempt || 0) + 1;
    session.messages.push({ role: 'assistant', content: session.turnBuffer, timestamp: Date.now() });
    session.messages.push({ role: 'user', content: buildNudgeMessage(session.turnBuffer), timestamp: Date.now() });
    console.log(`[codex:nudge] task=${taskId} attempt=${session._nudgeAttempt}/${config.OBJECTIVE_MAX_NUDGES} — prose-only response, retrying`);
    session._resultFinalized = false;
    session.proc = null;
    const nudgeEpoch = session._epoch || 0;
    setImmediate(() => {
      if ((session._epoch || 0) !== nudgeEpoch) return; // closed or restarted in between
      spawnCodexTurn(session, taskId);
    });
    return;
  }

  if (plainTurn) taskChatWidgets.attachTaskChatWidgets(session, assistantMsg);
  session.messages.push(assistantMsg);

  const tokens = usage ? {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cached_input_tokens || 0,
    cacheCreation: usage.cache_write_input_tokens || 0,
    costUsd: null, // Codex CLI doesn't report cost in --json usage
  } : null;

  const turnIndex = session.messages.filter(m => m.role === 'assistant').length - 1;
  const timingPayload = config.OBJECTIVE_TIMING_ENABLED ? session.timingMilestones : undefined;
  const pendingResult = {
    content: session.turnBuffer,
    tokens,
    filesAddressed: assistantMsg.filesAddressed,
    docUpdates: assistantMsg.docUpdates,
    cards: assistantMsg.cards,
    newTags: assistantMsg.newTags || [],
    objectiveSummary: assistantMsg.objectiveSummary || null, // C1339
    timingMilestones: timingPayload,
    turnIndex,
    code: code ?? 0,
  };

  const wsOpen = session.ws && session.ws.readyState === session.ws.OPEN;
  if (wsOpen) {
    emit({ type: 'objective-result', ...pendingResult, showAiStats: config.SHOW_AI_STATS });
    emit({ type: 'chat-ready', turnIndex });
    emit({ type: 'exit', code: code ?? 0, chatContinues: true, showAiStats: config.SHOW_AI_STATS });
  } else {
    session.pendingResult = pendingResult;
  }

  if (tokens) {
    session.totalTokens.input += tokens.input || 0;
    session.totalTokens.output += tokens.output || 0;
    session.totalTokens.cacheRead = (session.totalTokens.cacheRead || 0) + (tokens.cacheRead || 0);
    session.totalTokens.cacheCreation = (session.totalTokens.cacheCreation || 0) + (tokens.cacheCreation || 0);
  }
  session.turnTokens = tokens;
  session.lastTurnAt = Date.now();
  session._nudgeAttempt = 0;

  if (shouldTrimContext(session)) trimContext(session);

  throttle.recordSuccess(taskId);
  session.proc = null;
  session._resultFinalized = false; // reset for next turn
}

// ── spawnCodexTurn ───────────────────────────────────────────────────────────

/**
 * Spawn a Codex CLI headless turn for the given session/task.
 * Same call signature as spawnObjectiveTurn/spawnGeminiTurn/spawnPiTurn(session, taskId).
 */
function spawnCodexTurn(session, taskId) {
  // Torn-down chat (teardownObjectiveSession): never start another turn; free any slot a throttle
  // drain granted this call (C1031 early-return contract).
  if (session._closed) {
    console.log(`[codex] Spawn skipped for closed session task=${taskId}`);
    throttle.recordAbort(taskId);
    return;
  }
  const turnEpoch = session._epoch || 0;
  const emit = (frame) => {
    if (session.ws && session.ws.readyState === session.ws.OPEN) {
      session.ws.send(JSON.stringify({ ...frame, tabId: session.tabId }));
    }
  };

  // Reset per-turn state
  session.turnBuffer = '';
  session.turnRawSse = '';
  session._lastEmittedCardsJson = null;
  taskChatWidgets.resetTaskChatTurn(session);
  session._resultFinalized = false;
  session._aborted = false;

  const cwd = session.projectPath || config.PROJECT_ROOT;
  const model = resolveCodexModel(session);
  const hasProviderSession = !!session.codexSessionId;

  // Codex has no --append-system-prompt equivalent (like gemini/pi) — the system prompt
  // is folded into stdin on 'fresh'/'handoff' turns by buildTurnPrompt(includeSystemPrompt:true),
  // which applies the same context policy for every provider (providers/transcript.js).
  const { prompt: basePrompt, mode: promptMode } = buildTurnPrompt(session, {
    includeSystemPrompt: true,
    hasProviderSession,
  });
  const fence = toolProfileFor(session, 'codex') ? CODEX_TASK_CHAT_FENCE : CODEX_TOOL_FENCE;
  const withFence = promptMode === 'resume' ? basePrompt : `${fence}\n\n${basePrompt}`;
  if (promptMode === 'handoff') {
    console.log(`[objective:handoff] task=${taskId} switching to codex model=${model} — sending full transcript (${withFence.length} chars)`);
  }

  if (config.OBJECTIVE_TIMING_ENABLED) {
    session.timingMilestones = {
      msgReceivedAt: session.timingMilestones.msgReceivedAt,
      turnStart: Date.now(),
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

  // C1029 Phase 4.3: -i needs local image paths BEFORE spawn, unlike the other providers
  // (which spawn first, write stdin after). Mark _spawning synchronously so in-flight
  // guards (applyModelSelection, chat/revise handlers) see a turn is underway even
  // though session.proc isn't assigned yet.
  session._spawning = true;
  let resultUsage = null;
  (async () => {
    let finalPrompt = withFence;
    try {
      finalPrompt = (await localizeAttachments({
        taskId,
        prompt: withFence,
        projectRoot: session.projectPath || config.PROJECT_ROOT,
      })).prompt;
    } catch (err) {
      console.warn(`[codex] attachment localize failed task=${taskId}: ${err.message}`);
    }
    // Torn down or restarted during the await: teardown (or the restart's own new spawn) now owns
    // _spawning and the throttle slot — touch neither, just never spawn this stale turn.
    if ((session._epoch || 0) !== turnEpoch) return;
    if (session._aborted) { session._spawning = false; return; }
    const imagePaths = extractLocalImagePaths(finalPrompt);

    let env;
    try {
      // Profiled project chats have no task key to stamp into TIPATASK_TASK_ID.
      ({ env } = buildCodexEnv({ projectRoot: session.projectPath || config.PROJECT_ROOT, taskId: session.toolProfile ? session.taskKey : taskId }));
    } catch (err) {
      session._spawning = false;
      console.error(`[codex] env build failed task=${taskId}: ${err.message}`);
      emitCodexError(session, taskId, null, emit, `spawn-error:${err.message}`, session._retryAttempt || 0);
      return;
    }

    // Read after buildCodexEnv(): it has just refreshed the project's .codex/config.toml.
    const otherMcpServers = toolProfileFor(session, 'codex') ? listProjectMcpServerNames(cwd) : [];
    const args = buildCodexArgs(session, { cwd, model, imagePaths, otherMcpServers });
    const proc = cpSpawn(config.CODEX_BIN, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    session.proc = proc;
    session._spawning = false;

    if (config.OBJECTIVE_TIMING_ENABLED) session.timingMilestones.procSpawnedAt = Date.now();
    emit({ type: 'objective-progress', stage: 'spawned' });
    console.log(`[codex] Spawn task=${taskId} model=${model || '(default)'} first=${!hasProviderSession} images=${imagePaths.length} mode=exec reason=per-turn-effort-and-tool-policy`);

    try {
      proc.stdin.write(finalPrompt);
      proc.stdin.end();
    } catch { /* proc may have already exited */ }

    armTurnDeadline(session, taskId, proc, emit);
    armIdleWatchdog(session, taskId, proc, emit);

    // Codex streams no text/thinking deltas, so without this the chat bubble sits
    // silent for the entire turn. Purely cosmetic — cleared alongside the other timers.
    const turnStartedAt = Date.now();
    session._workingTicker = setInterval(() => {
      if (session.proc !== proc) return;
      emit({ type: 'objective-progress', stage: 'working', elapsedMs: Date.now() - turnStartedAt });
    }, 5000);

    // ── stdout JSONL loop ──
    let lineBuffer = '';
    proc.stdout.on('data', (chunk) => {
      if (session.proc !== proc) return;
      armIdleWatchdog(session, taskId, proc, emit); // any byte resets the idle clock

      const str = chunk.toString();
      session.turnRawSse += str;
      lineBuffer += str;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) continue;
        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }

        if (event.type === 'thread.started') {
          if (event.thread_id) {
            session.codexSessionId = event.thread_id;
            session._providerSwitchPending = false; // handoff consumed — future turns resume normally
            console.log(`[codex] thread_id=${event.thread_id}`);
          }
          if (config.OBJECTIVE_TIMING_ENABLED) {
            session.timingMilestones.claudeInitAt = Date.now();
            if (!session.timingMilestones.firstStdoutAt) session.timingMilestones.firstStdoutAt = Date.now();
          }
          emit({ type: 'objective-progress', stage: 'cli-init' });

        } else if (event.type === 'turn.started') {
          emit({ type: 'objective-progress', stage: 'model-thinking' });

        } else if (event.type === 'item.started') {
          // Only a task chat draws tool widgets; every other chat waits for item.completed.
          const item = event.item || {};
          if (session.type === 'taskChat' && item.type === 'mcp_tool_call') {
            taskChatWidgets.toolStarted(session, emit, { id: item.id, server: item.server, tool: item.tool, input: item.arguments });
          }

        } else if (event.type === 'item.completed') {
          const item = event.item || {};
          if (item.type === 'agent_message' && typeof item.text === 'string') {
            if (config.OBJECTIVE_TIMING_ENABLED && !session.timingMilestones.firstChunk) {
              session.timingMilestones.firstChunk = Date.now();
              if (!session.timingMilestones.firstStdoutAt) session.timingMilestones.firstStdoutAt = Date.now();
            }
            session.turnBuffer += item.text;
            emit({ type: 'data', data: item.text });
            if (session.type === 'taskChat') taskChatWidgets.emitDialogs(session, emit);
            else extractCards(session, emit);
          } else {
            // Reasoning/tool/command items — Codex's only pre-answer signal (no deltas).
            if (config.OBJECTIVE_TIMING_ENABLED && !session.timingMilestones.firstChunk) {
              session.timingMilestones.firstChunk = Date.now();
            }
            emit({ type: 'objective-progress', stage: 'tool', name: item.type || 'tool' });
            if (session.type === 'taskChat' && item.type === 'mcp_tool_call') {
              taskChatWidgets.toolFinished(session, emit, {
                id: item.id,
                server: item.server,
                tool: item.tool,
                input: item.arguments,
                isError: item.status === 'failed' || !!item.error,
                result: item.error || item.result,
              });
            }
          }

        } else if (event.type === 'turn.completed') {
          resultUsage = event.usage || null;
          if (config.OBJECTIVE_TIMING_ENABLED) session.timingMilestones.resultAt = Date.now();

        } else if (event.type === 'turn.failed' || event.type === 'error') {
          const reason = (event.message || (event.error && event.error.message) || event.error || 'codex-error');
          console.error(`[codex] error event task=${taskId}: ${String(reason).slice(0, 200)}`);
          emitCodexError(session, taskId, proc, emit, `codex:${String(reason).slice(0, 120)}`, session._retryAttempt || 0);
        }
        // unknown event types ignored — forward-compat with codex-cli version bumps
      }
    });

    proc.stderr.on('data', (chunk) => {
      if (session.proc !== proc) return;
      const msg = chunk.toString().trim();
      if (msg) console.warn(`[codex:stderr] task=${taskId}: ${msg.slice(0, 200)}`);
    });

    proc.on('close', (closeCode) => {
      if (session.proc !== proc) return;
      if (config.OBJECTIVE_TIMING_ENABLED) session.timingMilestones.procCloseAt = Date.now();
      clearCodexTimers(session);
      console.log(`[codex] proc closed task=${taskId} code=${closeCode}`);
      if (session._aborted) return;
      finalizeCodexTurn(session, taskId, closeCode, emit, resultUsage);
    });

    proc.on('error', (err) => {
      if (session.proc !== proc) return;
      console.error(`[codex] spawn error task=${taskId}: ${err.message}`);
      emitCodexError(session, taskId, proc, emit, 'exit-code-spawn-error', session._retryAttempt || 0);
    });
  })();
}

module.exports = { spawnCodexTurn, resolveCodexModel, buildCodexArgs, extractLocalImagePaths };
