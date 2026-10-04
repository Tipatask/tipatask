'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn: spawnChild } = require('node:child_process');
const config = require('./config');
const { readLastExitSince, readLostSessions, forgetLostSession } = require('./last-exit');
const { applyRehashIntent, spawnObjectiveTurn, killObjectiveProc, escalateKill, clearRetryTimers, clearTurnDeadline, prewarmObjective, killPrewarm, teardownObjectiveSession, trackHelperProc, clearHeartbeat, prewarmObjectiveCold, killColdPrewarm, startSleepWatchdog, objectiveCacheActivity, ensureSessionStartName, computeTurnSpans } = require('./claude-session');
const { spawnTurn, providerSessionId, clearProviderSessionId, applyModelSelection } = require('./providers/dispatch');
const { listObjectiveProviders, listVisibleObjectiveProviders, clampSelectionToProviders, formatSelection, currentSelection, configForProject } = require('./providers/registry');
const { createSession, isAgentChatType, isAgentChatId } = require('./session-state');
const { TASK_CHAT, isTaskChatId, taskKeyFromChatId, isProjectChatId, projectIdFromChatId, buildProjectChatTitle, buildTaskChatSeed, buildTaskChatSystemPrompt } = require('./task-chat');
const { providerSupportsProfile } = require('./providers/tool-profiles');
const { findOpenDialog, resolveDialogAnswer, replayTaskChatTurn, taskFrame, changedTaskFields, buildTaskEditNote } = require('./task-chat-widgets');
const { killProcessGroup, resolveAgentLimits } = require('./process-group');
const { createSessionQueue } = require('./session-queue');
const { emitTerminalState, handleTerminalInput, spawnTerminal, approvePlan, sanitizeReplayBuffer, buildTerminalExitFrame, injectPastedImage, forceResumeRepaint, requiresExplicitPlanReadyPattern, planReadyMinBufferLength, codexPlanReadyIsFresh, killPausedTargets, resumeRunawaySession, pausedSummary } = require('./terminal-session');
const { buildExitResolutionComment, hasSelfAuthoredResolution, waitForFinalMessage, selectFinalMessage } = require('./exit-resolution');
const { getTaskAgentInfo, getTaskAgentLabels, getAvailableAgents, getAvailableAgentsPeek, listTaskAgentStatuses, listTaskAgentStatusesPeek, refreshAgentDetection, resolveTaskAgentId, listAgentModels, listAllAgentModels } = require('./task-agent');
const { isModelAllowed } = require('./task-agent/model-registry');
const { getAgentQuotaStatus, getTaskAgent } = require('./task-agent');
const { ensureArchitectureDocsForChanges } = require('./architecture-docs');
const { clearContext, resetTurnBuffers } = require('./context-manager');
const { highestActiveCodingPriority } = require('./sprint-assign');
const { maxNumbersByPrefix, resolveCodingPrefix, isValidTaskKey } = require('./task-key-format');
const { readChatDraft, writeChatDraft, deleteChatDraft, readChatState, writeChatState, deleteChatState } = require('./chat-persistence');
const { readProjectConfig, readVoiceSettings, buildLanguageDirective, piEntryForModel, recordLastUsedAgent, readPiEntries, buildAgentsConfigPatch, summarizeAgents, PI_PROVIDERS, piProviderEnv, piKeyEnvVars } = require('./project-config');
const { augmentPathEnv, projectEnvExtras, resolveNvmBinDir, resolvePiLaunch } = require('./spawn-utils');
const { transcribeWithAssemblyAI, ASSEMBLYAI_ERRORS, MAX_AUDIO_BYTES: ASSEMBLYAI_MAX_AUDIO_BYTES } = require('./assemblyai-batch');
const { int16BufferToFloat32 } = require('./voice-stream/local-provider');
const { getApiCredentials } = require('./api-credentials');
const { fireSessionSync, pullArchitectureDocs, syncOnSessionStart, pushArchitectureDocs, pushAll } = require('../cli/knowledge-sync');
const { buildHistoryWindow, buildHistoryChunk, OBJECTIVE_HISTORY_PAGE_MESSAGES } = require('./objective-history');
const websocket = require('./websocket');
const throttle = require('./objective-throttle');
const { request: httpRequest } = require('../cli/http');
const { getStaticBundle, getStaticBundleStats, prefetchObjectiveWorkflow } = require('./static-context');
const { prewarmArchCache } = require('./arch-cache-prewarm');
const taskCache = require('../mcp/task-cache');
const archCache = require('../mcp/architecture-cache');
const objectiveResponseCache = require('./objective-response-cache');
const { summarizeOldTurns } = require('./objective-summarizer');
const { postPlanComments } = require('./plan-comment');
const { forcePendingProposalStatuses, forcePendingTodoPayloadNewTasks } = require('./objective-proposal-status');
const { promoteSplitOriginInTodo } = require('./split-origin-save');
const { classifySaveError } = require('./todo-save-error');
const { applyReopenToPatch } = require('./reopen-closed-task');
const { fetchStatusContext } = require('./status-roles');
const { VOICE_MODEL_IDS, VOICE_MODEL_ERRORS, listVoiceModels, getVoiceModelStatus, downloadVoiceModel, abortVoiceModelDownload, deleteVoiceModel } = require('./voice-model-manager');
const { contentSecurityPolicy } = require('./content-security-policy');
const { decodeRequestComponent, wrapHttpHandler } = require('./http-request-boundary');

// One process-level watchdog observes the one production sessions Map. The source is assigned
// when HTTP/WS handlers receive that Map; starting here keeps duplicate handlers from creating
// duplicate intervals.
let sleepWatchdogSessions = null;
startSleepWatchdog(() => sleepWatchdogSessions);

// (TPT444) Device-wide FIFO start queue for task terminal sessions (session-queue.js). The
// limits come from resolveAgentLimits(): a hardware-derived cap, optionally lowered per project.
const sessionQueue = createSessionQueue({
  getSessions: () => sleepWatchdogSessions,
  defaultProject: config.PROJECT_ROOT,
  resolveLimits: (projectPath) => resolveAgentLimits(projectPath),
  onChange: (projectPath, snapshot) => {
    websocket.emitSessionQueueState(projectPath, snapshot);
    for (const session of sleepWatchdogSessions?.values() || []) {
      if (session._queued && session.projectPath === projectPath) {
        _sendIfOpen(session.ws, queuedSessionFrame(session, session.tabId, snapshot));
      }
    }
  },
});

// Safe to call from anywhere a slot may have freed (task completed, pty exited, session
// terminated, failed start, watchdog tick); never throws.
function drainSessionQueue() {
  try { sessionQueue.drain(); } catch (err) { console.warn(`[session-queue] drain failed: ${err.message}`); }
}

function _sendIfOpen(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(payload)); } catch { /* socket went away */ }
  }
}

function queuedSessionFrame(session, taskId, snapshot) {
  const row = snapshot.queued.find(entry => entry.taskId === taskId);
  return { type: 'session-queued', tabId: session.tabId, taskId,
    position: row?.position ?? null, running: snapshot.running, cap: snapshot.cap,
    reason: 'device-cap', ...row };
}

// A queued session has no wireClient() yet; this is its minimal socket handling: a Stop/kill
// cancels the queue entry, a close just detaches (a headless Play All start closes on purpose).
function announceQueuedClient(ws, session, taskId, sessionKey, sessions, backend) {
  detachQueuedClient(session);
  if (!ws) return;
  session.ws = ws;
  const snap = sessionQueue.snapshot(session.projectPath);
  _sendIfOpen(ws, queuedSessionFrame(session, taskId, snap));
  const onMessage = (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'kill' || msg.type === 'terminate' || msg.type === 'stop') {
      terminateTerminalSession(session, taskId, sessionKey, sessions, 'terminated', { ackWs: ws, backend });
    }
  };
  const onClose = () => { if (session.ws === ws) session.ws = null; };
  ws.on('message', onMessage);
  ws.on('close', onClose);
  session._queuedClient = { ws, onMessage, onClose };
}

function detachQueuedClient(session) {
  const c = session && session._queuedClient;
  if (!c) return;
  session._queuedClient = null;
  try { c.ws.off('message', c.onMessage); c.ws.off('close', c.onClose); } catch { /* no-op */ }
}

async function _fetchTaskTags(backend, taskId) {
  try {
    const task = await backend.getTask(taskId);
    return (task?.tags || []).filter(t => t.startsWith('tt-'));
  } catch {
    return [];
  }
}

async function _syncAgentAssignee(backend, taskId, agent) {
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'pi') return;
  try {
    const current = await backend.getTask(taskId);
    if (!current || current.agentAssignee === agent) return;
    const updated = await backend.updateTask(taskId, { agentAssignee: agent });
    if (updated) websocket.emitTaskUpdated(updated, { agentAssigneeChanged: true });
  } catch (err) {
    console.error(`[ws] agentAssignee sync failed for ${taskId}:`, err.message);
  }
}

// C1408 — start-time assignee gate. `obj-*`/`specChat:`/`taskChat:` ids are chat sessions,
// never PTY task spawns, and are excluded from both helpers the same way the old inline guard
// skipped them (it only ran when opts.backend was present, which chat spawns never pass).
function _isRealTaskKey(taskId) {
  return !!taskId && !isAgentChatId(taskId);
}

// (C1444) GET /api/sessions bucketing. spawnTerminal() (terminal-session.js) awaits
// several remote round-trips (KB pull, task comments, status/VCS settings) before
// pty.spawn() flips `alive` — a plain `s.alive ? active : (s.pending ? neither : exited)`
// misreports that whole window as exited. The client's mergeSessionsSnapshot()
// (attention-state.js) wholesale-replaces state.activeSessions from this list, so a
// refetch mid-spawn used to demote the just-started session out of activeSessions and
// drop its left-nav row until the next refetch saw it alive. `_starting` closes the gap.
function sessionListBucket(s) {
  if (!s) return null;
  if (s._queued) return 'queued'; // (TPT444) parked in the start queue — not live, not exited
  if (s.alive || s._starting || s._launching) return 'active';
  if (s.pending) return null; // created, waiting for a `start` message — neither live nor exited
  return 'exited';
}

// A naturally exited terminal remains in the session map with its bounded PTY buffer. Reopen
// that exact session without a prompt so a completion banner cannot start a second agent run.
function replayExitedTerminal(ws, session) {
  const reset = '\x1b[!p\x1b[?1049l\x1b[2J\x1b[H';
  const buffer = sanitizeReplayBuffer(session.buffer || '');
  ws.send(JSON.stringify({ type: 'data', tabId: session.tabId, data: reset + buffer }));
  ws.send(JSON.stringify(buildTerminalExitFrame(session, session.exitCode ?? null, [])));
}

// (C1144/TPT413) One GET /api/sessions `sessionMeta` row. `agent` is read LIVE off the session
// object every time — never a cached launch value. session.taskAgent is mutable: seeded by
// createSession() (project default), overridden by the validated WS ?agent= param at connect
// (handleConnection, together with taskAgentLabel/planApprovalCommand), and rewritten by
// spawnTerminal() after pty.spawn from the agent that actually launched. The left-nav
// active-sessions row icon (task-board.js syncActiveSessionsNav()) is painted from this field.
function sessionMetaRow(s) {
  return { agent: s.taskAgent || null, label: s.taskAgentLabel || '', type: s.type || 'terminal', alive: !!s.alive,
    paused: pausedSummary(s),
    ...(s.startedAt ? { startedAt: s.startedAt } : {}),
    // (TPT469) A project chat is listed in the left menu once it has a title — its first user
    // message. Untitled ones are drafts the next Start Chat reuses.
    ...(s.chatProjectId ? { chatProjectId: s.chatProjectId, title: s.chatTitle || '' } : {}) };
}

// Blocks starting a task assigned to someone else. Replaces the guard that used to sit
// inline at the top of spawnTerminal() (terminal-session.js) — moved here so both spawn
// call sites can pass the task row they already fetched instead of paying a second,
// uncached GET /tasks/:key (api-backend.js's getTask() has no cache). `task` may be the
// caller's already-fetched row (possibly null if that fetch failed) — a null triggers one
// re-fetch here so a cosmetic failure upstream can't silently skip the whole gate.
// Returns the resolved current-user id (or null) so callers don't look it up twice.
// Fails OPEN on any unknown quantity (task fetch error, unresolved user id) — a transient
// /auth/me blip must never lock the owner out of their own tasks.
async function assertTaskStartable(backend, taskId, task) {
  if (!backend || !_isRealTaskKey(taskId) || typeof backend.getCurrentUserId !== 'function') {
    return null;
  }
  let me = null;
  try { me = await backend.getCurrentUserId(); } catch { /* fall through — fail open */ }
  let _task = task;
  if (!_task && typeof backend.getTask === 'function') {
    try { _task = await backend.getTask(taskId); } catch { /* fall through — fail open */ }
  }
  if (_task && _task.assignee != null && me != null && Number(_task.assignee) !== Number(me)) {
    throw Object.assign(new Error('TASK_ASSIGNED_TO_OTHER_MEMBER'), { code: 'EASSIGNEE' });
  }
  return me;
}

// Claims an unassigned task for the starting user before spawn. No-op for an already
// -assigned task (assertTaskStartable already vetted it) or a chat session id. Unlike the
// guard above, this fails CLOSED: the task must show a durable, API-confirmed assignee
// before the terminal is allowed to spawn — a claim that only lands in api-backend's
// offline mutation queue (`_pendingSync: true`) is not good enough, so the start is
// canceled rather than silently proceeding unassigned.
async function claimUnassignedTaskOnStart(backend, taskId, task, me, projectPath) {
  if (!backend || !_isRealTaskKey(taskId) || !task || task.assignee != null) return task;
  if (me == null) {
    throw Object.assign(new Error('CANNOT_CLAIM_UNKNOWN_USER'), { code: 'ECLAIM' });
  }
  let updated = null;
  try {
    updated = await backend.updateTask(taskId, { assignee: me });
  } catch (err) {
    throw Object.assign(new Error(`Failed to assign task before start: ${err.message}`), { code: 'ECLAIM' });
  }
  if (!updated || updated._pendingSync || Number(updated.assignee) !== Number(me)) {
    throw Object.assign(new Error('Assignee claim did not persist'), { code: 'ECLAIM' });
  }
  websocket.emitTaskUpdated(updated, { assigneeChanged: true }, projectPath);
  return updated;
}

// C1131 — persists the agent+model a CODING task just successfully spawned with as the
// project's implicit next default. Sibling to _syncAgentAssignee() above: same
// post-spawn-success placement (after spawnTerminal() resolves, never inside
// getSpawnSpec() — that runs before pty.spawn, so a failed launch must not persist), same
// "only real terminal task sessions" shape. session.taskAgent/taskAgentModel are set by
// spawnTerminal() (terminal-session.js) right before pty.spawn succeeds. Synchronous and
// swallows its own errors (recordLastUsedAgent never throws) — never awaited by callers.
function _recordLastUsedAgent(session) {
  if (!session || isAgentChatType(session.type)) return;
  recordLastUsedAgent(session.projectPath || config.PROJECT_ROOT, session.taskAgent, session.taskAgentModel);
}

// C1124 — {claude,codex,pi} → display label, for summarizeAgents()'s browser-mode
// GET /api/agents-config response. getTaskAgentInfo() only constructs the agent class (no
// spawnSync probe), so this is cheap; memoized once since labels never change at runtime.
let _agentLabelsCache = null;
function _agentLabels() {
  if (_agentLabelsCache) return _agentLabelsCache;
  _agentLabelsCache = getTaskAgentLabels();
  return _agentLabelsCache;
}

// TPT190 — Pi's `--list-models` command prints a fixed-width table rather than JSON. It also
// ignores `--provider` for the listing itself and prints every authenticated provider, so the
// parser MUST enforce the requested provider. Without this filter an unknown provider query can
// return OpenRouter's full catalog even though Pi exits 0.
const PI_MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
const PI_MODEL_LIST_TIMEOUT_MS = 5_000;
const PI_MODEL_LIST_MAX_BYTES = 1024 * 1024;
const _piModelCache = new Map();

// Limits apply to the complete HTTP body, including JSON/base64 or multipart framing.
// The image and audio envelopes leave room above the API's 10 MiB decoded image and
// 25 MiB multipart audio limits; generic JSON and persisted chat have separate budgets.
const JSON_BODY_MAX_BYTES = 2 * 1024 * 1024;
const BULK_BODY_MAX_BYTES = 32 * 1024 * 1024;
const CHAT_BODY_MAX_BYTES = 32 * 1024 * 1024;
const IMAGE_BODY_MAX_BYTES = 15 * 1024 * 1024;
const MULTIPART_AUDIO_MAX_BYTES = ASSEMBLYAI_MAX_AUDIO_BYTES + 1024 * 1024;

function parsePiModelList(output, provider) {
  const requested = String(provider || '').trim().toLowerCase();
  if (!requested) return [];
  const seen = new Set();
  const models = [];
  for (const rawLine of String(output || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').split(/\r?\n/)) {
    const columns = rawLine.trim().split(/\s{2,}/);
    if (columns.length < 2 || columns[0].toLowerCase() !== requested) continue;
    const id = columns[1].trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: id });
  }
  return models;
}

function _piProviderEntry(projectRoot, provider) {
  let cfg;
  try { cfg = readProjectConfig(projectRoot); } catch { cfg = null; }
  return readPiEntries(cfg).find((entry) => piProviderEnv(entry).provider === provider) || null;
}

function queryPiModels(provider, projectRoot, deps = {}) {
  const resolveLaunch = deps.resolveLaunch || resolvePiLaunch;
  const spawn = deps.spawn || spawnChild;
  const timeoutMs = deps.timeoutMs ?? PI_MODEL_LIST_TIMEOUT_MS;
  const launch = resolveLaunch();
  if (!launch) return Promise.resolve([]);

  const cwd = projectRoot || config.PROJECT_ROOT;
  const entry = _piProviderEntry(cwd, provider);
  const env = augmentPathEnv({
    PI_SKIP_VERSION_CHECK: '1',
    ...projectEnvExtras(cwd),
    ...piKeyEnvVars(entry),
    ...launch.env,
  });
  const nvmBinDir = resolveNvmBinDir(launch.command);
  if (nvmBinDir) env.PATH = `${nvmBinDir}${path.delimiter}${env.PATH}`;

  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let settled = false;
    let timer = null;
    function finish(models) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(models);
    }
    try {
      child = spawn(
        launch.command,
        [...(launch.argsPrefix || []), '--list-models', '--provider', provider],
        { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      return finish([]);
    }
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish([]);
    }, timeoutMs);
    child.once('error', () => finish([]));
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > PI_MODEL_LIST_MAX_BYTES) {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        finish([]);
      }
    });
    child.once('close', (code) => finish(code === 0 ? parsePiModelList(stdout, provider) : []));
  });
}

async function listPiModels(provider, projectRoot, deps = {}) {
  const id = String(provider || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(PI_PROVIDERS, id)) return [];
  const cache = deps.cache || _piModelCache;
  const now = deps.now ? deps.now() : Date.now();
  const cached = cache.get(id);
  if (cached && cached.expiresAt > now) return cached.models;
  const query = deps.query || queryPiModels;
  const models = await query(id, projectRoot, deps);
  cache.set(id, { models, expiresAt: now + PI_MODEL_CACHE_TTL_MS });
  return models;
}

// The API's member row has two IDs: `id` is the project-membership row and
// `user_id` is the value stored on task.assignee. The Task App must only expose
// the latter as its stable assignee ID. Keep the legacy snake_case aliases used
// by existing renderer consumers, while also exposing a canonical `id` and
// camelCase display fields for new consumers.
function normalizeProjectMember(member) {
  if (!member || typeof member !== 'object') return null;

  const id = member.user_id != null ? member.user_id
    : member.userId != null ? member.userId
      : member.user_id === undefined && member.userId === undefined && member.status !== 'pending'
        ? member.id ?? null
        : null;
  const name = [member.name, member.display_name, member.displayName, member.email]
    .find(value => typeof value === 'string' && value.trim())?.trim() || '';
  const avatarUrl = member.avatar_url ?? member.avatarUrl ?? null;

  return {
    ...member,
    id,
    user_id: id,
    name,
    display_name: name,
    avatar_url: avatarUrl,
    avatarUrl,
  };
}

// Resolve per-request project context from the X-TipTask-Project-Path header injected
// by Electron main.js (session.webRequest.onBeforeSendHeaders keyed by webContentsId).
// Ensures multi-window scenarios route Trello proxy calls to the correct project.
// Falls back to global config for non-Electron (standalone server) contexts.
function resolveProjectContext(req, backend) {
  if (backend && typeof backend.getCredentials === 'function') {
    const { baseUrl, projectId, token } = backend.getCredentials();
    return { projectId, apiBaseUrl: baseUrl, apiToken: token };
  }
  const headerPath = req.headers['x-tiptask-project-path'];
  try {
    const { baseUrl, projectId, token } = getApiCredentials(headerPath || config.PROJECT_ROOT);
    return { projectId, apiBaseUrl: baseUrl, apiToken: token };
  } catch {
    return { projectId: '', apiBaseUrl: '', apiToken: '' };
  }
}

// (C1186) Project ROOT for reading .tipatask/config.json directly (e.g. readVoiceSettings()) —
// NOT the same lookup as resolveProjectContext() above, which reads the DIFFERENTLY-SPELLED
// `x-tiptask-project-path` header (no second "a") and returns API credentials only, never a
// root path. This one matches the ~15 other routes in this file that key project-scoped config
// off `x-tipatask-project` (readProjectConfig/writeProjectConfig call sites). Both header names
// are real and both are injected by main.js's onBeforeSendHeaders — this is not a typo to "fix".
// Wire-facing objective-provider list + clamped default selection for one project — the
// GET /api/objective/providers body and the `providers:changed` broadcast share it so the
// two can never disagree. listVisibleObjectiveProviders() can return []; then ship '' as the
// selection rather than advertise a provider:model pair that isn't actually offered.
function _buildProvidersPayload(projectRoot) {
  const cfg = configForProject(projectRoot);
  const visible = listVisibleObjectiveProviders(cfg, { peek: true });
  const sel = visible.length ? clampSelectionToProviders(currentSelection(null, cfg), visible) : null;
  return {
    objectiveProviders: visible,
    objectiveSelection: sel ? formatSelection(sel.providerId, sel.model) : '',
  };
}

function resolveProjectRoot(req) {
  return req.headers['x-tipatask-project'] || config.PROJECT_ROOT;
}

// Push one project's current provider list to every open client of that project — the shared
// tail of an agents save and a Re-Check, so the two can't drift on the frame's shape.
function _broadcastProvidersChanged(projectRoot) {
  websocket.broadcastToProject(projectRoot, 'providers:changed', { projectPath: projectRoot || null, ..._buildProvidersPayload(projectRoot) });
}

// Re-Check (`GET /api/agent-config?refresh=1`). The caller has just force re-detected agent
// availability in this process, so the provider list an open chat holds may be stale NOW — push
// it immediately, without waiting on anything slow. The model list is separate: a CLI installed
// after boot leaves the registry on its static fallback list, and only a probe replaces it. That
// probe (streamed binary scan / CLI subcommand) runs off the request path and broadcasts again
// when it lands, so Re-Check itself stays fast and the live list still arrives without a reload.
// Best-effort throughout — a failed push or probe never fails the Re-Check response.
function _pushProvidersAfterRecheck(projectRoot) {
  try { _broadcastProvidersChanged(projectRoot); } catch (e) { console.warn('[ws-handlers] providers push after re-check failed:', e.message); }
  void listAllAgentModels(config, { force: true })
    .then(() => _broadcastProvidersChanged(projectRoot))
    .catch((e) => console.warn('[ws-handlers] model re-probe after re-check failed:', e.message));
}

// Every HTTP route that buffers a request body uses this reader. Content-Length is only an
// early-rejection hint; streamed bytes remain authoritative for chunked and false headers.
// On overflow, pause input and close the connection after the 413 has flushed so a peer
// cannot keep sending indefinitely or lose the response to an immediate socket destroy.
async function readCappedBody(req, res, maxBytes, opts = {}) {
  const { error = 'Audio upload exceeds 25 MB limit', code = 'AUDIO_TOO_LARGE' } = opts;
  const declared = req.headers?.['content-length'];
  const iterator = req[Symbol.asyncIterator]();
  function rejectOversize() {
    req.pause?.();
    // Node emits 'finish' after response bytes are handed to the socket. Destroying the
    // request before then can turn a valid 413 into ECONNRESET at the client.
    let closed = false;
    const closeRequest = () => {
      if (closed) return;
      closed = true;
      req.destroy?.();
      try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* already closed */ }
    };
    if (typeof res.once === 'function') {
      res.once('finish', closeRequest);
      res.once('close', closeRequest);
    }
    try {
      if (!res.writableEnded) {
        res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ error, code }));
      }
    } catch { closeRequest(); }
    if (typeof res.once !== 'function') closeRequest();
    return null;
  }
  if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return rejectOversize();
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await iterator.next();
      if (done) break;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) return rejectOversize();
      chunks.push(chunk);
    }
    if ('complete' in req && !req.complete) return null;
    return Buffer.concat(chunks, total);
  } catch {
    // IncomingMessage's async iterator rejects on a mid-body disconnect. There is no
    // useful response channel left; callers must not parse or mutate on this path.
    return null;
  }
}

async function readTextBody(req, res, maxBytes = JSON_BODY_MAX_BYTES) {
  const body = await readCappedBody(req, res, maxBytes, {
    error: 'Request body too large', code: 'BODY_TOO_LARGE',
  });
  return body === null ? null : body.toString('utf8');
}

// sherpa-onnx-node has no decode-cancellation API, so this bounds how long the CLIENT waits —
// it does not stop the in-flight ONNX inference, which keeps running in the background with its
// result simply discarded if the budget is hit first. See tt-audio-input.md § Local batch path.
const LOCAL_TRANSCRIBE_BUDGET_MS = 120_000;

// (C1186) voicePreset === 'local' branch of POST /api/transcribe. `body` is raw PCM16LE mono
// 16kHz audio (see src/client/pcm.js on the client side) — never multipart, that's rejected
// with 415 before this is called. require('./local-asr') is lazy so a project on the
// assemblyai preset never touches sherpa-onnx-node, matching voice-stream/local-provider.js.
async function handleLocalTranscribe(req, res, body, modelId) {
  let closed = false;
  res.once('close', () => { closed = true; });
  function respond(status, payload) {
    if (closed || res.writableEnded) return; // client already gone
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
  if (body.length === 0 || body.length % 2 !== 0) {
    return respond(400, { error: 'Expected raw PCM16LE audio (an even byte count)', code: 'INVALID_PCM16' });
  }
  try {
    const { LocalAsrSession } = require('./local-asr');
    const samples = int16BufferToFloat32(body);
    const session = new LocalAsrSession({ modelId });
    const workPromise = (async () => {
      await session.init();
      const results = [...(await session.acceptWaveform(samples)), ...(await session.flush())];
      const transcript = results.map((r) => r.text).filter(Boolean).join(' ').trim();
      const language_code = results.find((r) => r.lang)?.lang || null;
      return { transcript, language_code };
    })();
    workPromise.catch(() => {}); // if the timeout below wins the race, a later rejection here must not go unhandled
    const timedOut = Symbol('timedOut');
    const timeoutPromise = new Promise((resolve) => { setTimeout(() => resolve(timedOut), LOCAL_TRANSCRIBE_BUDGET_MS).unref(); });
    const outcome = await Promise.race([workPromise, timeoutPromise]);
    if (outcome === timedOut) {
      return respond(504, { error: 'Local transcription timed out', code: 'LOCAL_TIMEOUT' });
    }
    return respond(200, outcome);
  } catch (err) {
    // (C1197) Nothing logged this before — the only diagnostic was the toast, and even that
    // collapsed every cause into one static string. Log first so a packaged-build failure with
    // no other visibility (see tt-audio-input.md) at least lands in the app's console.
    console.error('[transcribe] local ASR failed:', err);
    if (err && err.code === 'LOCAL_ASR_UNAVAILABLE') {
      return respond(409, {
        error: `${err.message} — finish setup in Settings > Voice`,
        code: err.code,
        reasonCode: err.reasonCode || null,
        reasonDetail: err.detail || null,
      });
    }
    return respond(500, { error: err.message, code: 'LOCAL_TRANSCRIBE_FAILED' });
  }
}

// (C1186) voicePreset === 'assemblyai' + per-project key branch of POST /api/transcribe.
async function handleAssemblyAiTranscribe(res, body, apiKey) {
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', onClose);
  try {
    const { transcript, language_code } = await transcribeWithAssemblyAI(body, { apiKey, signal: controller.signal });
    res.removeListener('close', onClose);
    if (res.writableEnded) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ transcript, language_code }));
  } catch (err) {
    res.removeListener('close', onClose);
    if (err.code === ASSEMBLYAI_ERRORS.ABORTED || res.writableEnded) return; // client already gone
    // (C1203) This branch had no server-side log at all — the toast was the only diagnostic,
    // and voice.errUpstream collapsed every cause (network failure, bad audio, rate limit,
    // AssemblyAI-side transcription error) into one static string. Mirror handleLocalTranscribe's
    // C1197 logging so the real cause lands in the app's console.
    console.error('[transcribe] AssemblyAI failed:', err.code, err.status || '', err.upstream || '', err);
    // err.status === 413 (assemblyai-batch.js's own >25MB guard) used to win over statusByCode
    // and answer 413 with code ASSEMBLYAI_UPSTREAM — the client then rendered the generic
    // "Transcription service error" instead of voice.errTooLarge. Map it to AUDIO_TOO_LARGE so it
    // reads the same as readCappedBody's own 413 (which normally catches this first anyway).
    if (err.status === 413) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message || 'Audio upload exceeds 25 MB limit', code: 'AUDIO_TOO_LARGE' }));
    }
    const statusByCode = {
      [ASSEMBLYAI_ERRORS.UNAUTHORIZED]: 401,
      [ASSEMBLYAI_ERRORS.TIMEOUT]: 504,
      [ASSEMBLYAI_ERRORS.POLL_TIMEOUT]: 504,
      [ASSEMBLYAI_ERRORS.NETWORK]: 502,
      [ASSEMBLYAI_ERRORS.UPSTREAM]: 502,
    };
    const status = err.status || statusByCode[err.code] || 502;
    const message = err.code === ASSEMBLYAI_ERRORS.UNAUTHORIZED
      ? 'AssemblyAI rejected the configured key — check your key in Settings > Voice'
      : (err.message || 'AssemblyAI request failed');
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: message, code: err.code || 'ASSEMBLYAI_UPSTREAM' }));
  }
}

function postDeviceSession(taskId, backend) {
  if (config.DEVICE_ID <= 0 || !backend || typeof backend.getCredentials !== 'function') return;
  let credentials;
  try { credentials = backend.getCredentials(); } catch { return; }
  const url = `${credentials.baseUrl}/api/projects/${encodeURIComponent(credentials.projectId)}/tasks/${encodeURIComponent(taskId)}/device-sessions`;
  httpRequest(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credentials.token}` },
    body: { device_id: config.DEVICE_ID },
    timeoutMs: 5000,
  }).catch(err => console.warn(`[device-session] claim failed for ${taskId}: ${err.message}`));
}

function deleteDeviceSession(taskId, backend) {
  if (config.DEVICE_ID <= 0 || !backend || typeof backend.getCredentials !== 'function') return;
  let credentials;
  try { credentials = backend.getCredentials(); } catch { return; }
  const url = `${credentials.baseUrl}/api/projects/${encodeURIComponent(credentials.projectId)}/tasks/${encodeURIComponent(taskId)}/device-sessions/${config.DEVICE_ID}`;
  httpRequest(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${credentials.token}` },
    timeoutMs: 5000,
  }).catch(err => console.warn(`[device-session] release failed for ${taskId}: ${err.message}`));
}

function sessionEndedPayload(taskId, session, reason = 'terminated') {
  return {
    taskId,
    tabId: session?.tabId || taskId,
    reason,
  };
}

function sendSessionEnded(ws, taskId, session, reason = 'terminated') {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'session-ended', ...sessionEndedPayload(taskId, session, reason) }));
  }
}

function broadcastSessionEnded(taskId, session, reason = 'terminated') {
  // Project-scoped (C1057): the attention watcher (__attention__ branch below) and a
  // project-bound board watcher both react to session-ended, and task keys can collide
  // across two open Electron project windows.
  websocket.broadcastToProject(session?.projectPath, 'session-ended', sessionEndedPayload(taskId, session, reason));
}

// Objective/spec chat is over (finalize, kill, ws close/detach): teardownObjectiveSession() leaves
// no heartbeat, prewarm or turn proc behind, then the session leaves the map. Identity check so a
// late call never deletes a newer session that reuses the same tab key. Idempotent.
function dropObjectiveSession(sessions, sessionKey, session, taskId, reason) {
  teardownObjectiveSession(session, taskId, reason);
  // A queued turn request, or a Claude turn in its retry backoff (no proc), still holds a throttle
  // entry/slot and its stall watchdog — which would later drain into a spawn or count a timeout.
  if (session.type === 'objective') throttle.recordAbort(taskId);
  // The cold spare is global and only ever wanted by a chat that is being started; the next
  // composer keystroke re-warms it. A task chat never uses the pool, so ending one leaves it.
  if (session.type !== 'taskChat') killColdPrewarm(reason);
  if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
}

// (C1565) Group-kill first — reaps any backgrounded subprocess tree the agent spawned
// inside the pty, not just the pty leader itself (see process-group.js header). Falls
// through to the pre-C1565 leader-only kill when the group-kill guard refuses.
function killTerminalPty(ptyProcess) {
  if (!ptyProcess) return;
  const pid = ptyProcess.pid;
  if (!killProcessGroup(pid, 'SIGTERM')) {
    try { ptyProcess.kill('SIGTERM'); } catch { try { ptyProcess.kill(); } catch { /* already dead */ } }
  }
  const forceTimer = setTimeout(() => {
    if (!killProcessGroup(pid, 'SIGKILL')) {
      try { ptyProcess.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }, 1500);
  if (forceTimer.unref) forceTimer.unref();
}

function terminateTerminalSession(session, taskId, sessionKey, sessions, reason = 'terminated', opts = {}) {
  require('./session-memory').endSessionMemory(session, 'terminated');
  let attachedWs = null;
  sessionQueue.remove(sessionKey); // (TPT444) cancelling a queued start
  detachQueuedClient(session);
  if (session?._planIdleTimer) {
    clearTimeout(session._planIdleTimer);
    session._planIdleTimer = null;
  }
  if (session?._injectTimer) {
    clearTimeout(session._injectTimer);
    session._injectTimer = null;
  }
  // C948: user Terminate/Restart is how interactive agent sessions actually end
  // (the TUI never exits on its own) — post the resolution comment here, because
  // ptyProcess.onExit is suppressed by the _terminated flag set below. Guards:
  // alive+pty = live agent only (already-exited sessions posted via onExit);
  // _terminalOutputSeen = skip never-booted sessions; fire-and-forget so the
  // kill never blocks on the HTTP POST.
  if (session && session.alive && session.pty && session._terminalOutputSeen
      && typeof session.onSessionExit === 'function') {
    Promise.resolve(session.onSessionExit({ exitCode: null, reason: 'user-terminated', buffer: session.buffer }))
      .catch(err => console.error(`[terminal] resolution comment on terminate failed for ${taskId}:`, err.message));
  }
  if (session) {
    session._terminated = true;
    attachedWs = session.ws;
    const ptyProcess = session.pty;
    session.alive = false;
    session.pending = false;
    session._queued = false;
    session._launching = false;
    session._starting = false; // (C1444) terminate mid-spawn — throwIfTerminated() inside
                                // spawnTerminal() will abort it, but clear the flag now so
                                // GET /api/sessions doesn't call it 'active' in the meantime
    session.pty = null;
    session.ws = null;
    session._attentionBroadcasted = false;
    session._attentionLastBroadcast = null;
    session._attentionState = null;
    session.codexPlanReady = false;
    session.agentPlanReady = false;
    // A watchdog-paused tree is SIGSTOPped: continue and signal the stored set first, or its
    // members outside the pty leader's group would stay stopped, holding their memory.
    killPausedTargets(session);
    killTerminalPty(ptyProcess);
    // (C1565) After the kill, not before — killTerminalPty() reads ptyProcess.pid directly
    // (captured above), but leave ptyPid on the session until the signal is actually sent.
    session.descendantWatchdog = null;
    session.ptyPid = null;
  }
  sessions.delete(sessionKey);
  deleteDeviceSession(taskId, opts.backend);
  sendSessionEnded(opts.ackWs, taskId, session, reason);
  broadcastSessionEnded(taskId, session, reason);
  drainSessionQueue(); // (TPT444) the freed slot goes to the oldest queued start
  if (opts.closeAck !== false && opts.ackWs && opts.ackWs.readyState === opts.ackWs.OPEN) {
    setTimeout(() => {
      try { opts.ackWs.close(); } catch { /* already closed */ }
    }, 25);
  }
  if (attachedWs && attachedWs !== opts.ackWs && attachedWs.readyState === attachedWs.OPEN) {
    setTimeout(() => {
      try { attachedWs.close(); } catch { /* already closed */ }
    }, 25);
  }
}

// (C1463) Objective tab close — depth-capped BFS guard against a malformed parent_id cycle.
const OBJECTIVE_DESCENDANT_DEPTH_CAP = 64;

// (C1463) Resolves an objective's WHOLE descendant tree (not just direct children — a
// nested sub-objective's own children count too, see tt-task-subtasks.md § Objective nav
// tabs) and whether every one of them is closed, role-derived (complete OR canceled) via
// fetchStatusContext()'s isClosed(), never a hardcoded status literal and never the opaque
// per-parent completed_children_count rollup (that field is direct-children-only — this
// check spans the whole tree). getTasksUnfiltered() carries NO assignee filter (unlike the
// client's own getChildren() default) — this is the authoritative source the objective
// tab's close button gates on, deliberately not the client's cosmetic tick (see
// objective-tabs.js's isObjectiveTabDone() doc comment for why that source can't be
// trusted for this decision). An objective with zero descendants is vacuously "all closed".
async function resolveObjectiveDescendants(parentKey, backend) {
  const rows = await backend.getTasksUnfiltered();
  const byDbId = new Map(rows.map(r => [r.dbId, r]));
  const childrenByParentDbId = new Map();
  for (const r of rows) {
    if (r.parentDbId == null) continue;
    const list = childrenByParentDbId.get(r.parentDbId) || [];
    list.push(r);
    childrenByParentDbId.set(r.parentDbId, list);
  }
  const root = rows.find(r => r.id === parentKey);
  if (!root) return { taskKeys: new Set(), allClosed: true };

  const statusCtx = await fetchStatusContext(backend);
  const taskKeys = new Set();
  let allClosed = true;
  let frontier = [root.dbId];
  const visited = new Set([root.dbId]);
  for (let depth = 0; depth < OBJECTIVE_DESCENDANT_DEPTH_CAP && frontier.length > 0; depth++) {
    const next = [];
    for (const dbId of frontier) {
      for (const child of (childrenByParentDbId.get(dbId) || [])) {
        if (visited.has(child.dbId)) continue;
        visited.add(child.dbId);
        if (!child.isReservation) {
          taskKeys.add(child.id);
          if (!statusCtx.isClosed(child.status)) allClosed = false;
        }
        next.push(child.dbId);
      }
    }
    frontier = next;
  }
  return { taskKeys, allClosed };
}

// (C1463) Stops every LIVE TERMINAL session whose task key is in `taskKeys` — the objective
// parent's own session (if any) is deliberately left alone, "child" sessions only, by
// design (see tt-task-subtasks.md). Routes each stop through the existing
// terminateTerminalSession() exit path so onSessionExit() still posts the terminal-tail
// resolution comment and killTerminalPty() still group-kills the PTY tree — the normal
// Terminate flow, not a bypass. Iterates a SNAPSHOT of `sessions` since
// terminateTerminalSession() deletes from the live Map as it goes. Returns the ids actually
// terminated.
function terminateObjectiveSessions(taskKeys, sessions, backend, projectPath) {
  const closedIds = [];
  for (const [key, session] of [...sessions]) {
    if (!session || session.type !== 'terminal') continue;
    const id = session.tabId || session.taskId;
    if (!id || !taskKeys.has(id)) continue;
    if (session.projectPath && projectPath && session.projectPath !== projectPath) continue;
    terminateTerminalSession(session, id, key, sessions, 'objective-closed', { ackWs: null, backend });
    closedIds.push(id);
  }
  return closedIds;
}

// Wire queue-state broadcast to WebSocket
throttle.subscribe(websocket.emitObjectiveQueueState);

// ── Compute next available ID/priority hint for filtered TODO.md responses ──
// `activeStatuses` (C1187) — this project's active status names; defaults to the legacy
// 3-name set via highestActiveCodingPriority()'s own default when omitted.
// `codingPrefix` (C1483) — this project's own CODING key prefix (e.g. 'TPT'), already
// degraded to the legacy 'C' by resolveCodingPrefix() at the call site. Was hardcoded
// 'C'/'H' scan+mint — a project with its own task_prefix got a next-id hint for a
// prefix it no longer mints.
function nextIdHint(tasks, activeStatuses, codingPrefix) {
  const byPrefix = maxNumbersByPrefix(tasks);
  const nextCoding = (byPrefix.get(codingPrefix) ?? 0) + 1;
  const nextH = (byPrefix.get('H') ?? 0) + 1;
  const priorities = tasks.map(t => t.priority).filter(p => typeof p === 'number');
  const maxPriority = priorities.length ? Math.max(...priorities) : 0;
  const highestActive = activeStatuses ? highestActiveCodingPriority(tasks, activeStatuses) : highestActiveCodingPriority(tasks);
  const nextPriority = highestActive ?? (maxPriority + 1 || 1);
  const hint = highestActive
    ? `Next priority (joins active sprint ${highestActive}): ${nextPriority}`
    : `Next priority (new step/sprint): ${nextPriority}`;
  return `Next available task IDs (across ALL statuses): ${codingPrefix}${nextCoding}, H${nextH}. ${hint}`;
}

// ── Helpers ──

// (C1116) needsExplicitPlanReady / minPlanBufferLength used to be hand-copied literals here,
// independent of terminal-session.js's onData plan-ready branch — a drift hazard (the Pi
// 100-byte floor got fixed there once already and this reattach/session-status path silently
// kept the old value). Now both import the single source of truth.
function maybeRefirePlanReady(session, ws) {
  if (session.terminalPhase !== 'planning') return;
  if (!codexPlanReadyIsFresh(session)) return;
  const needsExplicitPlanReady = requiresExplicitPlanReadyPattern(session);
  if (needsExplicitPlanReady) {
    if (session.agentPlanReady !== true) return;
    if (session.taskAgent === 'codex' && session.codexPlanReady !== true) return;
  } else if (!(session.planOnly || (!session.planApprovalCommand && session._userInteracted))) {
    return;
  }
  const minPlanBufferLength = planReadyMinBufferLength(session);
  if (session.buffer.length <= minPlanBufferLength) return;

  if (session._planReadySent) {
    ws.send(JSON.stringify({
      type: 'plan-ready',
      tabId: session.tabId,
      codexPlanReady: session.codexPlanReady === true,
    }));
    return;
  }

  const idleMs = Date.now() - (session.lastOutputAt || 0);
  if (idleMs >= 2000) {
    session._planReadySent = true;
    ws.send(JSON.stringify({
      type: 'plan-ready',
      tabId: session.tabId,
      codexPlanReady: session.codexPlanReady === true,
    }));
    return;
  }

  clearTimeout(session._planIdleTimer);
  session._planIdleTimer = setTimeout(() => {
    if (session.terminalPhase === 'planning' && !session._planReadySent
        && codexPlanReadyIsFresh(session)
        && (!needsExplicitPlanReady || (session.agentPlanReady === true && (session.taskAgent !== 'codex' || session.codexPlanReady === true)))
        && session.ws && session.ws.readyState === session.ws.OPEN) {
      session._planReadySent = true;
      session.ws.send(JSON.stringify({
        type: 'plan-ready',
        tabId: session.tabId,
        codexPlanReady: session.codexPlanReady === true,
      }));
    }
  }, 2000 - idleMs);
}

function buildPlanIdSet() {
  try {
    return new Set(
      require('node:fs').readdirSync(config.PLANS_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => f.slice(0, -3))
    );
  } catch (e) {
    if (e.code === 'ENOENT') return new Set();
    throw e;
  }
}

function getTaskCommentKey(urlPath) {
  const prefix = '/api/tasks/';
  const suffix = '/comments';
  if (!urlPath.startsWith(prefix) || !urlPath.endsWith(suffix)) return null;
  const encoded = urlPath.slice(prefix.length, -suffix.length);
  return encoded ? decodeRequestComponent(encoded) : null;
}

// TPT34 — /api/tasks/:taskKey/comments/:commentId (edit). getTaskCommentKey above only
// matches an exact `/comments` suffix, so an id-bearing path falls through it entirely.
// commentId is always \d+ (a DB auto-increment id) so the split is unambiguous even if a
// task key itself contains slashes.
function getTaskCommentEditTarget(urlPath) {
  const m = urlPath.match(/^\/api\/tasks\/(.+)\/comments\/(\d+)$/);
  if (!m) return null;
  const taskKey = decodeRequestComponent(m[1]);
  return taskKey ? { taskKey, commentId: m[2] } : null;
}

// TPT17 — same key-parse shape as getTaskCommentKey above, for the Notifications tab's
// events log + subscription toggle proxy routes.
function getTaskEventsKey(urlPath) {
  const prefix = '/api/tasks/';
  const suffix = '/events';
  if (!urlPath.startsWith(prefix) || !urlPath.endsWith(suffix)) return null;
  const encoded = urlPath.slice(prefix.length, -suffix.length);
  return encoded ? decodeRequestComponent(encoded) : null;
}

function getTaskSubscriptionKey(urlPath) {
  const prefix = '/api/tasks/';
  const suffix = '/subscription';
  if (!urlPath.startsWith(prefix) || !urlPath.endsWith(suffix)) return null;
  const encoded = urlPath.slice(prefix.length, -suffix.length);
  return encoded ? decodeRequestComponent(encoded) : null;
}

function _httpError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function uploadImageThroughBackend(backend, parsed) {
  if (typeof parsed.filename !== 'string' || !parsed.filename) {
    throw _httpError('filename required', 400);
  }
  if (typeof parsed.mimeType !== 'string' || !parsed.mimeType.startsWith('image/')) {
    throw _httpError('mimeType must be an image type', 400);
  }
  if (typeof parsed.data !== 'string' || !parsed.data) {
    throw _httpError('data required', 400);
  }
  const r = await backend.uploadImage(parsed.filename, parsed.mimeType, parsed.data, parsed.taskKey || null);
  if (!r) {
    throw _httpError('Upload rejected by API', 502);
  }
  const base = typeof backend.getCredentials === 'function'
    ? backend.getCredentials().baseUrl
    : '';
  const url = base ? `${base}${r.url}` : r.url;
  return { id: r.id, url };
}

// C1246 — task_files generic attachment upload. Mirrors uploadImageThroughBackend above, but
// mimeType is NOT checked here against the doc allowlist (unlike the image startsWith('image/')
// check) — the API is the single source of truth for that list (files.js's FILE_MIME_EXT) and
// returns 400 INVALID_MIME, which apiRequest turns into a thrown err.statusCode. Duplicating the
// allowlist here would just be one more place to keep in sync.
async function uploadFileThroughBackend(backend, parsed) {
  if (typeof parsed.filename !== 'string' || !parsed.filename) {
    throw _httpError('filename required', 400);
  }
  if (typeof parsed.mimeType !== 'string' || !parsed.mimeType) {
    throw _httpError('mimeType required', 400);
  }
  if (typeof parsed.data !== 'string' || !parsed.data) {
    throw _httpError('data required', 400);
  }
  const r = await backend.uploadFile(parsed.filename, parsed.mimeType, parsed.data, parsed.taskKey || null);
  if (!r) {
    throw _httpError('Upload rejected by API', 502);
  }
  const base = typeof backend.getCredentials === 'function'
    ? backend.getCredentials().baseUrl
    : '';
  const url = base ? `${base}${r.url}` : r.url;
  return { id: r.id, url, filename: r.filename, size_bytes: r.size_bytes };
}

// (TPT349) The launch-time credential gate now names the token's expiry ("API token expired at
// 14:02 — sign in again."). Show that text for the two token-lifetime reason codes; every other
// EAUTH cause (latched 401, missing/malformed token) keeps the fixed message.
function eauthClientMessage(err) {
  const fallback = 'Authentication expired or invalid — sign in again.';
  return err && (err.reasonCode === 'expired' || err.reasonCode === 'expiring') && err.message
    ? err.message
    : fallback;
}

function sendWsJson(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

async function handleWsImageUpload(ws, backend, msg) {
  const blobUrl = typeof msg.blobUrl === 'string' ? msg.blobUrl : '';
  try {
    const uploaded = await uploadImageThroughBackend(backend, msg);
    sendWsJson(ws, { type: 'image-uploaded', blobUrl, ...uploaded });
  } catch (err) {
    sendWsJson(ws, {
      type: 'image-upload-error',
      blobUrl,
      error: err.message,
      status: err.statusCode || 500,
    });
  }
}

async function getObjectiveHistorySource(taskId, session, projectPath) {
  try {
    const draft = await readChatDraft(projectPath);
    if (draft && Array.isArray(draft.messages) && (!taskId || draft.taskId === taskId)) {
      return draft.messages;
    }
  } catch (err) {
    console.warn('[objective] Failed to read chat draft for history source:', err.message);
  }
  if (session && Array.isArray(session.messages)) {
    return session.messages;
  }
  return [];
}

// ── HTTP request handler ──

async function handleAgentQuotaRequest(req, res, registryOps = null) {
  // Capture scope before the first await; switching another window cannot change it.
  const projectRoot = req.headers['x-tipatask-project'] || registryOps?.getActiveProjectPath?.() || config.PROJECT_ROOT;
  const query = new URL(req.url, 'http://localhost').searchParams;
  const provider = query.get('agent');
  const ids = query.has('agent') ? [provider] : ['claude', 'codex'];
  const cfg = configForProject(projectRoot);
  const entries = await Promise.all(ids.map(async id => [id, await getAgentQuotaStatus(id, cfg, { projectRoot })]));
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  return res.end(JSON.stringify({ projectRoot, agents: Object.fromEntries(entries) }));
}

function createHttpHandler(sessions, getActiveBackend, registryOps = null) {
  sleepWatchdogSessions = sessions;
  const { readProjectConfig } = require('./project-config');
  const routeHandler = async (req, res) => {
    const urlPath = req.url.split('?')[0];
    decodeRequestComponent(urlPath);

    if (req.localAccess?.kind === 'electron' && urlPath === '/api/project-switch') {
      // Electron changes projects through its bound-window IPC, never through the
      // browser-only route that registers an arbitrary path and changes global state.
      res.writeHead(403); return res.end('Forbidden');
    }

    if (req.localAccess?.kind === 'handoff' || (req.localAccess?.kind === 'electron'
      && (urlPath === '/start-task' || urlPath === '/open-objective'))) {
      // This is the sole unauthenticated route, and Electron's own capability does
      // not bypass its user confirmation. Decide before any backend is selected.
      if (req.method !== 'GET' || (urlPath !== '/start-task' && urlPath !== '/open-objective')) {
        res.writeHead(403); return res.end('Forbidden');
      }
      const target = new URL(req.url, `http://${req.headers.host}`);
      const approved = target.searchParams.get('projectId') && target.searchParams.get('task')
        && target.searchParams.get('userId')
        && await registryOps?.confirmHandoffViaMain?.(target.searchParams.get('projectId'), target.searchParams.get('task'));
      if (!approved) { res.writeHead(403); return res.end('Not opened'); }
    }

    if (req.method === 'GET' && urlPath === '/api/agent-quota') {
      return handleAgentQuotaRequest(req, res, registryOps);
    }

    // Route ALL task/recipe/comment/tag requests to the caller's project backend
    // when the client forwards its x-tipatask-project header (Electron multi-window).
    // main.js onBeforeSendHeaders injects this header on every HTTP request from
    // each BrowserWindow, so per-project routing is automatic — no client changes needed.
    // Falls back to getActiveBackend() when header absent (browser mode / single-project).
    function resolveBackend(r) {
      const pp = r.headers['x-tipatask-project'];
      if (pp && registryOps && registryOps.getBackendForPath) {
        return registryOps.getBackendForPath(pp);
      }
      return getActiveBackend();
    }
    const backend = resolveBackend(req);
    if (process.env.TIPATASK_PROJECT_DEBUG === '1') {
      console.log(`[proj:http] ${req.method} ${urlPath} hdr=${req.headers['x-tipatask-project'] || '<none>'}`);
    }

    // TPT190 — provider metadata for every Pi model source the Agents UI can configure.
    // Built solely from the registry: config rows and their `apiKey` values are never read.
    if (req.method === 'GET' && urlPath === '/api/pi/providers') {
      const providers = Object.entries(PI_PROVIDERS).map(([id, meta]) => ({
        id,
        label: meta.label,
        envKey: meta.envKey,
        keyRequired: meta.keyRequired,
        supportsBaseUrl: meta.supportsBaseUrl,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(providers));
    }

    // TPT190 — live Pi catalog for one provider. Every failure deliberately degrades to an
    // empty array: model ids remain free text in the consumer, so catalog discovery is an aid,
    // never a gate that can block configuring a provider Pi knows but cannot currently list.
    if (req.method === 'GET' && urlPath === '/api/pi/models') {
      const provider = new URL(req.url, 'http://localhost').searchParams.get('provider');
      const models = await listPiModels(provider, resolveProjectRoot(req));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(models));
    }

    // GET /api/sessions — list active terminal sessions
    if (req.method === 'GET' && req.url === '/api/sessions') {
      // Scope to the caller's project in Electron multi-window mode (main.js injects
      // x-tipatask-project per BrowserWindow). No header → include all (browser/single-project).
      const reqPath = req.headers['x-tipatask-project'] || '';
      const active = [];
      const exited = [];
      const queued = []; // (TPT444) [{ taskId, position }] — start-queue entries, FIFO position
      const attention = [];
      const attentionDetails = {}; // (C1057) taskId -> { kind, promptText, agent }
      const sessionMeta = {}; // (C1144) taskId -> { agent, label, type, alive } — left-nav active-sessions list needs the agent id per session
      for (const [, s] of sessions) {
        if (reqPath && s.projectPath && s.projectPath !== reqPath) continue;
        const id = s.tabId; // bare id the board matches — not the composite sessKey map key
        if (!id) continue;
        const bucket = sessionListBucket(s); // (C1444) 'active' covers alive || _starting
        if (bucket === 'active') active.push(id);
        else if (bucket === 'exited') exited.push(id);
        else if (bucket === 'queued') queued.push({ taskId: id, position: sessionQueue.position(sessKey(id, s.projectPath || '')),
          reason: 'device-cap', ...sessionQueue.snapshot(s.projectPath).queued.find(row => row.taskId === id) });
        if (s._attentionBroadcasted) {
          attention.push(id);
          if (s._attentionLastBroadcast) attentionDetails[id] = s._attentionLastBroadcast;
        }
        sessionMeta[id] = sessionMetaRow(s);
      }
      const lost = [];
      const lostDetails = {};
      for (const row of readLostSessions(reqPath || config.PROJECT_ROOT, config.USER_DATA_ROOT)) {
        if (sessionMeta[row.taskId] || lostDetails[row.taskId]) continue;
        lost.push(row.taskId);
        lostDetails[row.taskId] = { reason: row.reason, at: row.at };
        sessionMeta[row.taskId] = { agent: row.agent, label: row.label, type: 'terminal',
          alive: false, startedAt: row.startedAt };
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ projectPath: reqPath || config.PROJECT_ROOT, sessions: active, exited, queued, lost, lostDetails, attention, attentionDetails, sessionMeta,
        admission: sessionQueue.snapshot(reqPath || config.PROJECT_ROOT).admission }));
    }

    // GET /api/agent-config — agent availability snapshot for startup population
    // (used by init() before the board is interactive, especially in Electron mode
    // where the board WS is never connected and availableAgents would stay [])
    if (req.method === 'GET' && (req.url === '/api/agent-config' || req.url.startsWith('/api/agent-config?'))) {
      // ?refresh=1 (the agent picker's Re-Check button) — force a re-detect in THIS process
      // before answering. Electron main's own force re-detect can't reach these caches, and
      // this process is the one that serves every objective-provider list.
      if (/[?&]refresh=1(&|$)/.test(req.url)) {
        try { await refreshAgentDetection(config); } catch (e) { console.warn('[ws-handlers] agent re-detect failed:', e.message); }
        // (TPT182) Re-Check must reach an already-open objective chat too — see the helper.
        _pushProvidersAfterRecheck(resolveProjectRoot(req));
      }
      // C1132 — project-scoped resolution (LAST_AGENT/TASK_AGENT), not the global startup
      // snapshot, mirroring the board-watcher 'config' frame's identical fix (C1131, above)
      // for the same reason: a multi-window Electron server must report each project's own
      // default, not whichever project it happened to boot against. availableAgents is
      // filtered by THIS project's own AVAILABLE_AGENTS (configForProject() view — the global
      // singleton is a boot-time default only, never refreshed by a Settings save);
      // agentStatuses stays global — machine-level CLI detection, not a per-project choice.
      const projectRoot = req.headers['x-tipatask-project'] || config.PROJECT_ROOT;
      const ta = getTaskAgentInfo(resolveTaskAgentId(projectRoot, null));
      let currentUserId = null;
      if (config.TASK_BACKEND === 'api') {
        try { currentUserId = (await backend.getCurrentUserId()) ?? null; } catch { currentUserId = null; }
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        taskAgent: ta.id,
        taskAgentLabel: ta.label,
        agentLabels: _agentLabels(),
        planApprovalCommand: ta.approvalCommand,
        supportsPlanMode: ta.supportsPlanMode,
        // (C1259) Peek variants — this is a status badge, not a gate; never
        // spawnSync-blocks the request on a stale-negative agent. See base-agent.js
        // peekDetect().
        availableAgents: getAvailableAgentsPeek(configForProject(projectRoot)),
        agentStatuses: listTaskAgentStatusesPeek(config),
        currentUserId,
      }));
    }

    // GET /api/agent-models[?agent=claude][&refresh=1] — (C1504) live per-agent model list,
    // for the edit-modal model dropdown. Plain JSON GET, same shape as /api/agent-config
    // above — HTTP, not WS, so it works in Electron where the board WS is never connected.
    // No `agent` param returns every registered agent; `refresh=1` bypasses the 24h/day cache
    // (model-registry.js) and forces a fresh probe — the request still returns promptly
    // because the probe itself is bounded (5s binary scan / 10s CLI spawn timeout) and
    // concurrent callers for the same agent coalesce onto one in-flight probe.
    if (req.method === 'GET' && urlPath === '/api/agent-models') {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const agentId = query.get('agent');
      const force = query.get('refresh') === '1';
      try {
        if (agentId) {
          const entry = await listAgentModels(agentId, config, { force });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          return res.end(JSON.stringify({ agents: { [entry.agent]: entry } }));
        }
        const agents = await listAllAgentModels(config, { force });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ agents }));
      } catch (err) {
        console.error('[ws-handlers] GET /api/agent-models failed:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/project/members — project members for edit-modal mention suggestions
    if (req.method === 'GET' && urlPath === '/api/project/members') {
      try {
        const rawMembers = await backend.getProjectMembers();
        const members = (Array.isArray(rawMembers) ? rawMembers : [])
          .map(normalizeProjectMember)
          .filter(Boolean);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify({ members }));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/project/tags — project tag registry for edit-modal typeahead
    if (req.method === 'GET' && urlPath === '/api/project/tags') {
      try {
        const tags = await backend.getProjectTags();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify({ tags }));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/project/statuses — project status registry for client-side workflow-role
    // resolution (C1184). Same-origin proxy so the renderer never holds API credentials
    // (mirrors /api/project/tags above). backend.getStatuses() never throws and never
    // returns [] (falls back to the legacy 5), so no error branch is needed here.
    if (req.method === 'GET' && urlPath === '/api/project/statuses') {
      const statuses = typeof backend.getStatuses === 'function' ? await backend.getStatuses() : [];
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
      return res.end(JSON.stringify({ statuses }));
    }

    // GET /api/project/settings — C1235. Project scalars the renderer needs; today
    // task_group_label (C1232) and color_scheme (C1305). Same same-origin-proxy shape
    // as /api/project/statuses above — no error branch, because getProjectSettings() never
    // throws (fail-open, degrades to null on any failure). The 'Batches' fallback here
    // matches migration 051's column default; 'default' matches migration 053's
    // ('default' = no project override, see
    // api/src/lib/color-schemes.js — task-board.js's readProjectTheme() falls through to
    // the local config.json theme when it sees this value).
    // TPT345 — user-triggered task-branch merge flow (Settings ▸ Version Control /
    // Project menu ▸ Merge task branches…). Same-origin like every route here; git runs in
    // this process (never an agent shell). Lazy require keeps merge-routes.js and the
    // git-merge/ tree off the boot path. See ai/architecture/tt-version-control-agents.md.
    if (urlPath.startsWith('/api/project/merge/')) {
      const { handleMergeRoute } = require('./merge-routes');
      await handleMergeRoute(req, res, urlPath, { projectRoot: resolveProjectRoot(req), backend, sessions, readTextBody });
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/project/settings') {
      const project = typeof backend.getProjectSettings === 'function' ? await backend.getProjectSettings() : null;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
      return res.end(JSON.stringify({
        taskGroupLabel: project?.task_group_label || 'Batches',
        colorScheme: project?.color_scheme || 'default',
        // C1332 — sprints_enabled (C1330 migration/PATCH). Same fail-open contract as the
        // two fields above: null/undefined project or column (file backend, unreachable
        // API) -> default true, matching migration 054's column default.
        sprintsEnabled: project?.sprints_enabled === undefined || project?.sprints_enabled === null
          ? true : !!project.sprints_enabled,
        // C1490 — kb_sync_as_you_go (C1488 migration/PATCH). Same fail-open contract:
        // null/undefined project or column -> default true (today's forced-sync behavior),
        // matching migration 056's column default. Settings modal's Memory tab.
        kbSyncAsYouGo: project?.kb_sync_as_you_go === undefined || project?.kb_sync_as_you_go === null
          ? true : !!project.kb_sync_as_you_go,
        // C1558 — use_objective_grouping (C1556 migration/PATCH). Same fail-open contract:
        // null/undefined project or column -> default true, matching migration 059's column
        // default (today's behavior — >1-task objectives get an is_objective parent).
        useObjectiveGrouping: project?.use_objective_grouping === undefined || project?.use_objective_grouping === null
          ? true : !!project.use_objective_grouping,
        // C1577 — sprint_sort_order (PATCH-only, no toggle). Only the literal 'desc' opts
        // into the legacy highest-first board order; anything else (missing column, file
        // backend, unreachable API) falls open to 'asc', matching migration 064's column
        // default.
        sprintSortOrder: project?.sprint_sort_order === 'desc' ? 'desc' : 'asc',
        // TPT61 — vcs_type/vcs_*_enabled (C1213/C1215) for the Task App's own Settings ▸
        // Version Control section (TPT62). Reports the RAW stored values, unlike
        // vcs-settings.js's fetchVcsSettings()/normalizeVcsSettings() which the agent-prompt
        // path uses — that one masks the four flags to false whenever vcs_type isn't 'git'
        // (dormant-flag rule, C1213). A settings FORM must show what's actually stored so a
        // git→svn→git round trip doesn't look like it lost the user's checkbox choices; the
        // web twin (api/web/src/pages/settings.js renderVersionControlTab) does the same.
        // Flags are MySQL TINYINT 0/1 (migrations 049 and 076), hence !! not === true.
        vcsType: project?.vcs_type === 'git' || project?.vcs_type === 'svn' ? project.vcs_type : null,
        vcsWorktreeEnabled: !!project?.vcs_worktree_enabled,
        vcsCommitEnabled: !!project?.vcs_commit_enabled,
        vcsPrEnabled: !!project?.vcs_pr_enabled,
        vcsMergeEnabled: !!project?.vcs_merge_enabled,
      }));
    }

    // TPT12 — GET /api/project/notifications — the caller's per-project `notifications`
    // inbox rows (TPT10), same-origin proxy so the renderer never holds API credentials.
    // Drives the board's per-card activity chip + OS push, NOT the modal's Notifications
    // tab (that's TPT17's separate /api/tasks/:id/events proxy above, backed by the
    // task_events audit log). Query: unread_only, limit, offset, task_key — all optional,
    // forwarded as-is to backend.getNotifications().
    if (req.method === 'GET' && urlPath === '/api/project/notifications') {
      try {
        const q = new URL(req.url, 'http://localhost').searchParams;
        const result = typeof backend.getNotifications === 'function'
          ? await backend.getNotifications({
            unreadOnly: q.get('unread_only') === 'true',
            limit: q.has('limit') ? Number(q.get('limit')) : undefined,
            offset: q.has('offset') ? Number(q.get('offset')) : undefined,
            taskKey: q.get('task_key') || undefined,
          })
          : { notifications: [], unread_count: 0, total: 0 };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // TPT12 — POST /api/project/notifications/read — batched mark-read, body { ids: [...] }.
    // Batched deliberately: a scroll/open event marking several rows read at once must not
    // fire one renderer request per id. Promise.allSettled — one bad id (already deleted,
    // belongs to another user) must not roll back the rest; the client reconciles per id
    // from `results`, not from a bare count.
    if (req.method === 'POST' && urlPath === '/api/project/notifications/read') {
      let body = await readTextBody(req, res);
      if (body === null) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      const ids = Array.isArray(parsed?.ids) ? parsed.ids : [];
      if (typeof backend.markNotificationRead !== 'function' || ids.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ read: 0, results: [] }));
      }
      const settled = await Promise.allSettled(ids.map((id) => backend.markNotificationRead(id)));
      const results = settled.map((s, i) => ({ id: ids[i], ok: s.status === 'fulfilled' && s.value != null }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ read: results.filter((r) => r.ok).length, results }));
    }

    // POST /api/project/statuses — Workflow tab: add a status (C1182)
    if (req.method === 'POST' && urlPath === '/api/project/statuses') {
      let body = await readTextBody(req, res);
      if (body === null) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      if (typeof backend.createStatus !== 'function') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Custom statuses require API backend' }));
      }
      try {
        const status = await backend.createStatus(parsed);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status }));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // PUT /api/project/statuses/reorder — Workflow tab: drag reorder (C1182). Must be
    // registered before the generic PATCH/DELETE .../:id routes below (same ordering
    // discipline as the API's own purge-reservations-before-:taskKey precedent).
    if (req.method === 'PUT' && urlPath === '/api/project/statuses/reorder') {
      let body = await readTextBody(req, res);
      if (body === null) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      if (typeof backend.reorderStatuses !== 'function') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Custom statuses require API backend' }));
      }
      try {
        const statuses = await backend.reorderStatuses(parsed.ids);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ statuses }));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // PATCH /api/project/statuses/:id — Workflow tab: rename/recolor/move-a-role (C1182)
    const statusPatchMatch = req.method === 'PATCH' && urlPath.match(/^\/api\/project\/statuses\/(\d+)$/);
    if (statusPatchMatch) {
      const statusId = statusPatchMatch[1];
      let body = await readTextBody(req, res);
      if (body === null) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      if (typeof backend.updateStatus !== 'function') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Custom statuses require API backend' }));
      }
      try {
        const status = await backend.updateStatus(statusId, parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status }));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // DELETE /api/project/statuses/:id — Workflow tab: delete a status (C1182)
    const statusDeleteMatch = req.method === 'DELETE' && urlPath.match(/^\/api\/project\/statuses\/(\d+)$/);
    if (statusDeleteMatch) {
      const statusId = statusDeleteMatch[1];
      if (typeof backend.deleteStatus !== 'function') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Custom statuses require API backend' }));
      }
      try {
        await backend.deleteStatus(statusId);
        // 200 + JSON, not the underlying API's 204 — matches this file's own DELETE
        // convention (see DELETE /api/tasks/:id above) that api-client.js's `_http()`
        // relies on (`res.json()` on every 2xx; a bare 204 has no body to parse).
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/project/tasks — key+title+status+dependencies list for the dependency
    // typeahead (C1093: dependencies included so the client can build a full dep graph
    // and filter cycle-causing candidates, not just {id, title, status}). (TPT59) Also
    // carries dbId/parentDbId when present — the client's subtask-chain.js walks this
    // list by numeric parentDbId to reconstruct a full breadcrumb ancestor chain.
    // Conditional spreads, not `?? null`: this list also feeds patchCachedBoardTasks(),
    // which merges each row into already-cached board tasks — an explicit null would
    // wipe a real dbId there instead of just omitting the key.
    if (req.method === 'GET' && urlPath === '/api/project/tasks') {
      try {
        const all = await backend.getTasksUnfiltered();
        const tasks = (all || [])
          .filter(t => !t.isReservation)
          .map(t => ({
            id: t.id,
            title: t.title,
            status: t.status,
            dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
            ...(t.dbId != null ? { dbId: t.dbId } : {}),
            ...(t.parentDbId != null ? { parentDbId: t.parentDbId } : {}),
          }));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify({ tasks }));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/connection-state — SSE stream of backend connection state changes (browser mode)
    if (req.method === 'GET' && urlPath === '/api/connection-state') {
      const b = resolveBackend(req);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const writeState = (state, message) => {
        try { res.write(`data: ${JSON.stringify({ state, message: message || null })}\n\n`); } catch {}
      };
      // Send current state immediately
      writeState(b.getConnectionState ? b.getConnectionState() : null);
      const unsub = b.onConnectionStateChange
        ? b.onConnectionStateChange((st, msg) => writeState(st, msg))
        : () => {};
      req.on('close', unsub);
      return;
    }

    // GET /api/project-info — returns API base URL + project ID (no secret token)
    if (req.method === 'GET' && urlPath === '/api/project-info') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        apiBaseUrl: config.API_BASE_URL || '',
        projectId: config.API_PROJECT_ID || '',
        projectName: config.projectName || '',
      }));
    }

    // GET /api/project-config — credential-safe settings for browser-mode reauth.
    if (req.method === 'GET' && urlPath === '/api/project-config') {
      // C1124 — header-scoped root (mirrors the ~15 other routes already keying off this
      // header for Electron multi-window): config.PROJECT_ROOT is the forked server's
      // process-global startup snapshot, not necessarily the requesting window's project.
      const projectRoot = req.headers['x-tipatask-project'] || config.PROJECT_ROOT;
      const cfg = readProjectConfig(projectRoot) || {};
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      const { rendererProjectConfig } = require('./project-config');
      return res.end(JSON.stringify({ projectPath: projectRoot, config: rendererProjectConfig(cfg) }));
    }

    // POST /api/project-config — saves updated project config (browser-mode reauth)
    if (req.method === 'POST' && urlPath === '/api/project-config') {
      let body = await readTextBody(req, res);
      if (body === null) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      // C1124 — header-scoped root (see GET above) + try/catch: a write that throws (bad
      // root, read-only bundle in a packaged build) used to become an unhandled rejection
      // that killed the whole app (see index.js's process.on('unhandledRejection') and the
      // Coding Agent crash writeup in tt-electron-app.md) — now it's just a 500.
      try {
        const projectRoot = req.headers['x-tipatask-project'] || config.PROJECT_ROOT;
        const { writeProjectConfig, mergeRendererProjectConfig } = require('./project-config');
        // (TPT95) Never let a raw client array reach the TOML writer as-is — it becomes
        // Codex section content verbatim (readBrowserToolSelection() re-validates too,
        // this is defense-in-depth against a malformed/crafted value getting persisted
        // to config.json in the first place).
        if ('MCP_BROWSER_TOOLS' in parsed) {
          const { normalizeBrowserToolIds } = require('../codex-mcp-config');
          parsed.MCP_BROWSER_TOOLS = normalizeBrowserToolIds(parsed.MCP_BROWSER_TOOLS);
        }
        const existing = readProjectConfig(projectRoot) || {};
        const merged = mergeRendererProjectConfig(existing, parsed, { allowApiToken: true });
        writeProjectConfig(projectRoot, merged);
        // Trigger a reconnect probe so SSE clients receive 'connected' after token refresh
        const b = resolveBackend(req);
        if (b.reconfigureAndProbe) b.reconfigureAndProbe(null).catch(() => {});
        // (C1202) Browser-mode counterpart of main/ipc/api-router.js's mergeConfig hook —
        // pre-warm when this write switches the project onto local voice. Fire-and-forget.
        if (('voicePreset' in parsed || 'voiceLocalModel' in parsed) && merged.voicePreset === 'local' && merged.voiceLocalModel) {
          require('./voice-prewarm').prewarmVoice(projectRoot, { reason: 'voice-settings save' }).catch(() => {});
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[ws-handlers] POST /api/project-config failed:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // (C1259) Debug ▸ click-to-render perf log (src/client/perf-log.js). Append-only
    // NDJSON, one file per calendar day, under USER_DATA_ROOT — machine-wide like the
    // voice-model store (voice-model-manager.js), not per-project, so a project switch
    // mid-session doesn't fragment the log. Gated on the requesting project's own
    // debugPerfLog flag (Settings ▸ Debug row): a POST from a stale/misconfigured client
    // with the flag off is a silent no-op 204, never a write. GET returns { enabled, path }
    // so the Settings modal can show/copy the path without duplicating the date-stamp logic.
    if (urlPath === '/api/debug/perf') {
      const projectRoot = req.headers['x-tipatask-project'] || config.PROJECT_ROOT;
      const cfg = readProjectConfig(projectRoot) || {};
      const logPath = path.join(config.USER_DATA_ROOT, 'logs', `perf-${new Date().toISOString().slice(0, 10)}.log`);

      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ enabled: !!cfg.debugPerfLog, path: logPath }));
      }

      if (req.method === 'POST') {
        if (!cfg.debugPerfLog) {
          res.writeHead(204);
          return res.end();
        }
        let body = await readTextBody(req, res);
        if (body === null) return;
        let parsed;
        try { parsed = JSON.parse(body); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        if (entries.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, written: 0 }));
        }
        try {
          await fs.mkdir(path.dirname(logPath), { recursive: true });
          const lines = entries.map(e => JSON.stringify({ ...e, loggedAt: new Date().toISOString() })).join('\n') + '\n';
          await fs.appendFile(logPath, lines, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, written: entries.length }));
        } catch (err) {
          console.error('[ws-handlers] POST /api/debug/perf failed:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: err.message }));
        }
      }
    }

    // (C1202) POST /api/voice-prewarm — internal, fire-and-forget trigger. Sole caller today:
    // main/ipc/api-router.js's mergeConfig handler, pinging the forked server after the
    // PACKAGED app's Settings > Voice save (which writes via Electron IPC, never through the
    // POST /api/project-config route above — that route only serves browser-mode). Always
    // 202'd immediately; the actual warm (or no-op) happens after response. See
    // voice-prewarm.js for the local/ready gating — this route never triggers a download.
    if (req.method === 'POST' && urlPath === '/api/voice-prewarm') {
      let body = await readTextBody(req, res);
      if (body === null) return;
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch { /* modelId optional, ignore bad body */ }
      const projectRoot = req.headers['x-tipatask-project'] || config.PROJECT_ROOT;
      require('./voice-prewarm').prewarmVoice(projectRoot, { modelId: parsed.modelId || null, reason: 'prewarm ping' }).catch(() => {});
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    // Proxy allowed project settings through backend.updateProject so credentials
    // stay server-side and cached settings invalidate. Older language-only clients
    // remain valid; unconfigured projects use local settings only.
    if (req.method === 'PATCH' && urlPath === '/api/project') {
      let body = await readTextBody(req, res);
      if (body === null) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      const patch = {};
      if (parsed.language !== undefined) {
        const language = typeof parsed.language === 'string' ? parsed.language.trim() : '';
        if (!language || language.length > 10) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'language must be a non-empty string of at most 10 chars' }));
        }
        patch.language = language;
      }
      if (parsed.task_group_label !== undefined) {
        // Hand-mirrors api/src/lib/task-group-labels.js's TASK_GROUP_LABELS — this
        // server can't require() the API package's lib, same convention group-label.js
        // and the web app's settings.js already follow.
        const TASK_GROUP_LABELS = ['Sprints', 'Batches', 'Bags', 'Jars', 'Groups', 'Steps'];
        if (!TASK_GROUP_LABELS.includes(parsed.task_group_label)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `task_group_label must be one of: ${TASK_GROUP_LABELS.join(', ')}` }));
        }
        patch.task_group_label = parsed.task_group_label;
      }
      if (parsed.color_scheme !== undefined) {
        // Hand-mirrors api/src/lib/color-schemes.js's COLOR_SCHEMES (C1305) — same
        // "this server can't require() the API package's lib" reasoning as
        // task_group_label above. Task App Settings ▸ Theme select PATCHes here so a
        // project's palette is a shared DB value, not a per-machine one (C1305).
        const COLOR_SCHEMES = [
          'default',
          'parchment', 'latte', 'meadow', 'arctic', 'terracotta', 'sakura', 'citrus', 'slate', 'lagoon', 'iris', 'paper',
          'mocha', 'ocean', 'ember', 'forest', 'nord', 'rose', 'graphite', 'espresso', 'neon', 'ink',
        ];
        if (!COLOR_SCHEMES.includes(parsed.color_scheme)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `color_scheme must be one of: ${COLOR_SCHEMES.join(', ')}` }));
        }
        patch.color_scheme = parsed.color_scheme;
      }
      if (parsed.sprints_enabled !== undefined) {
        // C1332 — hand-mirrors api/src/routes/projects.js's C1330 validation: strict
        // boolean, no 0/1/'true' coercion, same convention as task_group_label/color_scheme
        // above (this server can't require() the API package's route module).
        if (typeof parsed.sprints_enabled !== 'boolean') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'sprints_enabled must be a boolean' }));
        }
        patch.sprints_enabled = parsed.sprints_enabled;
      }
      if (parsed.kb_sync_as_you_go !== undefined) {
        // C1490 — hand-mirrors api/src/routes/projects.js's C1488 validation: strict
        // boolean, no 0/1/'true' coercion, same convention as sprints_enabled above.
        if (typeof parsed.kb_sync_as_you_go !== 'boolean') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'kb_sync_as_you_go must be a boolean' }));
        }
        patch.kb_sync_as_you_go = parsed.kb_sync_as_you_go;
      }
      if (parsed.use_objective_grouping !== undefined) {
        // C1558 — hand-mirrors api/src/routes/projects.js's C1556 validation: strict
        // boolean, no 0/1/'true' coercion, same convention as sprints_enabled/
        // kb_sync_as_you_go above.
        if (typeof parsed.use_objective_grouping !== 'boolean') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'use_objective_grouping must be a boolean' }));
        }
        patch.use_objective_grouping = parsed.use_objective_grouping;
      }
      if (parsed.sprint_sort_order !== undefined) {
        // C1577 — hand-mirrors api/src/lib/sprint-sort-order.js's SPRINT_SORT_ORDERS, same
        // "this server can't require() the API package's lib" reasoning as
        // task_group_label/color_scheme above.
        const SPRINT_SORT_ORDERS = ['asc', 'desc'];
        if (!SPRINT_SORT_ORDERS.includes(parsed.sprint_sort_order)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `sprint_sort_order must be one of: ${SPRINT_SORT_ORDERS.join(', ')}` }));
        }
        patch.sprint_sort_order = parsed.sprint_sort_order;
      }
      if (parsed.vcs_type !== undefined) {
        // TPT61 — '' (Disabled radio's value) normalizes to null, matching the DB column's
        // off-state (migration 049: ENUM('git','svn') NULL DEFAULT NULL). The git/svn-only
        // check is deliberately loose here — the API's buildVcsPatch() is the real gate.
        const vcsType = parsed.vcs_type === '' ? null : parsed.vcs_type;
        if (vcsType !== null && vcsType !== 'git' && vcsType !== 'svn') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: "vcs_type must be 'git', 'svn', or null" }));
        }
        patch.vcs_type = vcsType;
      }
      for (const field of ['vcs_worktree_enabled', 'vcs_commit_enabled', 'vcs_pr_enabled', 'vcs_merge_enabled']) {
        if (parsed[field] === undefined) continue;
        if (typeof parsed[field] !== 'boolean') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `${field} must be a boolean` }));
        }
        patch[field] = parsed[field];
      }
      if (Object.keys(patch).length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No supported fields to update' }));
      }
      const { projectId, apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
      if (!projectId || !apiBaseUrl || !apiToken) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, skipped: true }));
      }
      if (typeof backend.updateProject !== 'function') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Project settings require API backend' }));
      }
      try {
        const project = await backend.updateProject(patch);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, project }));
      } catch (err) {
        const status = err.statusCode || (err.networkError ? 502 : 500);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/config — returns current CLAUDE_MODEL, CODEX_MODEL, and TASK_AGENT (project config wins over hard default)
    if (req.method === 'GET' && urlPath === '/api/config') {
      // C1124 — header-scoped root, see POST /api/project-config above.
      const projectRoot = req.headers['x-tipatask-project'] || config.PROJECT_ROOT;
      const cfg = readProjectConfig(projectRoot) || {};
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        CLAUDE_MODEL: cfg.CLAUDE_MODEL !== undefined ? cfg.CLAUDE_MODEL : (config.CLAUDE_MODEL || 'opusplan'),
        CODEX_MODEL: cfg.CODEX_MODEL !== undefined ? cfg.CODEX_MODEL : (config.CODEX_MODEL || ''),
        TASK_AGENT: cfg.TASK_AGENT || config.TASK_AGENT || 'claude',
      }));
    }

    // POST /api/config — persist CLAUDE_MODEL / CODEX_MODEL / TASK_AGENT; mutates in-memory config (next spawn only)
    if (req.method === 'POST' && urlPath === '/api/config') {
      let body = await readTextBody(req, res);
      if (body === null) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      const { CLAUDE_MODEL, CODEX_MODEL, TASK_AGENT } = parsed;
      // C1124 — header-scoped root, needed here (not just at the write below) so
      // isModelAllowed() can accept a value already saved in THIS project's config.json
      // even after it rotates out of the live/static lists (C1504).
      const _validateProjectRoot = req.headers['x-tipatask-project'] || config.PROJECT_ROOT;
      // (C1504) Was a bare config.CLAUDE_MODELS.includes(x)/config.CODEX_MODELS.includes(x) —
      // that static allowlist is now just ONE of isModelAllowed()'s three sources (live probe
      // cache ∪ static list ∪ this project's already-saved value), so a model the live
      // registry just discovered (or one saved before the registry existed) is still
      // accepted. Cache-only (peekModels(), no probe) — a settings save must never block on
      // a cold probe.
      if (CLAUDE_MODEL !== undefined && CLAUDE_MODEL !== '' && !isModelAllowed('claude', CLAUDE_MODEL, _validateProjectRoot, config)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Invalid CLAUDE_MODEL. Must be one of: ${config.CLAUDE_MODELS.join(', ')}, a live-discovered model, or empty string` }));
      }
      if (CODEX_MODEL !== undefined && CODEX_MODEL !== '' && !isModelAllowed('codex', CODEX_MODEL, _validateProjectRoot, config)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Invalid CODEX_MODEL. Must be one of: ${config.CODEX_MODELS.join(', ')}, a live-discovered model, or empty string` }));
      }
      if (TASK_AGENT !== undefined) {
        // (C1259) Peek — only `.id` (Object.keys(_factories), same 3 ids regardless of
        // availability) is read here, never `.available`, so the non-blocking variant is
        // behavior-identical and removes a spawnSync-blocking opportunity from every
        // agent-config save.
        const { listTaskAgentStatusesPeek } = require('./task-agent');
        const knownIds = listTaskAgentStatusesPeek(config).map(a => a.id);
        if (!knownIds.includes(TASK_AGENT)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Invalid TASK_AGENT. Must be one of: ${knownIds.join(', ')}` }));
        }
      }
      // C1124 — header-scoped root (was config.PROJECT_ROOT — the forked server's process-
      // global startup snapshot, wrong for any window that isn't that project, and inside a
      // read-only packaged app bundle when TIPATASK_PROJECT_ROOT was never set at all) +
      // try/catch: a writeProjectConfig() throw here used to become an unhandled rejection
      // that killed the whole Electron app (this was the "changing Coding Agent crashes"
      // bug — see index.js's process.on('unhandledRejection') and tt-electron-app.md).
      try {
        const projectRoot = req.headers['x-tipatask-project'] || config.PROJECT_ROOT;
        const { writeProjectConfig } = require('./project-config');
        const existing = readProjectConfig(projectRoot) || {};
        const updates = {};
        if (CLAUDE_MODEL !== undefined) updates.CLAUDE_MODEL = CLAUDE_MODEL;
        if (CODEX_MODEL !== undefined) updates.CODEX_MODEL = CODEX_MODEL;
        if (TASK_AGENT !== undefined) {
          updates.TASK_AGENT = TASK_AGENT;
          // C1131 — LAST_AGENT (project-scoped implicit default, set on every real task
          // launch) otherwise outranks TASK_AGENT in resolveTaskAgentId()'s precedence and
          // would silently shadow an explicit Settings-modal pick. Mirroring it here keeps
          // "save in Settings" behaving like "the thing I just picked applies next".
          updates.LAST_AGENT = TASK_AGENT;
          // Ensure AVAILABLE_AGENTS includes the newly selected agent. Built from THIS
          // project's own on-disk value only — never the global config.AVAILABLE_AGENTS, which
          // would persist the server's boot-project allowlist into an unrelated project's file.
          // Normalized defensively (disk value is a CSV string, but tolerate an array).
          const _rawAvail = existing.AVAILABLE_AGENTS || 'claude';
          const existingAvail = (Array.isArray(_rawAvail) ? _rawAvail : String(_rawAvail).split(','))
            .map((s) => s.trim()).filter(Boolean);
          if (!existingAvail.includes(TASK_AGENT)) existingAvail.push(TASK_AGENT);
          updates.AVAILABLE_AGENTS = existingAvail.join(',');
        }
        writeProjectConfig(projectRoot, { ...existing, ...updates });
        // Model defaults still refresh the in-memory singleton (no per-project view exists for
        // them). TASK_AGENT/AVAILABLE_AGENTS deliberately do NOT: this one server process is
        // shared by every open project window, and any project without its own AVAILABLE_AGENTS
        // key falls through to the singleton — writing here would leak this project's allowlist
        // into every other window. Readers resolve them per project instead
        // (configForProject() / resolveTaskAgentId()), live from .tipatask/config.json.
        if (CLAUDE_MODEL !== undefined) config.CLAUDE_MODEL = CLAUDE_MODEL || 'opusplan';
        if (CODEX_MODEL !== undefined) config.CODEX_MODEL = CODEX_MODEL || '';
        const _savedAgent = updates.TASK_AGENT || existing.TASK_AGENT || config.TASK_AGENT;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, CLAUDE_MODEL: config.CLAUDE_MODEL, CODEX_MODEL: config.CODEX_MODEL, TASK_AGENT: _savedAgent }));
      } catch (err) {
        console.error('[ws-handlers] POST /api/config failed:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/agents-config — safe Pi rows and summary for Settings. A configured flag
    // and row reference let the editor keep a stored key without reading its value.
    if (req.method === 'GET' && urlPath === '/api/agents-config') {
      const projectRoot = req.headers['x-tipatask-project'] || config.PROJECT_ROOT;
      const cfg = readProjectConfig(projectRoot) || {};
      const agents = summarizeAgents(cfg, _agentLabels());
      const { rendererPiModels } = require('./project-config');
      const piRows = rendererPiModels(cfg);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        selection: {
          // agents.taskAgent is the LAST_AGENT-resolved EFFECTIVE default (matching the
          // Settings row summary below), not necessarily raw TASK_AGENT — pre-filling the
          // modal's Default radio with "what will actually run next" rather than a possibly-
          // stale explicit setting.
          taskAgent: agents.taskAgent,
          availableAgents: agents.availableAgents,
          piModels: piRows,
          claudeModel: agents.claudeModel,
          codexModel: agents.codexModel,
        },
        agents,
      }));
    }

    // POST /api/agents-config — Edit Agents modal save (C1124). Normal path does the ONE
    // config write (TASK_AGENT/AVAILABLE_AGENTS/PI_MODELS/CLAUDE_MODEL/CODEX_MODEL together
    // via buildAgentsConfigPatch), replacing the old per-field POST /api/config round trips.
    // `applyOnly:true` (sent by agents-modal.js right after the Electron
    // api:project.saveAgents IPC already did the real per-window disk write) does ZERO fs —
    // it only refreshes the singleton's CLAUDE_MODEL/CODEX_MODEL defaults. Neither branch
    // touches config.TASK_AGENT/config.AVAILABLE_AGENTS: those stay boot-time values, because
    // this one process serves every project window and the singleton is the fallback for any
    // project with no AVAILABLE_AGENTS of its own. The agent gates read the saving project's
    // .tipatask/config.json live (configForProject() / resolveTaskAgentId()), so a save still
    // takes effect without a restart.
    if (req.method === 'POST' && urlPath === '/api/agents-config') {
      let body = await readTextBody(req, res);
      if (body === null) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      try {
        const { applyOnly, ...selection } = parsed;
        let merged;
        if (applyOnly) {
          // The IPC write already resolved preserve actions against the bound project.
          // This branch only refreshes process-local model defaults.
          merged = buildAgentsConfigPatch({}, { ...selection, piModels: undefined });
        } else {
          const projectRoot = req.headers['x-tipatask-project'] || config.PROJECT_ROOT;
          const { writeProjectConfig } = require('./project-config');
          const existing = readProjectConfig(projectRoot) || {};
          merged = buildAgentsConfigPatch(existing, selection);
          writeProjectConfig(projectRoot, merged);
        }
        // Model defaults only — see the header comment for why TASK_AGENT/AVAILABLE_AGENTS
        // are never written to the singleton.
        if (merged.CLAUDE_MODEL !== undefined) config.CLAUDE_MODEL = merged.CLAUDE_MODEL || 'opusplan';
        if (merged.CODEX_MODEL !== undefined) config.CODEX_MODEL = merged.CODEX_MODEL || '';
        // An agents save is the moment a just-installed CLI gets enabled: re-detect in THIS
        // process (its caches are separate from Electron main's, which is where the modal's
        // own detection ran) and push the fresh provider list to open clients, so an
        // already-open objective chat gains the new provider without a restart. Best-effort —
        // never fails the save.
        try {
          await refreshAgentDetection(config);
          _broadcastProvidersChanged(resolveProjectRoot(req));
        } catch (e) { console.warn('[ws-handlers] providers refresh after agents save failed:', e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, agents: summarizeAgents(merged, _agentLabels()) }));
      } catch (err) {
        console.error('[ws-handlers] POST /api/agents-config failed:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    if (urlPath.startsWith('/api/trello/')) {
      const _ctx = resolveProjectContext(req, backend);
      console.log('[ws-handlers] trello %s %s header=%s ctx.projectId=%s', req.method, urlPath, req.headers['x-tiptask-project-path'] || '<none>', _ctx.projectId);
    }

    // POST /api/trello/cards/:cardId/apply-to-task — proxy to Tipatask project API
    const applyToTaskMatch = req.method === 'POST'
      && urlPath.match(/^\/api\/trello\/cards\/([^/]+)\/apply-to-task$/);
    if (applyToTaskMatch) {
      const cardId = decodeRequestComponent(applyToTaskMatch[1]);
      let body = await readTextBody(req, res);
      if (body === null) return;
      try {
        const { projectId, apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        if (!projectId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'API_PROJECT_ID not configured' }));
        }
        const apiUrl = `${apiBaseUrl}/api/projects/${projectId}/trello/cards/${encodeURIComponent(cardId)}/apply-to-task`;
        const apiResp = await fetch(apiUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          body,
        });
        const data = await apiResp.json();
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/trello/cards/:cardId/images — proxy card-image upload to Tipatask project API
    // Must be ordered before the generic /api/trello/cards/:cardId handler below.
    const cardImagesMatch = req.method === 'GET' && urlPath.match(/^\/api\/trello\/cards\/([^/]+)\/images$/);
    if (cardImagesMatch) {
      const cardId = decodeRequestComponent(cardImagesMatch[1]);
      try {
        const { projectId, apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        if (!projectId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'API_PROJECT_ID not configured' }));
        }
        const apiUrl = `${apiBaseUrl}/api/projects/${encodeURIComponent(projectId)}/trello/cards/${encodeURIComponent(cardId)}/images`;
        const apiResp = await fetch(apiUrl, { headers: { Authorization: `Bearer ${apiToken}` } });
        const data = await apiResp.json();
        // Rewrite relative image URLs to absolute — required for isInternalImageUrl() in image-attach.js
        const base = (apiBaseUrl || '').replace(/\/+$/, '');
        if (data.images && base) {
          data.images = data.images.map(img => ({
            ...img,
            url: img.url && img.url.startsWith('/') ? `${base}${img.url}` : img.url,
          }));
        }
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/trello/cards/:cardId — proxy single-card fetch to Tipatask API
    if (req.method === 'GET' && urlPath.startsWith('/api/trello/cards/')) {
      const cardId = decodeRequestComponent(urlPath.slice('/api/trello/cards/'.length));
      if (!cardId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'cardId required' }));
      }
      try {
        const { apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        const apiUrl = `${apiBaseUrl}/api/trello/cards/${encodeURIComponent(cardId)}`;
        const apiResp = await fetch(apiUrl, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        const data = await apiResp.json();
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/trello/status — proxy to Tipatask API
    if (req.method === 'GET' && urlPath === '/api/trello/status') {
      try {
        const { apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        const apiResp = await fetch(`${apiBaseUrl}/api/trello/status`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        const data = await apiResp.json();
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/trello/auth/initiate — proxy to Tipatask API
    if (req.method === 'GET' && urlPath === '/api/trello/auth/initiate') {
      try {
        const { apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        const apiResp = await fetch(`${apiBaseUrl}/api/trello/auth/initiate`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        const data = await apiResp.json();
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/trello/image-proxy?url= — proxy Trello image bytes through Tipatask API
    if (req.method === 'GET' && urlPath === '/api/trello/image-proxy') {
      try {
        const { apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        const apiResp = await fetch(`${apiBaseUrl}/api/trello/image-proxy${queryString}`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        const buf = Buffer.from(await apiResp.arrayBuffer());
        res.writeHead(apiResp.status, {
          'Content-Type': apiResp.headers.get('content-type') || 'application/octet-stream',
          'Cache-Control': apiResp.headers.get('cache-control') || 'private, max-age=300',
        });
        return res.end(buf);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/trello/workspaces — proxy to Tipatask API
    if (req.method === 'GET' && urlPath === '/api/trello/workspaces') {
      try {
        const { apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        const apiResp = await fetch(`${apiBaseUrl}/api/trello/workspaces`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        const data = await apiResp.json();
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/trello/boards?workspaceId= — proxy to Tipatask API
    if (req.method === 'GET' && urlPath === '/api/trello/boards') {
      try {
        const { apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        const q = new URL(req.url, 'http://x').searchParams;
        const workspaceId = q.get('workspaceId') || '';
        const apiResp = await fetch(
          `${apiBaseUrl}/api/trello/boards?workspaceId=${encodeURIComponent(workspaceId)}`,
          { headers: { Authorization: `Bearer ${apiToken}` } }
        );
        const data = await apiResp.json();
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/trello/cards-list?boardId=&search= — proxy to upstream /api/trello/cards
    // (renamed to avoid collision with existing startsWith('/api/trello/cards/') single-card route)
    if (req.method === 'GET' && urlPath === '/api/trello/cards-list') {
      try {
        const { apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        const q = new URL(req.url, 'http://x').searchParams;
        const boardId = q.get('boardId') || '';
        const search = q.get('search') || '';
        let upstreamUrl = `${apiBaseUrl}/api/trello/cards?boardId=${encodeURIComponent(boardId)}`;
        if (search) upstreamUrl += `&search=${encodeURIComponent(search)}`;
        const apiResp = await fetch(upstreamUrl, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        const data = await apiResp.json();
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/trello/board-association — proxy to project-scoped Tipatask API
    if (req.method === 'GET' && urlPath === '/api/trello/board-association') {
      try {
        const { projectId, apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        if (!projectId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'API_PROJECT_ID not configured' }));
        }
        const apiResp = await fetch(
          `${apiBaseUrl}/api/projects/${projectId}/trello/board-association`,
          { headers: { Authorization: `Bearer ${apiToken}` } }
        );
        const data = await apiResp.json();
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/trello/board-association — proxy to project-scoped Tipatask API
    if (req.method === 'POST' && urlPath === '/api/trello/board-association') {
      let body = await readTextBody(req, res);
      if (body === null) return;
      try {
        const { projectId, apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        if (!projectId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'API_PROJECT_ID not configured' }));
        }
        const apiResp = await fetch(
          `${apiBaseUrl}/api/projects/${projectId}/trello/board-association`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
            body,
          }
        );
        const data = await apiResp.json();
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/trello/import — proxy to project-scoped Tipatask API
    if (req.method === 'POST' && urlPath === '/api/trello/import') {
      let body = await readTextBody(req, res);
      if (body === null) return;
      try {
        const { projectId, apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        if (!projectId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'API_PROJECT_ID not configured' }));
        }
        const apiResp = await fetch(
          `${apiBaseUrl}/api/projects/${projectId}/trello/import`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
            body,
          }
        );
        const data = await apiResp.json();
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/gmail/status — proxy to Tipatask API
    if (req.method === 'GET' && urlPath === '/api/gmail/status') {
      try {
        const { apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        const apiResp = await fetch(`${apiBaseUrl}/api/gmail/status`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        // C1551 — .catch(() => ({})) so a non-JSON error body (e.g. a front-proxy error
        // page in front of the API) degrades to an empty object instead of throwing into
        // the catch below and rewriting a real upstream status into a generic 502, which
        // would also drop a gmail_not_configured 503's `missing` var list.
        const data = await apiResp.json().catch(() => ({}));
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/gmail/auth/initiate — proxy to Tipatask API
    if (req.method === 'GET' && urlPath === '/api/gmail/auth/initiate') {
      try {
        const { apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        const apiResp = await fetch(`${apiBaseUrl}/api/gmail/auth/initiate`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        const data = await apiResp.json().catch(() => ({})); // C1551 — see /api/gmail/status above
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/gmail/threads — proxy thread list to Tipatask API (forward query string verbatim)
    if (req.method === 'GET' && urlPath === '/api/gmail/threads') {
      try {
        const { apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        const apiResp = await fetch(`${apiBaseUrl}/api/gmail/threads${qs}`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        const data = await apiResp.json().catch(() => ({})); // C1551 — see /api/gmail/status above
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/gmail/threads/:threadId — proxy thread detail to Tipatask API
    if (req.method === 'GET' && urlPath.startsWith('/api/gmail/threads/')) {
      try {
        const { apiBaseUrl, apiToken } = resolveProjectContext(req, backend);
        const threadId = decodeRequestComponent(urlPath.slice('/api/gmail/threads/'.length));
        const apiResp = await fetch(`${apiBaseUrl}/api/gmail/threads/${encodeURIComponent(threadId)}`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        const data = await apiResp.json().catch(() => ({})); // C1551 — see /api/gmail/status above
        res.writeHead(apiResp.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    const commentTaskKey = getTaskCommentKey(urlPath);

    // GET /api/tasks/:id/comments — task comments for edit modal
    if (req.method === 'GET' && commentTaskKey) {
      try {
        const comments = await backend.getTaskComments(commentTaskKey);
        if (comments == null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Task not found' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify({ comments }));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/tasks/:id/comments — create task comment through active backend
    if (req.method === 'POST' && commentTaskKey) {
      let body = await readTextBody(req, res);
      if (body === null) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      if (typeof parsed.content !== 'string' || parsed.content.trim().length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'content is required' }));
      }
      if (parsed.type !== undefined && !['comment', 'resolution', 'spec'].includes(parsed.type)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'type must be comment, resolution, or spec' }));
      }
      try {
        const comment = await backend.createTaskComment(commentTaskKey, parsed.content, parsed.type);
        if (!comment) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Task not found' }));
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ comment }));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // PATCH /api/tasks/:id/comments/:commentId — TPT34 author-only comment edit. Body-read/
    // validate/catch shape copied from the POST block above; the regex-matched id path
    // mirrors statusPatchMatch's shape further down. MUST stay before the generic
    // `PATCH /api/tasks/*` task-update catch-all below — that one matches on a bare
    // `startsWith('/api/tasks/')` and would otherwise swallow this path and try to parse
    // "TPT34/comments/42" as a task key.
    const commentEditTarget = req.method === 'PATCH' ? getTaskCommentEditTarget(urlPath) : null;
    if (commentEditTarget) {
      if (typeof backend.updateTaskComment !== 'function') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Comment editing requires API backend' }));
      }
      let body = await readTextBody(req, res);
      if (body === null) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      if (typeof parsed.content !== 'string' || parsed.content.trim().length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'content is required' }));
      }
      try {
        const comment = await backend.updateTaskComment(commentEditTarget.taskKey, commentEditTarget.commentId, parsed.content);
        if (!comment) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Comment not found' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ comment }));
      } catch (err) {
        // A business-rule 403 (not the comment's author) rides this path verbatim — see
        // api-backend.js's apiRequest `allowForbidden` branch.
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // TPT17 — Notifications tab: task-wide event log + subscription toggle, same proxy
    // shape as the comments routes above.
    const eventsTaskKey = getTaskEventsKey(urlPath);

    // GET /api/tasks/:id/events — reverse-chronological event log for edit modal Notifications tab
    if (req.method === 'GET' && eventsTaskKey) {
      try {
        const result = await backend.getTaskEvents(eventsTaskKey);
        if (result == null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Task not found' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    const subscriptionTaskKey = getTaskSubscriptionKey(urlPath);

    // PUT /api/tasks/:id/subscription — set caller's per-task mute/follow override
    if (req.method === 'PUT' && subscriptionTaskKey) {
      let subBody = await readTextBody(req, res);
      if (subBody === null) return;
      let subParsed;
      try {
        subParsed = JSON.parse(subBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      if (typeof subParsed.subscribed !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'subscribed must be a boolean' }));
      }
      try {
        const result = await backend.setTaskSubscription(subscriptionTaskKey, subParsed.subscribed);
        if (!result) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Task not found' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/images/:projectId/:imageId — proxy image bytes from Tipatask API (browser has no JWT)
    const imgMatch = req.method === 'GET' && urlPath.match(/^\/api\/images\/(\d+)\/(\d+)$/);
    if (imgMatch) {
      const [, projectId, imageId] = imgMatch;
      const imgCtx = resolveProjectContext(req, backend);
      try {
        const apiResp = await fetch(
          `${imgCtx.apiBaseUrl}/api/projects/${projectId}/images/${imageId}`,
          { headers: { Authorization: `Bearer ${imgCtx.apiToken}` } }
        );
        if (!apiResp.ok) {
          res.writeHead(apiResp.status);
          return res.end();
        }
        const buf = Buffer.from(await apiResp.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': apiResp.headers.get('content-type') || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        return res.end(buf);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/images — proxy image upload to Tipatask API; returns absolute URL
    if (req.method === 'POST' && urlPath === '/api/images') {
      let body = await readTextBody(req, res, IMAGE_BODY_MAX_BYTES);
      if (body === null) return;
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      try {
        const r = await uploadImageThroughBackend(backend, parsed);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(r));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/files/:projectId/:fileId — proxy file bytes from Tipatask API (browser has no
    // JWT). Clone of the image GET route above, plus passing through upstream
    // content-disposition (drives the browser download filename) and nosniff. (C1246)
    const fileMatch = req.method === 'GET' && urlPath.match(/^\/api\/files\/(\d+)\/(\d+)$/);
    if (fileMatch) {
      const [, projectId, fileId] = fileMatch;
      const fileCtx = resolveProjectContext(req, backend);
      try {
        const apiResp = await fetch(
          `${fileCtx.apiBaseUrl}/api/projects/${projectId}/files/${fileId}`,
          { headers: { Authorization: `Bearer ${fileCtx.apiToken}` } }
        );
        if (!apiResp.ok) {
          res.writeHead(apiResp.status);
          return res.end();
        }
        const buf = Buffer.from(await apiResp.arrayBuffer());
        const headers = {
          'Content-Type': apiResp.headers.get('content-type') || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        };
        const disposition = apiResp.headers.get('content-disposition');
        if (disposition) headers['Content-Disposition'] = disposition;
        res.writeHead(200, headers);
        return res.end(buf);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/files — proxy generic-file upload to Tipatask API; returns absolute URL.
    // The 1 MB decoded task_files limit remains authoritative in the API. This 1.6 MB
    // request envelope leaves room for base64 + JSON framing and rejects excess in flight.
    if (req.method === 'POST' && urlPath === '/api/files') {
      const body = await readCappedBody(req, res, 1_600_000, {
        error: 'File upload exceeds 1 MB limit',
        code: 'FILE_TOO_LARGE',
      });
      if (body === null) return; // readCappedBody already responded (413 or client disconnect)
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      try {
        const r = await uploadFileThroughBackend(backend, parsed);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(r));
      } catch (err) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/transcribe — (C1186) three-way branch on the project's Voice settings (C1178):
    //   'local'                          -> on-device sherpa-onnx inference, no network at all
    //   'assemblyai' + per-project key   -> direct AssemblyAI call from THIS server, bypassing
    //                                        the remote Tipatask API's own key/quota entirely
    //   else (assemblyai, no per-project key) -> unchanged proxy to the remote Tipatask API,
    //                                        byte-identical to the pre-C1186 behavior — every
    //                                        existing project with no key configured relies on
    //                                        this path continuing to work exactly as before.
    // See tt-audio-input.md for the full writeup. This is the FALLBACK batch path — C1185's
    // __voice__ WS relay (voice-stream/session.js) is what normally serves live recordings;
    // this route only fires when that relay delivered no final result (connection failure,
    // preset unavailable, local model not ready) or a caller hits it directly.
    if (req.method === 'POST' && urlPath === '/api/transcribe') {
      const projectRoot = resolveProjectRoot(req);
      const { voicePreset, voiceLocalModel, assemblyaiApiKey } = readVoiceSettings(projectRoot);
      const contentType = req.headers['content-type'] || '';
      const isMultipart = contentType.toLowerCase().startsWith('multipart/');

      // ── local preset — needs raw PCM16, not multipart; needs no Tipatask API credentials
      // at all, unlike the two branches below. ──────────
      if (voicePreset === 'local') {
        if (isMultipart) {
          res.writeHead(415, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Local transcription needs raw PCM16 audio, not multipart/form-data', code: 'NEEDS_PCM16' }));
        }
        const body = await readCappedBody(req, res, ASSEMBLYAI_MAX_AUDIO_BYTES);
        if (body === null) return; // 413 (oversize) or client-disconnect already handled+responded
        return handleLocalTranscribe(req, res, body, voiceLocalModel);
      }

      // ── assemblyai preset, per-project key configured — call AssemblyAI directly. ────────
      if (voicePreset === 'assemblyai' && assemblyaiApiKey) {
        if (isMultipart) {
          res.writeHead(415, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Direct AssemblyAI transcription needs a raw audio body, not multipart/form-data', code: 'NEEDS_RAW_AUDIO' }));
        }
        const body = await readCappedBody(req, res, ASSEMBLYAI_MAX_AUDIO_BYTES);
        if (body === null) return;
        return handleAssemblyAiTranscribe(res, body, assemblyaiApiKey);
      }

      // ── fallback: proxy multipart audio to the remote Tipatask API (client has no JWT) ──
      // Keep the body byte-identical, with room for framing above the upstream 25 MiB file cap.
      let transcriptionCtx;
      try {
        transcriptionCtx = resolveProjectContext(req, backend);
      } catch {
        transcriptionCtx = {};
      }
      if (!transcriptionCtx.apiBaseUrl || !transcriptionCtx.apiToken) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Transcription unavailable: no Tipatask API token configured for this project' }));
      }
      const body = await readCappedBody(req, res, MULTIPART_AUDIO_MAX_BYTES);
      if (body === null) return;
      try {
        const upstreamRes = await fetch(`${transcriptionCtx.apiBaseUrl}/api/transcribe`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${transcriptionCtx.apiToken}`,
            'Content-Type': req.headers['content-type'],
          },
          body,
        });
        const upstreamBody = await upstreamRes.text();
        res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
        return res.end(upstreamBody);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/transcribe/stream-token (C1185) — proxy a short-lived AssemblyAI streaming
    // token mint to the Tipatask API (client has no JWT, same reasoning as the multipart proxy
    // right above). Consumed by voice-stream/assemblyai-provider.js — NOT called from the
    // browser directly, since the __voice__ WS session (this same server) is what needs the
    // token to open the upstream socket. Kept as an HTTP route anyway (not folded into the WS
    // handshake) so it stays testable/curl-able on its own, matching the existing
    // POST /api/transcribe route's shape.
    if (req.method === 'GET' && urlPath === '/api/transcribe/stream-token') {
      let tokenCtx;
      try {
        tokenCtx = resolveProjectContext(req, backend);
      } catch {
        tokenCtx = {};
      }
      if (!tokenCtx.apiBaseUrl || !tokenCtx.apiToken) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Transcription unavailable: no Tipatask API token configured for this project' }));
      }
      try {
        const upstreamRes = await fetch(`${tokenCtx.apiBaseUrl}/api/transcribe/stream-token${new URL(req.url, 'http://x').search}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${tokenCtx.apiToken}` },
        });
        const upstreamBody = await upstreamRes.text();
        res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
        return res.end(upstreamBody);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // ── Voice models (C1176) — GET /api/voice-models[/:id], POST /api/voice-models/:id/download,
    // POST /api/voice-models/:id/abort, DELETE /api/voice-models/:id (C1197). Deliberately NOT
    // project-scoped: no x-tipatask-project
    // header read here, on purpose — voice-model-manager.js resolves everything off
    // config.USER_DATA_ROOT (a machine-wide store shared by every project), never off a project
    // root, so the C1124 "always key routes off the request's project header" rule doesn't
    // apply to this family. See voice-model-manager.js's header comment / tt-audio-input.md.
    const voiceModelMatch = urlPath.match(/^\/api\/voice-models(?:\/([A-Za-z0-9._-]+))?(?:\/(download|abort))?\/?$/);
    if (voiceModelMatch) {
      const [, modelId, action] = voiceModelMatch;
      try {
        if (req.method === 'GET' && !modelId) {
          const result = await listVoiceModels();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(result));
        }
        if (req.method === 'GET' && modelId && !action) {
          const status = await getVoiceModelStatus(modelId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(status));
        }
        if (req.method === 'POST' && modelId && action === 'download') {
          let body = await readTextBody(req, res);
          if (body === null) return;
          let parsed = {};
          if (body) {
            try { parsed = JSON.parse(body); } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
          }
          // Validate synchronously (throws VOICE_MODEL_UNKNOWN for a bad id) before
          // responding, so a typo'd modelId gets an immediate 4xx instead of a 202 followed
          // by a WS error nobody's listening for yet.
          if (!VOICE_MODEL_IDS.includes(modelId)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `Unknown voice model "${modelId}"`, code: VOICE_MODEL_ERRORS.UNKNOWN }));
          }
          // Fire-and-forget: a 650MB download can take minutes — holding the HTTP response
          // open that long would trip proxy/browser timeouts for no benefit, since progress
          // already streams over WS. Never await; the .catch() is required even though
          // index.js's unhandledRejection handler exists as a backstop (C1x) — don't rely on it.
          downloadVoiceModel(modelId, { onProgress: websocket.emitVoiceModelProgress })
            .then((result) => {
              websocket.emitVoiceModelComplete(result);
              // (C1202) A model finishing its download is exactly when the user is most likely
              // to record next — warm it now instead of on that first recording. No-ops unless
              // this project's voicePreset is 'local' AND this is the currently-selected model
              // (voice-prewarm.js), so downloading a model you're not about to use never pays
              // the ORT build cost early.
              require('./voice-prewarm').prewarmVoice(config.PROJECT_ROOT, { modelId, reason: 'download complete' }).catch(() => {});
            })
            .catch((err) => websocket.emitVoiceModelError({ modelId, code: err.code || VOICE_MODEL_ERRORS.NETWORK, message: err.message }));
          res.writeHead(202, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, modelId, state: 'downloading' }));
        }
        if (req.method === 'POST' && modelId && action === 'abort') {
          const aborted = abortVoiceModelDownload(modelId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, aborted }));
        }
        if (req.method === 'DELETE' && modelId && !action) {
          // (C1197) frees disk for a downloaded model. deleteVoiceModel() throws UNKNOWN for a
          // bad id (-> 404 below) and LOCKED while a download is in flight (-> 409 below).
          const result = await deleteVoiceModel(modelId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
          websocket.emitVoiceModelDeleted(result);
          return;
        }
        res.writeHead(405, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Method not allowed' }));
      } catch (err) {
        const status = err.code === VOICE_MODEL_ERRORS.UNKNOWN ? 404
          : err.code === VOICE_MODEL_ERRORS.LOCKED ? 409
          : (err.status && Number.isInteger(err.status) ? 502 : 500);
        console.error('[ws-handlers] voice-models route failed:', err.message);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message, code: err.code || null }));
      }
    }

    // GET /api/tasks/:id — fetch single task by id
    if (req.method === 'GET' && req.url.startsWith('/api/tasks/') && !req.url.includes('?')) {
      const id = decodeRequestComponent(req.url.slice('/api/tasks/'.length));
      if (id) {
        try {
          const task = await backend.getTask(id);
          if (!task) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Task not found' }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(task));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: err.message }));
        }
      }
    }

    // PATCH /api/tasks/:id
    if (req.method === 'PATCH' && req.url.startsWith('/api/tasks/')) {
      const id = decodeRequestComponent(req.url.slice('/api/tasks/'.length));
      let body = await readTextBody(req, res);
      if (body === null) return;

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      const { status, description, title, priority, tags, order, assignee, agent_assignee, sprint_id, claude_model, codex_model, pi_model, effort, claude_design_mode, dependencies, reopen_if_closed, is_objective } = parsed;

      // Validate status against THIS project's own registry (C1184), not a hardcoded
      // literal list — a project can rename/add/remove statuses. fetchStatusContext()
      // never throws and fail-softs to the legacy 5, so a registry hiccup only ever
      // costs a friendlier error message, never blocks a write — the API re-validates
      // every status write server-side too (api/src/routes/tasks.js).
      // (C1259) One call instead of a separate fetchStatusNames()+fetchStatusRoles()
      // pair — fetchStatusContext() already resolves both names and roles off the same
      // getStatuses() read; the old pair paid two awaits (the 2nd a cache hit, but still
      // a wasted round-trip) for data this one call already returns together.
      let statusContext = await fetchStatusContext(backend);
      if (status !== undefined && !statusContext.names.includes(status)) {
        // One forced re-read before rejecting: never reject on a stale (≤30s) cache —
        // a status renamed/created seconds ago in the web app must not 400 here.
        statusContext = await fetchStatusContext(backend, { refresh: true });
        if (!statusContext.names.includes(status)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Invalid status. Must be one of: ${statusContext.names.join(', ')}` }));
        }
      }
      const statusRoles = statusContext.roles;

      if (description !== undefined && typeof description !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Description must be a string' }));
      }

      if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Title must be a non-empty string' }));
      }

      if (priority !== undefined && (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Priority must be a positive integer' }));
      }

      if (sprint_id !== undefined && sprint_id !== null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'sprint_id must be null' }));
      }

      if (tags !== undefined && !Array.isArray(tags)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Tags must be an array' }));
      }

      if (dependencies !== undefined && dependencies !== null && !Array.isArray(dependencies)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'dependencies must be an array or null' }));
      }

      if (order !== undefined && (typeof order !== 'number' || !Number.isInteger(order) || order < 0)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Order must be a non-negative integer' }));
      }

      if (assignee !== undefined && assignee !== null && (typeof assignee !== 'number' || !Number.isInteger(assignee))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Assignee must be an integer or null' }));
      }

      const validAgentAssignees = ['human', 'claude', 'codex', 'pi'];
      if (agent_assignee !== undefined && agent_assignee !== null && !validAgentAssignees.includes(agent_assignee)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Invalid agent_assignee. Must be one of: ${validAgentAssignees.join(', ')} or null` }));
      }

      if (claude_model !== undefined && claude_model !== null && typeof claude_model !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'claude_model must be a string or null' }));
      }

      if (codex_model !== undefined && codex_model !== null && typeof codex_model !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'codex_model must be a string or null' }));
      }

      if (pi_model !== undefined && pi_model !== null && typeof pi_model !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'pi_model must be a string or null' }));
      }

      // TPT285: per-task effort level — shape check only; the API owns the enum
      // (normalizeEffort, 400 on an unknown level). null/'' clears to inherit.
      if (effort !== undefined && effort !== null && typeof effort !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'effort must be a string or null' }));
      }

      // C1207: real boolean, not a tri-state model override — null is accepted and
      // means "off" (the column has no third state).
      if (claude_design_mode !== undefined && claude_design_mode !== null && typeof claude_design_mode !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'claude_design_mode must be a boolean' }));
      }

      // C1165: chat-driven-edit opt-in flag — not a field to persist, so it does NOT
      // count toward the "must provide" guard below.
      if (reopen_if_closed !== undefined && typeof reopen_if_closed !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'reopen_if_closed must be a boolean' }));
      }

      // (C1559) adoptOriginKey()'s absent-origin PATCH fallback needs this to clear the
      // C1341 is_objective stamp when a web-origin task is refined in place — this HTTP
      // path previously dropped the field silently (the Electron IPC path already maps
      // it, api-backend.js updateTask()).
      if (is_objective !== undefined && typeof is_objective !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'is_objective must be a boolean' }));
      }

      if (status === undefined && description === undefined && title === undefined && priority === undefined && sprint_id === undefined && tags === undefined && order === undefined && assignee === undefined && agent_assignee === undefined && claude_model === undefined && codex_model === undefined && pi_model === undefined && effort === undefined && claude_design_mode === undefined && dependencies === undefined && is_objective === undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Must provide status, description, title, priority, sprint_id, tags, order, assignee, agent_assignee, dependencies, is_objective, and/or claude_model/codex_model/pi_model/effort/claude_design_mode' }));
      }

      try {
        const updateFields = { status, description, title, priority, tags, order, assignee, agentAssignee: agent_assignee, claudeModel: claude_model, codexModel: codex_model, piModel: pi_model, effort, claudeDesignMode: claude_design_mode, dependencies, isObjective: is_objective };
        if (sprint_id === null) updateFields.priority = 0;
        // C1165: objective-chat's absent-target PATCH fallback (buildModifiedTaskPatch)
        // sets this flag instead of a status when the proposal carried none — reopen a
        // completed/canceled target to in_progress. Runs before updateTask so the reopen
        // persists in the same PATCH; postDeviceSession below keys off the request's own
        // `status` const (still undefined here), so a reopen never claims a device session.
        if (reopen_if_closed === true) await applyReopenToPatch(backend, id, updateFields, 'chat-patch');
        const updateResult = await backend.updateTask(id, updateFields);
        if (!updateResult) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Task ${id} not found` }));
        }
        if (status === statusRoles.in_progress) postDeviceSession(id, backend); // C1184
        // (C1259) The online path (api-backend.js's _rawUpdateTask) already returns the
        // full, freshly-joined row — a second GET here
        // was a second serial WAN round-trip for data the PATCH response already had,
        // doubling every card-status-change's latency. Only the offline-queued optimistic
        // stub is flagged `_pendingSync` and can be missing joined fields (api-backend.js
        // updateTask()) — only THAT path re-fetches, and falls back to the stub itself
        // (not a 500) if the re-fetch also fails because the device is still offline.
        const fresh = updateResult._pendingSync
          ? (await backend.getTask(id).catch(() => null)) || updateResult
          : updateResult;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // (C1453) dbId/parentDbId added — refreshCard() (task-card.js) always writes both
        // onto the card's dataset from whatever this response carries, so their previous
        // absence here silently wiped the C1433 objective-subtree anchors off a card on
        // every local status/field write. Also lets applyTaskPatch()'s live subtask-count
        // update (task-board.js's refreshParentSubtaskLabel()) locate the parent card
        // without falling back to the card's own (about-to-be-overwritten) dataset hint.
        // (TPT3) parentRescheduled — the TPT2 parent-follow cascade, forwarded from
        // api-backend.js's _rawUpdateTask()'s `_parentRescheduled` meta field. `undefined`
        // when absent (no cascade fired, or the offline-queued `fresh` re-fetch above never
        // carries it) drops out of JSON.stringify on its own — no `if (…) {}` needed here.
        res.end(JSON.stringify({ ok: true, id, status: fresh.status, description: fresh.description, title: fresh.title, priority: fresh.priority, tags: fresh.tags, order: fresh.order, assignee: fresh.assignee, agentAssignee: fresh.agentAssignee, claudeModel: fresh.claudeModel, codexModel: fresh.codexModel, piModel: fresh.piModel, effort: fresh.effort ?? null, claudeDesignMode: fresh.claudeDesignMode, dependencies: fresh.dependencies, dbId: fresh.dbId, parentDbId: fresh.parentDbId, parentRescheduled: fresh._parentRescheduled }));
        // (C1259) Project-scoped when the client's project is known (Electron: main.js's
        // onBeforeSendHeaders injects x-tipatask-project on every request automatically, no
        // client change needed — see resolveBackend() above) — a card update now sends one
        // targeted frame to windows on THIS project, not every open window regardless of
        // project. Falls back to the unscoped broadcast (prior behavior) when absent
        // (browser mode / single-project server, where every connected client is on the
        // same project anyway). (C1392) A plain browser tab now also attaches this header
        // when opened as todo.html?projectPath=<abs> (client's projectHeader(), utils.js) —
        // that one browser-mode case narrows the broadcast too, same as Electron.
        websocket.emitTaskUpdated(fresh, { assigneeChanged: assignee !== undefined, agentAssigneeChanged: agent_assignee !== undefined }, req.headers['x-tipatask-project']);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // DELETE /api/tasks/:id
    if (req.method === 'DELETE' && req.url.startsWith('/api/tasks/')) {
      const id = decodeRequestComponent(req.url.slice('/api/tasks/'.length));
      try {
        const found = await backend.deleteTask(id);
        if (!found) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Task ${id} not found` }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
        websocket.emitTaskDeleted(id, req.headers['x-tipatask-project']); // (C1259) project-scoped — see PATCH handler above
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // PUT /api/todo — overwrite TODO.md with server-side new-task ID assignment.
    // Delegates to backend.overwriteRawWithRemap which holds the per-project lock,
    // reads live state, assigns final C##/H## keys for newTaskIds, then writes atomically.
    // Returns { ok: true, idRemap } so the client can update stale references.
    // A failure answers { error, step, code } with the status classifySaveError() picks
    // (todo-save-error.js): the write is not idempotent, so the client sends it once and
    // shows this body as-is — it has to carry the real reason.
    if (req.method === 'PUT' && req.url === '/api/todo') {
      let body = await readTextBody(req, res, BULK_BODY_MAX_BYTES);
      if (body === null) return;

      if (!body.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Body cannot be empty' }));
      }

      let _todoStep = 'resolve-backend';
      try {
        const _todoBackend = resolveBackend(req);
        _todoStep = 'status-context';
        const _todoStart = (await fetchStatusContext(_todoBackend)).roles.start;
        _todoStep = 'force-pending';
        body = forcePendingTodoPayloadNewTasks(body, 'todo-write', _todoStart);
        _todoStep = 'normalize-priorities';
        body = await require('./sprint-assign').normalizeObjectiveTodoPriorities(body, _todoBackend, config);
        _todoStep = 'promote-split-origin';
        body = await promoteSplitOriginInTodo(body, _todoBackend);
        _todoStep = 'persist';
        const idRemap = await _todoBackend.overwriteRawWithRemap(body);
        const idRemapObj = Object.fromEntries(idRemap);
        if (Object.keys(idRemapObj).length > 0) {
          console.log('[todo] PUT /api/todo assigned new task IDs:', idRemapObj);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, idRemap: idRemapObj }));
      } catch (err) {
        const failure = classifySaveError(err, _todoStep);
        // The stack matters for a failure nobody classified (or one behind this server);
        // a rejected payload is fully described by its message.
        console.error(
          `[todo] PUT /api/todo failed at ${failure.body.step} (${failure.status}${failure.body.code ? ` ${failure.body.code}` : ''}):`,
          failure.status >= 500 ? (err && err.stack) || failure.body.error : failure.body.error
        );
        res.writeHead(failure.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(failure.body));
      }
      return;
    }

    // GET /api/recipes
    if (req.method === 'GET' && req.url === '/api/recipes') {
      try {
        const recipes = await backend.getRecipes();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ recipes }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/recipes
    if (req.method === 'POST' && req.url === '/api/recipes') {
      let body = await readTextBody(req, res);
      if (body === null) return;

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      const { content } = parsed;
      if (!content || typeof content !== 'string' || !content.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'content must be a non-empty string' }));
      }

      try {
        const result = await backend.saveRecipe(content);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/user — current user info for frontend filter modal
    if (req.method === 'GET' && req.url === '/api/user') {
      const taskAgent = getTaskAgentInfo(resolveTaskAgentId(resolveProjectRoot(req), null));
      let userId = config.USER_ID;
      // (C1392) `backend` is resolveBackend(req)'s per-request pick (x-tipatask-project) —
      // id now follows that project's backend.getCurrentUserId() instead of always the
      // process-global config.USER_ID, since the client now attaches the header in browser
      // mode too (utils.js projectHeader()). This id feeds state.currentUser →
      // canStartTaskCard() card-ownership gating client-side, so a stale ?projectPath=
      // would change who the UI thinks "you" are — same risk Electron already carried.
      if (typeof backend.getCurrentUserId === 'function') {
        try { userId = await backend.getCurrentUserId(); } catch { /* keep config fallback */ }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        name: config.USER_NAME,
        id: userId,
        avatarUrl: config.USER_AVATAR_URL,
        taskAgent: taskAgent.id,
        taskAgentLabel: taskAgent.label,
        agentLabels: _agentLabels(),
        planApprovalCommand: taskAgent.approvalCommand,
        supportsPlanMode: taskAgent.supportsPlanMode,
      }));
    }

    // PUT /api/chat-state — persist chat state to temp file
    if (req.method === 'PUT' && req.url === '/api/chat-state') {
      const projectPath = req.headers['x-tipatask-project'];
      let body = await readTextBody(req, res, CHAT_BODY_MAX_BYTES);
      if (body === null) return;
      try {
        JSON.parse(body); // validate JSON
        await writeChatState(body, projectPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        const status = err instanceof SyntaxError ? 400 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/chat-state — read persisted chat state
    if (req.method === 'GET' && req.url === '/api/chat-state') {
      const projectPath = req.headers['x-tipatask-project'];
      try {
        const data = await readChatState(projectPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(data ?? '{}');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // DELETE /api/chat-state — remove persisted chat state
    if (req.method === 'DELETE' && req.url === '/api/chat-state') {
      const projectPath = req.headers['x-tipatask-project'];
      try {
        await deleteChatState(projectPath);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    // POST /api/objective/prewarm — trigger cold prewarm proc for first-turn latency reduction
    if (req.method === 'POST' && req.url === '/api/objective/prewarm') {
      if (!config.SIMPLE_MODE) {
        // Electron injects this header per BrowserWindow. Bind the cold proc's cwd and env to
        // that project so the first WS turn from the same window can adopt it.
        const reqRoot = req.headers['x-tipatask-project'] || config.PROJECT_ROOT;
        if (config.OBJECTIVE_PROVIDER === 'claude') prewarmObjectiveCold(reqRoot);
        const reqProjectId = projectEnvExtras(reqRoot).API_PROJECT_ID || config.API_PROJECT_ID;
        if (reqProjectId) prewarmArchCache({ projectId: reqProjectId, projectRoot: reqRoot });
      }
      res.writeHead(204);
      return res.end();
    }

    // DELETE /api/objective/prewarm — a chat tab closed before it ever started a server session:
    // drop the cold spare its composer warmed (the next composer keystroke re-warms one).
    if (req.method === 'DELETE' && req.url === '/api/objective/prewarm') {
      killColdPrewarm('tab-closed');
      res.writeHead(204);
      return res.end();
    }

    // GET /api/objective/queue-status — circuit breaker + queue depth metric
    if (req.method === 'GET' && req.url === '/api/objective/queue-status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
      return res.end(JSON.stringify(throttle.getStatus()));
    }

    // GET /api/objective/providers — chat-model-selector option list + project default.
    // Seeds state.objectiveProviders on page load (chat-ui.js), before any objective WS
    // exists — the WS `config` frame is otherwise the only writer, so the composer showed
    // no selector at all until the first turn (C1045).
    if (req.method === 'GET' && req.url === '/api/objective/providers') {
      // C1101 — project-scoped so a project's saved PI_MODEL ("Other Model") shows up
      // in the selector and matches what applyModelSelection will later accept.
      // (TPT162) resolveProjectRoot(req) — same idiom as the ~15 other project-scoped
      // routes in this file — instead of a bare `|| ''`, which short-circuited
      // configForProject() straight to the global config singleton (registry.js) whenever
      // the page URL carried no ?projectPath= (browser mode, or an unbound Electron window).
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
      return res.end(JSON.stringify(_buildProvidersPayload(resolveProjectRoot(req))));
    }

    // POST /api/objective/abort?taskId=obj-*[&tabId=…] — HTTP fallback for Stop when WS is closed
    if (req.method === 'POST' && req.url.startsWith('/api/objective/abort')) {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const tid = u.searchParams.get('taskId') || '';
      const tabIdParam = u.searchParams.get('tabId') || '';
      const abortProjPath = req.headers['x-tipatask-project'] || '';
      const s = sessions.get(sessKey(tabIdParam || tid, abortProjPath));
      if (!s || s.type !== 'objective') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Session not found' }));
      }
      console.log(`[objective] HTTP abort requested for task ${tid}`);
      s._aborted = true;
      clearRetryTimers(s);
      clearTurnDeadline(s);
      s._retrying = false;
      s._retryAttempt = 0;
      if (s.proc) {
        killObjectiveProc(s, 'SIGTERM');
        escalateKill(s, tid);
      }
      if (s.messages.length > 0 && s.messages[s.messages.length - 1].role === 'user') {
        s.messages.pop();
      }
      resetTurnBuffers(s);
      throttle.recordAbort(tid);
      if (s.ws && s.ws.readyState === s.ws.OPEN) {
        s.ws.send(JSON.stringify({ type: 'generation-aborted', tabId: s.tabId }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    // GET /api/objective/session?taskId=obj-*[&tabId=…] — reconnect probe
    if (req.method === 'GET' && req.url.startsWith('/api/objective/session')) {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const tid = u.searchParams.get('taskId') || '';
      const tabIdParam = u.searchParams.get('tabId') || '';
      const sessProjPath = req.headers['x-tipatask-project'] || '';
      const s = sessions.get(sessKey(tabIdParam || tid, sessProjPath));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!s || s.type !== 'objective') {
        return res.end(JSON.stringify({ exists: false }));
      }
      return res.end(JSON.stringify({
        exists: true,
        running: !!s.proc,
        hasPendingResult: !!s.pendingResult,
        messageCount: s.messages.length,
      }));
    }

    // GET /api/objective/timing?taskId=obj-*[&tabId=…] — last-turn timing diagnostic
    if (req.method === 'GET' && req.url.startsWith('/api/objective/timing')) {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const tid = u.searchParams.get('taskId') || '';
      const tabIdParam = u.searchParams.get('tabId') || '';
      const timingProjPath = req.headers['x-tipatask-project'] || '';
      const s = sessions.get(sessKey(tabIdParam || tid, timingProjPath));
      const cacheActivity = objectiveCacheActivity(sessions);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!s || s.type !== 'objective') {
        return res.end(JSON.stringify({ exists: false, ...cacheActivity }));
      }
      const m = s.timingMilestones;
      const totalMs = (m.turnStart != null && m.turnEnd != null) ? m.turnEnd - m.turnStart : null;
      // C1255 — m.spans is only assigned by finalizeCloseTurn() on turn close (claude-session.js),
      // so a poll mid-turn saw spans:null/bottleneck:null forever. computeTurnSpans() is the same
      // pure reducer finalizeCloseTurn() uses; called here read-only (never writes m.spans) against
      // whatever milestones are populated so far — spans whose endpoint hasn't happened yet are
      // simply absent from the result, same as always.
      const live = m.spans ? { spans: m.spans, bottleneck: m.bottleneck } : computeTurnSpans(m);
      const sinceLastSignalMs = m.lastSignalAt != null ? Date.now() - m.lastSignalAt : null;
      return res.end(JSON.stringify({
        exists: true,
        taskId: tid,
        ...cacheActivity,
        lastTurn: {
          milestones: m,
          spans: live.spans,
          bottleneck: live.bottleneck,
          totalMs,
          running: !!s.proc,
          sinceLastSignalMs,
          contextSize: m.contextSize || null,
        },
      }));
    }

    // GET /api/objective/metrics[?taskId=obj-*][&tabId=…] — per-turn prompt-size + model_ttft trail (C495)
    if (req.method === 'GET' && req.url.startsWith('/api/objective/metrics')) {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const tid = u.searchParams.get('taskId');
      const tabIdParam = u.searchParams.get('tabId') || '';
      const metricsProjPath = req.headers['x-tipatask-project'] || '';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
      if (tid) {
        const s = sessions.get(sessKey(tabIdParam || tid, metricsProjPath));
        if (!s || s.type !== 'objective') {
          return res.end(JSON.stringify({ exists: false, task: tid, turns: [] }));
        }
        return res.end(JSON.stringify({ exists: true, task: tid, turns: s._profileTrail }));
      }
      const tasks = [];
      for (const [taskId, s] of sessions) {
        if (s.type === 'objective' && s._profileTrail && s._profileTrail.length) {
          tasks.push({ taskId, turns: s._profileTrail });
        }
      }
      return res.end(JSON.stringify({ tasks }));
    }

    // GET /api/objective/cache-probe?taskId=obj-*[&tabId=…] — per-turn cache trail (C455)
    if (req.method === 'GET' && req.url.startsWith('/api/objective/cache-probe')) {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const tid = u.searchParams.get('taskId') || '';
      const tabIdParam = u.searchParams.get('tabId') || '';
      const cacheProbeProjPath = req.headers['x-tipatask-project'] || '';
      const s = sessions.get(sessKey(tabIdParam || tid, cacheProbeProjPath));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!s || s.type !== 'objective') {
        return res.end(JSON.stringify({ exists: false, task: tid, turns: [] }));
      }
      return res.end(JSON.stringify({ exists: true, task: tid, turns: s._cacheTrail }));
    }

    // POST /api/objective/chat-draft — save chat draft messages to temp file
    if (req.method === 'POST' && req.url === '/api/objective/chat-draft') {
      const projectPath = req.headers['x-tipatask-project'];
      let body = await readTextBody(req, res, CHAT_BODY_MAX_BYTES);
      if (body === null) return;
      try {
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed.messages)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'messages must be an array' }));
        }
        await writeChatDraft(parsed.messages, parsed.taskId, parsed, projectPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        const status = err instanceof SyntaxError || err.code === 'INVALID_CHAT_DRAFT' ? 400 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/objective/chat-draft — read chat draft from temp file
    if (req.method === 'GET' && req.url === '/api/objective/chat-draft') {
      const projectPath = req.headers['x-tipatask-project'];
      try {
        const draft = await readChatDraft(projectPath);
        if (!draft || !Array.isArray(draft.messages)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({}));
        }
        const windowed = buildHistoryWindow(draft.messages);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const response = {
          taskId: draft.taskId || null,
          savedAt: draft.savedAt || null,
          messages: windowed.messages,
          historyWindowStart: windowed.historyWindowStart,
          historyTotalCount: windowed.historyTotalCount,
          hasOlderHistory: windowed.hasOlderHistory,
          objectiveModel: draft.objectiveModel || null,
          rehashIntent: draft.rehashIntent || null,
          taskKey: draft.taskKey || null,
          lockReleased: !!draft.lockReleased, // TPT283 — saved Rehash → Split keeps its intent, not its board lock
        };
        if (draft.draftVersion !== undefined) response.draftVersion = draft.draftVersion;
        for (const field of ['parentTaskKey', 'objectiveParentKey', 'originTaskKey', 'originResolution']) {
          if (Object.prototype.hasOwnProperty.call(draft, field)) response[field] = draft[field];
        }
        return res.end(JSON.stringify(response));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/objective/history?taskId=obj-*[&tabId=…] — load older chat messages on demand
    if (req.method === 'GET' && req.url.startsWith('/api/objective/history')) {
      const url = new URL(req.url, 'http://localhost');
      const taskId = url.searchParams.get('taskId') || '';
      const tabIdParam = url.searchParams.get('tabId') || '';
      const before = Number(url.searchParams.get('before') || 1);
      const limit = Number(url.searchParams.get('limit') || OBJECTIVE_HISTORY_PAGE_MESSAGES);
      const historyProjectPath = req.headers['x-tipatask-project'] || '';
      const session = (tabIdParam || taskId) ? sessions.get(sessKey(tabIdParam || taskId, historyProjectPath)) : null;
      try {
        const messages = await getObjectiveHistorySource(taskId, session, historyProjectPath);
        const chunk = buildHistoryChunk(messages, before, limit);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify(chunk));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // DELETE /api/objective/chat-draft — remove chat draft temp file
    if (req.method === 'DELETE' && req.url === '/api/objective/chat-draft') {
      const projectPath = req.headers['x-tipatask-project'];
      try {
        await deleteChatDraft(projectPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/resolve-sprints — compute sprint assignments for new tasks
    if (req.method === 'POST' && req.url === '/api/resolve-sprints') {
      let body = await readTextBody(req, res, BULK_BODY_MAX_BYTES);
      if (body === null) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      const { changes, pinned } = parsed;
      if (!Array.isArray(changes)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'changes must be an array' }));
      }
      const _rb = resolveBackend(req);
      forcePendingProposalStatuses(changes, 'resolve-sprints', (await fetchStatusContext(_rb)).roles.start);
      try {
        const { resolveAndAssign, healDependencyOrdering } = require('./sprint-assign');
        const pinnedIds = new Set(Array.isArray(pinned) ? pinned : []);
        // Re-read live tasks so ID computation is not based on a stale pre-request snapshot.
        // Must be unfiltered — ID-collision remap needs all tasks, not just the current user's.
        const existingTasks = await (_rb.getTasksUnfiltered ? _rb.getTasksUnfiltered() : _rb.getTasks());
        // Remap any C##/H## IDs that already exist in live state (another tab may have
        // committed them since the client built its snapshot).
        const newChanges = changes.filter(c => c.type === 'new');
        let idRemap = new Map();
        if (newChanges.length > 0) {
          const { remapCollidingIds: remap } = require('./id-remap');
          const result = remap(newChanges.map(c => c.task), existingTasks);
          if (result.idRemap.size > 0) {
            idRemap = result.idRemap;
            // Apply remapped IDs back into the changes array
            const remappedById = new Map(result.tasks.map(t => [t.id, t]));
            for (const c of newChanges) {
              if (pinnedIds.delete(c.task.id)) pinnedIds.add(idRemap.get(c.task.id) || c.task.id);
              const remappedId = idRemap.get(c.task.id) || c.task.id;
              if (remappedById.has(remappedId)) c.task.id = remappedId;
            }
            // Propagate idRemap to dependency refs across all changes
            for (const c of changes) {
              if (Array.isArray(c.task.dependencies)) {
                c.task.dependencies = c.task.dependencies.map(dep => idRemap.get(dep) || dep);
              }
              if (c.task.parentId && idRemap.has(c.task.parentId)) {
                c.task.parentId = idRemap.get(c.task.parentId);
              }
            }
          }
        }
        await resolveAndAssign(changes, _rb, config, pinnedIds, existingTasks);
        const { conflicts, autoBumped } = healDependencyOrdering(changes, existingTasks, pinnedIds);
        if (conflicts.length > 0) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'step_dependency_conflict', conflicts }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const idRemapObj = Object.fromEntries(idRemap);
        if (Object.keys(idRemapObj).length > 0) {
          console.log('[todo] resolve-sprints remapped colliding IDs:', idRemapObj);
        }
        return res.end(JSON.stringify({ changes, autoBumped, idRemap: idRemapObj }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // Serve TODO.md — synthesized from the api backend (C1352: file backend retired,
    // no more disk-read leg here). Supports ?status=pending,in_progress,on_fire filter
    // for objective prompt efficiency. Branch order: parentKey -> scope=all -> board fetch
    // -> status -> default
    if (req.method === 'GET' && urlPath === '/TODO.md') {
      try {
        const b = resolveBackend(req);
        const qs = req.url.includes('?') ? new URLSearchParams(req.url.split('?')[1]) : null;
        const statusParam = qs ? qs.get('status') : null;
        const statuses = statusParam ? statusParam.split(',').map(s => s.trim()).filter(Boolean) : null;
        const parentKey = qs ? qs.get('parentKey') : null;
        const scopeAll = qs ? qs.get('scope') === 'all' : false;
        const windowParam = qs ? qs.get('window') : null;
        const fullWindow = qs ? qs.get('full_window') === 'true' : false;
        const extendSprintsParam = qs ? qs.get('extend_sprints') : null;
        // (C1407) Task App board People-filter "All Tasks" mode. Named `assignees`
        // (plural) — deliberately distinct from the upstream API's own singular
        // `?assignee=<id>` param — so the two are never confused while reading a URL.
        // Only honored on the parentKey (drill-down) and board-fetch branches
        // below, both of which already run the C1407 owner-exemption filter by default;
        // an unrecognized value (or this param on any other branch) falls through as
        // scoped — same "unknown value, no crash" contract as ?scope=bogus.
        const assigneesParam = qs ? qs.get('assignees') : null;
        const wantAllAssignees = assigneesParam === 'all';

        const planIds = buildPlanIdSet();
        const enrichPlans = (tasks) => { for (const t of tasks) if (planIds.has(t.id)) t.hasPlan = true; };

        if (parentKey) {
          const children = await b.getChildren(parentKey, { unscoped: wantAllAssignees });
          enrichPlans(children);
          const payload = wantAllAssignees ? { assignees: 'all', tasks: children } : { tasks: children };
          const json = JSON.stringify(payload, null, 2);
          const md = `# TODO\n\n\`\`\`json\n${json}\n\`\`\`\n`;
          res.writeHead(200, { 'Content-Type': 'text/markdown', 'Cache-Control': 'no-cache, no-store' });
          return res.end(md);
        }

        // scope=all returns unscoped tasks for objective existence checks; default
        // remains assignee-scoped for the board. Echo scope only for this branch so
        // clients can reject an older server that ignored the option. Do not add
        // this marker to default TODO data: callers may PUT it back.
        if (scopeAll) {
          const t0 = config.OBJECTIVE_TIMING_VERBOSE ? Date.now() : 0;
          const all = await (b.getTasksUnfiltered ? b.getTasksUnfiltered() : b.getTasks());
          if (config.OBJECTIVE_TIMING_VERBOSE) console.log(`[objective:timing:endpoint] GET /TODO.md?scope=all backend=${Date.now() - t0}ms`);
          enrichPlans(all);
          const json = JSON.stringify({ scope: 'all', tasks: all }, null, 2);
          const md = `# TODO\n\n\`\`\`json\n${json}\n\`\`\`\n`;
          res.writeHead(200, { 'Content-Type': 'text/markdown', 'Cache-Control': 'no-cache, no-store' });
          return res.end(md);
        }

        // ?window=active (C1259) — board sprint window: oldest sprint holding an open
        // task onward, plus backlog. ?extend_sprints=N ("Load More") walks the floor N
        // more distinct sprints back. ?full_window=true selects the same board read
        // without a sprint floor, for search. See getBoardTasks() for { tasks, window }.
        // Kept as a separate opt-in branch (not folded into the default `b.getTasks()`
        // branch below) so every existing caller of the unwindowed board fetch is
        // byte-for-byte unaffected.
        if ((windowParam === 'active' || fullWindow) && typeof b.getBoardTasks === 'function') {
          const t0 = config.OBJECTIVE_TIMING_VERBOSE ? Date.now() : 0;
          const extendSprintsNum = extendSprintsParam ? parseInt(extendSprintsParam, 10) : 0;
          const { tasks, window } = await b.getBoardTasks({
            extendSprints: Number.isFinite(extendSprintsNum) ? extendSprintsNum : 0,
            unscoped: wantAllAssignees,
            fullWindow,
          });
          if (config.OBJECTIVE_TIMING_VERBOSE) console.log(`[objective:timing:endpoint] GET /TODO.md?${fullWindow ? 'full_window=true' : 'window=active'} backend=${Date.now() - t0}ms`);
          enrichPlans(tasks);
          const payload = wantAllAssignees ? { assignees: 'all', tasks, window } : { tasks, window };
          const json = JSON.stringify(payload, null, 2);
          const md = `# TODO\n\n\`\`\`json\n${json}\n\`\`\`\n`;
          res.writeHead(200, { 'Content-Type': 'text/markdown', 'Cache-Control': 'no-cache, no-store' });
          return res.end(md);
        }

        // (C1352) The file task backend is retired — this leg used to be gated on
        // `config.TASK_BACKEND === 'api'` with a disk-read fallback (fs.readFile(DATA_ROOT/
        // TODO.md)) for file mode. Now unconditional: `b` (resolveBackend(req)) is always an
        // api backend. This also fixes a latent multi-window mismatch — the old gate keyed off
        // the process-global config.TASK_BACKEND while the parentKey/scope=all/window=active
        // branches above all use the per-request backend `b` from the x-tipatask-project header.
        if (statuses) {
          const t0 = config.OBJECTIVE_TIMING_VERBOSE ? Date.now() : 0;
          // Objective/agent path: unfiltered so agents see all assignees' tasks.
          // nextIdHint must also span all tasks to avoid ID collisions.
          const all = await (b.getTasksUnfiltered ? b.getTasksUnfiltered() : b.getTasks());
          const _statusSet = new Set(statuses);
          const filtered = all.filter(t => _statusSet.has(t.status));
          if (config.OBJECTIVE_TIMING_VERBOSE) console.log(`[objective:timing:endpoint] GET /TODO.md?status= backend=${Date.now() - t0}ms`);
          enrichPlans(filtered);
          const json = JSON.stringify({ tasks: filtered }, null, 2);
          // (C1483) codingPrefix: this project's own task_prefix (e.g. 'TPT'), degraded
          // to the legacy 'C' when unavailable/invalid — getProjectSettings() is cached
          // and fail-open (never throws, null on failure/offline), so this adds no new
          // failure path over the pre-C1483 hardcoded 'C'.
          const [statusCtx, projectSettings] = await Promise.all([fetchStatusContext(b), b.getProjectSettings ? b.getProjectSettings() : null]);
          const codingPrefix = resolveCodingPrefix(projectSettings?.task_prefix);
          const hint = nextIdHint(all, statusCtx.active, codingPrefix);
          const md = `# TODO\n\n\`\`\`json\n${json}\n\`\`\`\n\n${hint}\n`;
          res.writeHead(200, { 'Content-Type': 'text/markdown', 'Cache-Control': 'no-cache, no-store' });
          return res.end(md);
        }
        const t0 = config.OBJECTIVE_TIMING_VERBOSE ? Date.now() : 0;
        const tasks = await b.getTasks();
        if (config.OBJECTIVE_TIMING_VERBOSE) console.log(`[objective:timing:endpoint] GET /TODO.md backend=${Date.now() - t0}ms`);
        enrichPlans(tasks);
        const json = JSON.stringify({ tasks }, null, 2);
        const md = `# TODO\n\n\`\`\`json\n${json}\n\`\`\`\n`;
        res.writeHead(200, { 'Content-Type': 'text/markdown', 'Cache-Control': 'no-cache, no-store' });
        return res.end(md);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // Serve TAGS.md — compact list of all project tags for objective prompt
    if (req.method === 'GET' && urlPath === '/TAGS.md') {
      try {
        const t0 = config.OBJECTIVE_TIMING_VERBOSE ? Date.now() : 0;
        const tags = await backend.getTags();
        if (config.OBJECTIVE_TIMING_VERBOSE) console.log(`[objective:timing:endpoint] GET /TAGS.md backend=${Date.now() - t0}ms`);
        const md = tags.length > 0 ? tags.map(t => `- ${t}`).join('\n') : '(no tags yet)';
        res.writeHead(200, { 'Content-Type': 'text/markdown', 'Cache-Control': 'no-cache, no-store' });
        return res.end(md);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/tags — tag registry with descriptions
    if (req.method === 'GET' && urlPath === '/api/tags') {
      try {
        const tags = await backend.getTagsDetailed();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
        return res.end(JSON.stringify({ tags }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // POST /api/tags — register a new tag (description required)
    if (req.method === 'POST' && urlPath === '/api/tags') {
      let body = await readTextBody(req, res);
      if (body === null) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
      const { name, description } = parsed;
      if (!name || typeof name !== 'string' || !name.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'name required' }));
      }
      if (!description || typeof description !== 'string' || !description.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'description required' }));
      }
      try {
        await backend.ensureTag(name.trim(), description.trim());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // GET /api/projects/list — list all registered projects (no credentials in response)
    if (req.method === 'GET' && urlPath === '/api/projects/list') {
      const projects = [];
      if (registryOps) {
        for (const [p, entry] of registryOps.projectRegistry) {
          projects.push({
            path: p,
            projectName: (entry.config && entry.config.projectName) || path.basename(p),
            TASK_BACKEND: (entry.config && entry.config.TASK_BACKEND) || 'unknown',
          });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ projects }));
    }

    // GET /api/project-switch?path=<abs> — register (if new) + set active backend
    if (req.method === 'GET' && urlPath === '/api/project-switch') {
      if (!registryOps) {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'project registry not available' }));
      }
      const u = new URL(req.url, `http://${req.headers.host}`);
      const projectPath = u.searchParams.get('path');
      if (!projectPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'path query param required' }));
      }
      try {
        await registryOps.getOrCreateBackend(projectPath);
        registryOps.setActiveProject(projectPath);
        taskCache.invalidate(getActiveBackend()); // drop stale singleton-keyed rows
        const activeBackend = getActiveBackend();
        const state = (typeof activeBackend.getConnectionState === 'function')
          ? (activeBackend.getConnectionState() || 'connected')
          : 'connected';
        const pendingCount = (typeof activeBackend.getPendingMutationCount === 'function')
          ? activeBackend.getPendingMutationCount() : 0;
        const pendingTaskIds = (typeof activeBackend.getPendingTaskIds === 'function')
          ? activeBackend.getPendingTaskIds() : [];
        websocket.emitApiStatus(state, null, pendingCount, pendingTaskIds);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, path: projectPath }));
      } catch (err) {
        res.writeHead(err.message.includes('No .tipatask') ? 404 : 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // Web handoff validates local project mapping, account, and task before
    // opening anything; errors render in the current tab. A childless objective
    // seeds chat, an objective with children starts its first ready child, and a
    // regular task starts directly. /open-objective remains an alias.
    if (req.method === 'GET' && (urlPath === '/start-task' || urlPath === '/open-objective')) {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const apiProjectId = u.searchParams.get('projectId');
      const taskKey = u.searchParams.get('task');
      const userId = u.searchParams.get('userId');
      const explicitPath = u.searchParams.get('projectPath') || null;

      const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const noticePage = (title, body, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} — TipΔTask</title>
<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:15vh auto 0;padding:0 24px;color:#1e1e2e;background:#f1f1ef}
h1{font-size:1.15rem;margin:0 0 12px}p{margin:0 0 8px;color:#4c4f69}ul{padding-left:1.2em}a{color:#1e66f5}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`);
      };

      if (!apiProjectId || !taskKey || !userId) {
        return noticePage('Missing parameters', '<p>This link is missing projectId, task, or userId.</p>');
      }

      // No Electron parent (standalone `node todo-server.js`) — best-effort only, no
      // project-id/account verification possible since this process can't ask main for a
      // path. Redirect into whatever project THIS server instance is already bound to.
      // (C1559) objectivePlan=1 always — the standalone fallback has no way to tell
      // whether the clicked task has children, so it degrades to the planning branch
      // unconditionally (same "dev-only, best-effort" scope this fallback has always had).
      if (!process.send || !registryOps || typeof registryOps.resolveProjectPathViaMain !== 'function') {
        res.writeHead(302, { Location: `/todo.html?objectiveTask=${encodeURIComponent(taskKey)}&objectivePlan=1` });
        return res.end();
      }

      try {
        const allCandidates = await registryOps.resolveProjectPathViaMain(apiProjectId);
        if (explicitPath && !allCandidates.includes(explicitPath)) {
          return noticePage('Project mismatch', '<p>This local project is not registered for the requested API project.</p>', 403);
        }
        const candidates = explicitPath ? [explicitPath] : allCandidates;

        if (!candidates.length) {
          return noticePage('TipΔTask not set up for this project',
            '<p>No local TipΔTask project on this machine is linked to this project. Run Task App setup on this machine and link it, then try again.</p>');
        }

        if (candidates.length > 1) {
          const links = candidates.map(p => {
            const href = `/start-task?projectId=${encodeURIComponent(apiProjectId)}&task=${encodeURIComponent(taskKey)}&userId=${encodeURIComponent(userId)}&projectPath=${encodeURIComponent(p)}`;
            return `<li><a href="${escapeHtml(href)}">${escapeHtml(p)}</a></li>`;
          }).join('');
          return noticePage('Which local project?', `<p>Multiple local checkouts are linked to this project — pick one:</p><ul>${links}</ul>`);
        }

        const projectPath = candidates[0];
        const cfg = readProjectConfig(projectPath);
        if (!cfg || String(cfg.API_PROJECT_ID) !== String(apiProjectId)) {
          return noticePage('Project mismatch',
            `<p>The local TipΔTask project at <code>${escapeHtml(projectPath)}</code> is not bound to this API project. Its local config may be stale — reopen it in TipΔTask and check Settings.</p>`);
        }

        const targetBackend = registryOps.getBackendForPath(projectPath);
        let currentUserId = null;
        try { currentUserId = (await targetBackend.getCurrentUserId()) ?? null; } catch { currentUserId = null; }
        if (currentUserId == null || String(currentUserId) !== String(userId)) {
          return noticePage('Signed in as a different account',
            '<p>The local TipΔTask project is signed in as a different account than the one you used on the web. Sign in to the matching account on that machine, then try again.</p>');
        }

        let task = null;
        try { task = await targetBackend.getTask(taskKey); } catch { task = null; }
        if (!task) {
          return noticePage('Task not found', `<p>Task <code>${escapeHtml(taskKey)}</code> was not found in the local project.</p>`);
        }

        // "Warn, still offer" (C1389 design decision) — an assignee mismatch degrades to a
        // notice inside the opened chat tab (see seedObjectiveFromTask() in template.html),
        // not a hard stop. Unassigned tasks (assignee == null) never warn.
        const warning = task.assignee != null && String(task.assignee) !== String(userId);

        // (C1559) Dispatch on the task's shape — getTask() carries no children_count (only
        // the list route's rollup does, see api-backend.js _mapRawTasks), so a real
        // getChildren() call is the only way to know. unscoped:true so a teammate-owned
        // child still counts (this is a cross-account handoff, not a board render).
        const children = await targetBackend.getChildren(taskKey, { unscoped: true }).catch(() => []);

        if (task.isObjective && children.length === 0) {
          // Branch 1: childless objective → origin-linked planning chat. title/description
          // (TPT16) forward the task this route already fetched above so the renderer's
          // seedObjectiveFromTask() can build the composer seed without a second
          // GET /api/tasks/:id round trip.
          const sent = registryOps.sendOpenObjective(projectPath, taskKey, { warning, originTaskKey: taskKey, title: task.title, description: task.description });
          if (!sent) {
            return noticePage('TipΔTask is not running',
              '<p>Could not reach the TipΔTask desktop app on this machine. Make sure it is running, then try again.</p>');
          }
          return noticePage('Opened in TipΔTask',
            `<p>${escapeHtml(task.title || taskKey)} is now open in the TipΔTask desktop app. You can close this tab.</p>${warning ? '<p><em>Note: this task is not assigned to you.</em></p>' : ''}`);
        }

        // Branch 2 (is_objective WITH children) and branch 3 (regular task): start a
        // terminal session. Both go through sendStartTask — branch 2 carries the fetched
        // children so the renderer (which alone holds the live board status map
        // isDepsBlocked() needs) can pick the first startable one; branch 3 carries none,
        // which the 'start-task' IPC listener reads as "start taskKey itself".
        const sent = registryOps.sendStartTask(projectPath, taskKey, { children: task.isObjective ? children : [] });
        if (!sent) {
          return noticePage('TipΔTask is not running',
            '<p>Could not reach the TipΔTask desktop app on this machine. Make sure it is running, then try again.</p>');
        }
        return noticePage('Opened in TipΔTask',
          `<p>${escapeHtml(task.title || taskKey)} is starting in the TipΔTask desktop app. You can close this tab.</p>${warning ? '<p><em>Note: this task is not assigned to you.</em></p>' : ''}`);
      } catch (err) {
        return noticePage('Something went wrong', `<p>${escapeHtml(err.message || 'Unknown error')}</p>`);
      }
    }

    // Only these build outputs are public. Keep URL matching literal: decoded aliases,
    // dotfiles, source paths and arbitrary node_modules paths have no static route.
    const staticAssets = {
      '/': 'todo.html',
      '/todo.html': 'todo.html',
      '/bundle.js': 'bundle.js',
      '/bundle.css': 'bundle.css',
      '/marked.min.js': 'marked.min.js',
      '/favicon.ico': 'favicon.ico',
      '/favicon.svg': 'favicon.svg',
    };
    const assetName = staticAssets[urlPath];
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !assetName) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const filePath = path.join(config.DIST, assetName);

    try {
      // A built asset or dist/ symlink must not redirect a public URL to private
      // content. realpath also checks containment after filesystem resolution.
      const [distStat, assetStat, realDist, realFile] = await Promise.all([
        fs.lstat(config.DIST), fs.lstat(filePath),
        fs.realpath(config.DIST), fs.realpath(filePath),
      ]);
      if (!distStat.isDirectory() || distStat.isSymbolicLink()
        || !assetStat.isFile() || assetStat.isSymbolicLink()
        || path.relative(realDist, realFile) !== assetName) {
        throw new Error('Static asset outside dist');
      }
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      // No-cache for built assets so a fresh bundle.js is always served after rebuild.
      const isBuiltAsset = urlPath === '/bundle.js' || urlPath === '/bundle.css'
        || urlPath === '/marked.min.js' || urlPath === '/' || urlPath === '/todo.html';
      const headers = { 'Content-Type': config.MIME[ext] || 'application/octet-stream' };
      if (isBuiltAsset) headers['Cache-Control'] = 'no-cache';
      if (urlPath === '/' || urlPath === '/todo.html') {
        headers['Content-Security-Policy'] = contentSecurityPolicy(data.toString('utf8'));
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  };
  return wrapHttpHandler(routeHandler);
}

// ── WebSocket connection handler ──

// Build a session map key that is unique per (tabId|taskId, projectPath) pair.
// Prevents two Electron windows with the same-millisecond taskId (e.g. both
// clicking New Objective at once) from sharing a single in-memory session object.
function sessKey(id, projectPath) {
  return id + (projectPath ? '\0' + projectPath : '');
}

// (TPT444) Everything a NEW terminal task session does once it holds a start slot: resolve
// the task, claim it, spawn the pty, wire the client. Runs inline when a slot was free, or later
// from the start queue (drainSessionQueue) — in which case the connecting socket may already be
// gone (headless Play All start closes it), so every client touch goes through the live
// `session.ws`, and a session whose socket is gone is simply left running unattached, exactly
// like one minimized after start.
async function launchNewTerminalSession(ctx) {
  const { session, prompt, taskId, sessionKey, sessions, backend, projectPath, initialCols, initialRows, _piModelParam } = ctx;
  detachQueuedClient(session);
  let ws = session.ws && session.ws.readyState === session.ws.OPEN ? session.ws : null;
  try {
  if (prompt) {
    try {
      // Fetch full task once — derive tt-* tags, discovery flag, AND per-task model override together.
      let taskTags = [];
      let discovery = false;
      let _taskModel;
      let _designMode = false; // C1207 — per-task /design opt-in (claude only)
      let _task = null; // C1408 — hoisted so assertTaskStartable()/claimUnassignedTaskOnStart() can reuse this fetch
      if (taskId) {
        try {
          _task = await backend.getTask(taskId);
          const _rawTags = _task?.tags || [];
          taskTags = _rawTags.filter(t => t.startsWith('tt-'));
          // (C1134) Raw tag, read before the tt-* filter above — PiAgent's discovery-mandate
          // directive gates on it (buildPrompt()'s PI_DISCOVERY_MANDATE); it is not a tt-* tag
          // so it would otherwise never reach getSpawnSpec()'s opts.
          discovery = _rawTags.includes('discovery');
          const _activeAgent = session.taskAgent || config.TASK_AGENT;
          if (_activeAgent === 'claude') {
            _taskModel = _task?.claudeModel || undefined;
            _designMode = !!_task?.claudeDesignMode; // C1207
          }
          else if (_activeAgent === 'codex') _taskModel = _task?.codexModel || undefined;
          else if (_activeAgent === 'pi') {
            if (_piModelParam) {
              _taskModel = _piModelParam;
            } else if (_task?.piModel) {
              // C1133 — saved per-task pi pin, revalidated the same way _piModelParam is
              // above: the project's PI_MODELS may have dropped this row since it was
              // saved, and spawning a stale id would run row 0's API key against the
              // wrong model.
              const _piCfgForTask = readProjectConfig(projectPath || config.PROJECT_ROOT);
              if (piEntryForModel(_piCfgForTask, _task.piModel)) {
                _taskModel = _task.piModel;
              } else {
                console.warn(`[ws] task ${taskId}'s saved pi_model "${_task.piModel}" not in this project's PI_MODELS — falling back to default`);
              }
            }
          }
          // C982: baseline status at spawn — the completion poller only auto-posts on a
          // genuine transition INTO completed, not when resuming an already-done task.
          session._spawnStatus = _task?.status ?? null;
        } catch { /* ignore — tags, discovery, and model fall back to empty/false/config default */ }
      }
      // C1408 — must start blocking; a caught EASSIGNEE below cancels the whole start.
      const _me = await assertTaskStartable(backend, taskId, _task);
      _task = await claimUnassignedTaskOnStart(backend, taskId, _task, _me, projectPath);
      // C1122 — _piModelParam prefixed so the validated launch-time pick survives even
      // when the getTask() try/catch above swallowed an error before _taskModel was set.
      await spawnTerminal(session, prompt, taskId, taskTags, { sessions, initialCols, initialRows, backend, model: _piModelParam || _taskModel, discovery, designMode: _designMode, task: _task });
      if (session.alive) forgetLostSession(taskId, projectPath || config.PROJECT_ROOT, config.USER_DATA_ROOT);
      if (session._terminated || sessions.get(sessionKey) !== session) {
        try { ws && ws.close(); } catch { /* already closed */ }
        return;
      }
      postDeviceSession(taskId, backend);
      await _syncAgentAssignee(backend, taskId, session.taskAgent);
      _recordLastUsedAgent(session);
      if (session._terminated || sessions.get(sessionKey) !== session) {
        try { ws && ws.close(); } catch { /* already closed */ }
        return;
      }
    } catch (err) {
      if (err.code === 'ETERMINATED') {
        try { ws && ws.close(); } catch { /* already closed */ }
        sessions.delete(sessionKey);
        if (!ws) broadcastSessionEnded(taskId, session, 'start-failed');
        return;
      }
      if (err.code === 'EASSIGNEE') {
        _sendIfOpen(ws, { type: 'error', code: 'EASSIGNEE', message: 'Cannot start a task assigned to another member.' });
        try { ws && ws.close(); } catch { /* already closed */ }
        sessions.delete(sessionKey);
        if (!ws) broadcastSessionEnded(taskId, session, 'start-failed');
        return;
      }
      if (err.code === 'ECLAIM') {
        _sendIfOpen(ws, { type: 'error', code: 'ECLAIM', message: 'Could not assign this task to you. Task start canceled.' });
        try { ws && ws.close(); } catch { /* already closed */ }
        sessions.delete(sessionKey);
        if (!ws) broadcastSessionEnded(taskId, session, 'start-failed');
        return;
      }
      if (err.code === 'EAUTH') {
        // (C1383) Pre-spawn credential check tripped — expired/invalid API_TOKEN.
        _sendIfOpen(ws, { type: 'error', code: 'EAUTH', message: eauthClientMessage(err) });
        try { ws && ws.close(); } catch { /* already closed */ }
        sessions.delete(sessionKey);
        if (!ws) broadcastSessionEnded(taskId, session, 'start-failed');
        return;
      }
      _sendIfOpen(ws, { type: 'error', message: `Failed to start ${session.taskAgentLabel}: ${err.message}` });
      try { ws && ws.close(); } catch { /* already closed */ }
      sessions.delete(sessionKey);
      if (!ws) {
        console.warn(`[terminal] Queued start of ${taskId} failed: ${err.message}`);
        broadcastSessionEnded(taskId, session, 'start-failed');
      }
      return;
    }
  }

  if (ws && ws.readyState === ws.OPEN) wireClient(ws, session, taskId, sessionKey, sessions, backend);
  } finally {
    session._launching = false;
    drainSessionQueue();
  }
}

async function handleConnection(ws, req, sessions, getActiveBackend, onAttentionNeeded, onAttentionCleared, getBackendForPath = null) {
  sleepWatchdogSessions = sessions;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const taskId = url.searchParams.get('taskId') || '';
  const tabId = url.searchParams.get('tabId') || '';
  // The entry-point guard validates the URL hint against the authenticated window or
  // browser scope before upgrade. Only the normalized, authorized header chooses backend.
  const projectPath = req.headers['x-tiptask-project-path'] || '';
  const sessionKey = sessKey(isProjectChatId(taskId) ? taskId : (tabId || taskId), projectPath);
  const prompt = url.searchParams.get('prompt') || '';
  const terminateOnConnect = url.searchParams.get('terminate') === '1';
  const resumePausedOnConnect = url.searchParams.get('resumePaused') === '1';
  const reconnectOnly = url.searchParams.get('reconnect') === '1'; // objective chat reattach — never starts a session
  const planOnly = url.searchParams.get('planOnly') === '1';
  const agentParam = url.searchParams.get('agent') || '';
  const modelParam = url.searchParams.get('model') || ''; // C1122 — Pi launch-time model pick
  const discussionMode = url.searchParams.get('discussion') === '1';
  // Use per-project backend when projectPath is present (Electron multi-window).
  const backend = (projectPath && getBackendForPath)
    ? getBackendForPath(projectPath)
    : getActiveBackend();
  if (process.env.TIPATASK_PROJECT_DEBUG === '1') {
    console.log(`[proj:ws] taskId=${taskId} projectPath=${projectPath || '<none>'} sessionKey=${JSON.stringify(sessionKey)}`);
  }
  const colsParam = parseInt(url.searchParams.get('cols'), 10);
  const rowsParam = parseInt(url.searchParams.get('rows'), 10);
  const initialCols = Number.isFinite(colsParam) ? Math.min(400, Math.max(40, colsParam)) : 0;
  const initialRows = Number.isFinite(rowsParam) ? Math.min(100, Math.max(10, rowsParam)) : 0;

  if (!taskId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing taskId parameter' }));
    ws.close();
    return;
  }

  // The URL names a project chat for the authenticated backend's project only. The tab id
  // cannot select a different session, and neither Start nor reconnect may switch backends.
  if (taskId.startsWith('projectChat:')) {
    let selectedProjectId = '';
    try { selectedProjectId = String(backend.getCredentials().projectId || ''); } catch { /* reject below */ }
    if (!isProjectChatId(taskId) || projectIdFromChatId(taskId) !== selectedProjectId) {
      ws.send(JSON.stringify({ type: 'error', message: 'Project chat does not match the selected project.' }));
      ws.close();
      return;
    }
    if (prompt) {
      ws.send(JSON.stringify({ type: 'error', message: 'Project chat starts only with start-project-chat.' }));
      ws.close();
      return;
    }
  }

  // ── Attention watcher (C1057) — narrow, project-scoped, side-effect-free ──
  // Deliberately NOT the board watcher: no `config` message (would clobber the per-window
  // currentUserId — see ws-handlers.js's config-message block below), no KB session-sync on
  // connect, no pushAll on close, no reconnect-storm risk. This is what lets Electron
  // subscribe to attention-needed/-cleared/session-ended without the risks that come with
  // opening the full board WS (see ai/architecture/tt-electron-app.md). Placed BEFORE the KB
  // session-sync block on purpose — an attention subscriber must never trigger it.
  if (taskId === '__attention__') {
    console.log(`[attention-ws] Subscriber connected${projectPath ? ` (project=${projectPath})` : ''}`);
    ws._attentionSubscriber = true;
    ws._projectPath = projectPath || '';
    for (const [, s] of sessions) {
      if (!s._attentionBroadcasted || !s.tabId) continue;
      if (ws._projectPath && s.projectPath && s.projectPath !== ws._projectPath) continue;
      // (C1058) agent included so a replay doesn't overwrite state.attentionDetails[taskId].agent
      // with undefined on the client — _attentionLastBroadcast only ever stored {kind, promptText}.
      ws.send(JSON.stringify({ type: 'attention-needed', taskId: s.tabId, agent: s.taskAgent, ...(s._attentionLastBroadcast || {}) }));
    }
    // (C1356) Standard `ws` isAlive liveness pattern — this socket previously had no way to
    // detect a half-open connection on either end (server pinged but never checked for a
    // pong; client had no heartbeat at all). After sleep/wake or a silent network drop,
    // ws.readyState can keep reporting OPEN on a dead connection indefinitely, and the
    // client's connectAttentionWs() early-returns on a stale OPEN readyState with nothing to
    // disprove it — so it would never reconnect, and this window would silently stop
    // learning about any attention-needed event until the user manually reloaded.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const attnPingInterval = setInterval(() => {
      if (ws.readyState !== 1) { clearInterval(attnPingInterval); return; }
      if (ws.isAlive === false) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    }, 30000);
    ws.on('close', () => clearInterval(attnPingInterval));
    return;
  }

  // (C1185) Streaming voice transcription — narrow, project-scoped, side-effect-free, same
  // reasoning as __attention__ above: no config message, no KB session-sync, no pushAll on
  // close. Delegates the whole connection lifecycle to voice-stream/session.js.
  if (taskId === '__voice__') {
    let voiceCtx;
    try {
      voiceCtx = resolveProjectContext(req, backend);
    } catch {
      voiceCtx = {};
    }
    // projectPath (resolved above, same var __attention__/__board__ use) is what
    // voice-stream/index.js#resolveVoicePreset() needs to read .tipatask/config.json's
    // voicePreset/voiceLocalModel/ASSEMBLYAI_API_KEY (C1178) — resolveProjectContext() only
    // returns API credentials, not the filesystem path.
    const { handleVoiceConnection } = require('./voice-stream/session');
    handleVoiceConnection(ws, { ...voiceCtx, projectPath });
    return;
  }

  // (C1463) Objective tab close — a short-lived one-shot connection, taskId is the
  // objective's own parentKey. Placed here (after __voice__, before the KB session-sync
  // block just below) on purpose — a tab close must never trigger a KB sync/re-index, same
  // reasoning the __attention__ branch's own placement comment above gives for that socket.
  // Two-phase: confirmed=0 first asks "is confirmation needed", confirmed=1 actually kills.
  if (url.searchParams.get('terminateChildren') === '1') {
    const parentKey = taskId;
    const confirmed = url.searchParams.get('confirmed') === '1';
    try {
      const { taskKeys, allClosed } = await resolveObjectiveDescendants(parentKey, backend);
      if (!confirmed && !allClosed) {
        sendWsJson(ws, { type: 'objective-close-needs-confirm', parentKey });
      } else {
        const closedIds = terminateObjectiveSessions(taskKeys, sessions, backend, projectPath);
        sendWsJson(ws, { type: 'objective-sessions-terminated', parentKey, taskIds: closedIds });
      }
    } catch (err) {
      sendWsJson(ws, { type: 'error', message: err.message });
    } finally {
      ws.close();
    }
    return;
  }

  {
    // Auto session-sync on WS connect: use the per-window projectPath when
    // available so the version cache writes to the project dir, not to the
    // read-only app.asar bundle in packaged Electron builds (C884 fix).
    const syncCfg = projectPath ? (readProjectConfig(projectPath) || {}) : {};
    const syncBackend = syncCfg.TASK_BACKEND || config.TASK_BACKEND;
    if (syncBackend === 'api') {
      try {
        const { baseUrl, projectId: liveProjectId, token } = backend.getCredentials();
        const _root = projectPath || config.PROJECT_ROOT;
        // C1218 — auto-reindex, chained AFTER the sync so its own presync doesn't race
        // syncOnSessionStart's write to the same version cache. Never awaited: this WS
        // connection continues into the __board__ branch immediately either way.
        Promise.resolve(fireSessionSync(baseUrl, liveProjectId, token, _root, 'ws'))
          .then(() => require('./kb-auto-reindex').fireAutoReindexWithBroadcast({ rootPath: _root, projectPath, backend, label: 'ws' }))
          .catch(() => {}); // fireAutoReindex never throws; belt-and-braces against an unrelated rejection
      } catch (err) {
        console.error(`[kb-sync:ws] skipped: ${err.message}`);
      }
    }
  }

  // ── Board watcher — passive listener for broadcasts ──
  if (taskId === '__board__') {
    console.log('[board] Board watcher connected');
    // (C1057) Project-scoping for websocket.broadcastToProject(), and a flag the API-poller
    // gate in index.js checks so it only polls while something is actually watching the board.
    ws._boardWatcher = true;
    ws._projectPath = projectPath || '';
    // C1131 — project-scoped resolution (LAST_AGENT/TASK_AGENT), not the global startup
    // snapshot, so a multi-window Electron server reports each project's own default.
    const taskAgent = getTaskAgentInfo(resolveTaskAgentId(projectPath, null));
    const _boardCfg = configForProject(projectPath); // C1101 — per-project PI_MODEL
    // (C1136) No live session backing this frame (board watcher) — always safe to clamp.
    const _boardVisibleProviders = listVisibleObjectiveProviders(_boardCfg, { peek: true }); // (C1259)
    // (TPT162) [] is now reachable — clamping an empty list would otherwise advertise a
    // provider:model pair nothing offers (see the GET /api/objective/providers comment above).
    const _boardSel = _boardVisibleProviders.length
      ? clampSelectionToProviders(currentSelection(null, _boardCfg), _boardVisibleProviders)
      : null;
    let currentUserId = null;
    if (config.TASK_BACKEND === 'api') {
      try { currentUserId = (await backend.getCurrentUserId()) ?? null; } catch { currentUserId = null; }
    }
    // (C1137) Per-connection, not process-global config.projectName — a second Electron window
    // on the same forked server serves a different projectPath (same lesson as C1124).
    const _boardProjectName = (projectPath ? (readProjectConfig(projectPath) || {}).projectName : config.projectName) || '';
    ws.send(JSON.stringify({
      type: 'config',
      showAiStats: config.SHOW_AI_STATS,
      taskAgent: taskAgent.id,
      taskAgentLabel: taskAgent.label,
      agentLabels: _agentLabels(),
      planApprovalCommand: taskAgent.approvalCommand,
      supportsPlanMode: taskAgent.supportsPlanMode,
      // (C1259) Peek variants — the board watcher's config frame is a status badge, not
      // a gate; this used to spawnSync-block EVERY board WS connect (and therefore any
      // concurrent WS handshake queued behind it on the same event loop, including an
      // unrelated ?terminate=1 connect) whenever an agent's cached status was a stale
      // negative. See base-agent.js peekDetect().
      availableAgents: getAvailableAgentsPeek(_boardCfg),
      agentStatuses: listTaskAgentStatusesPeek(config),
      deviceId: config.DEVICE_ID,
      deviceName: config.DEVICE_NAME,
      avatarUrl: config.USER_AVATAR_URL,
      projectName: _boardProjectName,
      currentUserId,
      // C1029 — chat-model-selector option list + project default (no live session yet).
      // (C1136) Filtered to this project's own selected+configured providers.
      objectiveProviders: _boardVisibleProviders,
      objectiveSelection: _boardSel ? formatSelection(_boardSel.providerId, _boardSel.model) : '',
    }));
    // Send current attention states to the new board watcher (C1057: bare tabId, never the
    // composite sessions-Map key — a card's data-id can never match "id\0projectPath").
    // Project-filtered so a second Electron window's tasks don't cross-talk.
    for (const [, s] of sessions) {
      if (!s._attentionBroadcasted || !s.tabId) continue;
      if (ws._projectPath && s.projectPath && s.projectPath !== ws._projectPath) continue;
      // (C1058) agent included so a replay doesn't overwrite state.attentionDetails[taskId].agent
      // with undefined on the client — _attentionLastBroadcast only ever stored {kind, promptText}.
      ws.send(JSON.stringify({ type: 'attention-needed', taskId: s.tabId, agent: s.taskAgent, ...(s._attentionLastBroadcast || {}) }));
    }
    // Send recently assigned tasks (within last 60s) to the new board watcher
    for (const tid of websocket.getRecentAssignments()) {
      ws.send(JSON.stringify({ type: 'newly-assigned', taskId: tid }));
    }
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'upload-image') {
        await handleWsImageUpload(ws, backend, msg);
      } else if (msg.type === 'sync-kb') {
        const cfg = projectPath ? (readProjectConfig(projectPath) || {}) : {};
        const taskBackend = cfg.TASK_BACKEND || config.TASK_BACKEND;
        if (taskBackend !== 'api') {
          sendWsJson(ws, { type: 'sync-kb-result', success: false, error: 'KB sync requires API backend' });
        } else {
          try {
            const { baseUrl: apiBaseUrl, projectId, token } = backend.getCredentials();
            const rootPath   = projectPath || config.PROJECT_ROOT;
            const archPull = await pullArchitectureDocs(apiBaseUrl, projectId, token, rootPath);
            const syncRes = await syncOnSessionStart(apiBaseUrl, projectId, token, rootPath);
            const archPush = await pushArchitectureDocs(apiBaseUrl, projectId, token, rootPath);
            await pushAll(apiBaseUrl, projectId, token, rootPath);
            archCache.invalidateArchForKeys(
              [...archPull.pulled, ...archPull.merged, ...syncRes.pulledKeys],
              rootPath,
            );
            const pulled = archPull.pulled.length + archPull.merged.length + syncRes.pulledCount;
            const pushed = archPush.pushed.length;
            sendWsJson(ws, { type: 'sync-kb-result', success: true, pushed, pulled });
            // C1218 — only on the success path (a failed sync means disk != remote, so
            // detect would classify against stale data); fired after the result frame is
            // already on the wire, promise dropped — never blocks this handler's return.
            require('./kb-auto-reindex').fireAutoReindexWithBroadcast({ rootPath, projectPath, backend, label: 'sync-kb' }).catch(() => {});
          } catch (err) {
            sendWsJson(ws, { type: 'sync-kb-result', success: false, error: err.message });
          }
        }
      } else if (msg.type === 'reindex-kb') {
        // C1040/C1218 — Knowledge Base > Re-Index. Same TASK_BACKEND/credentials guard as
        // sync-kb above; the manual click now routes through fireAutoReindex(manual:true)
        // — same single-flight/cooldown state the 4 auto triggers use, so a manual click
        // and an in-flight auto run can never both hit Opus (a manual click JOINS an
        // already-running auto run instead of starting a second one).
        const cfg = projectPath ? (readProjectConfig(projectPath) || {}) : {};
        const taskBackend = cfg.TASK_BACKEND || config.TASK_BACKEND;
        if (taskBackend !== 'api') {
          sendWsJson(ws, { type: 'reindex-kb-result', success: false, error: 'KB re-index requires API backend' });
        } else {
          const { fireAutoReindex } = require('../cli/knowledge-sync');
          const rootPath = projectPath || config.PROJECT_ROOT;
          const res = await fireAutoReindex(rootPath, 'manual', {
            backend,
            manual: true,
            onProgress: (p) => sendWsJson(ws, { type: 'reindex-kb-progress', ...p }),
            onStart: (d) => { if (d.joined) sendWsJson(ws, { type: 'reindex-kb-joined', ...d }); },
          });
          if (res.status === 'ran' || res.status === 'joined') {
            sendWsJson(ws, {
              type: 'reindex-kb-result',
              success: res.ok,
              tagsUpdated: res.result?.tagsUpdated ?? 0,
              filesUpdated: res.result?.filesUpdated ?? 0,
              skipped: res.result?.skipped ?? 0,
              errors: res.result?.errors ?? [],
              ...(res.ok ? {} : { error: res.message }),
            });
          } else {
            sendWsJson(ws, { type: 'reindex-kb-result', success: false, error: res.message || res.status });
          }
        }
      }
    });
    const pingInterval = setInterval(() => {
      if (ws.readyState === 1) ws.ping();
      else clearInterval(pingInterval);
    }, 30000);
    ws.on('close', () => {
      clearInterval(pingInterval);
      console.log('[board] Board watcher disconnected');
      // Push KB to API on project close — mirror of connect-side fireSessionSync (project open).
      const closeCfg = projectPath ? (readProjectConfig(projectPath) || {}) : {};
      if ((closeCfg.TASK_BACKEND || config.TASK_BACKEND) === 'api') {
        const rootPath   = projectPath             || config.PROJECT_ROOT;
        (async () => {
          try {
            const { baseUrl: apiBaseUrl, projectId, token } = backend.getCredentials();
            await pushAll(apiBaseUrl, projectId, token, rootPath);
          } catch (err) {
            console.error(`[kb-sync:ws-close] push failed: ${err.message}`);
          }
        })();
      }
    });
    return;
  }

  const existing = sessions.get(sessionKey);

  if (terminateOnConnect && existing && existing.type === 'taskChat') {
    // (TPT469) The left menu's End control on a chat row. A chat has no PTY: end it the way
    // its own `kill` frame does, telling a window still attached to it, then ack this socket.
    console.log(`[task-chat] Terminate-on-connect requested for ${taskId}`);
    const attached = existing.ws;
    dropObjectiveSession(sessions, sessionKey, existing, taskId, 'kill');
    existing.alive = false;
    if (attached && attached !== ws && attached.readyState === attached.OPEN) {
      attached.send(JSON.stringify({ type: 'chat-ended', tabId: existing.tabId }));
    }
    broadcastSessionEnded(taskId, existing);
    ws.send(JSON.stringify({ type: 'session-ended', ...sessionEndedPayload(taskId, existing, 'terminated') }), () => ws.close());
    return;
  }

  if (terminateOnConnect) {
    console.log(`[terminal] Terminate-on-connect requested for task ${taskId}`);
    terminateTerminalSession(existing, taskId, sessionKey, sessions, 'terminated', { ackWs: ws, backend });
    return;
  }

  // One-shot nav action. It must not reattach and displace the terminal modal's socket.
  if (resumePausedOnConnect) {
    const resumed = existing?.type === 'terminal' ? resumeRunawaySession(existing) : null;
    if (resumed) websocket.emitSessionRunaway(existing.projectPath, { taskId: existing.tabId, pid: existing.ptyPid, resumed: true, promptText: resumed.text });
    ws.send(JSON.stringify({ type: 'resume-paused-result', ok: !!resumed, paused: pausedSummary(existing) }), () => ws.close());
    return;
  }

  const requestedStart = Number(url.searchParams.get('startedAt'));
  if (existing && !prompt && requestedStart > 0 && existing.startedAt > 0
      && requestedStart !== existing.startedAt) {
    ws.send(JSON.stringify({ type: 'error', code: 'ESESSION_LOST',
      message: `Terminal session for ${taskId} was replaced by another run.` }));
    ws.close();
    return;
  }

  // ── Reconnect to existing non-objective session (terminal pty) ──
  if (existing && existing.alive && !isAgentChatType(existing.type)) {
    // (TPT413) A resume never respawns: the running pty keeps its agent. A picker choice on a
    // resume (merge-branches "Resolve with agent" on a live session) reaches here as ?agent= and
    // is deliberately ignored — say so, instead of silently letting the client believe it switched.
    if (agentParam && agentParam !== existing.taskAgent) {
      console.log(`[terminal] agent=${agentParam} ignored on reattach — session ${sessionKey} is already running under ${existing.taskAgent}`);
    }
    if (projectPath) existing.projectPath = projectPath;
    if (existing.ws && existing.ws.readyState === existing.ws.OPEN) {
      existing.ws.send(JSON.stringify({ type: 'detached', tabId: existing.tabId, message: 'Another client attached' }));
      existing.ws.close();
    }
    existing.ws = ws;
    console.log(`[terminal] Reattached to session ${sessionKey} (pid ${existing.pty?.pid})`);
    // Re-read permissions on reattachment, but never paste into an active CLI dialog.
    // Approval and the local completion tool independently re-read before their actions.
    void require('./vcs-context').refreshSessionVcs(existing, backend).then(context => {
      console.log(`[vcs:resume] ${taskId}: ${JSON.stringify(context)}`);
    });
    wireClient(ws, existing, taskId, sessionKey, sessions, backend);
    if (existing.buffer.length > 0) {
      // Reset xterm parser state before replay so a buffer that begins mid-frame
      // (after MAX_SCROLLBACK rollover) cannot leave the parser in an SGR/CSI
      // state and render escape-sequence fragments as literal text.
      const REPLAY_RESET = '\x1b[!p\x1b[?1049l\x1b[2J\x1b[H';
      const replayBuffer = sanitizeReplayBuffer(existing.buffer, {
        preserveAltScreenFrame: existing.taskAgent === 'codex'
          && existing.terminalPhase === 'planning'
          && existing.codexPlanReady === true && codexPlanReadyIsFresh(existing),
      });
      ws.send(JSON.stringify({ type: 'data', tabId: existing.tabId, data: REPLAY_RESET + replayBuffer }));
    }
    forceResumeRepaint(existing);
    maybeRefirePlanReady(existing, ws);
    return;
  }

  if (existing && existing.type === 'terminal' && sessionListBucket(existing) === 'exited' && !prompt) {
    if (projectPath) existing.projectPath = projectPath;
    if (existing.ws && existing.ws !== ws && existing.ws.readyState === existing.ws.OPEN) {
      _sendIfOpen(existing.ws, { type: 'detached', tabId: existing.tabId, message: 'Another client attached' });
      try { existing.ws.close(); } catch { /* already closed */ }
    }
    existing.ws = ws;
    wireClient(ws, existing, taskId, sessionKey, sessions, backend);
    replayExitedTerminal(ws, existing);
    return;
  }

  // ── Reconnect to objective session ──
  if (existing && existing.type === 'objective') {
    // Reattached inside the detach grace window — the in-flight turn is wanted again.
    if (existing._detachTimer) { clearTimeout(existing._detachTimer); existing._detachTimer = null; }
    if (projectPath) existing.projectPath = projectPath;
    if (existing.ws && existing.ws.readyState === existing.ws.OPEN) {
      existing.ws.send(JSON.stringify({ type: 'detached', tabId: existing.tabId, message: 'Another client attached' }));
      existing.ws.close();
    }
    existing.ws = ws;
    const historySource = await getObjectiveHistorySource(taskId, existing, projectPath);
    const historyWindow = buildHistoryWindow(historySource);
    // C1101 — per-project PI_MODEL; existing.projectPath was just refreshed above.
    const _resetSel = currentSelection(existing, configForProject(existing.projectPath));
    ws.send(JSON.stringify({
      type: 'chat-history-reset',
      tabId: existing.tabId,
      messages: historyWindow.messages,
      historyWindowStart: historyWindow.historyWindowStart,
      historyTotalCount: historyWindow.historyTotalCount,
      hasOlderHistory: historyWindow.hasOlderHistory,
      running: !!existing.proc,
      // C1029 — server is authoritative on model/provider; a restored client must show
      // what this session is actually on, not whatever the last page load remembered.
      objectiveSelection: formatSelection(_resetSel.providerId, _resetSel.model),
    }));
    if (existing.proc && existing.turnBuffer.length > 0) {
      ws.send(JSON.stringify({ type: 'data', tabId: existing.tabId, data: existing.turnBuffer }));
    }

    if (existing.pendingResult) {
      const pr = existing.pendingResult;
      ws.send(JSON.stringify({ type: 'objective-result', tabId: existing.tabId, content: pr.content, tokens: pr.tokens, filesAddressed: pr.filesAddressed, docUpdates: pr.docUpdates, newTags: pr.newTags || [], timingMilestones: pr.timingMilestones }));
      ws.send(JSON.stringify({ type: 'chat-ready', tabId: existing.tabId, turnIndex: pr.turnIndex }));
      ws.send(JSON.stringify({ type: 'exit', tabId: existing.tabId, code: pr.code, chatContinues: true, showAiStats: config.SHOW_AI_STATS }));
      existing.pendingResult = null;
    } else if (existing.proc) {
      console.log(`[objective] Reattached mid-turn for task ${taskId} — streaming continues`);
    } else if (existing.alive && providerSessionId(existing)) {
      ws.send(JSON.stringify({ type: 'chat-ready', tabId: existing.tabId, turnIndex: existing.messages.length - 1 }));
      if ((existing.providerType || config.OBJECTIVE_PROVIDER) === 'claude') prewarmObjective(existing, taskId);
    } else {
      ws.send(JSON.stringify({ type: 'objective-result', tabId: existing.tabId, content: existing.buffer }));
      ws.send(JSON.stringify({ type: 'exit', tabId: existing.tabId, code: 0 }));
    }

    wireClient(ws, existing, taskId, sessionKey, sessions, backend);
    return;
  }

  // ── Reconnect to spec-chat session ──
  if (existing && existing.type === 'specChat') {
    if (projectPath) existing.projectPath = projectPath;
    if (existing.ws && existing.ws.readyState === existing.ws.OPEN) {
      existing.ws.send(JSON.stringify({ type: 'detached', tabId: existing.tabId, message: 'Another client attached' }));
      existing.ws.close();
    }
    existing.ws = ws;
    ws.send(JSON.stringify({
      type: 'chat-history-reset',
      tabId: existing.tabId,
      messages: existing.messages,
      historyWindowStart: 0,
      historyTotalCount: existing.messages.length,
      hasOlderHistory: false,
      running: !!existing.proc,
    }));
    if (existing.proc && existing.turnBuffer.length > 0) {
      ws.send(JSON.stringify({ type: 'data', tabId: existing.tabId, data: existing.turnBuffer }));
    }
    if (!existing.proc && existing.claudeSessionId) {
      ws.send(JSON.stringify({ type: 'chat-ready', tabId: existing.tabId, turnIndex: existing.messages.length - 1 }));
    }
    wireClient(ws, existing, taskId, sessionKey, sessions, backend);
    return;
  }

  // ── Reconnect to task-chat session ──
  // The session outlives its socket (idle or mid-turn), so opening the chat again lands here:
  // the client gets the whole history back instead of sending `start-task-chat` a second time.
  if (existing && existing.type === 'taskChat') {
    if (projectPath) existing.projectPath = projectPath;
    if (existing.ws && existing.ws.readyState === existing.ws.OPEN) {
      existing.ws.send(JSON.stringify({ type: 'detached', tabId: existing.tabId, message: 'Another client attached' }));
      existing.ws.close();
    }
    existing.ws = ws;
    const _chatSel = currentSelection(existing, configForProject(existing.projectPath));
    ws.send(JSON.stringify({
      type: 'chat-history-reset',
      tabId: existing.tabId,
      taskKey: existing.taskKey,
      projectId: existing.chatProjectId || null,
      title: existing.chatTitle || '',
      messages: existing.messages,
      historyWindowStart: 0,
      historyTotalCount: existing.messages.length,
      hasOlderHistory: false,
      running: !!(existing.proc || existing._spawning || existing._projectChatStarting),
      objectiveSelection: _chatSel ? formatSelection(_chatSel.providerId, _chatSel.model) : '',
    }));
    if (existing.proc && existing.turnBuffer.length > 0) {
      ws.send(JSON.stringify({ type: 'data', tabId: existing.tabId, data: existing.turnBuffer }));
    }
    // Widgets of the running turn are not in `messages` yet — a finished turn's are.
    if (existing.proc || existing._spawning) replayTaskChatTurn(existing);
    if (existing.pendingResult) {
      // A turn finished while nobody was attached. Its text is already in `messages` above;
      // these frames close the turn for the client (tokens, chat-ready).
      const pr = existing.pendingResult;
      ws.send(JSON.stringify({ type: 'objective-result', tabId: existing.tabId, content: pr.content, tokens: pr.tokens, timingMilestones: pr.timingMilestones }));
      ws.send(JSON.stringify({ type: 'chat-ready', tabId: existing.tabId, turnIndex: pr.turnIndex }));
      ws.send(JSON.stringify({ type: 'exit', tabId: existing.tabId, code: pr.code, chatContinues: true, showAiStats: config.SHOW_AI_STATS }));
      existing.pendingResult = null;
    } else if (!existing.proc && !existing._spawning && existing.messages.length > 0) {
      ws.send(JSON.stringify({ type: 'chat-ready', tabId: existing.tabId, turnIndex: existing.messages.length - 1 }));
    }
    wireClient(ws, existing, taskId, sessionKey, sessions, backend);
    return;
  }

  // A reconnect-only objective socket (chat-ui.js sends ?reconnect=1 and never a `start`) whose
  // session is gone — torn down after its detach grace, or never here. Falling through would
  // create a pending session nobody starts, and the client would spin forever.
  if (reconnectOnly && taskId.startsWith('obj-')) {
    console.log(`[objective] Reconnect for ${taskId} found no live session — session-gone`);
    _sendSessionGone(ws, tabId || taskId, config.OBJECTIVE_PROVIDER);
    ws.close();
    return;
  }

  // (C1444) Mid-spawn terminal session: alive is still false (pty.spawn hasn't run yet),
  // so the reconnect branch above didn't catch it — but it's not a stale/dead session
  // either. Falling through to "Spawn new session" below would sessions.delete() it out
  // from under the in-flight spawnTerminal() call, orphaning the pty it's about to create.
  // (TPT444) A queued session is parked until a slot frees; a reconnect re-attaches to the wait
  // instead of falling through to "Spawn new session", which would delete it from the queue.
  if (existing && existing._queued && !isAgentChatType(existing.type)) {
    if (projectPath) existing.projectPath = projectPath;
    if (existing.ws && existing.ws !== ws && existing.ws.readyState === existing.ws.OPEN) {
      _sendIfOpen(existing.ws, { type: 'detached', tabId: existing.tabId, message: 'Another client attached' });
      try { existing.ws.close(); } catch { /* already closed */ }
    }
    announceQueuedClient(ws, existing, taskId, sessionKey, sessions, backend);
    return;
  }

  if (existing && (existing._starting || existing._launching) && !isAgentChatType(existing.type)) {
    ws.send(JSON.stringify({ type: 'error', message: `Session for ${taskId} is still starting — try again in a moment.` }));
    ws.close();
    return;
  }

  // A retained natural exit is not evidence of server loss. Check before deleting
  // any existing entry; a promptless reconnect must never discard retained history.
  if (!prompt && !isAgentChatId(taskId)) {
    const lastExit = !existing && readLastExitSince(url.searchParams.get('startedAt'), config.USER_DATA_ROOT);
    ws.send(JSON.stringify(lastExit
      ? { type: 'error', code: 'ESESSION_LOST', ...lastExit,
          message: `Terminal session for ${taskId} was lost when the server exited (${lastExit.reason}, ${lastExit.at}).` }
      : { type: 'error', message: `No active terminal session for ${taskId}` }));
    ws.close();
    return;
  }

  // ── Spawn new session ──
  if (existing) {
    if (existing.type === 'objective') {
      clearContext(existing, taskId);
      throttle.recordAbort(taskId);
    } else if (existing.type === 'specChat' || existing.type === 'taskChat') {
      clearContext(existing, taskId);
    }
    sessions.delete(sessionKey);
  }

  const session = createSession(ws, !prompt, tabId || taskId, projectPath);
  if (typeof onAttentionNeeded === 'function') {
    session.onAttentionNeeded = (detail) => onAttentionNeeded(sessionKey, detail);
  }
  if (typeof onAttentionCleared === 'function') {
    session.onAttentionCleared = () => onAttentionCleared(sessionKey);
  }
  if (projectPath) session.projectPath = projectPath;
  if (planOnly) session.planOnly = true;
  if (discussionMode) session.discussionMode = true;
  if (agentParam && (await getAvailableAgents(configForProject(projectPath))).includes(agentParam)) {
    // (TPT413) Label + approval command move with the id — spawnTerminal() rewrites all three
    // after pty.spawn, but GET /api/sessions (sessionMetaRow) and the "Failed to start" message
    // below read them during the multi-second _starting window, and must name the chosen agent.
    const _chosen = getTaskAgentInfo(agentParam);
    session.taskAgent = _chosen.id;
    session.taskAgentLabel = _chosen.label;
    session.planApprovalCommand = _chosen.approvalCommand;
  }
  // C1122 — Pi launch-time model pick, validated against the PROJECT's own configured
  // PI_MODELS rows (never the global env-default list — those have no apiKey behind
  // them). Validated here, outside the getTask() try/catch below, so a REST hiccup can
  // never silently drop the user's explicit choice.
  let _piModelParam = '';
  if (modelParam && (session.taskAgent || config.TASK_AGENT) === 'pi') {
    const _piCfg = readProjectConfig(projectPath || config.PROJECT_ROOT);
    if (piEntryForModel(_piCfg, modelParam)) {
      _piModelParam = modelParam;
    } else {
      console.warn(`[ws] rejected pi model param "${modelParam}" — not in this project's PI_MODELS`);
    }
  }
  sessions.set(sessionKey, session);
  // C948: wire lifecycle callbacks before spawn — an agent that dies during boot
  // fires onExit before wireClient() below would run.
  wireSessionLifecycle(session, taskId, backend);

  const launchCtx = { session, prompt, taskId, sessionKey, sessions, backend, projectPath, initialCols, initialRows, _piModelParam };
  if (!prompt || isAgentChatId(taskId)) {
    // Promptless / chat starts never hold a terminal slot.
    await launchNewTerminalSession(launchCtx);
    return;
  }
  const admitted = sessionQueue.submit({ key: sessionKey, session, taskId, start: () => launchNewTerminalSession(launchCtx) });
  if (admitted.queued) {
    announceQueuedClient(ws, session, taskId, sessionKey, sessions, backend);
    return;
  }
  await admitted.done;
}

// ── Client message routing ──

function _makeRejectFn(session) {
  return (reason) => {
    if (session.messages.length && session.messages.at(-1).role === 'user') session.messages.pop();
    if (session.ws && session.ws.readyState === session.ws.OPEN) {
      session.ws.send(JSON.stringify({ type: 'objective-error', tabId: session.tabId, reason, status: 503, queueDepth: 0, circuitState: 'open', attempts: 0, provider: session.providerType || config.OBJECTIVE_PROVIDER })); // C1031
    }
  };
}

// A turn request reached a chat whose server session is already torn down (kill, save, socket
// close), or a reconnect found no session at all. Tell the client instead of leaving its bubble
// spinning — it renders the session-gone Retry.
function _sendSessionGone(ws, tabId, provider) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'objective-error', tabId, reason: 'session-gone', attempts: 0, provider })); // C1031 shape
  }
}

// Gate an objective turn through the circuit breaker + queue.
// Returns false and sends objective-error if rejected; otherwise returns true.
// `epoch` is session._epoch captured when the request's WS message arrived: a request whose
// awaits (prefetch, cache lookup, history compression) straddled a teardown or restart is dropped.
function _throttledSpawn(taskId, session, runFn, epoch) {
  if (session._closed) {
    console.log(`[objective] Turn request dropped — session closed task=${taskId}`);
    _sendSessionGone(session.ws, session.tabId, session.providerType || config.OBJECTIVE_PROVIDER);
    return false;
  }
  if (epoch !== undefined && epoch !== (session._epoch || 0)) {
    console.log(`[objective] Turn request dropped — session restarted meanwhile task=${taskId}`);
    return false;
  }
  const result = throttle.requestTurn(taskId, runFn, _makeRejectFn(session));
  if (!result.ok) {
    if (session.messages.length && session.messages.at(-1).role === 'user') session.messages.pop();
    if (session.ws && session.ws.readyState === session.ws.OPEN) {
      session.ws.send(JSON.stringify({ type: 'objective-error', tabId: session.tabId, reason: result.reason, status: 503, queueDepth: result.queueDepth, circuitState: result.circuitState, attempts: 0, provider: session.providerType || config.OBJECTIVE_PROVIDER })); // C1031
    }
    return false;
  }
  return true;
}

async function maybeCompressHistory(session, taskId) {
  if (!config.OBJECTIVE_HISTORY_COMPRESS_ENABLED) return;
  if (session._closed) return; // no Haiku call for a chat that is already gone
  if (session.pendingCompression) {
    await session.pendingCompression;
    return;
  }
  const TAIL_TURNS = config.OBJECTIVE_HISTORY_COMPRESS_TAIL_TURNS;
  // session.messages layout: [objective(0), u1(1), a1(2), u2(3), a2(4), ...]
  // Last user message may not yet have a paired assistant reply (turn in progress), so
  // compute eligible pairs from complete pairs only (messages.length - 1 rounds down).
  const totalPairs = Math.floor((session.messages.length - 1) / 2);
  const eligiblePairs = totalPairs - TAIL_TURNS;
  if (eligiblePairs <= session.compressedThrough) return;

  const toCompress = [];
  for (let p = session.compressedThrough + 1; p <= eligiblePairs; p++) {
    const uIdx = 1 + (p - 1) * 2;
    const aIdx = uIdx + 1;
    toCompress.push({
      turnNum: p,
      userText: session.messages[uIdx]?.content || '',
      assistantText: session.messages[aIdx]?.content || '',
    });
  }
  if (toCompress.length === 0) return;

  const epoch = session._epoch || 0;
  // The Haiku proc is registered on the session so a teardown mid-compression kills it too.
  const promise = summarizeOldTurns(toCompress, { onSpawn: proc => trackHelperProc(session, proc) });
  session.pendingCompression = promise;
  let lines;
  try {
    lines = await promise;
  } finally {
    if (session.pendingCompression === promise) session.pendingCompression = null;
  }
  // Closed or restarted while Haiku ran: these summaries describe turns that no longer exist.
  if ((session._epoch || 0) !== epoch) return;
  session.compressedSummaries.push(...lines);
  session.compressedThrough = eligiblePairs;
  // Force fresh CLI session so injected block is sole source for compressed turns.
  // C1029: clears whichever provider is currently active, not hardcoded to Claude —
  // this fires unconditionally from the `chat` handler regardless of provider.
  clearProviderSessionId(session);
  console.log(`[objective:compress] task=${taskId} compressed ${toCompress.length} pair(s) (through=${eligiblePairs}, tailKept=${TAIL_TURNS})`);
}

// Task chat's system prompt names the provider's own tools (MCP for Claude/Codex, the REST
// tool for Pi), so it is rebuilt when the provider changes — and only then: Claude appends
// fetched tag docs to session.systemPrompt and relies on that prefix staying stable.
function ensureTaskChatSystemPrompt(session) {
  const provider = session.providerType || config.OBJECTIVE_PROVIDER;
  if (session._taskChatPromptProvider === provider && session.systemPrompt) return;
  session.systemPrompt = buildTaskChatSystemPrompt({
    provider,
    task: session.chatProjectId ? null : (session._taskChatTask || { id: session.taskKey }),
    project: session._taskChatProject || null,
    langDirective: buildLanguageDirective(session.projectPath || config.PROJECT_ROOT),
  });
  session._taskChatPromptProvider = provider;
  session._cachedTagsSerialized = new Set();
}

// A task-chat agent created or updated a task (session.onTaskChatMutation, called from
// task-chat-widgets.js when the tool call returns). The agent's write went to the API directly,
// so the task is read back here: the chat gets a `task-chat-task` frame and every board on this
// project gets the same broadcast a local edit sends. Returns the event kept in chat history,
// or null — a failed read costs the widget, never the turn.
async function handleTaskChatMutation(session, { action, taskKey, toolId }) {
  try {
    const task = session.backend ? await session.backend.getTask(taskKey) : null;
    if (!task) return null;
    const projectPath = session.projectPath || undefined;
    if (action === 'created') websocket.emitTaskCreated(task, projectPath);
    else websocket.emitTaskUpdated(task, null, projectPath);
    const event = { action, toolId, task };
    if (!session._closed && session.ws && session.ws.readyState === session.ws.OPEN) {
      session.ws.send(JSON.stringify({ ...taskFrame(session, event), tabId: session.tabId }));
    }
    return event;
  } catch (err) {
    console.warn(`[task-chat] Could not read back ${taskKey} after ${action}: ${err.message}`);
    return null;
  }
}

// Every task event this chat holds, oldest first: finished turns' (on their assistant message)
// and the running turn's (attached to its message only when the turn ends).
function taskChatEvents(session) {
  const events = [];
  for (const m of session.messages || []) {
    if (m && Array.isArray(m.taskEvents)) events.push(...m.taskEvents);
  }
  const turn = session._taskChatTurn;
  if (turn && Array.isArray(turn.taskEvents)) {
    for (const event of turn.taskEvents) if (!events.includes(event)) events.push(event);
  }
  return events;
}

// The user saved a task in the task editor opened from this chat (`task-chat-task-edited`).
// The agent has no way to notice that, so the task is read back and queued: the next user turn
// opens with a `task_edits` block (takeTaskChatEdits()). Allowed mid-turn — it only queues.
// The chat's own copies of the task are refreshed and the client gets the task back to redraw
// its cards. A failed read is dropped: the edit itself already succeeded.
async function handleTaskChatUserEdit(session, rawKey) {
  const taskKey = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!isValidTaskKey(taskKey)) return;
  let task;
  try {
    task = session.backend ? await session.backend.getTask(taskKey) : null;
  } catch (err) {
    console.warn(`[task-chat] Could not read back ${taskKey} after a user edit: ${err.message}`);
    return;
  }
  if (!task || session._closed) return;
  if (!session.pendingTaskEdits) session.pendingTaskEdits = new Map();
  const events = taskChatEvents(session).filter(event => event && event.task && event.task.id === taskKey);
  const queued = session.pendingTaskEdits.get(taskKey);
  // What the agent last saw: the copy from before the first still-untold edit, else the latest
  // copy this chat showed. Unknown when the chat never held the task.
  const prev = queued ? queued.prev : (events.length ? events[events.length - 1].task : null);
  const changed = changedTaskFields(prev, task);
  if (changed.length) session.pendingTaskEdits.set(taskKey, { task, changed, prev });
  else session.pendingTaskEdits.delete(taskKey);
  for (const event of events) event.task = task;
  if (session.ws && session.ws.readyState === session.ws.OPEN) {
    session.ws.send(JSON.stringify({ type: 'task-chat-task-edited', tabId: session.tabId, taskKey: session.taskKey, task, changed }));
  }
}

// Hand-made task edits not yet told to the agent -> [{ task, changed, prev }], and forget them.
// Kept on the session until the turn they ride on survives: an abort puts them back.
function takeTaskChatEdits(session) {
  const edits = session.pendingTaskEdits ? [...session.pendingTaskEdits.values()] : [];
  if (session.pendingTaskEdits) session.pendingTaskEdits.clear();
  session._drainedTaskEdits = edits.length ? edits : null;
  return edits;
}

function restoreTaskChatEdits(session) {
  const edits = session._drainedTaskEdits;
  session._drainedTaskEdits = null;
  if (!edits) return;
  if (!session.pendingTaskEdits) session.pendingTaskEdits = new Map();
  for (const edit of edits) {
    // A newer edit of the same task, queued while the turn ran, keeps its task but still
    // compares against what the agent saw before the aborted turn.
    const newer = session.pendingTaskEdits.get(edit.task.id);
    if (!newer) { session.pendingTaskEdits.set(edit.task.id, edit); continue; }
    const changed = changedTaskFields(edit.prev, newer.task);
    if (changed.length) session.pendingTaskEdits.set(edit.task.id, { task: newer.task, changed, prev: edit.prev });
    else session.pendingTaskEdits.delete(edit.task.id);
  }
}

// C948: lifecycle callbacks shared by wireClient() and the pre-spawn wiring in
// handleConnection() — wiring must exist before spawnTerminal() so an agent that
// dies during boot still posts its resolution comment.
function wireSessionLifecycle(session, taskId, backend) {
  if (!taskId || isAgentChatId(taskId)) return;
  // C982: stashed for the index.js completion poller — the sessions Map key is
  // sessKey(tabId||taskId, projectPath), so taskId is not recoverable from the key,
  // and per-project (Electron multi-window) sessions need their own backend.
  session.taskId = taskId;
  session.backend = backend;
  session.onSlotFreed = drainSessionQueue; // (TPT444) pty exit frees a start slot
  session.onTokensReady = (tokens) => {
    backend.addTokenUsage(taskId, tokens).catch(err =>
      console.error(`[ws] Failed to persist tokens for ${taskId}:`, err.message));
  };
  // (TPT354) The exit comment is composed by exit-resolution.js, in this order: (1) nothing at
  // all when the agent already posted its own resolution report this run; (2) the agent's final
  // assistant message, read from its own CLI transcript; (3) a sanitized, readability-checked
  // PTY tail; (4) the bare header. It used to be the raw ~80-line scrollback — which, for a TUI,
  // is redraw frames and animated-title OSC payloads, not text. See tt-claude-session-terminal.md
  // § Exit resolution comment.
  session.onSessionExit = async ({ exitCode, buffer, reason, reasonText }) => {
    if (!backend) return;
    // Dedup: natural exit posts first; the follow-up terminate/cleanup must not re-post.
    if (session._resolutionPosted) return;
    session._resolutionPosted = true;
    // Snapshot this run's state now — the completion wait below can outlive a restart, which
    // replaces session._transcriptHint / _commentBaselineId with the NEW run's.
    const transcriptSession = { _transcriptHint: session._transcriptHint };
    const baselineId = session._commentBaselineId;
    const agentPostedOwnReport = async () => {
      if (typeof backend.getTaskComments !== 'function') return false;
      try {
        return hasSelfAuthoredResolution(await backend.getTaskComments(taskId), baselineId);
      } catch {
        return false; // unknown → fail toward posting
      }
    };
    try {
      if (await agentPostedOwnReport()) {
        console.log(`[ws] ${taskId}: agent posted its own resolution comment — skipping the auto exit comment`);
        return;
      }
      let finalMessage = '';
      try {
        const agent = getTaskAgent(session.taskAgent);
        // 'completed' fires from a 10s poll on the task status flip, which can precede the
        // agent's closing message by a few seconds: wait for its turn to end (bounded).
        const result = await waitForFinalMessage(() => agent.readFinalMessage(transcriptSession), { needTurnEnd: reason === 'completed' });
        finalMessage = selectFinalMessage(result, reason);
      } catch (err) {
        console.error(`[ws] Final-message read failed for ${taskId}:`, err.message);
      }
      // The agent's own report and its `completed` status can land out of order, and the wait
      // above may have run for a while — look once more before posting a redundant comment.
      if (reason === 'completed' && await agentPostedOwnReport()) {
        console.log(`[ws] ${taskId}: agent posted its own resolution comment — skipping the auto exit comment`);
        return;
      }
      const { content, source } = buildExitResolutionComment({ reason, reasonText, exitCode, finalMessage, buffer });
      await backend.createTaskComment(taskId, content, 'resolution');
      console.log(`[ws] ${taskId}: posted exit resolution comment (${source})`);
    } catch (err) {
      console.error(`[ws] Failed to post resolution comment for ${taskId}:`, err.message);
    }
  };
}

function wireClient(ws, session, taskId, sessionKey, sessions, backend) {
  // C1131 — session.taskAgent is already resolved project-scoped (createSession() /
  // session-state.js) or explicitly overridden (WS ?agent= param) — read it straight
  // instead of re-resolving against the global config.TASK_AGENT snapshot.
  const taskAgent = getTaskAgentInfo(session && session.taskAgent);
  // C1101 — per-project PI_MODEL; harmless identity no-op for terminal/spec sessions.
  const _clientCfg = configForProject(session && session.projectPath);
  const _clientVisibleProviders = listVisibleObjectiveProviders(_clientCfg, { peek: true }); // (C1259)
  // (C1136) Only clamp a default the session hasn't really chosen yet (no selectedModel) —
  // a session that already picked a provider stays session-authoritative even if that
  // provider is no longer visible; chat-ui.js's own stale-selection heal covers that rarer
  // case client-side instead of the server silently swapping a live choice.
  // (TPT162) The no-selectedModel clamp branch can now land on an empty _clientVisibleProviders
  // — clampSelectionToProviders() returns its input unchanged on [], which would advertise a
  // provider:model pair nothing offers. Ship null (→ '' below) instead; a session that already
  // picked a provider (the branch above) stays session-authoritative either way.
  const _clientSel = (session && session.selectedModel)
    ? currentSelection(session, _clientCfg)
    : (_clientVisibleProviders.length
      ? clampSelectionToProviders(currentSelection(session, _clientCfg), _clientVisibleProviders)
      : null);
  ws.send(JSON.stringify({
    type: 'config',
    showAiStats: config.SHOW_AI_STATS,
    taskAgent: taskAgent.id,
    taskAgentLabel: taskAgent.label,
    agentLabels: _agentLabels(),
    planApprovalCommand: taskAgent.approvalCommand,
    supportsPlanMode: taskAgent.supportsPlanMode,
    // (C1259) Peek variants — same reasoning as the board watcher's config frame above.
    availableAgents: getAvailableAgentsPeek(_clientCfg),
    agentStatuses: listTaskAgentStatusesPeek(config),
    avatarUrl: config.USER_AVATAR_URL,
    // C1029 — chat-model-selector option list + this session's current selection
    // (session-specific: reflects any prior applyModelSelection on this session).
    // (C1136) Filtered to this project's own selected+configured providers.
    objectiveProviders: _clientVisibleProviders,
    objectiveSelection: _clientSel ? formatSelection(_clientSel.providerId, _clientSel.model) : '',
  }));
  if (!isAgentChatType(session.type)) {
    emitTerminalState(session);
  }
  wireSessionLifecycle(session, taskId, backend);
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // A torn-down chat (kill, save, socket close) takes no further turns — and restart must not
    // resurrect it: clearContext() would re-open a session that is no longer in the map.
    if (session._closed && ['chat', 'revise', 'restart', 'task-chat-message', 'task-chat-answer'].includes(msg.type)) {
      _sendSessionGone(ws, session.tabId, session.providerType || config.OBJECTIVE_PROVIDER);
      return;
    }
    // Turn requests below await (rehash, prefetch, cache, compression) before spawning; a
    // teardown or restart in between bumps the epoch and _throttledSpawn() drops the stale request.
    const epochAtReceipt = session._epoch || 0;

    // Follow-ups carry the tab's current context, including explicit null on exit.
    if (session.type === 'objective' && ['chat', 'revise', 'restart'].includes(msg.type)
        && !session.proc && !session._spawning) {
      try { await applyRehashIntent(session, msg, taskId); }
      catch (err) {
        ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: err.message }));
        return;
      }
    }

    if (msg.type === 'upload-image') {
      await handleWsImageUpload(ws, backend, msg);
    } else if (msg.type === 'start' && session.pending && typeof msg.prompt === 'string') {
      session.pending = false;

      if (msg.mode === 'objective') {
        try {
          if (config.OBJECTIVE_TIMING_ENABLED) {
            session.timingMilestones.msgReceivedAt = Date.now();
            if (msg.clientTiming) session.timingMilestones.client = msg.clientTiming;
          }
          session.type = 'objective';
          // C1187 — stash backend on the session so claude-session.js's live task-card
          // preview can resolve this project's workflow-start status name (once,
          // fire-and-forget — never blocks turn start; see claude-session.js's
          // ensureSessionStartName/sessionStartName for the sync-read/async-resolve split).
          session.backend = backend;
          void ensureSessionStartName(session);
          // C1029 — apply chat-model-selector choice before anything else reads
          // providerType/selectedModel (systemPrompt assembly, prewarm gating, spawn).
          {
            const _sel = await applyModelSelection(session, msg.model, { taskId });
            if (_sel.error) {
              if (session.ws && session.ws.readyState === session.ws.OPEN) {
                session.ws.send(JSON.stringify({ type: 'objective-error', tabId: session.tabId, reason: _sel.error, status: 409, detail: _sel.reason }));
              }
              return;
            }
          }
          // Active project root for arch-doc resolution — multiple project windows share one
          // forked server, so reads must target THIS session's project tree, not a module
          // const (which in packaged builds pointed at the app bundle). Falls back to
          // config.PROJECT_ROOT (dev/single-project — unchanged) (C894).
          const objProjectRoot = session.projectPath || config.PROJECT_ROOT;
          // Pre-warm arch-doc disk cache so the first get_tag_architectures hook hits cache (~0ms) vs MCP stdio (~386ms).
          if (!config.SIMPLE_MODE && config.API_PROJECT_ID) {
            _fetchTaskTags(backend, taskId).then(ttTags => {
              const override = ttTags.length ? ttTags : undefined;
              prewarmArchCache({ projectId: config.API_PROJECT_ID, tagsOverride: override, projectRoot: objProjectRoot });
            }).catch(() => {
              prewarmArchCache({ projectId: config.API_PROJECT_ID, projectRoot: objProjectRoot });
            });
          }
          // Kick off pre-fetch before synchronous system-prompt work so both run concurrently.
          const prefetchPromise = config.SIMPLE_MODE ? null : prefetchObjectiveWorkflow(backend, taskId, objProjectRoot, msg.prompt);
          if (msg.systemPrompt) {
            if (config.SIMPLE_MODE) {
              // SIMPLE_MODE: suppress static bundle; --append-system-prompt is skipped in buildObjectiveArgs
              session.systemPrompt = '';
            } else {
              const staticBundle = getStaticBundle(objProjectRoot);
              // Project-language directive first (C942), '' for 'en' — READ-ONLY
              // PLANNER gate stays a substring so CLAUDE.md detection is unaffected.
              const langDirective = buildLanguageDirective(objProjectRoot, { objective: true });
              // READ-ONLY PLANNER gate leads — static KB follows (C934)
              session.systemPrompt = (langDirective ? langDirective + '\n\n' : '') + msg.systemPrompt + '\n\n' + staticBundle;
              const stats = getStaticBundleStats(objProjectRoot);
              session._profileStatic = { staticChars: stats.chars, sha: stats.sha, tagsCount: stats.tagsCount, clientChars: msg.systemPrompt.length };
              console.log(`[objective:init] task=${taskId} staticBundle.chars=${stats.chars} sha=${stats.sha} tags=${stats.tagsCount} clientSystemPrompt.chars=${msg.systemPrompt.length} systemPrompt.chars=${session.systemPrompt.length}`);
            }
          }
          await applyRehashIntent(session, msg, taskId);
          if (prefetchPromise) {
            const { bundle: prefetchBundle, elapsedMs: prefetchMs } = await prefetchPromise;
            if (prefetchBundle) {
              msg.prompt = `${prefetchBundle}\n\n${msg.prompt}`;
              console.log(`[objective:init] prefetch ms=${prefetchMs} chars=${prefetchBundle.length}`);
            }
          }
          // (TPT254) A blank subtask kickoff sends userText: '' — that's a real, intentional
          // value, not a missing one. `|| msg.prompt` would replay the whole assembled prompt
          // (pre-fetch bundle included) as the user bubble on reconnect; only fall back when
          // userText isn't a string at all (older client / non-string payload).
          session.messages.push({ role: 'user', content: typeof msg.userText === 'string' ? msg.userText : msg.prompt, timestamp: Date.now() });
          session.firstPrompt = msg.prompt;

          // Response cache lookup (C481): bypass spawn on first-turn repeat with same task state + prompt.
          if (!config.SIMPLE_MODE && !session.rehashIntent && process.env.OBJECTIVE_RESPONSE_CACHE_ENABLED !== '0') {
            try {
              const allTasks = await taskCache.getTasks(backend, backend);
              const currentTask = allTasks.find(t => t.id === taskId) || null;
              const cacheKey = objectiveResponseCache.buildKey({
                taskId, task: currentTask, tasks: allTasks, userText: msg.userText || msg.prompt, projectPath: objProjectRoot,
                provider: session.providerType, model: session.selectedModel,
              });
              session._objectiveCacheKey = cacheKey;
              session._objectiveCacheTaskId = taskId;

              const hit = objectiveResponseCache.get(cacheKey);
              if (hit) {
                const p = hit.payload;
                const assistantMsg = {
                  role: 'assistant', content: p.content, cards: p.cards,
                  filesAddressed: p.filesAddressed, docUpdates: p.docUpdates,
                  objectiveSummary: p.objectiveSummary || null, // C1339
                  // C1439: was missing — the live WS frame below already sends newTags,
                  // but session.messages (the reconnect/chat-history-reset replay source)
                  // never carried it for a cache-hit turn, so a reconnect right after one
                  // silently lost the turn's tag registrations.
                  newTags: p.newTags || [],
                  timestamp: Date.now(), fromCache: true, cachedAt: hit.cachedAt,
                };
                session.messages.push(assistantMsg);
                const turnIndex = session.messages.length - 1;
                ws.send(JSON.stringify({
                  type: 'objective-result', tabId: session.tabId, content: p.content, tokens: p.tokens,
                  filesAddressed: p.filesAddressed, docUpdates: p.docUpdates,
                  newTags: p.newTags || [], objectiveSummary: p.objectiveSummary || null,
                  timingMilestones: p.timingMilestones, cards: p.cards,
                  fromCache: true, cachedAt: hit.cachedAt,
                }));
                ws.send(JSON.stringify({ type: 'chat-ready', tabId: session.tabId, turnIndex }));
                ws.send(JSON.stringify({ type: 'exit', tabId: session.tabId, code: 0, chatContinues: false, showAiStats: config.SHOW_AI_STATS }));
                console.log(`[objective:cache] task=${taskId} hit cachedAt=${new Date(hit.cachedAt).toISOString()} key=${cacheKey.slice(0, 12)}`);
                return;
              }
              console.log(`[objective:cache] task=${taskId} miss key=${cacheKey.slice(0, 12)}`);
            } catch (cacheErr) {
              console.warn(`[objective:cache] lookup error (will spawn): ${cacheErr.message}`);
            }
          }

          await maybeCompressHistory(session, taskId);
          _throttledSpawn(taskId, session, () => spawnTurn(session, taskId), epochAtReceipt);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: `Failed to start Claude Code: ${err.message}` }));
          ws.close();
          sessions.delete(sessionKey);
        }
      } else {
        if (session._queued || session._launching || session._starting || session.alive) return;
        const launch = async () => {
          try {
            if (msg.agent) {
              if ((await getAvailableAgents(configForProject(session.projectPath))).includes(msg.agent)) {
                session.taskAgent = msg.agent;
              } else {
                ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: `Unknown agent: ${msg.agent}` }));
                ws.close();
                sessions.delete(sessionKey);
                return;
              }
            }
            try {
              // Inlined rather than reusing _fetchTaskTags() (whose tt-*-only return shape is also
              // relied on by the objective-chat arch-cache prewarm call above) — this spawn site
              // additionally needs the raw 'discovery' tag (C1134), which is not a tt-* tag.
              // C1207: this deferred-start path reads neither the per-task model (claudeModel)
              // nor claudeDesignMode — it is currently unreachable for a real task key (a
              // promptless connect is rejected above unless the id is obj-*/specChat:, and the
              // only `{type:'start'}` sender is objective-mode chat-ui.js). If that ever changes,
              // both would need wiring here together, the same way as the path above.
              let taskTags = [];
              let discovery = false;
              let _task = null; // C1408 — hoisted so assertTaskStartable()/claimUnassignedTaskOnStart() can reuse this fetch
              try {
                _task = await backend.getTask(taskId);
                const _rawTags = _task?.tags || [];
                taskTags = _rawTags.filter(t => t.startsWith('tt-'));
                discovery = _rawTags.includes('discovery');
              } catch { /* ignore — tags and discovery fall back to empty/false */ }
              // C1408 — see the handleConnection spawn path above for the same guard.
              const _me = await assertTaskStartable(backend, taskId, _task);
              _task = await claimUnassignedTaskOnStart(backend, taskId, _task, _me, session.projectPath);
              await spawnTerminal(session, msg.prompt, taskId, taskTags, { sessions, backend, discovery, task: _task });
              if (session._terminated || sessions.get(sessionKey) !== session) {
                try { ws.close(); } catch { /* already closed */ }
                return;
              }
              postDeviceSession(taskId, backend);
              await _syncAgentAssignee(backend, taskId, session.taskAgent);
              _recordLastUsedAgent(session);
              if (session._terminated || sessions.get(sessionKey) !== session) {
                try { ws.close(); } catch { /* already closed */ }
                return;
              }
            } catch (err) {
              if (err.code === 'ETERMINATED') {
                try { ws.close(); } catch { /* already closed */ }
                sessions.delete(sessionKey);
                return;
              }
              if (err.code === 'EASSIGNEE') {
                ws.send(JSON.stringify({ type: 'error', code: 'EASSIGNEE', tabId: session.tabId, message: 'Cannot start a task assigned to another member.' }));
                ws.close();
                sessions.delete(sessionKey);
                return;
              }
              if (err.code === 'ECLAIM') {
                ws.send(JSON.stringify({ type: 'error', code: 'ECLAIM', tabId: session.tabId, message: 'Could not assign this task to you. Task start canceled.' }));
                ws.close();
                sessions.delete(sessionKey);
                return;
              }
              if (err.code === 'EAUTH') {
                // (C1383) Pre-spawn credential check tripped — expired/invalid API_TOKEN.
                ws.send(JSON.stringify({ type: 'error', code: 'EAUTH', tabId: session.tabId, message: eauthClientMessage(err) }));
                ws.close();
                sessions.delete(sessionKey);
                return;
              }
              ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: `Failed to start ${session.taskAgentLabel}: ${err.message}` }));
              ws.close();
              sessions.delete(sessionKey);
            }
          } finally {
            session._launching = false;
            drainSessionQueue();
          }
        };
        if (isAgentChatId(taskId)) await launch();
        else {
          const admitted = sessionQueue.submit({ key: sessionKey, session, taskId, start: launch });
          if (admitted.queued) {
            const snap = sessionQueue.snapshot(session.projectPath);
            _sendIfOpen(ws, queuedSessionFrame(session, taskId, snap));
          } else await admitted.done;
        }

      }
    } else if (msg.type === 'chat' && typeof msg.content === 'string' && session.type === 'objective') {
      if (config.OBJECTIVE_TIMING_ENABLED) session.timingMilestones.msgReceivedAt = Date.now();
      // (C1030) session._spawning covers Codex's async image-localize window — proc is
      // assigned only after that resolves, so a proc-only check lets a second send in.
      if (session.proc || session._spawning) {
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: 'A turn is still in progress. Wait for chat-ready.' }));
        }
        return;
      }
      {
        const _sel = await applyModelSelection(session, msg.model, { taskId });
        if (_sel.error) {
          if (session.ws && session.ws.readyState === session.ws.OPEN) {
            session.ws.send(JSON.stringify({ type: 'objective-error', tabId: session.tabId, reason: _sel.error, status: 409, detail: _sel.reason }));
          }
          return;
        }
      }
      // C1029: only reject when there is truly nothing to hand off. A provider switch
      // nulls providerSessionId() by design (registry.clearAllProviderSessionIds) even
      // though session.messages still holds the conversation — providers/transcript.js
      // replays it to the new provider (buildTurnPrompt 'handoff' mode) instead of
      // resuming a CLI session id that no longer applies.
      if (!providerSessionId(session) && session.messages.length === 0) {
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: 'No session to resume. Start a new conversation.' }));
        }
        return;
      }
      console.log(`[objective] Chat follow-up for task ${taskId}: "${msg.content.slice(0, 80)}..."`);
      session.buffer += `\n--- User ---\n${msg.content}\n--- Assistant ---\n`;
      session.messages.push({ role: 'user', content: msg.content, timestamp: Date.now() });
      await maybeCompressHistory(session, taskId);
      _throttledSpawn(taskId, session, () => spawnTurn(session, taskId), epochAtReceipt);

    } else if (msg.type === 'start-spec-chat' && session.pending) {
      session.pending = false;
      try {
        const taskKey = msg.taskKey || taskId.replace(/^specChat:/, '');
        const task = await backend.getTask(taskKey);
        if (!task) {
          if (session.ws && session.ws.readyState === session.ws.OPEN) {
            session.ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: `Task not found: ${taskKey}` }));
          }
          return;
        }
        session.type = 'specChat';
        session.taskKey = taskKey;
        session.systemPrompt = msg.systemPrompt || '';
        const seed = `Here is the task I want to improve:\n\n\`\`\`json\n${JSON.stringify(task, null, 2)}\n\`\`\`\n\n${msg.openingMessage || 'Help me refine this task spec. Ask any clarifying questions before proposing changes.'}`;
        session.messages.push({ role: 'user', content: seed, timestamp: Date.now() });
        session.firstPrompt = seed;
        console.log(`[spec-chat] Started for task ${taskKey} (session ${taskId})`);
        spawnObjectiveTurn(session, taskId);
      } catch (err) {
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: `Failed to start spec chat: ${err.message}` }));
        }
      }

    } else if (msg.type === 'spec-chat-message' && session.type === 'specChat') {
      if (session.proc) {
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: 'A turn is still in progress. Wait for chat-ready.' }));
        }
        return;
      }
      if (!session.claudeSessionId) {
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: 'No Claude session to resume. Start a new spec chat.' }));
        }
        return;
      }
      const content = String(msg.content || '').trim();
      if (!content) return;
      console.log(`[spec-chat] Follow-up for ${taskId}: "${content.slice(0, 80)}"`);
      session.messages.push({ role: 'user', content, timestamp: Date.now() });
      spawnObjectiveTurn(session, taskId);

    } else if (msg.type === 'start-project-chat' && session.pending && isProjectChatId(taskId)) {
      session.pending = false;
      // Mark this as a chat before any backend await. A reconnect while project context is
      // loading must reattach to this session instead of replacing its map entry.
      session.type = 'taskChat';
      session.taskKey = null;
      session.chatProjectId = projectIdFromChatId(taskId);
      session._projectChatStarting = true;
      try {
        const projectId = session.chatProjectId;
        const [settings, tasks] = await Promise.all([
          backend.getProjectSettings ? backend.getProjectSettings({ strict: true }) : null,
          backend.getTasksUnfiltered ? backend.getTasksUnfiltered() : backend.getTasks(),
        ]);
        if (sessions.get(sessionKey) !== session || session._closed) return;
        if (settings?.id != null && String(settings.id) !== projectId) {
          throw new Error('Project settings do not match the selected project.');
        }
        const localConfig = readProjectConfig(session.projectPath || config.PROJECT_ROOT) || {};
        const project = {
          id: projectId,
          name: settings?.name || localConfig.projectName || config.projectName || `Project ${projectId}`,
          description: settings?.description || '',
          language: settings?.language || localConfig.language || '',
          task_group_label: settings?.task_group_label || '',
          sprints_enabled: settings?.sprints_enabled ?? null,
        };
        session.toolProfile = TASK_CHAT;
        session.backend = backend;
        session.onTaskChatMutation = info => handleTaskChatMutation(session, info);
        session._taskChatProject = project;
        if (!providerSupportsProfile(session, session.providerType || config.OBJECTIVE_PROVIDER)) {
          session.providerType = 'claude';
          session.selectedModel = null;
        }
        const _sel = await applyModelSelection(session, msg.model, { taskId });
        if (_sel.error) {
          if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
          if (session.ws && session.ws.readyState === session.ws.OPEN) {
            session.ws.send(JSON.stringify({ type: 'objective-error', tabId: session.tabId, reason: _sel.error, status: 409, detail: _sel.reason }));
          }
          return;
        }
        if (sessions.get(sessionKey) !== session || session._closed) return;
        ensureTaskChatSystemPrompt(session);
        const seed = buildTaskChatSeed({ project, tasks, openingMessage: typeof msg.openingMessage === 'string' ? msg.openingMessage : '' });
        session.messages.push({ role: 'user', content: seed, seed: true, timestamp: Date.now() });
        session.firstPrompt = seed;
        if (!session._aborted) spawnTurn(session, taskId);
      } catch (err) {
        if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: `Failed to start project chat: ${err.message}` }));
        }
      } finally {
        session._projectChatStarting = false;
      }

    } else if (msg.type === 'start-task-chat' && session.pending && isTaskChatId(taskId)) {
      session.pending = false;
      try {
        const taskKey = taskKeyFromChatId(taskId);
        const [task, comments] = await Promise.all([
          backend.getTask(taskKey),
          // Comment history is context, not a precondition — a failed read starts the chat without it.
          Promise.resolve().then(() => backend.getTaskComments(taskKey)).catch(() => []),
        ]);
        if (!task) {
          if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
          if (session.ws && session.ws.readyState === session.ws.OPEN) {
            session.ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: `Task not found: ${taskKey}` }));
          }
          return;
        }
        session.type = 'taskChat';
        session.taskKey = taskKey;
        session.toolProfile = TASK_CHAT;
        session.backend = backend;
        session.onTaskChatMutation = info => handleTaskChatMutation(session, info);
        session._taskChatTask = { id: task.id || taskKey, title: task.title || '' };
        // A server-wide default the profile cannot run on (gemini) must not be advertised
        // back to the client as this chat's provider.
        if (!providerSupportsProfile(session, session.providerType || config.OBJECTIVE_PROVIDER)) {
          session.providerType = 'claude';
          session.selectedModel = null;
        }
        const _sel = await applyModelSelection(session, msg.model, { taskId });
        if (_sel.error) {
          if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
          if (session.ws && session.ws.readyState === session.ws.OPEN) {
            session.ws.send(JSON.stringify({ type: 'objective-error', tabId: session.tabId, reason: _sel.error, status: 409, detail: _sel.reason }));
          }
          return;
        }
        ensureTaskChatSystemPrompt(session);
        const seed = buildTaskChatSeed({ task, comments, openingMessage: typeof msg.openingMessage === 'string' ? msg.openingMessage : '' });
        // `seed: true` marks the generated first message so a client can leave it out of the transcript.
        session.messages.push({ role: 'user', content: seed, seed: true, timestamp: Date.now() });
        session.firstPrompt = seed;
        console.log(`[task-chat] Started for task ${taskKey} provider=${session.providerType} comments=${Array.isArray(comments) ? comments.length : 0}`);
        spawnTurn(session, taskId);
      } catch (err) {
        if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: `Failed to start task chat: ${err.message}` }));
        }
      }

    } else if ((msg.type === 'task-chat-message' || msg.type === 'task-chat-answer') && session.type === 'taskChat') {
      const _chatError = (message) => {
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message }));
        }
      };
      // session._spawning covers Codex's async image-localize window (see the `chat` handler).
      if (session.proc || session._spawning || session._projectChatStarting) {
        _chatError('A turn is still in progress. Wait for chat-ready.');
        return;
      }
      // An answer to a dialog is a user turn like any other; what differs is where its text
      // comes from — the options picked, checked against the dialog the agent actually asked.
      let content;
      let _answered = null;
      if (msg.type === 'task-chat-answer') {
        const open = findOpenDialog(session.messages, msg.dialogId);
        if (open.error) { _chatError(open.error); return; }
        const resolved = resolveDialogAnswer(open.dialog, { selected: msg.selected, other: msg.other });
        if (resolved.error) { _chatError(resolved.error); return; }
        content = resolved.content;
        _answered = { dialog: open.dialog, answer: resolved.answer };
      } else {
        content = typeof msg.content === 'string' ? msg.content.trim() : '';
        if (!content) {
          _chatError('task-chat-message needs a non-empty `content` string.');
          return;
        }
      }
      {
        const _sel = await applyModelSelection(session, msg.model, { taskId });
        if (_sel.error) {
          if (session.ws && session.ws.readyState === session.ws.OPEN) {
            session.ws.send(JSON.stringify({ type: 'objective-error', tabId: session.tabId, reason: _sel.error, status: 409, detail: _sel.reason }));
          }
          return;
        }
      }
      // Torn down or restarted while the selection was being validated.
      if (session._closed || (session._epoch || 0) !== epochAtReceipt) return;
      ensureTaskChatSystemPrompt(session);
      console.log(`[task-chat] Follow-up for ${taskId}: "${content.slice(0, 80)}"`);
      const _userMsg = { role: 'user', content, timestamp: Date.now() };
      if (_answered) {
        // Re-checked after the await above: a second answer may have raced this one.
        if (_answered.dialog.answer) { _chatError('That dialog is already answered.'); return; }
        _answered.dialog.answer = { ..._answered.answer, at: _userMsg.timestamp };
        _userMsg.dialogAnswer = { dialogId: _answered.dialog.id, ..._answered.answer };
      }
      // Tasks the user edited by hand since the last turn ride at the top of this one.
      const _edits = takeTaskChatEdits(session);
      if (_edits.length) {
        _userMsg.content = `${buildTaskEditNote(_edits)}\n\n${content}`;
        _userMsg.taskEdits = _edits.map(e => ({ taskKey: e.task.id, changed: e.changed }));
      }
      session.messages.push(_userMsg);
      // (TPT469) The first message the user sends names a project chat: from here on it is a
      // conversation of its own in the left menu, and the next Start Chat opens a new one.
      if (session.chatProjectId && !session.chatTitle) {
        session.chatTitle = buildProjectChatTitle(content);
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'project-chat-titled', tabId: session.tabId, title: session.chatTitle }));
        }
      }
      // Image/file refs are localized by each provider's spawn (localizeAttachments() on the
      // assembled prompt), so messages[].content keeps the text the user sent — no pass here.
      spawnTurn(session, taskId);

    } else if (msg.type === 'task-chat-task-edited' && session.type === 'taskChat') {
      await handleTaskChatUserEdit(session, msg.taskKey);

    } else if (msg.type === 'apply-spec-update' && session.type === 'specChat') {
      const update = msg.update || {};
      const patch = {};
      if (typeof update.title === 'string' && update.title.trim()) patch.title = update.title.trim();
      if (typeof update.description === 'string') patch.description = update.description;
      if (Array.isArray(update.tags)) patch.tags = update.tags;
      if (typeof update.priority === 'number' && Number.isInteger(update.priority) && update.priority >= 1) patch.priority = update.priority;
      if (Object.keys(patch).length === 0) {
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'spec-apply-error', tabId: session.tabId, message: 'No valid fields in update' }));
        }
        return;
      }
      try {
        // C1165: accepting a spec-chat suggestion is always a chat-driven edit — no
        // opt-in flag needed here (unlike the objective-chat PATCH fallback, which
        // shares this handler's PATCH /api/tasks/:id route with non-chat callers).
        await applyReopenToPatch(backend, session.taskKey, patch, 'spec-chat');
        const updated = await backend.updateTask(session.taskKey, patch);
        if (!updated) {
          if (session.ws && session.ws.readyState === session.ws.OPEN) {
            session.ws.send(JSON.stringify({ type: 'spec-apply-error', tabId: session.tabId, message: `Task ${session.taskKey} not found` }));
          }
          return;
        }
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'spec-applied', tabId: session.tabId, taskId: session.taskKey, task: updated }));
        }
        websocket.emitTaskUpdated(updated);
        console.log(`[spec-chat] Applied spec update to ${session.taskKey}: ${Object.keys(patch).join(', ')}`);
      } catch (err) {
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'spec-apply-error', tabId: session.tabId, message: err.message }));
        }
      }

    } else if (msg.type === 'revise' && session.type === 'objective') {
      if (config.OBJECTIVE_TIMING_ENABLED) session.timingMilestones.msgReceivedAt = Date.now();
      // (C1030) see matching comment on the `chat` handler above re: session._spawning.
      if (session.proc || session._spawning) {
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: 'A turn is still in progress.' }));
        }
        return;
      }
      {
        const _sel = await applyModelSelection(session, msg.model, { taskId });
        if (_sel.error) {
          if (session.ws && session.ws.readyState === session.ws.OPEN) {
            session.ws.send(JSON.stringify({ type: 'objective-error', tabId: session.tabId, reason: _sel.error, status: 409, detail: _sel.reason }));
          }
          return;
        }
      }
      // C1029: see the matching comment on the `chat` handler above.
      if (!providerSessionId(session) && session.messages.length === 0) {
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: 'No session to resume.' }));
        }
        return;
      }
      const { accepted, rejected, feedback } = msg;
      let revisionPrompt = '';
      if (accepted && accepted.length > 0) {
        revisionPrompt += `The user ACCEPTED these task cards (keep them as-is unless feedback says otherwise):\n${JSON.stringify(accepted, null, 2)}\n\n`;
      }
      if (rejected && rejected.length > 0) {
        revisionPrompt += `The user REJECTED these task cards (remove or rework them):\n${JSON.stringify(rejected, null, 2)}\n\n`;
      }
      if (feedback) {
        revisionPrompt += `User feedback: ${feedback}\n\n`;
      }
      revisionPrompt += 'Please provide a revised set of task proposals in the same JSON format.';

      console.log(`[objective] Revise for task ${taskId}: accepted=${(accepted||[]).length} rejected=${(rejected||[]).length}`);
      session.buffer += `\n--- User (revise) ---\n${revisionPrompt}\n--- Assistant ---\n`;
      session.messages.push({ role: 'user', content: revisionPrompt, timestamp: Date.now() });
      await maybeCompressHistory(session, taskId);
      _throttledSpawn(taskId, session, () => spawnTurn(session, taskId), epochAtReceipt);

    } else if (msg.type === 'finalize' && session.type === 'objective') {
      const { changes } = msg;
      if (!changes || !Array.isArray(changes) || changes.length === 0) {
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'error', message: 'No changes to finalize' }));
        }
        return;
      }
      if (session.proc) {
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'error', message: 'Cannot finalize while a turn is in progress' }));
        }
        return;
      }
      forcePendingProposalStatuses(changes, 'objective-finalize', (await fetchStatusContext(backend)).roles.start);
      let finalizeTimeoutId;
      try {
        const finalizeTimeout = new Promise((_, rej) => {
          finalizeTimeoutId = setTimeout(
            () => rej(Object.assign(new Error('finalize timed out'), { code: 'EFINALIZETIMEOUT' })),
            config.OBJECTIVE_FINALIZE_TIMEOUT_MS,
          );
        });
        await Promise.race([backend.finalizeChanges(changes), finalizeTimeout]);
        clearTimeout(finalizeTimeoutId);
        try { await ensureArchitectureDocsForChanges(changes); } catch (err) {
          console.error('[arch-docs] stub creation failed:', err.message);
        }
        postPlanComments(backend, session, changes).catch(err => {
          console.warn(`[plan-comment] post failed: ${err.message}`);
        });
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'finalize-result', tabId: session.tabId, ok: true, count: changes.length }));
        }
        websocket.emitTasksFinalized(changes);
        // Record assignments for newly assigned tasks (for newly-assigned WS state sync)
        for (const change of changes) {
          if (change.task && change.task.assignee != null) {
            websocket.recordAssignment(change.task.id, change.task.assignee);
          }
        }
        console.log(`[objective] Finalized ${changes.length} tasks for ${taskId}`);
      } catch (err) {
        clearTimeout(finalizeTimeoutId);
        if (err.code === 'EFINALIZETIMEOUT') {
          console.log(`[objective] Finalize timed out for task ${taskId} after ${config.OBJECTIVE_FINALIZE_TIMEOUT_MS}ms`);
          if (session.ws && session.ws.readyState === session.ws.OPEN) {
            session.ws.send(JSON.stringify({ type: 'objective-error', tabId: session.tabId, reason: 'finalize-timeout', attempts: 0 }));
          }
        } else {
          if (session.ws && session.ws.readyState === session.ws.OPEN) {
            session.ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: `Finalize failed: ${err.message}` }));
          }
        }
      } finally {
        // Saved (or gave up saving) — the chat is done. No heartbeat, prewarm or turn proc may
        // outlive it. A finalize-timeout Retry still works: this handler's `session` closure and
        // session.ws survive the map delete, and finalize needs no LLM.
        dropObjectiveSession(sessions, sessionKey, session, taskId, 'finalize');
      }

    } else if (msg.type === 'data' && typeof msg.data === 'string') {
      handleTerminalInput(session, msg.data);
    } else if (msg.type === 'resize' && msg.cols && msg.rows) {
      if (session.type !== 'objective' && session.alive && session.pty) {
        session.cols = Math.max(1, msg.cols);
        session.rows = Math.max(1, msg.rows);
        session.pty.resize(session.cols, session.rows);
      }
    } else if (msg.type === 'session-status') {
      if (!isAgentChatType(session.type) && session.alive) {
        emitTerminalState(session);
        maybeRefirePlanReady(session, ws);
      }
    } else if (msg.type === 'attention-seen') {
      // Opening a terminal clears local attention, but may leave the prompt open.
      // Reset only broadcast dedup state so the next sweep can re-raise it; keep
      // the actual terminal attention state intact.
      if (session.type === 'terminal') session._attentionLastBroadcast = null;
    } else if (msg.type === 'objective-typing' && session.type === 'objective') {
      await applyModelSelection(session, msg.model, { taskId }); // advisory warm hint — ignore errors, no user message involved
      if (session.providerType === 'claude') prewarmObjective(session, taskId);

    } else if (msg.type === 'abort' && isAgentChatType(session.type)) {
      console.log(`[objective] Abort requested for task ${taskId}`);
      killPrewarm(taskId, 'abort');
      session._aborted = true;
      clearRetryTimers(session);
      clearTurnDeadline(session);
      session._retrying = false;
      session._retryAttempt = 0;
      session._spawning = false; // (C1030) unwedge if abort lands mid Codex image-localize
      if (session.abortController) {
        session.abortController.abort();
        session.abortController = new AbortController();
      }
      if (session.proc) {
        killObjectiveProc(session, 'SIGTERM');
        escalateKill(session, taskId);
      }
      // The aborted turn's user message is dropped — except a task chat's generated seed, which
      // is the chat's context, not something the user typed and can retype.
      const _lastMsg = session.messages[session.messages.length - 1];
      if (_lastMsg && _lastMsg.role === 'user' && !_lastMsg.seed) {
        session.messages.pop();
        // A dropped dialog answer re-opens its dialog.
        if (_lastMsg.dialogAnswer) {
          const _asked = session.messages[session.messages.length - 1];
          const _dialog = _asked && Array.isArray(_asked.dialogs) && _asked.dialogs.find(d => d.id === _lastMsg.dialogAnswer.dialogId);
          if (_dialog) delete _dialog.answer;
        }
        // Hand-made task edits that rode on it go back in the queue for the next turn.
        if (_lastMsg.taskEdits) restoreTaskChatEdits(session);
      }
      resetTurnBuffers(session);
      if (session.type === 'objective') throttle.recordAbort(taskId);
      if (session.ws && session.ws.readyState === session.ws.OPEN) {
        session.ws.send(JSON.stringify({ type: 'generation-aborted', tabId: session.tabId }));
      }

    } else if (msg.type === 'restart' && isAgentChatType(session.type)) {
      killPrewarm(taskId, 'restart');
      console.log(`[${session.type}] Restart requested for task ${taskId}`);
      if (!session.messages || session.messages.length === 0) {
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'error', tabId: session.tabId, message: 'No messages to restart from' }));
        }
        return;
      }
      const firstMessage = session.messages[0];
      clearContext(session, taskId);
      if (session.type === 'objective') throttle.recordAbort(taskId);
      {
        const _sel = await applyModelSelection(session, msg.model, { taskId });
        if (_sel.error) {
          if (session.ws && session.ws.readyState === session.ws.OPEN) {
            session.ws.send(JSON.stringify({ type: 'objective-error', tabId: session.tabId, reason: _sel.error, status: 409, detail: _sel.reason }));
          }
          return;
        }
      }
      session.messages = [firstMessage];
      // Keep the start-time firstPrompt (prefetched workflow bundle + the client's full first
      // prompt) — the first message alone is only the user's visible text.
      session.firstPrompt = session.firstPrompt || firstMessage.content;
      if (session.ws && session.ws.readyState === session.ws.OPEN) {
        session.ws.send(JSON.stringify({ type: 'restarted', tabId: session.tabId }));
      }
      if (session.type === 'specChat') {
        spawnObjectiveTurn(session, taskId);
      } else if (session.type === 'taskChat') {
        ensureTaskChatSystemPrompt(session);
        spawnTurn(session, taskId);
      } else {
        _throttledSpawn(taskId, session, () => spawnTurn(session, taskId));
      }

    } else if (msg.type === 'kill' || msg.type === 'terminate' || msg.type === 'stop') {
      console.log(`[terminal] Kill requested for task ${taskId}`);
      if (isAgentChatType(session.type)) {
        // Timers + prewarm + turn proc + _closed guard; also resets _spawning (C1030) for any
        // in-flight closure still holding a reference to this discarded session.
        dropObjectiveSession(sessions, sessionKey, session, taskId, 'kill');
        session.alive = false;
        if (session.ws && session.ws.readyState === session.ws.OPEN) {
          session.ws.send(JSON.stringify({ type: 'chat-ended', tabId: session.tabId }));
        }
      } else if (session.pty) {
        terminateTerminalSession(session, taskId, sessionKey, sessions, 'terminated', { ackWs: ws, closeAck: false, backend });
      } else {
        terminateTerminalSession(session, taskId, sessionKey, sessions, 'terminated', { ackWs: ws, closeAck: false, backend });
      }
    } else if (msg.type === 'resume-paused' && session.type === 'terminal') {
      // (TPT443) The paused banner's Resume button. SIGCONTs the tree the watchdog stopped;
      // resumeRunawaySession() itself re-sends terminal-state (banner off on this socket) and the
      // session-runaway `resumed` frame clears the board ring in every window of this project.
      const resumed = resumeRunawaySession(session);
      if (resumed) {
        console.log(`[watchdog] Task ${taskId}: resumed by the user`);
        websocket.emitSessionRunaway(session.projectPath, { taskId: session.tabId, pid: session.ptyPid, resumed: true, promptText: resumed.text });
      } else {
        emitTerminalState(session); // already running — resync a stale banner
      }
    } else if (msg.type === 'plan-approve') {
      if (session.type !== 'objective') approvePlan(session);
    } else if (msg.type === 'paste-image') {
      // Terminal image paste (C809, C1003): save clipboard image locally, inject as a
      // bracketed-paste bare path so Claude Code attaches it as native [Image #N].
      if (!isAgentChatType(session.type)) {
        try {
          const localPath = injectPastedImage(session, msg.mimeType, msg.data);
          sendWsJson(ws, { type: 'paste-image-done', path: localPath });
        } catch (err) {
          sendWsJson(ws, { type: 'paste-image-error', error: err.message });
        }
      }
    }
  });

  ws.on('close', () => {
    console.log(`[terminal] Client detached from task ${taskId}`);
    const isCurrentWs = session.ws === ws;
    if (session.ws === ws) session.ws = null;
    if (isCurrentWs && !isAgentChatType(session.type) && !isAgentChatId(taskId)) {
      deleteDeviceSession(taskId, backend);
    }
    if (session.pending) {
      sessions.delete(sessionKey);
    } else if (session.type === 'objective' && isCurrentWs && !session.proc) {
      // A socket displaced by "Another client attached" (isCurrentWs false) must not tear down
      // the session its replacement now owns.
      console.log(`[objective] Cleaning up orphaned session ${taskId}`);
      dropObjectiveSession(sessions, sessionKey, session, taskId, 'ws-close');
    } else if (session.type === 'objective' && isCurrentWs) {
      // Detached mid-turn. Idle LLM activity stops now; the in-flight turn gets a short grace
      // window for a page reload to reattach (handleConnection clears _detachTimer), then dies.
      clearHeartbeat(session);
      killPrewarm(taskId, 'ws-detach');
      if (session._detachTimer) clearTimeout(session._detachTimer);
      session._detachTimer = setTimeout(() => {
        session._detachTimer = null;
        if (session.ws) return; // reattached
        console.log(`[objective] No reconnect within ${config.OBJECTIVE_DETACH_GRACE_MS}ms for ${taskId} — tearing down`);
        dropObjectiveSession(sessions, sessionKey, session, taskId, 'detach');
      }, config.OBJECTIVE_DETACH_GRACE_MS);
      session._detachTimer.unref?.();
    } else if (session.type === 'specChat' && !session.proc) {
      console.log(`[spec-chat] Detaching client from idle session ${taskId} (kept for reconnect)`);
      // Not deleted — persists until Cancel (kill msg) or server restart.
    } else if (session.type === 'taskChat') {
      // Kept whether idle or mid-turn: a running turn finishes on its own and buffers its
      // result (session.pendingResult) for the reconnect branch in handleConnection(). Ends only
      // on `kill` or server shutdown.
      console.log(`[task-chat] Client detached from ${taskId} (${session.proc || session._spawning ? 'turn still running' : 'idle'}) — session kept for reconnect`);
    }
  });
}

module.exports = {
  handleAgentQuotaRequest,
  maybeRefirePlanReady,
  createHttpHandler,
  handleConnection,
  normalizeProjectMember,
  assertTaskStartable,
  claimUnassignedTaskOnStart,
  sessionListBucket, sessionMetaRow,
  replayExitedTerminal,
  drainSessionQueue, sessionQueue, queuedSessionFrame,
  parsePiModelList,
  queryPiModels,
  listPiModels,
  PI_MODEL_CACHE_TTL_MS,
  // (C1463) Exported for unit testing — see resolve-objective-descendants.test.js.
  resolveObjectiveDescendants,
  terminateObjectiveSessions,
  // (TPT354) Exported for unit testing — see exit-resolution-lifecycle.test.js.
  wireSessionLifecycle,
};
