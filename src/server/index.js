'use strict';

// Main passes this only to the fork. Remove it before agent subprocesses can inherit
// process.env through their spawn specs.
const LOCAL_SECRET = process.env.TIPATASK_LOCAL_SECRET || '';
delete process.env.TIPATASK_LOCAL_SECRET;

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createWebSocketGate } = require('./ws-upgrade');
const config = require('./config');
const { augmentPathEnv, isAsarPath } = require('./spawn-utils');
const { createBackend, createPerProjectBackend, coerceBackendType } = require('./task-backend');
const { createHttpHandler, handleConnection, drainSessionQueue, sessionQueue } = require('./ws-handlers');
const websocket = require('./websocket');
const { preloadAgentDetection, listAllAgentModels } = require('./task-agent');
const { fetchStatusRoles } = require('./status-roles');
const { createTaskChangePoll } = require('./task-change-poll');
const { getAttentionPromptMatch, shouldHoldAttention, bgAgentsBusy, emitTerminalNotice, killRunawaySession, pauseRunawaySession } = require('./terminal-session'); // (C1386, C1565, TPT348, TPT357)
const { snapshotProcesses, sweepDescendantWatchdog, resolveAgentLimits } = require('./process-group'); // (C1565, TPT357/TPT370)
const { installShutdownReaper } = require('./shutdown-reaper'); // (TPT295)
const { installCrashGuard } = require('./crash-guard'); // (TPT356)
const { createMemoryTelemetry } = require('./memory-telemetry');
const { createSessionMemoryTracker, setSessionMemoryTracker, endSessionMemory } = require('./session-memory');

// C1356 — true when the module-scope `backend` singleton (below) has no real project
// bound and never will: packaged Electron's forked server is shared across every open
// project window and deliberately never gets TIPATASK_PROJECT_ROOT (C1318), so
// config.PROJECT_ROOT's cwd-based dev guess lands on an unrelated directory and
// the singleton's credentials resolve permanently blank. Same test `boot-kb-sync.js`'s
// resolveBootKbRoot() already uses to skip a boot KB pull into that same dead root — reused
// here so the singleton's own boot init()/connection-state churn stays just as harmless.
function isSingletonUnbound() {
  return !config.BOUND_PROJECT_ROOT && isAsarPath(config.SERVER_ROOT);
}

const ENV_PATH = path.join(config.USER_DATA_ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(config.SERVER_ROOT, '.env.example');

// node-pty's spawn-helper must be executable, or posix_spawnp fails when we
// pty.spawn(). Fresh `npm install` (or fork() after a re-extracted prebuild)
// can leave it at 0644 — fix on boot before any terminal session is spawned.
(function ensurePtySpawnHelperExecutable() {
  if (process.platform === 'win32') return;
  const platformDir = `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(config.SERVER_ROOT, 'node_modules/node-pty/build/Release/spawn-helper'),
    path.join(config.SERVER_ROOT, 'node_modules/node-pty/prebuilds', platformDir, 'spawn-helper'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try { fs.accessSync(p, fs.constants.X_OK); continue; } catch {}
    try { fs.chmodSync(p, 0o755); console.log(`[pty] chmod +x ${p}`); }
    catch (e) { console.warn(`[pty] failed to chmod spawn-helper ${p}: ${e.message}`); }
  }
})();

function readEnvLines() {
  let content;
  try {
    content = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    try {
      content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
      fs.writeFileSync(ENV_PATH, content, 'utf8');
    } catch {
      content = '';
    }
  }
  return content.split('\n');
}

function writeEnvUpdates(lines, updates) {
  const handled = new Set();
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in updates) {
      handled.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  for (const [key, val] of Object.entries(updates)) {
    if (!handled.has(key)) updated.push(`${key}=${val}`);
  }
  const result = updated.join('\n');
  fs.writeFileSync(ENV_PATH, result.endsWith('\n') ? result : result + '\n', 'utf8');
}

function askOnce(rl, question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans)));
}

async function ensureCavemanPlugin() {
  try {
    const spawnEnv = augmentPathEnv({});
    const list = execFileSync(config.CLAUDE_BIN, ['plugin', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv });
    if (list.includes('caveman')) {
      console.log('[caveman] plugin already installed');
      return;
    }
    execFileSync(config.CLAUDE_BIN, ['plugin', 'marketplace', 'add', 'JuliusBrussee/caveman'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv });
    execFileSync(config.CLAUDE_BIN, ['plugin', 'install', 'caveman@caveman'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv });
    console.log('[caveman] plugin installed');
  } catch (err) {
    console.warn('[caveman] plugin install skipped:', err.message);
  }
}

async function ensureUserConfigured() {
  if (config.USER_NAME) return;

  // No interactive TTY (Electron GUI launch, forked child, CI): blocking on
  // stdin would hang forever. Fall back to the OS username instead.
  if (!process.stdin.isTTY) {
    let name = 'user';
    try {
      const raw = (require('node:os').userInfo().username || '').trim().split(/\s+/)[0];
      if (raw) name = raw;
    } catch {}
    try { writeEnvUpdates(readEnvLines(), { USER_NAME: name, USER_ID: '1' }); } catch {}
    config.USER_NAME = name;
    config.USER_ID = 1;
    console.log(`[config] USER_NAME defaulted to OS username: ${name}`);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    let name;
    while (true) {
      const answer = (await askOnce(rl, 'Enter your name (one word): ')).trim();
      if (!answer) {
        console.log('  Name cannot be empty.');
        continue;
      }
      if (/\s/.test(answer)) {
        console.log('  Name must be a single word (no spaces).');
        continue;
      }
      name = answer;
      break;
    }
    const lines = readEnvLines();
    writeEnvUpdates(lines, { USER_NAME: name, USER_ID: '1' });
    config.USER_NAME = name;
    config.USER_ID = 1;
    console.log(`  Saved USER_NAME=${name} to .env`);
  } finally {
    rl.close();
  }
}

const { readProjectConfig } = require('./project-config');
const { createLocalAccess, LOCAL_HOST } = require('./local-access');

const backend = createBackend(config);
const sessions = new Map();
const sessionValidation = require('./session-validation').createSessionValidationRecorder();
const memoryTelemetry = createMemoryTelemetry({
  getSessions: () => sessions,
  isRunning: session => sessionQueue.isRunning(session),
  tracker: createSessionMemoryTracker({ historyFile: path.join(config.USER_DATA_ROOT, 'memory-peaks.json'),
    onLifecycle: sessionValidation.status().enabled ? event => sessionValidation.lifecycle(event) : null }),
  onSample: sessionValidation.status().enabled ? snapshot => sessionValidation.sample(snapshot, admission.snapshot(), sessions) : null,
});
setSessionMemoryTracker(memoryTelemetry.tracker);
const admission = require('./session-admission').createSessionAdmission({
  getSessions: () => sessions,
  getTelemetry: () => memoryTelemetry.snapshot(),
  isRunning: session => sessionQueue.isRunning(session),
  onChange: drainSessionQueue,
});
sessionQueue.setAdmission(admission);
const stopMemoryAdmission = () => { admission.stop(); memoryTelemetry.stop(); sessionValidation.stop(); };
// Exit also covers fatal startup errors and the crash guard's explicit process.exit.
process.once('exit', stopMemoryAdmission);

// ── Per-project backend registry ──
// Maps absolute project path → { config }. The backend singleton is always the
// same module reference — configure() reconfigures it when switching projects.
const projectRegistry = new Map();
projectRegistry.set(config.PROJECT_ROOT, { config });
let activeProjectPath = config.PROJECT_ROOT;

// ── Per-project backend instance cache ──
// Mirrors main/window-state.js _backendCache. Objective-save HTTP requests carry
// x-tipatask-project and are routed to the project's own isolated backend here
// rather than the global active-project singleton.
const _backendInstances = new Map();
_backendInstances.set(config.PROJECT_ROOT, backend);

function getBackendForPath(projectPath) {
  if (!projectPath) return backend;
  if (_backendInstances.has(projectPath)) return _backendInstances.get(projectPath);
  let cfg;
  try { cfg = readProjectConfig(projectPath); } catch { cfg = null; }
  if (!cfg) return backend;
  const inst = createPerProjectBackend(cfg, projectPath);
  inst.init().catch(err => console.warn(`[backend-registry] init failed for ${projectPath}:`, err.message));
  _backendInstances.set(projectPath, inst);
  return inst;
}

function getActiveBackend() {
  return backend;
}

function setActiveProject(projectPath) {
  if (!projectRegistry.has(projectPath)) throw new Error(`Project not registered: ${projectPath}`);
  activeProjectPath = projectPath;
  const entry = projectRegistry.get(projectPath);
  if (typeof backend.configure === 'function') backend.configure(entry.config, projectPath);
  console.log(`[project-registry] active → ${projectPath}`);
}

async function getOrCreateBackend(projectPath) {
  if (projectRegistry.has(projectPath)) return backend;
  const projectConfig = readProjectConfig(projectPath);
  if (!projectConfig) throw new Error(`No .tipatask/config.json found at ${projectPath}`);
  projectRegistry.set(projectPath, { config: projectConfig });
  return backend;
}

// (C1389) Web→Task App handoff — child→main request/reply over the existing fork IPC
// channel (main.js:1609 serverChild.on('message') / this process's own process.send,
// previously one-directional: only 'ready' and {type:'fatal'} outbound, and main→child
// fire-and-forget for 'kb:auto-reindex' above). Only Electron main holds workspaceState/
// recent-projects.json, so only main can answer "which local path is this apiProjectId
// bound to" — buildProjectIdToPathIndex() there. This process never duplicates that index;
// it just asks and waits, with a timeout so a wedged/absent main degrades to "not found"
// instead of hanging the HTTP request.
const _pendingProjectPathResolutions = new Map(); // requestId -> { resolve, timer }
const RESOLVE_PROJECT_PATH_TIMEOUT_MS = 3000;

process.on('message', (msg) => {
  if (!msg || msg.type !== 'resolve-project-path-reply' || !msg.requestId) return;
  const pending = _pendingProjectPathResolutions.get(msg.requestId);
  if (!pending) return; // already timed out, or a reply we don't recognize
  _pendingProjectPathResolutions.delete(msg.requestId);
  clearTimeout(pending.timer);
  pending.resolve(Array.isArray(msg.candidates) ? msg.candidates : []);
});

// Resolves to an array of local project paths bound to apiProjectId — [] when unknown,
// main is unreachable, this process has no Electron parent, or the round-trip times out.
function resolveProjectPathViaMain(apiProjectId) {
  if (!process.send) return Promise.resolve([]);
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      _pendingProjectPathResolutions.delete(requestId);
      resolve([]);
    }, RESOLVE_PROJECT_PATH_TIMEOUT_MS);
    _pendingProjectPathResolutions.set(requestId, { resolve, timer });
    try {
      process.send({ type: 'resolve-project-path', requestId, apiProjectId });
    } catch {
      clearTimeout(timer);
      _pendingProjectPathResolutions.delete(requestId);
      resolve([]);
    }
  });
}

// Fire-and-forget — by the time this is called, /start-task has already fully
// validated project + account + task, so main only needs to focus the window and push
// the seed. Returns false (caller renders a "not running" notice) when there is no
// Electron parent to send to.
// (C1559) opts.originTaskKey — set only for the childless-objective planning branch
// (route's own /open-objective alias name lives on; see ws-handlers.js § /start-task).
// (TPT16) opts.title/opts.description — the task the route already fetched, forwarded so
// the renderer can seed the composer without its own GET /api/tasks/:id round trip.
function sendOpenObjective(projectPath, taskKey, { warning, originTaskKey, title, description } = {}) {
  if (!process.send) return false;
  try {
    process.send({ type: 'open-objective', projectPath, taskKey, warning: !!warning, originTaskKey: originTaskKey || null, title: title || null, description: description || null });
    return true;
  } catch {
    return false;
  }
}

// (C1559) Sibling of sendOpenObjective() for the other 2 /start-task branches — an
// is_objective task WITH children (opts.children carries the fetched child list so the
// renderer, which alone holds the live board status map isDepsBlocked() needs, can pick
// the first startable one — see template.html's 'start-task' IPC listener) or a regular
// task (opts.children omitted/empty → start taskKey itself). Same fire-and-forget
// contract as sendOpenObjective — validation already happened in the route.
function sendStartTask(projectPath, taskKey, { children } = {}) {
  if (!process.send) return false;
  try {
    process.send({ type: 'start-task', projectPath, taskKey, children: Array.isArray(children) ? children : [] });
    return true;
  } catch {
    return false;
  }
}

const pendingHandoffs = new Map();
function confirmHandoffViaMain(projectId, taskKey) {
  if (!process.send) return Promise.resolve(false);
  return new Promise(resolve => {
    const requestId = require('node:crypto').randomUUID();
    const timer = setTimeout(() => {
      pendingHandoffs.delete(requestId);
      resolve(false);
    }, 60_000);
    pendingHandoffs.set(requestId, { resolve, timer });
    try { process.send({ type: 'confirm-start-task', requestId, projectId, taskKey }); }
    catch { clearTimeout(timer); pendingHandoffs.delete(requestId); resolve(false); }
  });
}

process.on('message', msg => {
  if (!msg || msg.type !== 'confirm-start-task-reply') return;
  const pending = pendingHandoffs.get(msg.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingHandoffs.delete(msg.requestId);
  pending.resolve(msg.approved === true);
});

const _registryOps = {
  projectRegistry, getOrCreateBackend, setActiveProject, getBackendForPath,
  getActiveProjectPath: () => activeProjectPath,
  resolveProjectPathViaMain, sendOpenObjective, sendStartTask, confirmHandoffViaMain,
};

// C1218 — Electron main delegates its window-bind auto-reindex trigger to THIS process
// over the fork's own IPC channel (main/window-state.js's setServerMessenger/_fireKbSync)
// instead of running the Opus reindex in main itself — main lacks a correct
// TIPATASK_PROJECT_ROOT/cwd for runHeadlessClaude in a packaged build, and its arch-doc
// cache is a separate in-memory instance from the one this process's agent-facing reads
// use (see ai/architecture/tt-knowledge-sync.md § Auto-Trigger on Sync). Fire-and-forget:
// main gets nothing back; the outcome surfaces to the renderer via
// websocket.broadcastToProject (kb-auto-reindex.js) and to this process's own stderr.
process.on('message', (msg) => {
  if (!msg || msg.type !== 'kb:auto-reindex' || !msg.projectPath) return;
  try {
    require('./kb-auto-reindex').fireAutoReindexWithBroadcast({
      rootPath: msg.projectPath,
      projectPath: msg.projectPath,
      backend: getBackendForPath(msg.projectPath),
      label: 'window-bind',
    }).catch(() => {});
  } catch (err) {
    console.warn(`[kb-reindex:window-bind] delegated run failed to start: ${err.message}`);
  }
});

const localAccess = createLocalAccess({
  port: config.PORT,
  secret: LOCAL_SECRET || undefined,
  electron: !!LOCAL_SECRET,
  getActiveProjectPath: () => activeProjectPath,
});
const httpHandler = createHttpHandler(sessions, getActiveBackend, _registryOps);
const server = http.createServer((req, res) => {
  Promise.resolve(localAccess.guardHttp(req, res, httpHandler)).catch(err => {
    console.error('[local-access] HTTP guard failed:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

// C1075: server.listen() below had no 'error' listener — EADDRINUSE (e.g. a stray
// orphaned `node todo-server.js`, or a second app instance) threw as an unhandled
// error, killing this process before it ever sent 'ready' over IPC. main.js's exit
// handler then quit silently (splash → nothing, no dialog) because the startServer()
// promise was never rejected. Send a typed 'fatal' message so the parent can show a
// real error instead.
//
// Register before WebSocket upgrade handling so listen failures are reported through the
// existing parent-process fatal path.
function sendFatal(payload) {
  if (process.send) {
    try { process.send({ type: 'fatal', ...payload }); } catch {}
  }
}

server.on('error', (err) => {
  const message = err.code === 'EADDRINUSE'
    ? `Port ${config.PORT} is already in use — another TipATask window or a stray "node todo-server.js" process is running. Quit it, then reopen TipATask.`
    : `Server failed to start: ${err.message}`;
  console.error(`[server] listen error: ${err && err.stack || err}`);
  sendFatal({ code: err && err.code || 'ERR_LISTEN', port: config.PORT, message });
  process.exit(2);
});

// Request failures are handled by createHttpHandler()'s per-request boundary. This is the
// process-level backstop for everything that has no request to answer (see crash-guard.js): a
// network-class uncaught exception (ECONNRESET / ETIMEDOUT / ...) is logged and the server keeps
// running; other uncaught exceptions exit 1 only with no live sessions across any project.
// Unhandled rejections from background work are logged and never exit.
installCrashGuard({
  sessions,
  hasLiveSessions: () => [...sessions.values()].some(session => session?.alive === true),
});

// (TPT295) Objective LLM children and KB re-index runs are spawned detached — their own process
// groups — so the SIGTERM that stops this server (Electron quit → serverChild.kill()), a Ctrl+C
// SIGINT, or Electron main going away never reaches them. Reap them, then exit. Installed at module
// load, not in the boot chain below, so a quit during boot is covered too.
installShutdownReaper({ sessions, beforeShutdown: stopMemoryAdmission });
server.once('close', stopMemoryAdmission);

const wss = createWebSocketGate(server, (ws, req) => {
  Promise.resolve(handleConnection(ws, req, sessions, getActiveBackend, broadcastAttentionFor, broadcastAttentionCleared, _registryOps.getBackendForPath)).catch(err => {
    console.error('[ws] Connection handler failed:', err.message);
    try {
      ws.send(JSON.stringify({ type: 'error', message: `Connection setup failed: ${err.message}` }));
      ws.close();
    } catch {}
  });
}, {
  // Every lane is authorized by the local-access guard before the upgrade completes.
  guardUpgrade: (req, socket, head, laneWss) => localAccess.guardUpgrade(req, socket, head, laneWss),
});

websocket.init(wss);
const { broadcast } = websocket;

// (C1057) Idle fallback threshold — pattern match (terminal-session.js's feedAttentionChunk,
// via BaseTaskAgent#isPromptLine) is the PRIMARY attention signal now; this is only a
// backstop for a prompt whose wording no pattern caught. Raised from the old 5s (which fired
// on every ordinary tool call, latching _attentionBroadcasted before the real prompt ever
// appeared — the root cause of "detected with huge delay") to 60s, and no longer excludes
// Codex — a real pattern match always wins over this regardless of agent, so the exclusion
// (which existed only to suppress the 5s rule's Codex false-positives) no longer serves a
// purpose. 0 disables the fallback entirely.
const ATTENTION_IDLE_MS = (() => {
  const v = Number(process.env.ATTENTION_IDLE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 60000;
})();
const ATTENTION_STALE_MS = 120000; // stale-latch guard: clear a pattern match that never got a clearing chunk

function terminalIdleFallbackNeeded(session, now = Date.now()) {
  if (ATTENTION_IDLE_MS <= 0) return false;
  if (session._attentionState) return false; // a real prompt match always wins — never let idle swallow it
  if (!session._terminalOutputSeen) return false;
  // (TPT348) A Claude turn that ended with "Waiting for N background agents to finish" leaves a
  // quiet screen and an empty prompt box while sub-agents work — silence there is not "needs a
  // human". Returning false also lets the sweep below withdraw an idle dot already broadcast.
  if (bgAgentsBusy(session, now)) return false;
  return now - session.lastOutputAt > ATTENTION_IDLE_MS;
}

if (coerceBackendType(config.TASK_BACKEND) === 'api' && typeof backend.onConnectionStateChange === 'function') {
  backend.onConnectionStateChange((state, message) => {
    console.log(`[api-backend] state → ${state}${message ? ` (${message})` : ''}`);
    // (C1356) A credential-less packaged-Electron singleton (see isSingletonUnbound()
    // above) churns through connection states on its own dead init() — nothing real ever
    // reads from it (every bound window uses its own per-project backend), so an unscoped
    // emitApiStatus() here would bleed a bogus offline/reauth banner into every open
    // project window.
    if (isSingletonUnbound()) return;
    websocket.emitApiStatus(state, message, backend.getPendingMutationCount(), backend.getPendingTaskIds());
  });

  backend.onMutationsDrained((replayedTasks, remaining) => {
    websocket.emitApiStatus(
      remaining > 0 ? 'reconnecting' : 'connected',
      remaining > 0 ? `Reconnected — ${remaining} updates still queued` : null,
      remaining,
      backend.getPendingTaskIds(),
    );
    for (const t of replayedTasks) {
      if (t._deleted) {
        websocket.emitTaskDeleted(t.id);
      } else if (t._replacedTmpId) {
        websocket.emitTaskDeleted(t._replacedTmpId);
        websocket.emitTaskCreated(t);
      } else {
        websocket.emitTaskUpdated(t);
      }
    }
  });
}

// (C1057) `detail` is { kind, promptText, agent } — optional; falls back to the session's
// current pattern state. Re-broadcasts (instead of only latching once) when kind/promptText
// changed since the last broadcast, so a real prompt can supersede a previously-broadcast
// idle-fallback event instead of being swallowed by the single-fire latch.
function broadcastAttentionFor(sessionKey, detail = null) {
  const session = sessions.get(sessionKey);
  if (!session || !session.alive || session.type !== 'terminal') return;
  if (!session.tabId) return; // bare id required — the composite sessionKey must never reach the wire (C1057)
  const kind = detail?.kind || session._attentionState?.kind || 'attention';
  const promptText = detail?.promptText ?? session._attentionState?.promptText ?? '';
  const agentId = detail?.agent || session.taskAgent;
  const last = session._attentionLastBroadcast;
  if (session._attentionBroadcasted && last && last.kind === kind && last.promptText === promptText) return;
  session._attentionBroadcasted = true;
  session._attentionLastBroadcast = { kind, promptText };
  websocket.broadcastToProject(session.projectPath, 'attention-needed', { taskId: session.tabId, kind, promptText, agent: agentId });
}

function broadcastAttentionCleared(sessionKey) {
  const session = sessions.get(sessionKey);
  if (!session || !session.tabId) return;
  if (!session._attentionBroadcasted) return;
  session._attentionBroadcasted = false;
  session._attentionLastBroadcast = null;
  websocket.broadcastToProject(session.projectPath, 'attention-cleared', { taskId: session.tabId });
}

// C982: interactive Claude/Codex TUIs never exit on their own (C482), so the agent
// marking a task `completed` produces no PTY exit — nothing to hang a resolution
// comment off of. Sweep live terminal sessions and fire the existing onSessionExit
// machinery (same path as user-Terminate, C948) the first time a session's task is
// observed to have transitioned into `completed`. Runs from the api-poll interval
// below, independent of connected WS clients.
async function detectCompletedTerminalSessions() {
  // C1184: "completed" is now a role, not a literal — resolve once per distinct backend
  // per sweep (sessions in different Electron windows can carry different backend
  // instances via session.backend) rather than per session, so a sweep with many live
  // sessions on the same project costs one /statuses fetch, not one per session.
  // fetchStatusRoles() never throws and fails soft to the legacy role names, on top of
  // api-backend.js's own 30s TTL cache — this never turns into a real per-sweep cost.
  const rolesByBackend = new Map();
  const rolesFor = async (b) => {
    if (!rolesByBackend.has(b)) rolesByBackend.set(b, await fetchStatusRoles(b));
    return rolesByBackend.get(b);
  };

  for (const [, session] of sessions) {
    if (session.type !== 'terminal') continue;
    // (C1356) `_completionEmitted` (below) is the ONLY gate on the task:updated emit now.
    // `_resolutionPosted` still gates the resolution-comment repost inside the completion
    // branch, but must no longer also block the emit: a natural PTY exit fires
    // session.onSessionExit() directly (terminal-session.js's onExit handler), which sets
    // _resolutionPosted = true immediately — often before the very next sweep tick. Pre-
    // C1356 that permanently skipped this whole session on every future sweep, so an agent
    // that completed its task and then exited normally (the common case) never got its
    // task:updated emitted at all — the left-nav tick relied entirely on the next
    // payload-less tasks-updated poll picking it up. A naturally-exited session also stays
    // in `sessions` (only terminateTerminalSession() deletes it) with session.alive=false,
    // so this no longer skips on !session.alive either — a completed-then-exited session
    // gets exactly one more look before _completionEmitted silences it for good.
    if (session._completionEmitted || !session._terminalOutputSeen) continue;
    if (typeof session.onSessionExit !== 'function' || !session.taskId) continue;
    const sessionBackend = session.backend || backend;
    const roles = await rolesFor(sessionBackend);
    if (session._spawnStatus === roles.complete) continue; // spawned already-done — no transition to fire on
    let task;
    try {
      // getTask() is uncached (unlike getTasks*/getTasksUnfiltered, 1500ms TTL) — a
      // just-written complete status is always seen on the very next sweep.
      task = await sessionBackend.getTask(session.taskId);
    } catch (err) {
      console.error(`[completion] status check failed for ${session.taskId}:`, err.message);
      continue;
    }
    if (task && task.status === roles.complete) {
      try {
        const gate = await require('./git-merge/completion-guard').guardCompletionTransition({
          session, backend: sessionBackend, projectRoot: session.projectPath || config.PROJECT_ROOT,
        });
        if (!gate.allowed) {
          const reason = JSON.stringify(gate.verification.blockers);
          if (session._vcsBlockedNotice !== reason) {
            emitTerminalNotice(session, `Completion verification blocked: ${reason}. Recheck live VCS settings and use tipatask-local complete_task after required merges and checks.`);
            session._vcsBlockedNotice = reason;
          }
          if (gate.task) websocket.emitTaskUpdated(gate.task, null, session.projectPath);
          continue;
        }
        session._vcsBlockedNotice = null;
      } catch (err) {
        console.error('[completion] verification unavailable; retrying on next poll');
        continue;
      }
      // (C1329, decoupled from _resolutionPosted in C1356) An agent completing a task in
      // TASK_BACKEND=api writes straight through the MCP server to the remote REST API —
      // never through this server's own PATCH /api/tasks/:key, the only other caller of
      // emitTaskUpdated(). Without this, the sole client signal is the payload-less
      // `tasks-updated` poll broadcast below, which the left-nav active-sessions list can't
      // use to tick a completed row on its own. Emitting the granular event here routes
      // agent-driven completion through the client's existing task:updated handling
      // (template.html), same as a manual board edit. _completionEmitted above guards this
      // to firing once per session, independent of the resolution-comment dedupe below.
      session._completionEmitted = true;
      endSessionMemory(session, 'completed');
      console.log(`[completion] ${session.taskId} → ${roles.complete}, emitting task:updated (project=${session.projectPath || '<default>'})`);
      websocket.emitTaskUpdated(task, null, session.projectPath);
      // (TPT345) git-worktree projects: warn the project's windows when the task's
      // worktree still holds uncommitted changes — the merge panel would block on it.
      // Fail-open, fires once per session (session._worktreeDirtyWarned).
      require('./git-merge/completion-guard').warnIfCompletedWorktreeDirty({ session, backend: sessionBackend, projectRoot: session.projectPath || config.PROJECT_ROOT, task })
        .catch(err => console.error(`[worktree] guard failed for ${session.taskId}:`, err.message));
      // onSessionExit() no-ops internally when _resolutionPosted is already true (natural
      // exit already fired it) — calling it here unconditionally is always safe and is what
      // still covers the case where the task went `completed` while the process is still
      // alive and hasn't exited on its own (interactive TUIs never exit by themselves, C982).
      Promise.resolve(session.onSessionExit({ exitCode: null, reason: 'completed', buffer: session.buffer }))
        .catch(err => console.error(`[completion] resolution comment failed for ${session.taskId}:`, err.message));
      drainSessionQueue(); // (TPT444) a completed task releases its slot to the oldest queued start
    }
  }
}

// ── Attention reconciliation sweep (C1057) ──
// The real-time raise/clear already happened synchronously from onData() (see
// terminal-session.js's feedAttentionChunk, wired via session.onAttentionNeeded/
// onAttentionCleared -> broadcastAttentionFor/broadcastAttentionCleared above). This sweep
// only: (a) re-sends the broadcast for a session whose pattern match fired while no board/
// attention client was connected (broadcastAttentionFor is a no-op with no `_wss`/no match
// at the time), (b) drives the idle fallback (ATTENTION_IDLE_MS, see terminalIdleFallbackNeeded
// above) for a prompt no pattern caught, and (c) clears a pattern match that's been stuck
// long enough to suspect the clearing chunk was missed.
setInterval(() => {
  const now = Date.now();
  // Gate broadcasts (not state reconciliation) on someone actually watching — otherwise the
  // always-open attention socket used by Electron would need this to run per-window, and a
  // reconnecting board should see accurate state without waiting a full tick.
  const hasWatcher = [...wss.clients].some((c) => c._boardWatcher || c._attentionSubscriber);
  for (const [taskId, session] of sessions) {
    if (!session.alive || session.type !== 'terminal') continue;

    if (session._attentionState && now - session._attentionState.at > ATTENTION_STALE_MS) {
      // (C1386) Must not fire while the tail still reports an unanswered inject-gate dialog.
      // Claude's Ink TUI repaints only cursor-addressed fragments while a tool-approval dialog
      // waits, so `state.at` stops being refreshed even though the prompt is genuinely still on
      // screen — and because those same fragment repaints keep `lastOutputAt` fresh, the idle
      // fallback below does not pick it up either; without this guard the session falls straight
      // through to broadcastAttentionCleared() at ~2 minutes. Same predicate feedAttentionChunk()'s
      // step 4 uses (see terminal-session.js's shouldHoldAttention()), so the two clear paths can
      // never disagree; ATTENTION_HOLD_MAX_MS (30min) > ATTENTION_STALE_MS (2min) is what makes
      // this guard meaningful, and the ceiling inside the predicate is what keeps it bounded.
      const tailKind = getAttentionPromptMatch(session._attentionTail || '', session.taskAgent)?.kind ?? null;
      const held = shouldHoldAttention(
        session._attentionState, tailKind, now - session._attentionState.at, session._injectDone === true,
      );
      if (!held) {
        session._attentionState = null;
        session._patternAttentionNeeded = false;
      }
    }

    if (session._attentionState) {
      if (hasWatcher) broadcastAttentionFor(taskId, session._attentionState);
      continue;
    }

    if (terminalIdleFallbackNeeded(session, now)) {
      if (hasWatcher) broadcastAttentionFor(taskId, { kind: 'idle', promptText: '', agent: session.taskAgent });
    } else if (session._attentionBroadcasted && hasWatcher) {
      // (C1356) Previously also silently zeroed session._attentionBroadcasted/
      // _attentionLastBroadcast when !hasWatcher, on the assumption attention had genuinely
      // resolved. That assumption isn't safe: the ATTENTION_STALE_MS guard just above can
      // null session._attentionState purely because 2 minutes passed with no fresh matching
      // output chunk — NOT because the prompt was actually answered — which is exactly the
      // common case for a window backgrounded/unfocused while the user is away. With no
      // watcher connected there is nothing to broadcast a clear to anyway, so dropping the
      // latch here bought nothing; it only meant ws-handlers.js's __attention__ reconnect
      // replay (`if (!s._attentionBroadcasted) continue`) and GET /api/sessions both skip
      // the session forever afterward — the highlight never comes back even though the
      // prompt may still be genuinely open. The unconditional real-time raise/clear from
      // terminal-session.js's onData -> feedAttentionChunk (independent of any connected
      // client) remains the sole authority on whether attention is truly still needed; this
      // sweep now only broadcasts when it safely can, never silently mutates the latch.
      broadcastAttentionCleared(taskId);
    }
  }
}, 1000);

// ── Process-tree watchdog (C1565) ──
// One shared `ps -Ao pgid=,pid=,ppid=,rss=,stat=,comm=` per tick serves every live terminal session
// (~32ms measured for ~860 processes) instead of one ps spawn per session. Runs
// headless — no hasWatcher gate — same reasoning as detectCompletedTerminalSessions()
// below: a runaway process tree must be caught whether or not a board/attention client
// happens to be connected right now. Skipped entirely on win32 (killProcessGroup()'s
// negative-pid semantics are POSIX-only there anyway, so counting would inform an alert
// this app could never act on) — logged once at boot, not per tick.
if (process.platform === 'win32') {
  console.log('[watchdog] Descendant-count watchdog disabled on win32 (no POSIX process groups).');
} else {
  setInterval(async () => {
    drainSessionQueue(); // (TPT444) safety net — a missed slot-freed trigger never strands a queued start
    const snapshot = await snapshotProcesses();
    if (!snapshot) return; // ps failed/timed out — skip this tick, never throw
    // Count + memory limits and the action (warn / pause / kill) come from each session's
    // project — resolveAgentLimits(); only advisory budgets scale with the cross-project
    // registry. Fresh host pressure corroborates tree growth; killing is explicit opt-in.
    sweepDescendantWatchdog(sessions, snapshot, {
      resolveLimits: resolveAgentLimits,
      host: memoryTelemetry.snapshot().host,
      sampledAt: Date.now(),
      killRunawaySession,
      pauseRunawaySession,
      emitTerminalNotice,
      emitSessionRunaway(projectPath, detail) {
        sessionValidation.watchdog(detail);
        websocket.emitSessionRunaway(projectPath, detail);
      },
    });
  }, 30000);
}

// ── Objective metrics: hourly p50/p95/p99 of prompt size + model_ttft (C495) ──
setInterval(() => {
  const allTotal = [];
  const allTtft = [];
  for (const [, s] of sessions) {
    if (s.type !== 'objective' || !s._profileTrail || !s._profileTrail.length) continue;
    for (const e of s._profileTrail) {
      if (typeof e.totalSize === 'number') allTotal.push(e.totalSize);
      if (typeof e.model_ttft === 'number') allTtft.push(e.model_ttft);
    }
  }
  if (!allTotal.length && !allTtft.length) return;
  const pct = (arr, q) => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  };
  console.log(
    `[objective:metrics-hourly] samples=${allTotal.length}` +
    ` total_p50=${pct(allTotal, 0.5)} total_p95=${pct(allTotal, 0.95)} total_p99=${pct(allTotal, 0.99)}` +
    ` ttft_p50=${pct(allTtft, 0.5)} ttft_p95=${pct(allTtft, 0.95)} ttft_p99=${pct(allTtft, 0.99)}`
  );
}, 3600 * 1000);

async function fetchUserProfile() {
  if (!backend || typeof backend.getCredentials !== 'function') return;
  try {
    const { baseUrl, token } = backend.getCredentials();
    const { request } = require('../cli/http');
    const { data } = await request(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 5000,
    });
    if (data && data.user) {
      config.USER_AVATAR_URL = data.user.avatar_url || '';
      console.log(`[profile] avatar_url ${config.USER_AVATAR_URL ? 'loaded' : 'empty'}`);
    }
  } catch (err) {
    console.warn('[profile] /api/auth/me fetch failed:', err.message);
  }
}

ensureCavemanPlugin()
  .then(() => ensureUserConfigured())
  // (C1356) Skip — a credential-less init() here only latches _connectionState =
  // 'unauthorized' on a singleton nothing real ever reads from (every bound project
  // window's WS/HTTP traffic already resolves its OWN per-project backend via
  // getBackendForPath — see task-change-poll.js and ws-handlers.js's resolveBackend()).
  // Left un-skipped, that latch used to also fire an unscoped emitApiStatus() broadcast
  // (see the onConnectionStateChange guard below) — a bogus offline/reauth banner on
  // every open project window, sourced from a project that doesn't exist.
  .then(() => (isSingletonUnbound() ? undefined : backend.init()))
  .then(() => preloadAgentDetection(config))
  .then(() => {
    // (C1515) Warm the C1504 model registry too, so the objective chat's live-model ladder
    // (providers/registry.js offeredModelIds()) has something to show on first paint instead
    // of falling all the way to the static config.js list. Fire-and-forget — never delays
    // server startup, and the ladder falls back to the static list gracefully if this
    // hasn't finished (or fails) yet, same as the existing client-triggered warm via
    // GET /api/agent-models (the task edit modal's ensureAgentModels()).
    void listAllAgentModels(config).catch((err) => {
      console.error('[index] model-registry boot warm failed:', err && err.message);
    });
  })
  .then(() => fetchUserProfile())
  .then(() => {
  server.listen(config.PORT, LOCAL_HOST, () => {
    memoryTelemetry.start();
    admission.start();
    if (process.send) process.send('ready');
    console.log(`TODO board: http://127.0.0.1:${config.PORT}/todo.html`);
    if (localAccess.loginCode) console.log(`Task App launch code: ${localAccess.loginCode} (enter at http://127.0.0.1:${config.PORT}/login)`);
    setImmediate(() => {
      try {
        const archCache = require('../mcp/architecture-cache');
        const t = Date.now();
        const r = archCache.loadAll();
        console.log(`[arch-cache] warm: ${r.count} tags in ${Date.now() - t}ms`);
      } catch (e) {
        console.warn('[arch-cache] warm failed:', e.message);
      }
    });

    // (C1202) Fire-and-forget — no-ops instantly unless this server's own project is on the
    // `local` voice preset with a fully-downloaded model (see voice-prewarm.js). Never blocks
    // 'ready'/listen above, never touches sherpa-onnx-node for an AssemblyAI-preset project.
    setImmediate(() => {
      require('./voice-prewarm').prewarmVoice(config.PROJECT_ROOT, { reason: 'server boot' })
        .catch((e) => console.warn('[voice-prewarm] boot warm failed:', e.message));
    });

    // (C1230/C1337) Server-boot KB sync — a full pull+push, THEN the one-time forced
    // re-index (projects.kb_last_reindexed_at, C1229) chained after it, mirroring
    // ws-handlers.js's WS-connect ordering (sync must land before the re-index's own
    // presync touches the same version cache). Fire-and-forget, same shape as the two
    // one-shots above, runs after process.send('ready') so the splash never waits on this.
    // Extracted to boot-kb-sync.js (unit-tested there) because requiring index.js itself
    // stands up a real HTTP server. coerceBackendType(), not the raw config.TASK_BACKEND
    // literal (C1353) — a legacy install whose config still says "file"/unset must still get
    // boot KB sync now that the file backend is retired (C1352), not silently lose it forever
    // because this one gate never coerced; fireBootKbSync's own root/creds guards (see that
    // file) decide whether the pull or the force-once re-index actually do anything.
    if (coerceBackendType(config.TASK_BACKEND) === 'api') {
      setImmediate(() => {
        require('./boot-kb-sync').fireBootKbSync({ config, backend })
          .catch((e) => console.warn('[kb-sync:boot] boot sync failed to start:', e.message));
      });
    }
  });

  // ── API backend: poll for changes every 10s, per project (C1356) ──
  // coerceBackendType(), not the raw config.TASK_BACKEND literal — createBackend/
  // createPerProjectBackend already coerce a stale "file"/unset config to a real api
  // backend (C1352), so gating on the raw literal could silently disable both this poll
  // and the completion sweep below for a project whose config predates that migration.
  if (coerceBackendType(config.TASK_BACKEND) === 'api') {
    const taskChangePoll = createTaskChangePoll({ wss, getBackendForPath, websocket, isSingletonUnbound });

    setInterval(async () => {
      // C982: completion detection runs regardless of connected clients — a detached
      // agent (modal closed, process still alive) must still get its resolution
      // comment even with no browser open.
      await detectCompletedTerminalSessions();
      // (C1057/C1282) A board or attention watcher is enough to run the poll. The Electron
      // __attention__ socket now forwards tasks-updated to the mounted Objective view, so it
      // must stay subscribed here even though it deliberately does not receive board config or
      // perform full Tasks-section rendering. task-change-poll.js's own tick() re-derives the
      // exact same watched set per project, so this is just a cheap early-out.
      if (![...wss.clients].some((c) => c._boardWatcher || c._attentionSubscriber)) return;
      await taskChangePoll.tick();
    }, 10000);
  }
  })
  .catch((err) => {
    stopMemoryAdmission();
    console.error(err);
    sendFatal({ code: err && err.code || 'ERR_STARTUP', port: config.PORT, message: err && err.message || String(err) });
    process.exit(1);
  });

module.exports = { server, sessions, projectRegistry, getActiveBackend, setActiveProject, getOrCreateBackend,
  getMemoryTelemetry: () => memoryTelemetry.snapshot() };
