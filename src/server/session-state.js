'use strict';

const config = require('./config');
const { getTaskAgentInfo, resolveTaskAgentId } = require('./task-agent');

// C1131 — projectPath, when known at connect time, resolves the session's initial
// taskAgent against that PROJECT's config.json (LAST_AGENT/TASK_AGENT) instead of the
// server-global config.TASK_AGENT startup snapshot. session.taskAgent is always truthy
// from here on (never '' /null), so downstream `session.taskAgent || config.TASK_AGENT`
// reads elsewhere already resolve correctly without needing their own project lookup —
// this is the single place that decides the default. An explicit WS ?agent= param
// (ws-handlers.js, right after createSession()) still overrides it.
function createSession(ws, pending, tabId, projectPath) {
  const taskAgent = getTaskAgentInfo(resolveTaskAgentId(projectPath, null));
  return {
    tabId: tabId || null,
    startedAt: Date.now(), // stable across reattachments; server clock, epoch milliseconds
    pty: null,
    ptyPid: null,             // (C1565) pty leader pid == pgid (forkpty implies setsid) —
                               // stashed separately because terminateTerminalSession() nulls
                               // session.pty before the group-kill needs the pid
    descendantWatchdog: null, // Per-run count/RSS/pressure streaks, timestamps, policy identity,
                               // action latches and resume baseline; set at spawn, cleared on exit.
                               // See process-group.js evaluateRunaway().
    _pause: null,             // { at, reason, count, threshold, rssMb, limitMb, text, targets }
                               // while the watchdog holds the tree SIGSTOPped — see
                               // terminal-session.js pauseRunawaySession()/resumeRunawaySession()
    proc: null,
    type: 'terminal',
    buffer: '',
    alive: false,
    // (C1444) true from spawnTerminal() entry until pty.spawn sets alive=true — GET
    // /api/sessions must report this window as active, not exited (see ws-handlers.js
    // sessionListBucket()). spawnTerminal() awaits several remote round-trips (KB pull,
    // task comments, status/VCS settings) before pty.spawn, so this window can run seconds.
    _queued: false,     // (TPT444) parked in the task-session start queue (session-queue.js)
    _launching: false,  // (TPT444) admitted by the queue, spawn preparation in flight — counts as running
    _starting: false,
    cols: 0,
    rows: 0,
    ws,
    pending,
    _terminated: false,
    lastOutputAt: Date.now(),
    _terminalOutputSeen: false,
    _attentionBroadcasted: false,
    _attentionLastBroadcast: null, // (C1057) { kind, promptText } most recently sent on the wire — dedup + connect-replay source
    _attentionLineCarry: '',       // (C1057) cross-chunk partial-line buffer for carveAttentionLines()
    _attentionOscOpen: false,      // (C1060) OSC string left open at end of chunk, for stripOscChunk()
    _attentionState: null,         // (C1057) { kind, promptText, agent, at } | null — the real-time pattern-match signal
    _attentionRow: 1,              // (C1066) tracked cursor row for screen-reflow.js's reflowChunk()
    _attentionCol: 1,              // (C1066) tracked cursor column for screen-reflow.js's reflowChunk()
    _attentionRowCarry: '',        // (C1066) cross-chunk partial-line buffer for carveReflowLines()
    _lastAttentionKind: null,      // (C1120) line-scoped _attentionState.kind seen on the PREVIOUS onData chunk
    _lastTailDialogKind: null,     // (C1120) tail-scoped getAttentionPromptMatch() gate kind seen on the PREVIOUS chunk
    _injectDone: false,            // (C1386) mirrors spawnTerminal()'s injectDone closure var — gates shouldHoldAttention() and index.js's stale-latch sweep, both outside that closure
    _bgAgentsBusyAt: null,         // (TPT348) ms timestamp of the last "Waiting for N background agents" / agents-panel sighting (Claude), null once superseded — read via terminal-session.js's bgAgentsBusy(), gates the quiet-screen attention raisers
    codexPlanReady: false,
    agentPlanReady: false,
    onAttentionNeeded: null,
    onAttentionCleared: null,
    onSessionExit: null,
    _commentBaselineId: null,      // (TPT354) highest task-comment id at spawn — onSessionExit's "did the agent post its own report" watermark; null = unknown
    _transcriptHint: null,         // (TPT354) { cwd, spawnedAt, taskId, agentSessionId, env } — locates this run's agent transcript (task-agent/final-message.js)
    taskAgent: taskAgent.id,
    taskAgentLabel: taskAgent.label,
    taskAgentModel: '',       // (C1118) resolved --model value from the last spawnTerminal(), for the terminal header caption
    terminalPhase: 'planning',
    planApprovalCommand: taskAgent.approvalCommand,
    _userInteracted: false,
    _localCommandBuffer: '',
    _interceptingApprovalCommand: false,
    // Per-project scoping (Electron multi-window)
    projectPath: '',
    // Task chat fields (taskChat / projectChat)
    taskKey: null,            // bare task key for task chats; null for project chats
    chatProjectId: null,      // API project id for a project chat; never taken from a Start payload
    _projectChatStarting: false, // Start is fetching context; reconnect must retain this session
    toolProfile: null,        // providers/tool-profiles.js profile name; null = the provider's objective (read-only planner) fence
    pendingResult: null,      // turn result finished while no client was attached — flushed on reconnect
    _taskChatTurn: null,      // the running turn's dialogs/tools/task events (task-chat-widgets.js); reset per turn
    onTaskChatMutation: null, // set by ws-handlers.js at start-task-chat: a create/update tool call succeeded
    onNativeSession: null,    // set by ws-handlers.js for task/project chats: a provider emitted its session id or finished a turn (chat-history index)
    _resumedHistory: null,    // { historyId, provider, nativeSessionId, transcriptUnavailable } when the chat continues a native session from the history index
    _historySearchPrior: null, // { keywords, first, latest } of the resumed entry, folded into each later history record
    _historyIds: null,        // { '<provider>:<native id>': historyId } — one index entry per provider context of this chat
    pendingTaskEdits: null,   // Map taskKey -> { task, changed, prev }: tasks the user edited by hand, told to the agent with the next user turn
    _drainedTaskEdits: null,  // the edits the running turn's user message carried — put back if that turn is aborted
    // Multi-turn objective fields
    claudeSessionId: null,
    geminiSessionId: null,
    piSessionId: null,
    codexSessionId: null,     // (C1029)
    providerType: config.OBJECTIVE_PROVIDER,  // 'claude' | 'gemini' | 'pi' | 'codex' — initial value only;
                                               // changeable per turn via the chat-model-selector (C1029), see
                                               // providers/dispatch.js applyModelSelection(). specChat sessions
                                               // never read a selection and stay on this initial provider.
    selectedModel: null,      // (C1029) user-picked model for providerType; null = that provider's config default
    _providerSwitchPending: false,  // (C1029) set by applyModelSelection on a provider change; consumed by
                                     // providers/transcript.js buildTurnPrompt() to send a handoff transcript
                                     // on the next turn instead of --resume-ing a session id that no longer exists
    _spawning: false,         // (C1029) true between "decided to spawn" and "proc assigned to session.proc" —
                               // codex needs an async image-localize step before spawn; guards in-flight checks
                               // (applyModelSelection, chat/revise handlers) against a race in that window
    systemPrompt: null,
    messages: [],
    turnBuffer: '',
    turnRawSse: '',
    _lastEmittedCardsJson: null,
    _lastEmittedSpecJson: null,
    _aborted: false,
    _closed: false,         // set by teardownObjectiveSession(): no turn/heartbeat/prewarm may spawn again
    _epoch: 0,              // bumped by every teardown; async continuations captured earlier bail out
    _detachTimer: null,     // ws closed mid-turn: grace window for a reattach before teardown
    _helperProcs: null,     // Set of one-shot Haiku helper procs (compression, efficiency) killed on teardown
    turnTokens: null,
    totalTokens: { input: 0, output: 0, costUsd: 0, cacheCreation: 0, cacheRead: 0 },
    lastTurnAt: 0,
    _heartbeatTimer: null,
    _heartbeatProc: null,    // cache-keepalive child, tracked so sleep/teardown can kill it
    _heartbeatKillTimer: null,
    _heartbeatSleepBlocked: false, // wake cleanup blocks re-arm until the next real turn
    _heartbeatDueAt: 0,    // wall-clock ms the armed heartbeat should fire (drift gate)
    _lastCacheTouchAt: 0,  // wall-clock ms of the last real turn or successful ping (cache TTL gate)
    _heartbeatPings: 0,    // consecutive pings since the last real turn (OBJECTIVE_HEARTBEAT_MAX_PINGS cap)
    _resultFinalized: false,
    timingMilestones: {
      msgReceivedAt: null,  // WS start/chat/revise parsed
      turnStart: null,      // spawnObjectiveTurn entry
      procSpawnedAt: null,  // cpSpawn returned
      firstStdoutAt: null,  // first proc stdout chunk
      claudeInitAt: null,   // init event session_id captured
      firstChunk: null,     // first text_delta
      resultAt: null,       // result event captured
      procCloseAt: null,    // proc close fired
      turnEnd: null,        // finalizeCloseTurn done
      toolCalls: [],
      spans: null,          // computed on turnEnd: { stage -> ms }
      bottleneck: null,     // { stage, durationMs }
    },
    abortController: new AbortController(),
    tagArchCache: new Map(), // Map<tagName, { content: string, fetchedAt: number, mtimeMs: number }>
    _cachedTagsSerialized: new Set(),
    // Cache observability (C455)
    _priorSystemPrompt: null,  // session.systemPrompt as of prior spawn — for prefix-stability check
    _priorCacheRead: 0,        // cumulative cache_read after prior turn
    _cacheTrail: [],           // last 10 per-turn cache snapshots { turnIdx, sysPromptSha, sysPromptChars, prefixMatch, cacheRead, cacheWrite, cacheReadDelta, hitPct }
    _profileTrail: [],         // last 100 per-turn prompt-size snapshots { turn, staticSize, historySize, tagsSize, totalSize, model_ttft, ts } (C495)
    // Response cache (C481)
    _objectiveCacheKey: null,      // SHA-256 key used for this session's first-turn cache lookup
    _objectiveCacheTaskId: null,   // taskId at lookup time; guards against stale writes after task switch
    // Sliding-window history compression (C493)
    compressedSummaries: [],       // [{ turn: N, summary: "..." }] for demoted turn-pairs
    compressedThrough: 0,          // highest turn-pair index already in compressedSummaries
    pendingCompression: null,      // in-flight Promise from summarizeOldTurns (prevents double-fire)
  };
}

// Headless agent-chat sessions (one CLI process per turn, no pty). Everything else is a
// terminal session. The id prefixes are how a chat is recognised before its `start-*` message
// has set session.type — a promptless connect, the pre-spawn lifecycle wiring, GET /api/sessions.
const AGENT_CHAT_TYPES = Object.freeze(['objective', 'specChat', 'taskChat']);
const AGENT_CHAT_ID_PREFIXES = Object.freeze(['obj-', 'specChat:', 'taskChat:', 'projectChat:']);

function isAgentChatType(type) {
  return AGENT_CHAT_TYPES.includes(type);
}

function isAgentChatId(id) {
  return typeof id === 'string' && AGENT_CHAT_ID_PREFIXES.some(prefix => id.startsWith(prefix));
}

module.exports = { createSession, isAgentChatType, isAgentChatId, AGENT_CHAT_TYPES, AGENT_CHAT_ID_PREFIXES };
