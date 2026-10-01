'use strict';

const config = require('./config');
const { getApiCredentials, createTokenWatch } = require('./api-credentials');
const { request } = require('../cli/http');
const recipesStore = require('./recipes-store');
const { ensureArchitectureDocs, buildStub } = require('./architecture-docs');
const { selectLinkCandidates, prepareTagDocs, linkTagDocs } = require('./tag-doc-link');
const { withProjectLock } = require('./project-mutex');
const { isReservationPlaceholder } = require('./reservation-placeholder');
const { readProjectConfig } = require('./project-config');
const { buildSpecCommentBody, stripSpecCommentHeader } = require('./spec-comment');
const { readOriginSpecSnapshot, postOriginSpecComment } = require('./origin-spec-capture');
const { applyReopenToPatch } = require('./reopen-closed-task');
const { LEGACY_STATUSES, fetchStatusContext } = require('./status-roles');
const {
  DEFAULT_LIMIT: RESOLUTIONS_DEFAULT_LIMIT,
  MAX_LIMIT: RESOLUTIONS_MAX_LIMIT,
  isAgentLogTailComment,
  shapeResolutionPayload,
} = require('./resolution-payload');
const {
  parseTagRegistryResponse,
  buildTagIndex,
  resolveTagNames,
  unregisteredTagError,
  selectTasksToWrite,
} = require('./tag-registry-gate');
const { AuthCorruptedError, inspectToken, validateCredentials: validateCredentialsGuard } = require('./auth-guard');

const TODO_REGEX = /```json\s*\n([\s\S]*)```/;
const TASKS_CACHE_TTL_MS = parseInt(process.env.API_BACKEND_TASKS_CACHE_TTL_MS || '1500', 10);
const TASKS_CACHE_LOG = process.env.API_BACKEND_CACHE_LOG === '1';
// C1184: registry only changes from the web settings UI (not from any task mutation),
// so this TTL is generous and — unlike the task caches — deliberately NOT cleared by
// _cacheInvalidate() below (that fires on every task mutation; clearing statuses there
// would make index.js's 10s completion poller re-fetch /statuses on every sweep).
const STATUSES_CACHE_TTL_MS = 30_000;
const STATUSES_FALLBACK_TTL_MS = 5_000; // synthesized (legacy) result re-probes fast
// C1215 — project row cache (vcs_type/vcs_worktree_enabled/vcs_commit_enabled/
// vcs_pr_enabled, read by vcs-settings.js). Same "project switch invalidates, task
// mutations don't" discipline as STATUSES_CACHE_TTL_MS above — these settings only
// change from the web settings UI (C1214), never from a task write.
const PROJECT_SETTINGS_CACHE_TTL_MS = 30_000;
const PROJECT_SETTINGS_FALLBACK_TTL_MS = 5_000;
const RECONNECT_BACKOFF_MS_TABLE = [2000, 4000, 8000, 16000, 30000];

// Scope Task App board tasks to current assignee even for a project owner, whose
// API assignee filter is otherwise ignored. If current user lookup fails, keep
// returned list rather than hiding every task. Web app retains its own scope.
function filterToOwnOrUnassigned(tasks, currentUserId) {
  if (currentUserId == null) return tasks;
  const me = Number(currentUserId);
  return (tasks || []).filter(t =>
    t.assignee == null
    || Number(t.assignee) === me
    || Number(t.createdBy) === me);
}

// (C1541) list_task_resolutions candidate selection — pure, unit-testable in isolation
// (see tasks-by-tags.test.js), same discipline as filterToOwnOrUnassigned above.
// tagSet: lowercased Set of wanted tag names, ANY match qualifies (OR semantics).
// statusName: exact status match when given; omitted → closedSet-based (role-derived
// completed/canceled) default, since "past resolutions" implies finished work.
// Reservation placeholders are never candidates — they carry no real narrative.
function selectResolutionCandidates(tasks, { tagSet, statusName, closedSet }) {
  return (tasks || []).filter(t => {
    if (t.isReservation) return false;
    if (statusName ? t.status !== statusName : !closedSet.has(t.status)) return false;
    const tags = t.tags || [];
    return tags.some(tag => tagSet.has(String(tag).toLowerCase()));
  });
}

function createApiBackend(initialCfg, projectRoot) {
// initialCfg remains in the public signature for backend-factory compatibility.
// Credentials themselves are always live-read from _projectRoot/config.json.
void initialCfg;
// Per-instance project root → which .tipatask/config.json this backend live-reads
// for credentials. Updated on configure()/reconfigureAndProbe() when a path is given.
let _projectRoot = projectRoot || config.PROJECT_ROOT || null;

// (C1346) Local dual-write copy of a recipe (api mode saves to BOTH the API and disk — see
// tt-recipe-history.md § Storage). Per-project under .tipatask/recipes — NOT the process-
// global config.DATA_ROOT/fileOps singleton this used to call, which pooled every project's
// recipes into one machine-wide dir in the forked server (<userData>/data/recipes) and, in
// the Electron MAIN process, was an unwritable path inside app.asar: TIPATASK_USER_DATA is
// fork-only, so USER_DATA_ROOT degenerated to the asar SERVER_ROOT there, and
// api:auth.reauth-save's init() → ensureRecipesDir() mkdir threw ENOTDIR (C1346).
//
// recipesStore.resolveRecipesDir() applies the C1318 containment guard itself — _projectRoot
// is not always a real project: the module singleton (config-only createApiBackend(), used by
// src/server/index.js for TASK_BACKEND=api with nothing bound) falls back to
// config.PROJECT_ROOT, which in a packaged build is a cwd-based guess landing on
// an unrelated directory. A null return here means "skip the local copy" — always non-fatal, since
// getRecipes() below reads only from the API; this mirror is write-only.
function _localRecipesDir() {
  return recipesStore.resolveRecipesDir(_projectRoot);
}

// ── Task list cache ──
let _listEntry = null;    // { rows: Task[], at: number } — unfiltered full list
let _listInflight = null; // Promise<Task[]> | null

// ── Scoped task cache (current user + unassigned) ──
// (C1407) Rows here are ALSO re-filtered client-side by filterToOwnOrUnassigned() after
// fetch, on top of the ?assignee= query the API already applies — the API grants the
// project OWNER an exemption from ?assignee= (owner sees every task, tt-api-backend.md
// § C904), so an owner's raw response can still contain other members' rows. The
// client-side pass closes that gap for the Task App board only.
let _scopedEntry = null;    // { rows: Task[], at: number } — assignee==me OR NULL
let _scopedInflight = null; // Promise<Task[]> | null

// ── Board sprint-window cache (C1259) — keyed by `${windowMode}|${scope}` ──
// Separate from _scopedEntry: the board's default view only needs the active-sprint
// window, not the full assignee-scoped list. Cleared by the same _cacheInvalidate().
// (C1407) Rows in a 'me'-scoped entry are filterToOwnOrUnassigned()-filtered for the
// same owner-exemption reason as _scopedEntry above. The key includes the scope
// ('me' vs 'all', see getBoardTasks()'s `unscoped` option) so a People-filter toggle
// between My Tasks and All Tasks can never alias one cached result onto the other.
let _boardEntries = new Map();   // "${windowMode}|${scope}" -> { rows, windowInfo, at }
let _boardInflight = new Map();  // "${windowMode}|${scope}" -> Promise<{rows,windowInfo}>|null

// ── Current user ──
// Resolved once in init() via GET /api/auth/me; stamped onto every task created
// through the Task App so assignee always reflects the logged-in user.
// (C1522) Cleared by resetUserContext() — called on a detected API_TOKEN change
// (re-auth as a different user) and by configure()/reconfigureAndProbe() (project
// switch). _userIdGeneration guards a /me response that was already in flight under
// the OLD token from re-installing a stale id after a reset lands mid-request.
let _currentUserId = null;
let _userIdGeneration = 0;

// ── Status registry cache (C1184) — project switch invalidates, task mutations don't ──
let _statusesEntry = null; // { rows, at }

// ── Project settings cache (C1215) — same invalidation discipline as _statusesEntry ──
let _projectSettingsEntry = null; // { row, at, fallback }

function _cacheInvalidate() {
  _listEntry = null;
  _listInflight = null;
  _scopedEntry = null;
  _scopedInflight = null;
  _boardEntries.clear();
  _boardInflight.clear();
}

// (C1522) Drop everything derived from "who is signed in": the resolved user id, every
// task-list cache (assignee scoping depends on _currentUserId), and the status/project-
// settings registries (a different user's project membership can see a different set —
// same reasoning as the project-switch reset these caches already had). Deliberately
// does NOT touch _pendingMutations (offline-queued writes replay under the new token —
// see tt-api-backend.md) or the connection state machine (a token swap while connected
// isn't a disconnect).
function _resetUserContext(reason) {
  _currentUserId = null;
  _userIdGeneration++;
  _cacheInvalidate();
  _statusesEntry = null;
  _projectSettingsEntry = null;
  console.log(`[api-backend] User context reset (${reason})`);
}

// Per-instance token watch — fires _resetUserContext() the moment ANY caller's
// getCredentials() call observes a changed API_TOKEN. Since apiRequest()/
// _fetchCurrentUserId()/_probeConnection() all call getCredentials() before touching
// the network, every process (forked server, MCP child, Electron main) picks up a
// re-auth on its own next request — no cross-process IPC needed.
const _tokenWatch = createTokenWatch(() => _resetUserContext('API_TOKEN changed'));

// Called at the top of any method that reads _currentUserId to build a request (e.g.
// `?assignee=`) BEFORE that read — makes sure a token swap that landed since the last
// call is observed first. Swallows credential errors; a missing/blank config just means
// "keep whatever we have," same stance as apiRequest()'s self-heal below.
function _syncCredentialWatch() {
  try { getCredentials(); } catch { /* missing/blank creds — leave state as-is */ }
}

// Apply a mutation function to the unfiltered, scoped, AND board-window (C1259) list
// caches. Use for optimistic mutations (update/delete/create) so every board view stays
// in sync while offline-queued — without this, a board-window cache entry would keep
// showing pre-mutation rows until its 1500ms TTL expires (it isn't cleared by
// _cacheInvalidate() on the offline path — only the online _raw*() calls hit that).
function _eachListCache(fn) {
  if (_listEntry) fn(_listEntry);
  if (_scopedEntry) fn(_scopedEntry);
  for (const entry of _boardEntries.values()) fn(entry);
}

// ── Connection state machine ──
const RECONNECT_BACKOFF_MS = RECONNECT_BACKOFF_MS_TABLE;
let _connectionState = null; // null until init() completes
let _reconnectTimer = null;
let _reconnectAttempt = 0;
const _stateListeners = new Set();
// Token value that triggered the current 'unauthorized' latch — used by the
// apiRequest self-heal to detect when a freshly re-authed token differs.
let _unauthorizedToken = null;
// A server 401/403 against a token that is locally VALID (decodable, unexpired) is not
// proof the token is dead — an edge/proxy hiccup answers the same way — yet the latch
// pins that very token, so the token-changed self-heal can never fire and every later
// call fails locally without the API ever being asked again. For that case only, the
// latched guard lets ONE real request through per AUTH_REVERIFY_INTERVAL_MS; a 2xx/404
// un-latches, another 401/403 re-arms the window. A locally dead token (expired /
// malformed / missing) never re-verifies — still fail-closed.
const AUTH_REVERIFY_INTERVAL_MS = 60_000;
let _reverifyAfter = 0; // 0 = current latch is not re-verifiable

// ── Pending mutation queue ──
// Buffers write mutations (update/create/delete) while offline so callers get
// an optimistic value instead of an error. Drains in insertion order once the
// reconnect probe succeeds, before _markConnected() fires.
let _pendingMutations = [];      // [{ op, args, timestamp, taskId }]
const _pendingTaskIds = new Set(); // task ids currently in queue (for _pendingSync enrichment)
const _drainListeners = new Set(); // cb(replayedTasks[], remainingCount)

function _isOffline() {
  return _connectionState === 'disconnected' || _connectionState === 'reconnecting';
}

function _enqueueMutation(op, args, taskId) {
  _pendingMutations.push({ op, args, timestamp: Date.now(), taskId });
  if (taskId) _pendingTaskIds.add(taskId);
  // Re-fire state listeners so index.js can push updated pendingCount via emitApiStatus
  _notifyState(_connectionState, null);
}

function _notifyDrain(replayedTasks, remainingCount) {
  for (const cb of _drainListeners) {
    try { cb(replayedTasks, remainingCount); } catch (e) { console.warn('[api-backend] drain listener error:', e.message); }
  }
}

async function _drainPendingMutations() {
  if (_pendingMutations.length === 0) return;
  const snapshot = _pendingMutations.slice();
  _pendingMutations = [];
  const replayedTasks = [];

  for (let i = 0; i < snapshot.length; i++) {
    const entry = snapshot[i];
    try {
      if (entry.op === 'update') {
        const result = await _rawUpdateTask(...entry.args);
        _pendingTaskIds.delete(entry.taskId);
        if (result) replayedTasks.push(result);
      } else if (entry.op === 'delete') {
        await _rawDeleteTask(...entry.args);
        _pendingTaskIds.delete(entry.taskId);
        replayedTasks.push({ _deleted: true, id: entry.taskId });
      } else if (entry.op === 'create') {
        const result = await _rawCreateTask(...entry.args);
        if (result) {
          // Remap tmp id → real id in both unfiltered and scoped caches
          _eachListCache(cache => {
            const idx = cache.rows.findIndex(t => t.id === entry.taskId);
            if (idx >= 0) cache.rows[idx] = { ...result };
          });
          _pendingTaskIds.delete(entry.taskId);
          replayedTasks.push({ ...result, _replacedTmpId: entry.taskId });
        }
      }
    } catch (err) {
      if (err.networkError) {
        // Re-queue remaining (including this entry) and re-arm backoff
        _pendingMutations.unshift(...snapshot.slice(i));
        _notifyDrain(replayedTasks, _pendingMutations.length);
        _armReconnect();
        return;
      }
      // (C1383) Auth failure — re-queue remaining (including this entry) same as a
      // network failure, but do NOT arm the reconnect timer: a timer cannot heal a
      // dead token, only a fresh one (via the apiRequest self-heal / token-watch) can.
      // The queue stays parked until that happens — previously this fell into the
      // generic 4xx/5xx branch below and the write was silently dropped.
      if (err.authError) {
        _pendingMutations.unshift(...snapshot.slice(i));
        _notifyDrain(replayedTasks, _pendingMutations.length);
        return;
      }
      // Non-network, non-auth error (other 4xx/5xx) — drop entry, log, continue draining
      console.warn(`[api-backend:queue] Dropping ${entry.op} for ${entry.taskId}: ${err.message}`);
      _pendingTaskIds.delete(entry.taskId);
    }
  }
  _notifyDrain(replayedTasks, _pendingMutations.length);
}

function _notifyState(state, message) {
  for (const cb of _stateListeners) {
    try { cb(state, message); } catch (e) { console.warn('[api-backend] listener error:', e.message); }
  }
}

function _markConnected() {
  if (_connectionState === 'connected') return;
  _connectionState = 'connected';
  _reconnectAttempt = 0;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  _notifyState('connected', null);
}

function _markDisconnected(message) {
  if (_connectionState !== 'connected') return;
  _connectionState = 'disconnected';
  _notifyState('disconnected', message);
  _armReconnect();
}

function _markUnauthorized(message, token) {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  _reconnectAttempt = 0;
  _unauthorizedToken = token ?? null;
  _reverifyAfter = (token && inspectToken(token).ok) ? Date.now() + AUTH_REVERIFY_INTERVAL_MS : 0;
  if (_connectionState === 'unauthorized') return;
  _connectionState = 'unauthorized';
  // One line per latch (never the token) — the reauth wizard is otherwise the only trace.
  console.warn(`[api-backend] unauthorized latch: ${message || '(no reason)'}${_reverifyAfter ? ' — token locally valid, will re-verify' : ''}`);
  _notifyState('unauthorized', message);
}

// Clear the unauthorized latch without triggering a full reconfigureAndProbe.
// Used by clearCredentialCache() and the apiRequest self-heal when a fresh
// token is detected in config.json.
function _clearUnauthorized() {
  if (_connectionState !== 'unauthorized') return;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  _reconnectAttempt = 0;
  _unauthorizedToken = null;
  _reverifyAfter = 0;
  _connectionState = null;
}

function _armReconnect() {
  if (_reconnectTimer) return;
  const delay = RECONNECT_BACKOFF_MS[Math.min(_reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
  _reconnectAttempt++;
  if (_connectionState !== 'reconnecting') {
    _connectionState = 'reconnecting';
    _notifyState('reconnecting', null);
  }
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _probeConnection();
  }, delay);
}

// Fetch and cache the id of the user whose token is in getCredentials().
// Non-throwing: failure leaves _currentUserId = null so creates fall back to assignee:null.
async function _fetchCurrentUserId() {
  // (C1522) Snapshot the generation AFTER getCredentials() — that call is what can
  // trigger _resetUserContext() (token-watch self-detects a swap) if this fetch was
  // itself provoked by a stale token. Only install the result if nothing reset the
  // identity while this request was in flight — otherwise a /me response minted under
  // the OLD token could land after a reset and re-install the previous user's id.
  let gen;
  try {
    const { baseUrl, token } = getCredentials();
    gen = _userIdGeneration;
    const res = await request(`${baseUrl}/api/auth/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 8000,
    });
    if (gen !== _userIdGeneration) {
      // Reset happened mid-flight — a fresher fetch (or the next caller) owns this.
      return _currentUserId;
    }
    if (res.status < 400 && res.data && res.data.user && res.data.user.id != null) {
      _currentUserId = res.data.user.id;
      console.log(`[api-backend] Current user id: ${_currentUserId}`);
    } else {
      console.warn(`[api-backend] GET /api/auth/me returned ${res.status}; assignee will be null`);
    }
  } catch (err) {
    console.warn(`[api-backend] could not resolve current user id: ${err.message}`);
  }
  return _currentUserId;
}

async function _probeConnection() {
  try {
    const { baseUrl, token, projectId } = getCredentials();
    const assigneeParam = _currentUserId != null ? `?assignee=${_currentUserId}` : '';
    const url = `${baseUrl}/api/projects/${projectId}/tasks${assigneeParam}`;
    const res = await request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 8000,
    });
    // (C1383) 401/403 must NOT be treated as "reachable" — the old `res.status < 500`
    // gate called _markConnected() on an auth failure too, which CLEARS the
    // 'unauthorized' latch and then drains the pending-write queue straight into a
    // second 401 per entry (previously dropped silently — see _drainPendingMutations).
    // Fail closed instead: latch unauthorized, leave the queue parked, do not reconnect
    // on a timer (a timer cannot heal a dead token).
    if (res.status === 401 || res.status === 403) {
      _markUnauthorized(res.status === 401
        ? 'Authentication required for this project'
        : 'Access denied — this project may not belong to your account', token);
      return;
    }
    if (res.status < 500) {
      _cacheInvalidate();
      await _drainPendingMutations();
      // If drain re-armed reconnect (partial failure), don't call _markConnected yet
      if (!_reconnectTimer) _markConnected();
    } else {
      _armReconnect();
    }
  } catch {
    _armReconnect();
  }
}

// ── Credential hot-reload ──
// The per-project .tipatask/config.json is the SINGLE source of truth — it is the
// file the app rewrites on Google re-auth. getCredentials() delegates to the shared
// live resolver on every call so a refreshed token is picked up without restart.

function getCredentials() {
  return getApiCredentials(_projectRoot, { watch: _tokenWatch });
}

// ── Tag-registration guard (C1439) ──
// Closure-scope, not a `backend` method — _rawCreateTask (below) is also closure-scope
// inside createApiBackend() and needs to reach this without going through `this`.
// Live GET /tags on every call, no caching — see tag-registry-gate.js for why that
// matters (an unreadable registry must throw a DIFFERENT error than "nothing is
// registered", which a cache would make harder to reason about, not easier).

function _projectIdForMessages() {
  try {
    return getCredentials().projectId || config.API_PROJECT_ID || 'unknown';
  } catch {
    return config.API_PROJECT_ID || 'unknown';
  }
}

async function _readTagRegistry() {
  const data = await apiRequest('GET', '/tags');
  return parseTagRegistryResponse(data, _projectIdForMessages());
}

// taskTags: tag names a save wants to write. primaryRows: a registry read the caller
// already has in hand (overwriteRaw reuses its existingTagRows read here — no extra
// network on the happy path). extraKnown: tags this same save is registering via
// POST /tags (tagRegistrations / new_tags) — count as known even before a re-read.
// Returns Map<incomingName, canonicalDbName> for every task tag, unchanged when empty.
// Throws TAG_REGISTRY_UNREADABLE (via _readTagRegistry) or the "Unregistered tag(s)"
// error (via unregisteredTagError) — never silently swallows either failure.
async function _assertTagsRegistered(taskTags, { primaryRows = null, extraKnown = [] } = {}) {
  const wanted = (taskTags || []).filter(Boolean);
  if (wanted.length === 0) return new Map();

  const projectId = _projectIdForMessages();
  let rows = primaryRows;
  if (rows == null) rows = await _readTagRegistry();

  let index = buildTagIndex(rows, extraKnown);
  let { unknown, canonical } = resolveTagNames(wanted, index);
  if (unknown.length > 0) {
    // One fresh re-read before failing — a concurrent registration during the round
    // trip above must not produce a false "unregistered" error. Unlike the pre-C1439
    // code, a failure on THIS read propagates (TAG_REGISTRY_UNREADABLE) instead of
    // being caught into `[]`, which used to turn a transient blip into a hard throw.
    rows = await _readTagRegistry();
    index = buildTagIndex(rows, extraKnown);
    ({ unknown, canonical } = resolveTagNames(wanted, index));
  }
  if (unknown.length > 0) {
    throw unregisteredTagError(unknown, { projectId, registrySize: rows.length });
  }
  return canonical;
}

// ── HTTP helper ──

async function apiRequest(method, urlPath, body, opts = {}) {
  if (_connectionState === 'unauthorized' && !opts.bypassAuthGuard) {
    // Self-heal: if a fresh token has been written to config.json since the latch was set
    // (e.g. force-reauth from the Electron app wrote a new API_TOKEN while the MCP child
    // process was still running), clear the latch and proceed so the MCP child recovers
    // without a Claude Code restart. If creds are still missing/blank → stay latched.
    let healedToken = null;
    try {
      const fresh = getCredentials();
      if (fresh.token && fresh.token !== _unauthorizedToken) healedToken = fresh.token;
    } catch { /* missing or blank creds — stay latched */ }
    if (healedToken) {
      _clearUnauthorized();
    } else if (_reverifyAfter && Date.now() >= _reverifyAfter) {
      // Re-verification slot (see AUTH_REVERIFY_INTERVAL_MS): bump the window first so
      // concurrent callers still fail fast, then let THIS request reach the API. The
      // latch stays set until the response proves the token works.
      _reverifyAfter = Date.now() + AUTH_REVERIFY_INTERVAL_MS;
    } else {
      throw new AuthCorruptedError('Authentication required for this project', { reasonCode: 'unauthorized', statusCode: 401 });
    }
  }
  const { baseUrl, token, projectId } = getCredentials();

  // (C1383) Pre-flight local expiry check — catches a KNOWN-dead token (decodable JWT,
  // past `exp`) before spending a request on it. Runs after the self-heal block above so
  // a freshly-written token still un-latches normally; deliberately permissive on any
  // token shape it can't judge (see auth-guard.js) — the API's own 401/403 below remains
  // the ground truth for everything this pre-check can't decide.
  if (!opts.bypassAuthGuard) {
    const verdict = inspectToken(token);
    if (!verdict.ok) {
      _markUnauthorized(verdict.reason, token);
      throw new AuthCorruptedError(verdict.reason, { reasonCode: verdict.reasonCode, statusCode: 401 });
    }
  }

  const url = `${baseUrl}/api/projects/${projectId}${urlPath}`;
  const timeoutMs = opts.timeoutMs ?? config.OBJECTIVE_API_TIMEOUT_MS;

  let res;
  try {
    res = await request(url, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      body,
      timeoutMs,
      signal: opts.signal,
    });
  } catch (err) {
    // A response that exceeds the client limit is a deterministic local failure,
    // not an offline signal to queue and replay a mutation.
    if (err.code === 'ERR_RESPONSE_TOO_LARGE') throw err;
    // Every transport-level failure (ECONNRESET / socket hang up, ETIMEDOUT, ECONNREFUSED, DNS,
    // ...) surfaces as a rejected call — never an unhandled 'error' event. `networkError` is the
    // marker the mutation queue and stale-cache fallbacks key on; `retryable` states the same
    // thing for callers outside this file, and `code`/`cause` keep the underlying error.
    if (err.code === 'ETIMEDOUT') {
      const e = new Error(`API timed out at ${url} after ${timeoutMs}ms`, { cause: err });
      e.code = err.code;
      e.networkError = true;
      e.retryable = true;
      _markDisconnected(e.message);
      throw e;
    }
    if (err.code === 'EABORT') throw new Error(`API request aborted at ${url}`);
    const e = new Error(`API unreachable at ${baseUrl}: ${err.message}`, { cause: err });
    if (err.code) e.code = err.code;
    e.networkError = true;
    e.retryable = true;
    _markDisconnected(e.message);
    throw e;
  }

  // The API authenticated this token (anything that isn't 401/403 got past auth) while the
  // latch was still set — a re-verification request. Un-latch the same way a successful
  // reconnect probe does: drop caches, announce 'connected', replay the parked queue.
  if (_connectionState === 'unauthorized' && !opts.bypassAuthGuard && res.status < 500
      && res.status !== 401 && res.status !== 403) {
    _unauthorizedToken = null;
    _reverifyAfter = 0;
    _cacheInvalidate();
    _markConnected();
    _drainPendingMutations().catch(() => {});
  }
  if (res.status === 204) return null;
  if (res.status === 401) {
    _markUnauthorized('Authentication required for this project', token);
    throw new AuthCorruptedError('Authentication required for this project', { reasonCode: 'unauthorized', statusCode: 401 });
  }
  if (res.status === 403) {
    // TPT34 — two unrelated 403s land here. The auth one ("this project isn't yours") must
    // keep latching the connection. A *business-rule* 403 from one route (the author-only
    // comment-edit gate, api/src/routes/tasks.js) must NOT: latching would take the entire
    // Task App session to `unauthorized` just because a user clicked Edit on someone else's
    // comment. Only a caller that opts in via `opts.allowForbidden` gets the non-latching
    // path below — every existing caller's behavior is unchanged.
    if (opts.allowForbidden) {
      const detail = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      const err = new Error(`API 403: ${detail}`);
      err.statusCode = 403;
      err.body = res.data;
      err.forbidden = true;
      throw err;
    }
    _markUnauthorized('Access denied — this project may not belong to your account', token);
    throw new AuthCorruptedError('Access denied — this project may not belong to your account', { reasonCode: 'unauthorized', statusCode: 403 });
  }
  if (res.status === 404) return { _notFound: true };

  if (res.status >= 400) {
    const detail = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const err = new Error(`API ${res.status}: ${detail}`);
    err.statusCode = res.status;
    // Additive only — existing callers all read `.message`/`.statusCode` and never
    // touch this, so it's safe alongside them. Lets a caller that wants the API's raw
    // `{ error, ... }` validation body (e.g. C1182's Workflow tab CRUD, below) recover
    // it without re-parsing `.message`'s `API <status>: <json>` wrapper.
    err.body = res.data;
    throw err;
  }

  return res.data;
}

// C1182 — Workflow tab CRUD errors: api/src/routes/statuses.js returns structured 400/409
// bodies (`{ error: "..." }`, sometimes `{ error, missing }`) that are worth showing verbatim
// in the Settings UI instead of apiRequest()'s generic `API <status>: <json>` wrapper.
function unwrapStatusesApiError(err) {
  if (err && err.statusCode && err.body && typeof err.body === 'object' && typeof err.body.error === 'string') {
    const e = new Error(err.body.error);
    e.statusCode = err.statusCode;
    return e;
  }
  return err;
}

// ── Field mapping ──
// API uses `task_key` as identifier; frontend uses `id`.

function fromApi(t) {
  return {
    id: t.task_key,
    projectId: t.project_id ?? null,
    parentDbId: t.parent_id ?? null,
    // (C1433) numeric row id, kept alongside parentDbId so the board can match a card to
    // its children client-side. Deliberately NOT `parentId` — that field name is a
    // write-path-only task_key (task-backend.js) and populating it on the read path
    // would activate template.html's dormant `!t.parentId` root-task filter.
    dbId: t.id ?? null,
    title: t.title,
    description: t.description || '',
    category: t.category || 'CODING',
    // C1187: a synchronous field-mapper (no registry access) — this is a "the API
    // response is missing the field entirely" guard, not a role resolution. Should
    // never actually fire in practice (the API always sends a real status), so it isn't
    // worth threading an async registry lookup through fromApi() for.
    status: t.status || 'pending',
    priority: Number(t.priority ?? 0),
    order: t.display_order ?? 0,
    dependencies: t.dependencies || [],
    tags: t.tags || [],
    assignee: t.assignee ?? null,
    // (TPT180) Read-only author id (tasks.created_by). Immutable from this client: toApi()
    // below has no created_by key, and the API's bulk-PUT UPDATE branch never writes it, so
    // an author survives every write path the Task App has. Null for a row whose author is
    // unknown (created before migration 066/072 with no assignee to derive from).
    createdBy: t.created_by ?? null,
    totalInputTokens: t.total_input_tokens || 0,
    totalOutputTokens: t.total_output_tokens || 0,
    totalCostUsd: parseFloat(t.total_cost_usd) || 0,
    activeDevice: t.active_device || null,
    recentDeviceId: t.recent_device_id ?? null,
    recentDevice: t.recent_device || null,
    agentAssignee: t.agent_assignee ?? null,
    claudeModel: t.claude_model ?? null,
    codexModel: t.codex_model ?? null,
    piModel: t.pi_model ?? null,
    // TPT284/TPT285: per-task reasoning effort ('low'|'medium'|'high'|'max'), null = inherit
    // the agent default. Same key in snake_case and camelCase.
    effort: t.effort ?? null,
    // C1207: a real boolean, not a tri-state override. Column is TINYINT(1) NOT NULL
    // DEFAULT 0 and mysql2 hands it back as 0/1 (api/src/db.js sets no typeCast), so
    // coerce here — same discipline as isReservation below. Never let `null` through:
    // tasksDiffer() and the edit-modal dirty check both compare with ?? null, and a
    // null-vs-false mismatch would mark every task dirty.
    claudeDesignMode: !!t.claude_design_mode,
    due_date: t.due_date ?? null,
    // C1017: unfinalized reserve_task_keys placeholder marker. Not sent back by
    // toApi() below — it's server-owned, cleared only by a real PATCH/finalize.
    isReservation: !!t.is_reservation,
    // C1338/migration 055: same TINYINT(1) NOT NULL coercion discipline as
    // claudeDesignMode above. Was missing entirely until now — toApi()/_rawUpdateTask()
    // never forwarded it either, so nothing could set or read it back.
    isObjective: !!t.is_objective,
  };
}

function toApi(t) {
  const out = {
    task_key: String(t.id || ''),
    parent_id: t.parentDbId ?? null,
    title: String(t.title || ''),
    description: String(t.description || t.title || 'No description'),
    category: t.category || 'CODING',
    // C1187: same "field genuinely absent" guard as fromApi() above, not a role check —
    // a caller building a task object always sets a real status via the resolved role
    // name before this runs (create_task/update_task in mcp/server.js, etc).
    status: t.status || 'pending',
    priority: Number(t.priority ?? 0),
    display_order: t.order ?? 0,
    dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
    tags: Array.isArray(t.tags) ? t.tags : [],
    assignee: t.assignee ?? null,
    agent_assignee: t.agentAssignee ?? null,
    due_date: t.due_date ?? null,
  };
  // Per-task model override forwarded ONLY when explicitly set to a non-empty
  // model id. Blank/undefined is omitted (not sent as null) so a plain new
  // task carries no defaulted model and inherits the project
  // CLAUDE_MODEL/CODEX_MODEL default at spawn (C954). API POST/PUT handlers
  // read `t.claude_model ?? null`, so an omitted key still resolves to "no
  // override" — clearing (explicit null in the object) still works.
  if (t.claudeModel) out.claude_model = t.claudeModel;
  if (t.codexModel) out.codex_model = t.codexModel;
  if (t.piModel) out.pi_model = t.piModel;
  // TPT285: same conditional-omit rule — an omitted `effort` resolves to NULL (inherit) in the
  // API's POST/PUT readers (normalizeEffort(undefined) -> null).
  if (t.effort) out.effort = t.effort;
  // C1207: same conditional-omit shape as the model fields above, different reason —
  // for a boolean, omitting *is* "false": the API's POST/PUT readers do
  // `toBoolInt(t.claude_design_mode)` → 0, identical to the column default.
  if (t.claudeDesignMode) out.claude_design_mode = true;
  // Same conditional-omit shape as claudeDesignMode above, same reason — omitting is
  // "false", matching the column default. Was missing entirely (migration 055 shipped
  // the column but no client write path ever set it).
  if (t.isObjective) out.is_objective = true;
  // C1245: task-app's create path never forwarded `type` (task/story/bug) — API
  // column is real (migration 008), just wasn't reachable from a manual create.
  if (t.type) out.type = t.type;
  return out;
}

async function resolveParentDbId(parentKey) {
  const data = await apiRequest('GET', `/tasks/${encodeURIComponent(parentKey)}`);
  if (!data || data._notFound || !data.task) throw new Error(`Parent task ${parentKey} not found`);
  return data.task.id;
}

function applyIdRemapToTaskPayload(tasks, idRemap) {
  if (!idRemap || idRemap.size === 0) return;
  for (const t of tasks) {
    const id = String(t.id || '');
    if (idRemap.has(id)) t.id = idRemap.get(id);
  }
  for (const t of tasks) {
    if (Array.isArray(t.dependencies)) {
      t.dependencies = t.dependencies.map(dep => idRemap.get(String(dep)) || dep);
    }
    if (t.parentId && idRemap.has(String(t.parentId))) {
      t.parentId = idRemap.get(String(t.parentId));
    }
  }
}

// isReservationPlaceholder (shared with id-remap.js — see reservation-placeholder.js)
// replaces the old locally-defined isReservedPlaceholder/RESERVED_PLACEHOLDER_DESCRIPTION
// pair (C1017) — same check, now also considers the is_reservation flag column.

// C980: task keys are no longer minted by scanning+incrementing local state (that
// read-then-guess pattern is exactly what let two concurrent saves collide). Every
// "new" task's id here SHOULD already be a real, atomically-reserved placeholder row
// — booked live during the chat via the planner's reserve_task_keys tool, or by a
// web-frontend create form. Trust it as-is when it validates against live state;
// otherwise (planner skipped/miscounted the reservation, or sent a stale/duplicate
// id) reserve a fresh key right now via the same atomic endpoint. Never invents an
// id by scanning history.
async function assignIncomingNewTaskIds(backend, incomingNewTasks, liveTasks) {
  const liveById = new Map(liveTasks.map(t => [String(t.id || ''), t]));
  const claimedThisBatch = new Set();
  const idRemap = new Map();

  for (const t of incomingNewTasks) {
    const oldId = String(t.id || '');
    const liveTask = liveById.get(oldId);
    if (oldId && !claimedThisBatch.has(oldId) && isReservationPlaceholder(liveTask)) {
      claimedThisBatch.add(oldId);
      continue; // already a real, unique, unfinalized key — keep t.id as-is
    }
    const isHuman = /^H\d+$/.test(oldId) || t.category === 'HUMAN';
    const { keys } = await backend.reserveTaskKeys({
      count: 1,
      category: isHuman ? 'HUMAN' : 'CODING',
      priority: t.priority ?? 0,
    });
    const newId = keys[0];
    claimedThisBatch.add(newId);
    // Mutate t.id directly so two tasks sharing one source id diverge to distinct
    // final keys. Record idRemap only for the first occurrence of each source id —
    // used exclusively for dep/parentId rewriting.
    if (oldId && !idRemap.has(oldId)) idRemap.set(oldId, newId);
    t.id = newId;
  }

  return idRemap;
}

// Field-level diff used by overwriteRaw (C980) to decide whether a carried-over
// task actually needs a PATCH, or can be skipped — avoids re-sending every task in
// the project on every save now that persistence is targeted-PATCH, not bulk-PUT.
const DIFF_FIELDS = ['title', 'description', 'category', 'status', 'priority', 'order',
  'dependencies', 'tags', 'assignee', 'agentAssignee', 'claudeModel', 'codexModel', 'piModel', 'effort', 'claudeDesignMode', 'due_date', 'parentDbId', 'isObjective'];
function tasksDiffer(incoming, live) {
  if (!live) return true;
  for (const f of DIFF_FIELDS) {
    const a = incoming[f];
    const b = live[f];
    if (Array.isArray(a) || Array.isArray(b)) {
      if (JSON.stringify(a || []) !== JSON.stringify(b || [])) return true;
    } else if ((a ?? null) !== (b ?? null)) {
      return true;
    }
  }
  return false;
}

// ── Task list row mapper ──
// Shared by getTasksUnfiltered() and getTasks() so both caches use identical mapping.

function _mapRawTasks(raw) {
  const parentDbIds = new Set(raw.filter(t => t.parent_id != null).map(t => t.parent_id));
  return raw.map(t => ({
    ...fromApi(t),
    // (C1340) parentDbIds only sees children present in THIS same response — fine for
    // an unwindowed list, but getBoardTasks() (the only caller sending raw rows through
    // here) is sprint-windowed (C1259), so a parent's children can fall outside the
    // window and vanish from parentDbIds even though real children exist. The route
    // returns an authoritative per-row children_count by default (api/src/routes/
    // tasks.js, includeCount unless include_children_count=false, never sent here) —
    // fall back to it so an objective task outside its own children's window doesn't
    // wrongly render the yellow "Create Subtasks" button in place of the green
    // "Subtasks N/M" one (C1436).
    hasChildren: parentDbIds.has(t.id) || (t.children_count || 0) > 0,
    // (C1435) raw list-route rollup counts, for the board's "Subtasks N/M" badge.
    // `?? null`, not `?? 0` — null means "the API didn't compute this" (an
    // include_children_count=false caller, or an out-of-date deployment), which a
    // client must be able to tell apart from a real zero to avoid rendering a false
    // "0/0" instead of hiding the badge.
    childrenCount: t.children_count ?? null,
    completedChildrenCount: t.completed_children_count ?? null,
    _pendingSync: _pendingTaskIds.has(t.task_key),
  }));
}

// ── Raw mutation helpers (no queue logic — used directly in drain loop) ──

async function _rawUpdateTask(id, fields) {
  const body = {};
  if (fields.status !== undefined) body.status = fields.status;
  if (fields.description !== undefined) body.description = fields.description.trim();
  if (fields.title !== undefined) body.title = fields.title.trim();
  if (fields.order !== undefined) body.display_order = fields.order;
  // assignee (integer user id or null) is now reassignable from the Task App
  // edit modal (Member Assignee select). MCP agent paths should still avoid
  // stamping assignee to prevent accidental reassignment during task execution.
  if (fields.assignee !== undefined) body.assignee = fields.assignee;
  if (fields.priority !== undefined) body.priority = fields.priority;
  if (fields.tags !== undefined) body.tags = fields.tags;
  // category/type — needed so the finalize/Save-Tasks path (C980) can PATCH a
  // pre-reserved placeholder row's real content in one call instead of a bulk PUT.
  if (fields.category !== undefined) body.category = fields.category;
  if (fields.type !== undefined) body.type = fields.type;
  if (fields.dependencies !== undefined) body.dependencies = fields.dependencies;
  const agentAssignee = fields.agentAssignee !== undefined ? fields.agentAssignee : fields.agent_assignee;
  if (agentAssignee !== undefined) body.agent_assignee = agentAssignee;
  const claudeModel = fields.claudeModel !== undefined ? fields.claudeModel : fields.claude_model;
  if (claudeModel !== undefined) body.claude_model = claudeModel;
  const codexModel = fields.codexModel !== undefined ? fields.codexModel : fields.codex_model;
  if (codexModel !== undefined) body.codex_model = codexModel;
  const piModel = fields.piModel !== undefined ? fields.piModel : fields.pi_model;
  if (piModel !== undefined) body.pi_model = piModel;
  // TPT285: single key in both casings; '' clears to null (API normalizeEffort does the same).
  if (fields.effort !== undefined) body.effort = fields.effort || null;
  // C1207. The snake_case fallback is MANDATORY, not defensive: main/ipc/api-router.js
  // forwards the renderer's snake_case patch verbatim, and in the desktop app that IPC
  // route — not ws-handlers.js's HTTP PATCH — is the primary path for api.tasks.update().
  const claudeDesignMode = fields.claudeDesignMode !== undefined ? fields.claudeDesignMode : fields.claude_design_mode;
  if (claudeDesignMode !== undefined) body.claude_design_mode = !!claudeDesignMode;
  // Was missing entirely (migration 055 shipped the column but no client write path
  // ever set it) — same shape as claudeDesignMode above.
  const isObjective = fields.isObjective !== undefined ? fields.isObjective : fields.is_objective;
  if (isObjective !== undefined) body.is_objective = !!isObjective;
  if (fields.parentId !== undefined) {
    body.parent_id = fields.parentId === null ? null : await resolveParentDbId(fields.parentId);
  }
  const data = await apiRequest('PATCH', `/tasks/${encodeURIComponent(id)}`, body);
  if (data && data._notFound) return null;
  _cacheInvalidate();
  const task = fromApi(data.task);
  // TPT3 — surface the TPT2 parent-follow cascade (parent_rescheduled: [{task_key,from,to}])
  // instead of dropping it on the floor like the rest of the PATCH body. Underscore-prefixed
  // meta field, same precedent as _pendingSync above — never a real task column.
  if (Array.isArray(data.parent_rescheduled) && data.parent_rescheduled.length) {
    task._parentRescheduled = data.parent_rescheduled;
  }
  return task;
}

async function _rawDeleteTask(id) {
  const data = await apiRequest('DELETE', `/tasks/${encodeURIComponent(id)}`);
  if (data && data._notFound) return false;
  _cacheInvalidate();
  return true;
}

async function _rawCreateTask(task) {
  _syncCredentialWatch();
  const body = toApi(task);
  // An explicit assignee (e.g. the New Task form's Member Assignee pick) wins; otherwise
  // the task is owned by the creator. Resolve lazily in case init() was called before the
  // network was ready — only when a fallback is actually needed.
  if (task.assignee == null && _currentUserId == null) await _fetchCurrentUserId();
  body.assignee = task.assignee ?? _currentUserId ?? null;
  if (task.parentId) body.parent_id = await resolveParentDbId(task.parentId);

  // C1038: no more silent auto-registration with a placeholder description (the API
  // now rejects placeholders anyway — see api/src/lib/tag-descriptions.js). An unknown
  // tag must be registered with a real description BEFORE it lands on a task, so the
  // agent is forced to think through what the tag means: mcp ensure_project_tag for
  // plain tags, create_system_tag for tt-* architecture tags. Fail fast here rather
  // than letting POST /tasks 400 with a less actionable TAGS_UNREGISTERED message.
  // C1439: _assertTagsRegistered trims/case-folds (matching the tags table's
  // case-insensitive collation) and returns each tag's CANONICAL db spelling — rewrite
  // body.tags to it, since the API's own resolveTagIds does a case-SENSITIVE JS lookup
  // after its case-INSENSITIVE SQL match (see tag-registry-gate.js's resolveTagNames).
  if (Array.isArray(body.tags) && body.tags.length > 0) {
    const canonical = await _assertTagsRegistered(body.tags);
    body.tags = body.tags.map(n => canonical.get(n) ?? n);
  }

  const data = await apiRequest('POST', '/tasks', body);
  if (!data || !data.task) {
    throw new Error('API createTask response missing task');
  }
  const created = fromApi(data.task);
  _cacheInvalidate();
  return created;
}

// ── Backend implementation ──

const backend = {
  async init() {
    try {
      const data = await apiRequest('GET', '/tasks', undefined, { bypassAuthGuard: true });
      if (data && data._notFound) {
        throw new Error('Project not found — check API_PROJECT_ID in .tipatask/config.json');
      }
      // (C1346) Non-fatal: a local-recipes-dir problem must never fail connect/reauth. See
      // _localRecipesDir() above for why this is per-project, not the global fileOps singleton.
      try {
        const dir = _localRecipesDir();
        if (dir) await recipesStore.ensureRecipesDir(dir);
      } catch (e) {
        console.warn('[api-backend] local recipes dir unavailable (non-fatal):', e.message);
      }
      await _fetchCurrentUserId();
      // Through the notifier, not a raw assignment: a successful (re)init after a latch
      // must emit 'connected' or the renderer keeps its reauth prompt up forever.
      _unauthorizedToken = null;
      _reverifyAfter = 0;
      _markConnected();
      console.log(`[api-backend] Connected — ${(data.tasks || []).length} tasks in project`);
    } catch (err) {
      if (err && (err.authError || err.missingCredentials)) {
        // State already pushed via _markUnauthorized (or surface here for missing creds).
        if (err.missingCredentials) _markUnauthorized(err.message);
        return; // soft-fail; reauth modal handles recovery in renderer
      }
      throw err;
    }
  },

  // Full unfiltered list — all project tasks regardless of assignee.
  // Use for all save/merge/agent/system paths to prevent data loss.
  async getTasksUnfiltered() {
    const t0 = TASKS_CACHE_LOG ? Date.now() : 0;

    if (_listEntry !== null && (Date.now() - _listEntry.at) < TASKS_CACHE_TTL_MS) {
      if (TASKS_CACHE_LOG) process.stderr.write(`[api-backend:cache] op=list outcome=hit ms=${Date.now() - t0}\n`);
      return _listEntry.rows;
    }

    if (_listInflight) {
      if (TASKS_CACHE_LOG) process.stderr.write(`[api-backend:cache] op=list outcome=inflight\n`);
      return _listInflight;
    }

    // include_reservations=true (C1017): this backend's internal logic (id-collision
    // checks, finalize-in-place matching in overwriteRaw, list_task_id_meta max-id
    // computation) must keep seeing unfinalized reservation placeholders even though
    // the API excludes them by default. Rendering hides them — see template.html.
    _listInflight = apiRequest('GET', '/tasks?include_reservations=true').then(data => {
      const rows = _mapRawTasks(data.tasks || []);
      _listEntry = { rows, at: Date.now() };
      _listInflight = null;
      if (TASKS_CACHE_LOG) process.stderr.write(`[api-backend:cache] op=list outcome=fetch ms=${Date.now() - t0}\n`);
      return rows;
    }).catch(err => {
      _listInflight = null;
      if (err.networkError && _listEntry !== null) {
        if (TASKS_CACHE_LOG) process.stderr.write(`[api-backend:cache] op=list outcome=stale-fallback\n`);
        return _listEntry.rows;
      }
      throw err;
    });
    return _listInflight;
  },

  // Scoped list — tasks assigned to the current user OR unassigned (NULL).
  // Used exclusively by the Task App board so other users' tasks don't appear.
  // Falls back to unfiltered when _currentUserId is not yet resolved (init not complete).
  async getTasks() {
    _syncCredentialWatch();
    if (_currentUserId == null) {
      if (TASKS_CACHE_LOG) process.stderr.write(`[api-backend:cache] op=scoped outcome=no-user-fallback\n`);
      return this.getTasksUnfiltered();
    }

    const t0 = TASKS_CACHE_LOG ? Date.now() : 0;

    if (_scopedEntry !== null && (Date.now() - _scopedEntry.at) < TASKS_CACHE_TTL_MS) {
      if (TASKS_CACHE_LOG) process.stderr.write(`[api-backend:cache] op=scoped outcome=hit ms=${Date.now() - t0}\n`);
      return _scopedEntry.rows;
    }

    if (_scopedInflight) {
      if (TASKS_CACHE_LOG) process.stderr.write(`[api-backend:cache] op=scoped outcome=inflight\n`);
      return _scopedInflight;
    }

    // include_reservations=true — see comment on getTasksUnfiltered() above; the
    // board renderer (template.html) filters reservations out for display.
    _scopedInflight = apiRequest('GET', `/tasks?assignee=${_currentUserId}&include_reservations=true`).then(data => {
      // (C1407) filterToOwnOrUnassigned() closes the project-owner exemption gap —
      // see the _scopedEntry comment above.
      const rows = filterToOwnOrUnassigned(_mapRawTasks(data.tasks || []), _currentUserId);
      _scopedEntry = { rows, at: Date.now() };
      _scopedInflight = null;
      if (TASKS_CACHE_LOG) process.stderr.write(`[api-backend:cache] op=scoped outcome=fetch ms=${Date.now() - t0}\n`);
      return rows;
    }).catch(err => {
      _scopedInflight = null;
      if (err.networkError && _scopedEntry !== null) {
        if (TASKS_CACHE_LOG) process.stderr.write(`[api-backend:cache] op=scoped outcome=stale-fallback\n`);
        return _scopedEntry.rows;
      }
      throw err;
    });
    return _scopedInflight;
  },

  // Request the API's active sprint window (plus backlog); extendSprints loads
  // older tiers. fullWindow fetches every sprint for search. API owns the
  // completed-only fallback for windowed reads. Missing user id falls
  // back to getTasks(). unscoped skips both API and local assignee filters;
  // cache keys separate 'me' and 'all' results.
  async getBoardTasks({ extendSprints = 0, unscoped = false, fullWindow = false } = {}) {
    _syncCredentialWatch();
    const n = Number.isFinite(extendSprints) && extendSprints > 0 ? Math.floor(extendSprints) : 0;
    if (_currentUserId == null && !unscoped) {
      if (TASKS_CACHE_LOG) process.stderr.write(`[api-backend:cache] op=board outcome=no-user-fallback\n`);
      return { tasks: await this.getTasksUnfiltered(), window: null };
    }

    const scope = unscoped ? 'all' : 'me';
    const cacheKey = `${fullWindow ? 'full' : n}|${scope}`;
    const t0 = TASKS_CACHE_LOG ? Date.now() : 0;
    const cached = _boardEntries.get(cacheKey);
    if (cached && (Date.now() - cached.at) < TASKS_CACHE_TTL_MS) {
      if (TASKS_CACHE_LOG) process.stderr.write(`[api-backend:cache] op=board outcome=hit n=${n} scope=${scope} ms=${Date.now() - t0}\n`);
      return { tasks: cached.rows, window: cached.windowInfo };
    }

    const inflight = _boardInflight.get(cacheKey);
    if (inflight) {
      if (TASKS_CACHE_LOG) process.stderr.write(`[api-backend:cache] op=board outcome=inflight n=${n} scope=${scope}\n`);
      return inflight;
    }

    const assigneeQs = unscoped ? '' : `assignee=${_currentUserId}&`;
    const qs = `${assigneeQs}include_reservations=true${fullWindow ? '' : `&window=active${n > 0 ? `&extend_sprints=${n}` : ''}`}`;
    const req = apiRequest('GET', `/tasks?${qs}`).then(data => {
      const mapped = _mapRawTasks(data.tasks || []);
      // (C1407) unscoped → skip the owner-exemption filter too, this IS the "show
      // everyone" mode.
      const rows = unscoped ? mapped : filterToOwnOrUnassigned(mapped, _currentUserId);
      const windowInfo = data.window || null;
      _boardEntries.set(cacheKey, { rows, windowInfo, at: Date.now() });
      _boardInflight.delete(cacheKey);
      if (TASKS_CACHE_LOG) process.stderr.write(`[api-backend:cache] op=board outcome=fetch n=${n} scope=${scope} ms=${Date.now() - t0}\n`);
      return { tasks: rows, window: windowInfo };
    }).catch(err => {
      _boardInflight.delete(cacheKey);
      if (err.networkError && cached) {
        if (TASKS_CACHE_LOG) process.stderr.write(`[api-backend:cache] op=board outcome=stale-fallback n=${n} scope=${scope}\n`);
        return { tasks: cached.rows, window: cached.windowInfo };
      }
      throw err;
    });
    _boardInflight.set(cacheKey, req);
    return req;
  },

  async getTask(id) {
    const data = await apiRequest('GET', `/tasks/${encodeURIComponent(id)}`);
    if (!data || data._notFound || !data.task) return null;
    return fromApi(data.task);
  },

  async getTasksFiltered(statuses) {
    // Reuse the unfiltered full list — this is used by objective/agent paths that must
    // see all assignees' tasks. Board scoping is via getTasks(), not this method.
    const tasks = await this.getTasksUnfiltered();
    const set = new Set(statuses);
    return tasks.filter(t => set.has(t.status));
  },

  // (C1541) Backs the list_task_resolutions MCP tool — lets an agent browse past task
  // comment history (all comment types: comment/resolution/spec) by tag, so per-task
  // narrative stays discoverable without ever needing to live in the architecture KB
  // (which must hold standing system concepts only). No server-side tag filter exists on
  // GET /tasks and there is no batch comments endpoint, so this filters the cached
  // unfiltered task list client-side and probes GET .../comments per candidate task.
  //
  // Comments are deliberately never cached — this is called rarely, and a stale
  // resolution is worse than one extra round-trip. Reuses getTasksUnfiltered()'s own
  // _listEntry TTL cache for the task list itself, so no new cache slot/invalidation is
  // needed here.
  async getTasksByTags(tags, { limit, status, includeAgentLogs = false } = {}) {
    const wanted = (tags || []).map(t => String(t).toLowerCase()).filter(Boolean);
    if (wanted.length === 0) {
      const err = new Error('getTasksByTags: tags must be a non-empty array');
      err.code = 'VALIDATION';
      throw err;
    }
    const tagSet = new Set(wanted);
    const effectiveLimit = Math.min(RESOLUTIONS_MAX_LIMIT, Math.max(1, limit || RESOLUTIONS_DEFAULT_LIMIT));

    const [allTasks, statusCtx] = await Promise.all([
      this.getTasksUnfiltered(),
      fetchStatusContext(this),
    ]);
    if (status && !statusCtx.names.includes(status)) {
      const err = new Error(`Invalid status ${JSON.stringify(status)}. This project's statuses are: ${statusCtx.names.join(', ')}.`);
      err.code = 'VALIDATION';
      throw err;
    }

    const candidates = selectResolutionCandidates(allTasks, { tagSet, statusName: status, closedSet: statusCtx.closed })
      .sort((a, b) => (b.dbId ?? 0) - (a.dbId ?? 0));

    // Probe comments in bounded batches with early exit, rather than one Promise.all over
    // `limit` tasks — getTaskComments() returns null on 404 (a task deleted between the
    // list fetch and the probe), and a single slow/timing-out GET among many parallel ones
    // flips this backend's connection state via _markDisconnected() and broadcasts
    // 'disconnected' to the Task App UI (apiRequest's timeout path, see above). Over-fetch
    // beyond `limit` because a candidate whose only comment is an excluded agent-log-tail
    // must not consume a result slot — see the ws-handlers.js auto-post hook this excludes.
    const PROBE_BATCH = 5;
    const maxProbe = Math.min(candidates.length, effectiveLimit * 3, 30);
    const acceptedTasks = [];
    const commentsByTaskId = {};
    for (let i = 0; i < maxProbe && acceptedTasks.length < effectiveLimit; i += PROBE_BATCH) {
      const batch = candidates.slice(i, i + PROBE_BATCH);
      const results = await Promise.allSettled(batch.map(t => this.getTaskComments(t.id)));
      for (let j = 0; j < batch.length && acceptedTasks.length < effectiveLimit; j++) {
        const settled = results[j];
        const comments = settled.status === 'fulfilled' ? (settled.value || []) : [];
        // A task whose only comment(s) are the excluded agent-log-tail artifact must not
        // consume a result slot — check survivability under the same filter
        // shapeResolutionPayload will apply, not just "has any comment at all".
        const survives = includeAgentLogs
          ? comments.length > 0
          : comments.some(c => !isAgentLogTailComment(c.content));
        if (!survives) continue;
        commentsByTaskId[batch[j].id] = comments;
        acceptedTasks.push(batch[j]);
      }
    }

    return shapeResolutionPayload({
      tasks: acceptedTasks,
      commentsByTaskId,
      includeAgentLogs,
      totalMatched: candidates.length,
    });
  },

  // Push filters+projection down to server — bypasses full-list cache so
  // filtered slices don't pollute the full-list cache used by list_task_id_meta.
  // Pass unscoped:true to skip assignee filtering (MCP/agent callers must see all tasks).
  async getTasksServerFiltered({ status, category, limit, offset, fields = 'summary', unscoped = false }) {
    _syncCredentialWatch();
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (limit != null) qs.set('limit', String(limit));
    if (offset != null && offset > 0) qs.set('offset', String(offset));
    qs.set('fields', fields);
    qs.set('include_children_count', 'true');
    qs.set('include_active_device', 'false');
    // include_reservations=true (C1017) — same reasoning as getTasksUnfiltered()/
    // getTasks() above: internal callers must keep seeing placeholders.
    qs.set('include_reservations', 'true');
    // Scope to current user unless the caller explicitly opts out (MCP/agent paths).
    if (_currentUserId != null && !unscoped) qs.set('assignee', String(_currentUserId));
    const data = await apiRequest('GET', `/tasks?${qs.toString()}`);
    const raw = data.tasks || [];
    let rows = raw.map(t => ({
      ...fromApi(t),
      hasChildren: (t.children_count || 0) > 0,
      // (C1435) same raw-count passthrough as _mapRawTasks() — this method also sends
      // include_children_count=true explicitly, so the fields are always present here.
      childrenCount: t.children_count ?? null,
      completedChildrenCount: t.completed_children_count ?? null,
    }));
    if (category) rows = rows.filter(t => t.category === category);
    return rows;
  },

  async getTags() {
    const data = await apiRequest('GET', '/tags');
    return (data.tags || []).map(t => (typeof t === 'string' ? t : t.name));
  },

  // knowledgeFileKey (046) surfaces tags.knowledge_file_id, joined server-side to its
  // file_key — the DB-verified tag<->doc link, as opposed to the name-convention guess
  // every other consumer still makes. null when unlinked (plain tags, or a tt-* tag
  // whose link hasn't been (re)established yet).
  async getTagsDetailed() {
    const data = await apiRequest('GET', '/tags');
    return (data.tags || []).map(t =>
      typeof t === 'string'
        ? { name: t, description: null, knowledgeFileKey: null }
        : { name: t.name, description: t.description ?? null, knowledgeFileKey: t.knowledge_file_key ?? null }
    );
  },

  async getProjectTags() {
    const data = await apiRequest('GET', '/tags');
    return data.tags || [];
  },

  // fileKey (optional) links this tag to an already-pushed project_knowledge_files row
  // (tags.knowledge_file_id — see api/src/migrations/046_tags_knowledge_file_link.js).
  // The KB doc must already exist server-side when this is called — create_system_tag
  // pushes the doc first, then calls ensureTag with fileKey set, so the tt-* tag <-> doc
  // relation is established atomically instead of relying on name-convention matching.
  async ensureTag(name, description, fileKey) {
    if (!description || !description.trim()) {
      throw new Error(`description required for tag "${name}"`);
    }
    const entry = { name, description: description.trim() };
    if (fileKey) entry.file_key = fileKey;
    await apiRequest('POST', '/tags', { tags: [entry] });
  },

  // C1040 — persist Knowledge Base > Re-Index results (Opus-generated tag/file
  // descriptions). payload: { files?: [{file_key, description}], tags?: [{name, description}] }.
  // Never creates rows — server-side UPDATE-only, see api/src/routes/knowledge.js.
  async reindexKnowledge(payload) {
    return apiRequest('POST', '/knowledge/reindex', payload);
  },

  // C1184 — ordered project status list with role flags + task_count (see
  // api/src/routes/statuses.js). 30s TTL cache (STATUSES_CACHE_TTL_MS above); a fetch
  // failure (network down, older API server with no /statuses route) never throws —
  // falls back to the last good cached rows, else LEGACY_STATUSES, so a statuses
  // hiccup never blocks a task spawn or a status write-guard. A synthesized
  // (LEGACY_STATUSES) result is cached only STATUSES_FALLBACK_TTL_MS (5s), not the full
  // 30s — same "never serve a stale negative for long" discipline as base-agent.js's
  // NEGATIVE_DETECT_TTL_MS, so a transient outage self-heals fast once the API is back.
  // opts.refresh bypasses the cache entirely — used by callers that must not act on a
  // stale registry (e.g. ws-handlers' PATCH status validation re-checking a miss before
  // rejecting, so a status renamed/created seconds ago is never 400'd).
  async getStatuses(opts = {}) {
    if (!opts.strict && !opts.refresh && _statusesEntry) {
      const ttl = _statusesEntry.fallback ? STATUSES_FALLBACK_TTL_MS : STATUSES_CACHE_TTL_MS;
      if ((Date.now() - _statusesEntry.at) < ttl) return _statusesEntry.rows;
    }
    try {
      const data = await apiRequest('GET', '/statuses');
      const rows = (data && data.statuses) || [];
      if (rows.length > 0) {
        _statusesEntry = { rows, at: Date.now(), fallback: false };
        return rows;
      }
      // Empty/missing statuses array (older API server, unexpected shape) — degrade
      // rather than hand every caller an empty registry.
      if (opts.strict) throw new Error('Project statuses unavailable');
      _statusesEntry = { rows: LEGACY_STATUSES, at: Date.now(), fallback: true };
      return LEGACY_STATUSES;
    } catch (err) {
      if (opts.strict) throw err;
      // Stale-but-real beats legacy-synthetic.
      if (_statusesEntry && !_statusesEntry.fallback) return _statusesEntry.rows;
      _statusesEntry = { rows: LEGACY_STATUSES, at: Date.now(), fallback: true };
      return LEGACY_STATUSES;
    }
  },

  // C1215 — this project's row (used for vcs_type/vcs_worktree_enabled/
  // vcs_commit_enabled/vcs_pr_enabled — see vcs-settings.js). `apiRequest`'s urlPath is
  // always prefixed with `/api/projects/${projectId}` (see apiRequest() above), so an
  // EMPTY urlPath hits exactly `GET /api/projects/:id` — the project-detail endpoint,
  // response shape `{ project, is_owner }`. Same cache/fallback shape as getStatuses()
  // above: a fetch failure never throws — falls back to the last good cached row, else
  // null (vcs-settings.js's normalizeVcsSettings(null) degrades to VCS_OFF, so a
  // hiccup here can never block a task spawn). opts.refresh bypasses the cache.
  async getProjectSettings(opts = {}) {
    if (!opts.strict && !opts.refresh && _projectSettingsEntry) {
      const ttl = _projectSettingsEntry.fallback ? PROJECT_SETTINGS_FALLBACK_TTL_MS : PROJECT_SETTINGS_CACHE_TTL_MS;
      if ((Date.now() - _projectSettingsEntry.at) < ttl) return _projectSettingsEntry.row;
    }
    try {
      const data = await apiRequest('GET', '');
      const row = (data && data.project) || null;
      if (opts.strict && !row) throw new Error('Project settings unavailable');
      _projectSettingsEntry = { row, at: Date.now(), fallback: !row };
      return row;
    } catch (err) {
      // Permissions must never be authorized from a stale cache after a failed read.
      // UI callers retain their existing last-known-good fallback.
      if (opts.strict) throw err;
      // Stale-but-real beats a null fallback.
      if (_projectSettingsEntry && !_projectSettingsEntry.fallback) return _projectSettingsEntry.row;
      _projectSettingsEntry = { row: null, at: Date.now(), fallback: true };
      return null;
    }
  },

  // C1271 — PATCH this project's row (language, task_group_label, color_scheme,
  // sprints_enabled, kb_sync_as_you_go, use_objective_grouping, sprint_sort_order, and —
  // since TPT61 — vcs_type/vcs_worktree_enabled/vcs_commit_enabled/vcs_pr_enabled, C1213/
  // C1215). Empty urlPath resolves to PATCH /api/projects/:id (see apiRequest() above),
  // response shape { project }. Unlike getProjectSettings() this is a write and must NOT
  // fail open — the caller (Settings modal) rolls its control back to the previous value on
  // throw. Drops _projectSettingsEntry so the next getProjectSettings() re-reads the fresh
  // row instead of serving up to 30s of stale cache — same discipline the statuses CRUD
  // below uses for _statusesEntry. unwrapStatusesApiError() is generic despite its name
  // (just unwraps `{ error }` API bodies) — reused here rather than duplicated. This same
  // method is what TPT61's "updateProjectSettings(patch)" ask maps onto — no separate
  // method was added, the field allowlist in ws-handlers.js's PATCH /api/project is the
  // real gate (the API's buildVcsPatch() owns the git-only-flag cross-check).
  async updateProject(fields) {
    try {
      const data = await apiRequest('PATCH', '', fields);
      _projectSettingsEntry = null;
      return (data && data.project) || null;
    } catch (err) {
      throw unwrapStatusesApiError(err);
    }
  },

  // C1182 — Workflow tab CRUD (add/rename/recolor/delete/reorder statuses + move a
  // workflow role). All four go through apiRequest() like every other mutation here, then
  // drop `_statusesEntry` so the next getStatuses() (this tab's own re-render, or a
  // concurrent role-resolution call from C1184's status-roles.js) sees the fresh registry
  // instead of serving up to STATUSES_CACHE_TTL_MS of stale rows. reorderStatuses() gets
  // the fresh list back from the API in the same response, so it repopulates the cache
  // directly instead of dropping it — saves the immediate re-fetch every reorder would
  // otherwise cause.
  async createStatus({ name, color, is_workflow_start, is_in_progress, is_workflow_complete } = {}) {
    const body = { name };
    if (color !== undefined) body.color = color;
    if (is_workflow_start !== undefined) body.is_workflow_start = is_workflow_start;
    if (is_in_progress !== undefined) body.is_in_progress = is_in_progress;
    if (is_workflow_complete !== undefined) body.is_workflow_complete = is_workflow_complete;
    try {
      const data = await apiRequest('POST', '/statuses', body);
      _statusesEntry = null;
      return data.status;
    } catch (err) {
      throw unwrapStatusesApiError(err);
    }
  },

  async updateStatus(id, fields = {}) {
    try {
      const data = await apiRequest('PATCH', `/statuses/${encodeURIComponent(id)}`, fields);
      _statusesEntry = null;
      return data.status;
    } catch (err) {
      throw unwrapStatusesApiError(err);
    }
  },

  async deleteStatus(id) {
    try {
      await apiRequest('DELETE', `/statuses/${encodeURIComponent(id)}`);
      _statusesEntry = null;
      return true;
    } catch (err) {
      throw unwrapStatusesApiError(err);
    }
  },

  async reorderStatuses(ids) {
    try {
      const data = await apiRequest('PUT', '/statuses/reorder', { ids });
      const rows = data.statuses || [];
      _statusesEntry = { rows, at: Date.now(), fallback: false };
      return rows;
    } catch (err) {
      throw unwrapStatusesApiError(err);
    }
  },

  async getProjectMembers() {
    const data = await apiRequest('GET', '/members');
    return data.members || [];
  },

  async getTaskComments(taskKey) {
    const data = await apiRequest('GET', `/tasks/${encodeURIComponent(taskKey)}/comments`);
    if (data && data._notFound) return null;
    return data.comments || [];
  },

  async createTaskComment(taskKey, content, type = 'comment') {
    const data = await apiRequest('POST', `/tasks/${encodeURIComponent(taskKey)}/comments`, { content, type });
    if (data && data._notFound) return null;
    return data.comment;
  },

  // TPT34 — author-only comment edit. `allowForbidden` keeps the API's business 403 (not
  // your comment) from latching the connection (see apiRequest's 403 branch above).
  // unwrapStatusesApiError() is reused despite its name — its {error}-body unwrap is
  // generic, same reuse as updateStatuses() above — so the caller sees the API's real
  // "Forbidden: only the comment author may edit it" instead of apiRequest's
  // `API 403: {"error":...}` wrapper. comment_type is intentionally not accepted here —
  // it isn't editable server-side either.
  async updateTaskComment(taskKey, commentId, content) {
    try {
      const data = await apiRequest(
        'PATCH',
        `/tasks/${encodeURIComponent(taskKey)}/comments/${encodeURIComponent(commentId)}`,
        { content },
        { allowForbidden: true }
      );
      if (data && data._notFound) return null;
      return data.comment;
    } catch (err) {
      throw unwrapStatusesApiError(err);
    }
  },

  // TPT12 — the caller's per-project `notifications` inbox rows (TPT10). Distinct from
  // getTaskEvents() below (TPT17): that reads the task-wide `task_events` audit log with no
  // per-user read state; this reads the recipient inbox that already excludes the actor's
  // own actions server-side and has a real per-row `read_at` — it's what drives the Task
  // App's card activity chip + OS push, not the modal's Notifications tab.
  // `{_notFound:true}` (a deployment predating this route, e.g. this branch not yet on
  // production) degrades to an empty inbox rather than throwing — see task-change-poll.js.
  async getNotifications({ unreadOnly, limit, offset, taskKey } = {}) {
    const params = new URLSearchParams();
    if (unreadOnly) params.set('unread_only', 'true');
    if (limit != null) params.set('limit', String(limit));
    if (offset != null) params.set('offset', String(offset));
    if (taskKey) params.set('task_key', taskKey);
    const qs = params.toString();
    const data = await apiRequest('GET', `/notifications${qs ? `?${qs}` : ''}`);
    if (data && data._notFound) return { notifications: [], unread_count: 0, total: 0 };
    return {
      notifications: data.notifications || [],
      unread_count: data.unread_count || 0,
      total: data.total || 0,
    };
  },

  async markNotificationRead(id) {
    const data = await apiRequest('PATCH', `/notifications/${encodeURIComponent(id)}/read`);
    if (data && data._notFound) return null;
    return data.notification || null;
  },

  // TPT17 — task-wide event log + per-task subscription toggle, backing the Notifications tab.
  async getTaskEvents(taskKey) {
    const data = await apiRequest('GET', `/tasks/${encodeURIComponent(taskKey)}/events`);
    if (data && data._notFound) return null;
    return { events: data.events || [], total: data.total || 0, subscribed: data.subscribed !== false };
  },

  async setTaskSubscription(taskKey, subscribed) {
    const data = await apiRequest('PUT', `/tasks/${encodeURIComponent(taskKey)}/subscription`, { subscribed });
    if (data && data._notFound) return null;
    return { subscribed: !!data.subscribed };
  },

  async uploadImage(filename, mimeType, data, taskKey = null) {
    const result = await apiRequest('POST', '/images', { filename, mimeType, data, taskKey });
    if (!result || result._notFound) return null;
    return result; // { id, url }
  },

  // Lists images linked to a task via task_images.task_key (C1012) — used by
  // image-attach.js's attachment-merge path (though that module hits the route
  // directly rather than through this backend; see architecture-hint note) and
  // by any future UI wanting a "task images" panel. 404/old API server → [].
  async listTaskImages(taskKey) {
    const data = await apiRequest('GET', `/images/task/${encodeURIComponent(taskKey)}`);
    if (!data || data._notFound) return [];
    return data.images || [];
  },

  // C1246 — task_files, generic (non-image) attachment store. Parallel to uploadImage/
  // listTaskImages above but hits /files instead of /images; the API applies its own 1 MB cap
  // and doc-mime allowlist, so errors surface here as a thrown apiRequest error (statusCode
  // 400/413) rather than a soft null.
  async uploadFile(filename, mimeType, data, taskKey = null) {
    const result = await apiRequest('POST', '/files', { filename, mimeType, data, taskKey });
    if (!result || result._notFound) return null;
    return result; // { id, url, filename, size_bytes }
  },

  async listTaskFiles(taskKey) {
    const data = await apiRequest('GET', `/files/task/${encodeURIComponent(taskKey)}`);
    if (!data || data._notFound) return [];
    return data.files || [];
  },

  async updateTask(id, fields) {
    if (!_isOffline()) {
      // Capture original objective text before adoption PATCH, but post its spec
      // comment only after a successful write. A failed PATCH must not leave a
      // comment that suppresses capture on retry. Offline replay bypasses this.
      const specSnapshot = await readOriginSpecSnapshot(this, id, fields);
      try {
        const result = await _rawUpdateTask(id, fields);
        if (specSnapshot) {
          const lang = (readProjectConfig(_projectRoot) || {}).language || 'en';
          await postOriginSpecComment(this, id, specSnapshot, lang);
        }
        return result;
      } catch (err) {
        if (!err.networkError) throw err;
        // Fell offline during request — fall through to queue
      }
    }
    _enqueueMutation('update', [id, fields], id);
    // Optimistic: mutate cached row in both unfiltered and scoped caches
    let _found = null;
    _eachListCache(cache => {
      const row = cache.rows.find(t => t.id === id);
      if (row) {
        if (fields.status !== undefined) row.status = fields.status;
        if (fields.title !== undefined) row.title = fields.title;
        if (fields.description !== undefined) row.description = fields.description;
        if (fields.priority !== undefined) row.priority = fields.priority;
        if (fields.tags !== undefined) row.tags = fields.tags;
        if (fields.agentAssignee !== undefined) row.agentAssignee = fields.agentAssignee;
        if (fields.claudeModel !== undefined) row.claudeModel = fields.claudeModel;
        if (fields.codexModel !== undefined) row.codexModel = fields.codexModel;
        if (fields.piModel !== undefined) row.piModel = fields.piModel;
        if (fields.effort !== undefined) row.effort = fields.effort || null;
        if (fields.claudeDesignMode !== undefined) row.claudeDesignMode = !!fields.claudeDesignMode;
        if (fields.isObjective !== undefined) row.isObjective = !!fields.isObjective;
        if (fields.order !== undefined) row.order = fields.order;
        if (fields.assignee !== undefined) row.assignee = fields.assignee;
        row._pendingSync = true;
        if (!_found) _found = { ...row };
      }
    });
    if (_found) return _found;
    return { id, ...fields, _pendingSync: true };
  },

  async addTokenUsage(taskKey, tokens) {
    await apiRequest('POST', `/tasks/${encodeURIComponent(taskKey)}/token-usage`, {
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      cost_usd: tokens.costUsd,
    });
    _cacheInvalidate();
  },

  async deleteTask(id) {
    if (!_isOffline()) {
      try {
        return await _rawDeleteTask(id);
      } catch (err) {
        if (!err.networkError) throw err;
      }
    }
    _enqueueMutation('delete', [id], id);
    // Optimistic: remove from both caches so neither getTasks() nor getTasksUnfiltered() returns the deleted row
    _eachListCache(cache => { cache.rows = cache.rows.filter(t => t.id !== id); });
    return true;
  },

  async createTask(task) {
    if (!_isOffline()) {
      try {
        return await _rawCreateTask(task);
      } catch (err) {
        if (!err.networkError) throw err;
      }
    }
    const tmpId = `tmp-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    _enqueueMutation('create', [task], tmpId);
    const optimistic = {
      // created_by mirrors what the server will stamp on replay (req.user.id) so the row
      // survives filterToOwnOrUnassigned() even if assignee is later reassigned offline.
      ...fromApi({ ...toApi(task), task_key: tmpId, assignee: task.assignee ?? _currentUserId, created_by: _currentUserId }),
      _pendingSync: true,
      _tmpId: true,
    };
    // Push to both caches — task is created by _currentUserId so it passes the scope filter
    _eachListCache(cache => { cache.rows.push(optimistic); });
    return optimistic;
  },

  // Atomically reserve `count` real, collision-proof task keys (C980) — used by the
  // reserve_task_keys MCP tool (New Objective planner) and the Save/Accept persistence
  // path's defensive fallback. Unlike createTask, this has no offline-queue fallback:
  // a guaranteed-unique key can only ever come from the live server, so a network
  // failure here must surface to the caller rather than be silently optimistic-queued.
  async reserveTaskKeys({ count = 1, category = 'CODING', priority = 0, type = 'task', parentId = null } = {}) {
    const body = { count, category, priority, type };
    if (parentId != null) body.parent_id = await resolveParentDbId(parentId);
    const data = await apiRequest('POST', '/tasks/reserve', body);
    // apiRequest() swallows a 404 into { _notFound: true } instead of throwing (line ~346)
    // — normally correct for "resource doesn't exist yet", but here a 404 means the API
    // server predates the /tasks/reserve route (C980) or the project lookup 404'd, and
    // silently degrading that into `keys: []` left the objective planner unable to tell
    // "no keys available" from "server is out of date" — it just retried and gave up.
    // Fail loud instead so the real cause reaches the caller/planner.
    if (data && data._notFound) {
      throw new Error('reserve failed: POST /tasks/reserve returned 404 — the API server is missing the reserve route (C980) or this project was not found. Update/redeploy the API, or verify project access.');
    }
    _cacheInvalidate();
    const tasks = (data.tasks || []).map(fromApi);
    if (tasks.length === 0) {
      throw new Error('reserve failed: API returned no tasks for a reserve request (unexpected response shape).');
    }
    return { keys: tasks.map(t => t.id), tasks };
  },

  // Reaps stale, never-finalized reserve_task_keys placeholder rows (C1017). Same
  // _notFound handling as reserveTaskKeys above — a 404 here means an out-of-date
  // API server (predates the purge-reservations route), not "nothing to purge".
  async purgeStaleReservations({ olderThanHours = 24, dryRun = false } = {}) {
    const body = { older_than_hours: olderThanHours, dry_run: dryRun };
    const data = await apiRequest('POST', '/tasks/purge-reservations', body);
    if (data && data._notFound) {
      throw new Error('purge failed: POST /tasks/purge-reservations returned 404 — the API server is missing the purge route (C1017) or this project was not found. Update/redeploy the API, or verify project access.');
    }
    if (!dryRun && (data.purged || 0) > 0) _cacheInvalidate();
    return { purged: data.purged || 0, keys: data.keys || [] };
  },

  async saveTasks(tasks) {
    await apiRequest('PUT', '/tasks', { tasks: tasks.map(toApi) });
    _cacheInvalidate();
  },

  async getSprints() {
    const data = await apiRequest('GET', '/sprints');
    return (data && data.sprints) ? data.sprints : (Array.isArray(data) ? data : []);
  },

  async createSprint(name, number) {
    try {
      const data = await apiRequest('POST', '/sprints', { name, number });
      return data && data.sprint ? data.sprint : null;
    } catch (err) {
      if (err.statusCode === 409) return null; // already exists
      throw err;
    }
  },

  async overwriteRawWithRemap(content) {
    // Serialize concurrent overwrites via the project lock so two simultaneous
    // PUT /api/todo requests can't race and produce duplicate or missing tasks.
    let lockKey;
    try { lockKey = `api:${getCredentials().projectId}`; } catch { lockKey = `api:${config.API_PROJECT_ID}`; }
    return withProjectLock(lockKey, async () => {
      let idRemap = new Map();
      _cacheInvalidate();

      const match = content.match(TODO_REGEX);
      if (!match) throw new Error('No JSON block found in content');
      let parsed;
      try {
        parsed = JSON.parse(match[1]);
      } catch (e) {
        throw new Error(`Invalid JSON in TODO content: ${e.message}`);
      }
      if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
        throw new Error('Invalid task data: missing tasks array');
      }

      const taskIdsInPayload = new Set(parsed.tasks.map(t => String(t.id || '')).filter(Boolean));
      const newTaskIds = Array.isArray(parsed.newTaskIds)
        ? [...new Set(parsed.newTaskIds.map(id => String(id || '').trim()).filter(id => id && taskIdsInPayload.has(id)))]
        : [];

      if (newTaskIds.length > 0) {
        // Must be unfiltered — ID assignment needs to see all existing task keys
        const liveTasks = await this.getTasksUnfiltered();
        const newIdSet = new Set(newTaskIds);
        const incomingNewTasks = parsed.tasks.filter(t => newIdSet.has(String(t.id || '')));
        idRemap = await assignIncomingNewTaskIds(this, incomingNewTasks, liveTasks);
        // After assignIncomingNewTaskIds, incomingNewTasks[i].id is already the
        // final key (mutated in place). Collect all assigned ids — this correctly
        // captures dup-source-id tasks that diverged to distinct final keys.
        const finalNewTaskIds = incomingNewTasks.map(t => String(t.id));
        if (idRemap.size > 0 || finalNewTaskIds.some(id => !newTaskIds.includes(id))) {
          applyIdRemapToTaskPayload(parsed.tasks, idRemap);
          parsed.newTaskIds = finalNewTaskIds;
          content = content.replace(TODO_REGEX, () => '```json\n' + JSON.stringify(parsed, null, 2) + '\n```');
        }
      }

      await this.overwriteRaw(content);
      return idRemap;
    });
  },

  async overwriteRaw(content) {
    // Invalidate the task-list cache before any reads so we see the latest DB
    // state — critical when two save requests are serialized by the lock above.
    _cacheInvalidate();

    const match = content.match(TODO_REGEX);
    if (!match) throw new Error('No JSON block found in content');
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch (e) {
      throw new Error(`Invalid JSON in TODO content: ${e.message}`);
    }
    if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
      throw new Error('Invalid task data: missing tasks array');
    }
    const originalSpec = typeof parsed.originalSpec === 'string' ? parsed.originalSpec.trim() : '';
    const taskIdsInPayload = new Set(parsed.tasks.map(t => String(t.id || '')).filter(Boolean));
    const newTaskIds = Array.isArray(parsed.newTaskIds)
      ? [...new Set(parsed.newTaskIds.map(id => String(id || '').trim()).filter(id => id && taskIdsInPayload.has(id)))]
      : [];
    const newTaskIdSet = new Set(newTaskIds);
    delete parsed.originalSpec;
    delete parsed.newTaskIds;
    // Ensure required fields have values before sending to API
    for (const t of parsed.tasks) {
      if (!t.description) t.description = t.title || 'No description';
    }
    // Resolve parentId (string task_key) → parentDbId (int FK) before persisting.
    // toApi() only writes parent_id from parentDbId; the string parentId field is
    // dropped, so without this pass new subtasks save with parent_id=NULL and
    // never appear under their parent in getChildren queries.
    for (const t of parsed.tasks) {
      if (t.parentId && t.parentDbId == null) {
        try {
          t.parentDbId = await resolveParentDbId(t.parentId);
        } catch (err) {
          console.warn(`[overwriteRaw] parent resolution failed for ${t.id}: ${err.message}`);
        }
      }
    }
    // Pre-register tags before persisting — legacy `parsed.tags` (migration JSON) + `parsed.new_tags` (objective proposals).
    // C1038: no more silent auto-registration with a placeholder description — a
    // `new_tags` entry missing its description, or a task tag not covered by `tags`/
    // `new_tags` at all, is a hard error now instead of a best-effort warning. Forces
    // the planner prompt (see client/utils.js) to always supply a real description for
    // every new tag before save, plain tags included.
    const tagRegistrations = [];
    if (Array.isArray(parsed.tags) && parsed.tags.length > 0) {
      tagRegistrations.push(...parsed.tags);
    }
    // ttHints: tag name -> architecture_hint, tt-* new_tags entries only. Never sent to
    // POST /tags (that payload stays byte-identical to before C1237) — feeds local stub
    // generation for the KB-doc-link step below instead.
    const ttHints = new Map();
    if (Array.isArray(parsed.new_tags) && parsed.new_tags.length > 0) {
      const missingDescription = parsed.new_tags.filter(t => t && t.name && !(t.description && t.description.trim()));
      if (missingDescription.length > 0) {
        throw new Error(
          `new_tags missing a description for: ${missingDescription.map(t => `"${t.name}"`).join(', ')} — ` +
          'every new tag needs a real one-line description before it can be registered.'
        );
      }
      for (const t of parsed.new_tags) {
        // C1439: trim the name — the API trims on write (api/src/routes/tags.js:104), so
        // an untrimmed push here used to register under the trimmed spelling while this
        // save's own gate matched against the padded one.
        tagRegistrations.push({ name: String(t.name).trim(), description: t.description.trim() });
        if (t.name.startsWith('tt-') && typeof t.architecture_hint === 'string' && t.architecture_hint.trim()) {
          ttHints.set(t.name, t.architecture_hint.trim());
        }
      }
    }

    // Moved up from after the POST /tags call below — same call, reused for both the
    // KB-doc-link candidate selection (C1237) and the tag gate further down.
    // C1439: _readTagRegistry() (not this.getProjectTags()) — throws TAG_REGISTRY_UNREADABLE
    // on a malformed/404 response instead of silently degrading to `[]`, so a bad read
    // can't be mistaken for "this project genuinely has zero tags" by either consumer.
    const existingTagRows = await _readTagRegistry();

    // C1237 — best-effort: link new tt-* tags to their KB doc atomically at save time.
    // Never touches the POST /tags payload (no file_key sent there — that endpoint has
    // no transaction and aborts the whole batch on one bad file_key) and never blocks
    // the save on any failure. See tag-doc-link.js and
    // ai/architecture/tt-api-backend.md § "tt-* tag ↔ KB doc linking at save (C1237)".
    let docPlan = { linkable: [], skipped: [] };
    try {
      const candidates = selectLinkCandidates(tagRegistrations, ttHints, existingTagRows);
      if (candidates.length > 0) {
        docPlan = await prepareTagDocs({
          ...getCredentials(),
          rootPath: _projectRoot || config.PROJECT_ROOT,
          candidates,
          tasks: parsed.tasks,
          buildStub,
        });
      }
    } catch (err) {
      console.warn(`[overwriteRaw] tag doc prep failed: ${err.message}`);
    }

    if (tagRegistrations.length > 0) {
      await apiRequest('POST', '/tags', { tags: tagRegistrations });
    }

    if (docPlan.linkable.length > 0) {
      try {
        const report = await linkTagDocs({ ...getCredentials(), linkable: docPlan.linkable });
        console.log(`[overwriteRaw] tag-doc link: ${report.linked.length} linked` +
          (report.failed.length ? `, ${report.failed.length} deferred (${report.failed.map(f => `${f.tag}:${f.reason}`).join(', ')})` : ''));
      } catch (err) {
        console.warn(`[overwriteRaw] tag-doc link failed: ${err.message}`);
      }
    }

    // Read current live tasks fresh — cache invalidated above, so this re-fetches.
    // Must be unfiltered — id-validation/diffing needs to see every task regardless
    // of assignee.
    //
    // C980: persistence is now targeted PATCH-per-task, never a bulk replace. The old
    // approach read live state, merged the client's full local task list on top, and
    // PUT the merged result back — PUT /tasks is a full-project bulk-replace that
    // deletes any task_key not in the payload. The "merge" only helped when this
    // save's own live-read happened to land AFTER a concurrent save's write; two
    // genuinely concurrent saves (different processes, no cross-process lock) could
    // still interleave so one's stale read missed the other's brand-new task, and the
    // bulk PUT then deleted it. PATCHing only the tasks actually touched this save
    // can never delete or clobber anything it doesn't name, regardless of staleness.
    const liveTasks = await this.getTasksUnfiltered();
    const liveById = new Map(liveTasks.map(t => [String(t.id), t]));

    // Belt-and-suspenders: deduplicate parsed.tasks by id. This guards against any
    // future upstream path that sends duplicate ids. Prefer whichever entry ISN'T an
    // echoed-back reservation placeholder — a duplicate id here almost always means one
    // entry is the still-blank row read fresh from ./TODO.md and the other is the real
    // proposed content for that same (already-reserved) key; keeping the placeholder and
    // dropping the real content silently finalizes garbage onto the row (C1378 et al).
    const parsedById = new Map();
    for (const t of parsed.tasks) {
      const key = String(t.id);
      if (parsedById.has(key)) {
        const existing = parsedById.get(key);
        const preferIncoming = existing.isReservation && !t.isReservation;
        console.warn(
          `[overwriteRaw] duplicate id "${key}" in PUT body — ` +
          `"${existing.title}" vs "${t.title}"; ` +
          (preferIncoming ? 'first (reservation) entry replaced' : 'second entry dropped') + '. ' +
          'assignIncomingNewTaskIds should have prevented this — check id assignment.'
        );
        if (preferIncoming) parsedById.set(key, t);
      } else {
        parsedById.set(key, t);
      }
    }

    // C1439: gate only the tasks this save actually PATCHes/creates, not every task
    // echoed back in `parsed.tasks` (the client's whole scoped TODO.md list) — a legacy
    // carried-over task holding a since-deleted tag used to block an unrelated save
    // before this fix (see objective-parent-task.js's `tags: []` workaround comment,
    // which predates this narrowing and remains harmless belt-and-suspenders after it).
    // selectTasksToWrite mirrors the write loop's own skip rule below exactly.
    const tasksToWrite = selectTasksToWrite(parsedById, liveById, newTaskIdSet, tasksDiffer);
    const writtenTagNames = tasksToWrite.flatMap(([, t]) => (Array.isArray(t.tags) ? t.tags : []));
    // primaryRows reuses the existingTagRows read from above (no extra network on the
    // happy path); extraKnown folds in tagRegistrations (tags/new_tags this same save
    // just registered via POST /tags) so they count as known without another round trip.
    const canonicalTagNames = await _assertTagsRegistered(writtenTagNames, {
      primaryRows: existingTagRows,
      extraKnown: tagRegistrations,
    });
    // Rewrite each written task's tags to the registry's canonical spelling — see
    // tag-registry-gate.js's resolveTagNames for why this matters (the API's own
    // resolveTagIds matches case-insensitively in SQL but then filters case-sensitively
    // in JS, so an un-rewritten case-drifted tag would still 400 downstream).
    for (const [, t] of tasksToWrite) {
      if (Array.isArray(t.tags)) t.tags = t.tags.map(n => canonicalTagNames.get(n) ?? n);
    }

    // A "new" task with no assignee must not finalize its reservation row to assignee=null
    // (the reserve route stamps the creator; the PATCH below would clear it). Mirrors
    // _finalizeChangesInner()'s stamp. Resolved once, and only when a new task needs it.
    if (newTaskIdSet.size > 0 && _currentUserId == null
      && tasksToWrite.some(([id, t]) => newTaskIdSet.has(id) && t.assignee == null)) {
      await _fetchCurrentUserId();
    }

    for (const [id, t] of tasksToWrite) {
      const liveTask = liveById.get(id);
      const isNew = newTaskIdSet.has(id);
      if (isNew && t.assignee == null) t.assignee = _currentUserId ?? null;

      if (isNew || !liveTask) {
        if (liveTask) {
          // Expected path: id is a real reservation placeholder row (booked live via
          // reserve_task_keys or a web-frontend create form) — finalize it in place.
          await this.updateTask(id, t);
        } else {
          // Defensive fallback only — assignIncomingNewTaskIds should already have
          // guaranteed every "new" id is a live row by this point. Create directly
          // rather than silently dropping the task if that guarantee ever breaks.
          console.warn(`[overwriteRaw] "new" task ${id} has no live placeholder row — creating directly`);
          await this.createTask(t);
        }
      } else {
        await this.updateTask(id, t);
      }
    }
    _cacheInvalidate();
    if (originalSpec && newTaskIds.length > 0) {
      // C1159: header the stored spec comment as reference-only — the executor agent
      // reads this comment first (spec sorts ahead of others, see base-agent.js
      // formatTaskCommentsBlock) and was eagerly implementing sibling tasks' scope
      // out of the raw objective text. Per-project language, same as agent prompts
      // (buildLanguageDirective).
      const lang = (readProjectConfig(_projectRoot) || {}).language || 'en';
      const specBody = buildSpecCommentBody(originalSpec, lang);
      await Promise.all(newTaskIds.map(async id => {
        try {
          let existing = null;
          try {
            existing = await this.getTaskComments(id);
          } catch (err) {
            console.warn(`[overwriteRaw] spec comment duplicate check failed for ${id}: ${err.message}`);
          }
          // stripSpecCommentHeader tolerates a pre-C1159 raw comment (no header) and a
          // comment posted under a different project language than this save.
          if (Array.isArray(existing) && existing.some(c => c.comment_type === 'spec' && stripSpecCommentHeader(c.content) === originalSpec)) {
            return;
          }
          const comment = await this.createTaskComment(id, specBody, 'spec');
          if (!comment) console.warn(`[overwriteRaw] spec comment failed for ${id}: task not found`);
        } catch (err) {
          console.warn(`[overwriteRaw] spec comment failed for ${id}: ${err.message}`);
        }
      }));
    }
  },

  async finalizeChanges(changes) {
    let lockKey;
    try { lockKey = `api:${getCredentials().projectId}`; } catch { lockKey = `api:${config.API_PROJECT_ID}`; }
    return withProjectLock(lockKey, async () => this._finalizeChangesInner(changes));
  },

  // NOTE: not reachable from any current UI — the live Save/Accept path is
  // overwriteRaw/overwriteRawWithRemap above, via PUT /api/todo. Kept functionally
  // consistent (same C980 fix: reserved-key validation, targeted PATCH instead of
  // bulk replace) in case something starts calling this interface method again.
  async _finalizeChangesInner(changes) {
    _syncCredentialWatch();
    // Must be unfiltered — dedup + reserved-key validation must see all project tasks
    const tasks = await this.getTasksUnfiltered();
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const idRemap = new Map();

    // Dedup: skip 'new' changes whose title+description already exist in live tasks
    const existingTitleDesc = new Map();
    for (const t of tasks) {
      existingTitleDesc.set(`${t.title}\0${t.description || ''}`, t.id);
    }
    for (const c of changes) {
      if (c.type !== 'new') continue;
      const key = `${c.task.title}\0${c.task.description || ''}`;
      const existingId = existingTitleDesc.get(key);
      if (existingId !== undefined) {
        if (c.task.id && c.task.id !== existingId) idRemap.set(c.task.id, existingId);
        c._skip = true;
      }
    }

    // C980: trust an id that's already a real, unfinalized reservation placeholder;
    // otherwise reserve a fresh one atomically. Never scan+increment local state.
    const claimedThisBatch = new Set();
    for (const c of changes) {
      if (c._skip || c.type !== 'new') continue;
      const oldId = c.task.id;
      const liveTask = oldId ? taskMap.get(oldId) : null;
      if (oldId && !claimedThisBatch.has(oldId) && isReservedPlaceholder(liveTask)) {
        claimedThisBatch.add(oldId);
        continue;
      }
      const { keys } = await this.reserveTaskKeys({
        count: 1,
        category: c.task.category === 'HUMAN' ? 'HUMAN' : 'CODING',
        priority: c.task.priority ?? 0,
      });
      claimedThisBatch.add(keys[0]);
      if (oldId) idRemap.set(oldId, keys[0]);
      c.task.id = keys[0];
    }
    if (idRemap.size > 0) {
      for (const c of changes) {
        if (Array.isArray(c.task.dependencies)) {
          c.task.dependencies = c.task.dependencies.map(dep => idRemap.get(dep) || dep);
        }
      }
    }

    // Resolve sprint assignments based on dependency graph — pass prefetched tasks to avoid a second round-trip.
    try {
      const { resolveAndAssign } = require('./sprint-assign');
      await resolveAndAssign(changes, this, config, undefined, tasks);
    } catch (err) {
      console.warn('[sprint-assign] Sprint resolution failed, keeping LLM-assigned priorities:', err.message);
    }

    // Stamp assignee on new tasks (mirrors _rawCreateTask). Resolve once per
    // finalize call; falls back to null if /me is unreachable.
    if (_currentUserId == null) await _fetchCurrentUserId();

    // C980: persist via targeted PATCH-per-change (new tasks finalize their
    // already-reserved placeholder row; modified tasks PATCH directly) instead of a
    // full bulk saveTasks(tasks) replace — a PATCH can never delete/clobber a task
    // it doesn't name, unlike the bulk-replace endpoint. `tasks`/`taskMap` are still
    // mutated in-loop purely for the same-priority-tier order computation below.
    for (const c of changes) {
      if (c._skip) continue;
      if (c.type === 'new') {
        if (c.task.assignee == null) c.task.assignee = _currentUserId ?? null;
        // C945: assign display_order = max(order in same priority tier)+1 so multiple new
        // tasks proposed into one sprint don't collide at the same order. Mirrors the
        // client preview save (chat-task-preview.js).
        // `tasks` is mutated in-loop, so sequential same-priority new tasks in this batch
        // each see the prior one and land on distinct, increasing orders.
        const samePriority = tasks.filter(t => t.priority === c.task.priority);
        const maxOrder = samePriority.length > 0 ? Math.max(...samePriority.map(t => t.order ?? 0)) : 0;
        c.task.order = maxOrder + 1;
        tasks.push(c.task);
        taskMap.set(c.task.id, c.task);
        await this.updateTask(c.task.id, c.task);
      } else if (c.type === 'modified') {
        const existing = taskMap.get(c.task.id);
        if (existing) Object.assign(existing, c.task);
        // C1165: kept consistent with the live save paths (PUT /api/todo,
        // PATCH /api/tasks/:id, apply-spec-update) even though this WS `finalize`
        // message has no current client sender — see file header note above.
        await applyReopenToPatch(this, c.task.id, c.task, 'objective-finalize');
        await this.updateTask(c.task.id, c.task);
      }
    }

    try { await ensureArchitectureDocs(tasks); } catch (err) {
      console.error('[arch-docs] stub creation failed:', err.message);
    }
  },

  // (C1407) opts.unscoped:true — Task App board's People-filter "All Tasks" mode, threaded
  // down into subtask drill-down too (the drill-down must obey the same filter the board
  // does — otherwise an objective's children would show teammates' tasks even while the
  // board itself hides them). Uncached, so no cache-key concern like getBoardTasks().
  // (TPT58) Single round trip: the /children route now returns each child's own
  // children_count/completed_children_count (same grandchildren rollup the list route
  // computes for its rows), so hasChildren is derived from the response itself instead of
  // fetching the ENTIRE unfiltered project task list just to build a parentDbIds set.
  // Back-compat fallback: an older API deployment predating this rollup returns rows with
  // no children_count field at all — detected once below and, only then, falls back to the
  // previous getTasksUnfiltered()-based enrichment so a stale server never breaks the
  // Subtasks button on a grandchild.
  async getChildren(parentKey, { unscoped = false } = {}) {
    _syncCredentialWatch();
    const data = await apiRequest(
      'GET',
      // include_reservations=true (C1017) — the board's next-id guess and any
      // in-flight subtask reservation (task-detail.js) must stay visible here too;
      // rendering hides them (template.html), same as the top-level task list.
      `/tasks/${encodeURIComponent(parentKey)}/children?include_reservations=true`
    );
    const raw = data.children || [];
    let mapped;
    if (raw.length > 0 && raw.every(t => t.children_count === undefined)) {
      // Legacy deployment without the TPT58 rollup — same enrichment getChildren() used
      // before this change.
      const allTasks = await this.getTasksUnfiltered();
      const parentDbIds = new Set(allTasks.filter(t => t.parentDbId != null).map(t => t.parentDbId));
      mapped = raw.map(t => ({ ...fromApi(t), hasChildren: parentDbIds.has(t.id) }));
    } else {
      mapped = raw.map(t => ({
        ...fromApi(t),
        hasChildren: (t.children_count || 0) > 0,
        childrenCount: t.children_count ?? null,
        completedChildrenCount: t.completed_children_count ?? null,
      }));
    }
    return unscoped ? mapped : filterToOwnOrUnassigned(mapped, _currentUserId);
  },

  async getRecipes() {
    const data = await apiRequest('GET', '/recipes');
    return (data.recipes || []).map(r => ({ filename: r.filename, content: r.content }));
  },

  async saveRecipe(content) {
    const data = await apiRequest('POST', '/recipes', { content });
    // (C1346) Non-fatal, per-project local mirror — see _localRecipesDir() above.
    try {
      const dir = _localRecipesDir();
      if (dir) {
        await recipesStore.ensureRecipesDir(dir);
        // (C1576) Thread the API-assigned filename through so the mirror matches
        // recipes.filename byte-for-byte — writeRecipe() validates it and falls back to
        // its own (now transliterated) generation when it's missing or malformed.
        await recipesStore.writeRecipe(dir, content, {
          fallbackSlug: 'objective',
          preferredFilename: data.recipe && data.recipe.filename,
        });
      }
    } catch (e) {
      console.warn('[api-backend] local recipe copy failed (non-fatal):', e.message);
    }
    return { filename: data.recipe.filename, duplicate: !!data.duplicate };
  },

  onConnectionStateChange(cb) {
    _stateListeners.add(cb);
    return () => _stateListeners.delete(cb);
  },

  getConnectionState() {
    return _connectionState;
  },

  getCredentials() {
    return getCredentials();
  },

  // (C1383) Lets a caller outside this closure (task-backend.js's factory) latch this
  // instance to 'unauthorized' without reaching into private state — used to seal a
  // freshly-constructed backend whose token is already known-dead (expired/malformed)
  // before it is ever handed back to a spawn or request path.
  markAuthCorrupted(reason) {
    let token = null;
    try { ({ token } = getCredentials()); } catch { /* missing/blank creds — token stays null */ }
    _markUnauthorized(reason, token);
  },

  // (C1383) Never throws. Local-only verdict — same check apiRequest() runs pre-flight,
  // plus the current connection latch. Used by task-backend.js's factory and by
  // ad-hoc callers that want a yes/no without triggering a network round trip.
  async validateCredentials() {
    if (_connectionState === 'unauthorized') {
      return { ok: false, reason: 'Backend is latched unauthorized', reasonCode: 'unauthorized' };
    }
    return validateCredentialsGuard(_projectRoot);
  },

  async getCurrentUserId() {
    _syncCredentialWatch();
    if (_currentUserId == null) await _fetchCurrentUserId();
    return _currentUserId;
  },

  // (C1522) Explicit identity/cache reset — nulls _currentUserId, drops every task-list
  // cache plus the status/project-settings registries. Called automatically by the
  // token-change watcher (see _tokenWatch above) and by configure()/reconfigureAndProbe()
  // on a project switch; exposed here too for a caller (IPC/ws) that knows a re-auth just
  // landed and wants the reset applied before its own next read.
  resetUserContext(reason = 'manual') {
    _resetUserContext(reason);
  },

  onMutationsDrained(cb) {
    _drainListeners.add(cb);
    return () => _drainListeners.delete(cb);
  },

  getPendingMutationCount() {
    return _pendingMutations.length;
  },

  getPendingTaskIds() {
    return [..._pendingTaskIds];
  },

  configure(cfg, projectRoot) {
    void cfg;
    if (projectRoot) _projectRoot = projectRoot;
    // (C1522) Project switch — a different project can mean a different user context
    // (status registry, vcs_*/project-settings row, AND the resolved user id itself).
    _resetUserContext('configure() — project switch');
  },

  async reconfigureAndProbe(cfg, projectRoot) {
    void cfg;
    if (projectRoot) _projectRoot = projectRoot;
    _resetUserContext('reconfigureAndProbe() — project switch'); // C1522
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    _reconnectAttempt = 0;
    _connectionState = null;
    await this.init();
    return _connectionState;
  },

  // Explicit credential-cache reset — clears the task-list cache and the 'unauthorized'
  // latch so the next API call re-reads config.json and re-probes without a full
  // reconfigureAndProbe. Useful from callers (e.g. an IPC handler) that know a new
  // token was just written but don't want to restart the backend's connection state
  // machine from scratch.
  clearCredentialCache() {
    _cacheInvalidate();
    _clearUnauthorized();
  },

  // TEST SEAM (C1346) — lets api-backend-recipes-dir.test.js assert this backend instance's
  // resolved local recipes dir (or null) without mocking the whole HTTP/apiRequest layer just
  // to reach init()/saveRecipe(). No production call site reads this directly.
  _localRecipesDir,

  // TEST SEAM (C1383) — lets auth-fail-closed.test.js drive the reconnect probe directly
  // instead of waiting on the real RECONNECT_BACKOFF_MS timer. No production call site
  // reads this directly; production always reaches _probeConnection() via _armReconnect().
  _probeConnectionForTest: _probeConnection,
  // TEST SEAM (C1383) — lets auth-fail-closed.test.js push a mutation straight into the
  // pending queue and drain it on demand, without a real ECONNREFUSED + reconnect timer
  // (which would leave a live setTimeout past test teardown). Queue state itself is
  // already readable via the public getPendingMutationCount()/getPendingTaskIds(). No
  // production call site reads these two directly.
  _enqueueMutationForTest: _enqueueMutation,
  _drainPendingMutationsForTest: _drainPendingMutations,
};

return backend;
} // end createApiBackend

// Backward-compat singleton (used by todo-server.js / MCP server).
const _singleton = createApiBackend(null);
module.exports = _singleton;
module.exports.createApiBackend = createApiBackend;
// (C1407) Pure, unit-testable — see board-assignee-scope.test.js.
module.exports.filterToOwnOrUnassigned = filterToOwnOrUnassigned;
// (C1541) Pure, unit-testable — see tasks-by-tags.test.js.
module.exports.selectResolutionCandidates = selectResolutionCandidates;
// (C1383) Re-exported for callers/tests that need to discriminate this error type —
// see auth-guard.js for the class + the fail-closed auth design.
module.exports.AuthCorruptedError = AuthCorruptedError;

// ── User-scoped device helpers (module-level, not per-project) ──
// Called from Electron main process to sync open-project state across devices.

async function fetchLastUsedOpenProjects({ apiBaseUrl, apiToken, excludeDeviceId } = {}) {
  if (!apiBaseUrl || !apiToken) return null;
  try {
    const base = apiBaseUrl.replace(/\/+$/, '');
    const qs = excludeDeviceId != null ? `?exclude_device_id=${encodeURIComponent(excludeDeviceId)}` : '';
    const res = await fetch(`${base}/api/devices/last-used-open-projects${qs}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('[api-backend] fetchLastUsedOpenProjects failed:', e.message);
    return null;
  }
}

async function patchDeviceOpenProjects({ apiBaseUrl, apiToken, deviceId, openProjectIds } = {}) {
  if (!apiBaseUrl || !apiToken || deviceId == null) return null;
  try {
    const base = apiBaseUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/api/devices/${encodeURIComponent(deviceId)}/open-projects`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ open_project_ids: openProjectIds || [] }),
    });
    if (!res.ok) {
      console.warn('[api-backend] patchDeviceOpenProjects failed:', res.status);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn('[api-backend] patchDeviceOpenProjects failed:', e.message);
    return null;
  }
}

module.exports.fetchLastUsedOpenProjects = fetchLastUsedOpenProjects;
module.exports.patchDeviceOpenProjects = patchDeviceOpenProjects;
