'use strict';

const { ipcMain, app } = require('electron');
const { getWindowState, reconfigureWindowBackend } = require('../window-state');
const serverConfig = require('../../src/server/config');
const { applyReopenToPatch } = require('../../src/server/reopen-closed-task');

let _taskAgentInfo = null;
function getAgentInfo() {
  if (_taskAgentInfo) return _taskAgentInfo;
  try {
    const { getTaskAgentInfo } = require('../../src/server/task-agent/index');
    _taskAgentInfo = getTaskAgentInfo(serverConfig.TASK_AGENT);
  } catch {
    _taskAgentInfo = { id: 'claude', label: 'Claude Code', approvalCommand: '/approve-plan', supportsPlanMode: true };
  }
  return _taskAgentInfo;
}

// C1124 — {claude,codex,pi} → display label, for summarizeAgents()'s Settings-row/Edit-
// modal summary. getTaskAgentInfo() only constructs the agent class (no spawnSync probe),
// so this is cheap and safe to compute unconditionally; labels are static, so memoized once.
let _agentLabelsCache = null;
function _agentLabels() {
  if (_agentLabelsCache) return _agentLabelsCache;
  try {
    const { getTaskAgentInfo } = require('../../src/server/task-agent/index');
    _agentLabelsCache = {
      claude: getTaskAgentInfo('claude').label,
      codex: getTaskAgentInfo('codex').label,
      pi: getTaskAgentInfo('pi').label,
    };
  } catch {
    // (C1136) 'Other Model' — must not disagree with pi-agent.js's real label if the
    // require() above ever throws and this fallback is what actually ships.
    _agentLabelsCache = { claude: 'Claude Code', codex: 'Codex', pi: 'Other Model' };
  }
  return _agentLabelsCache;
}

function b(event) {
  return getWindowState(event.sender.id).backend;
}

function registerApiHandlers() {
  // ── Tasks ────────────────────────────────────────────────────────────────────

  ipcMain.handle('api:tasks.list', async (event, opts) => {
    const backend = b(event);
    if (!backend) return [];
    if (opts && (opts.status || opts.category)) {
      try { return await backend.getTasksServerFiltered(opts); } catch { /* fall through */ }
    }
    return backend.getTasks();
  });

  // (C1259) Sprint-windowed board list — oldest sprint holding an open task onward, plus
  // backlog. `opts.extendSprints` walks the floor further back ("Load More");
  // `opts.fullWindow` fetches every sprint while searching. See
  // api-backend.js's getBoardTasks() for the { tasks, window } contract; `api:tasks.list`
  // above is left untouched so no existing caller of the unwindowed list breaks.
  // (C1407) opts.unscoped — Task App board's People-filter "All Tasks" mode. No preload
  // change needed: this handler already takes an opaque opts bag (preload.js forwards it
  // verbatim), so the new field just rides along.
  ipcMain.handle('api:tasks.board', async (event, opts) => {
    const backend = b(event);
    if (!backend) return { tasks: [], window: null };
    if (typeof backend.getBoardTasks !== 'function') return { tasks: await backend.getTasks(), window: null };
    return backend.getBoardTasks({ extendSprints: (opts && opts.extendSprints) || 0, unscoped: !!(opts && opts.unscoped), fullWindow: !!(opts && opts.fullWindow) });
  });

  // All project tasks (cross-assignee), slim key+title+status+dependencies — deps
  // typeahead (C1093: dependencies included so the client can build a dep graph and
  // filter cycle-causing candidates). (TPT59) Also carries dbId/parentDbId when present
  // — see the twin ws-handlers.js GET /api/project/tasks comment for why these are
  // conditional spreads rather than `?? null`.
  ipcMain.handle('api:tasks.listAll', async (event) => {
    const backend = b(event);
    if (!backend) return [];
    const all = await backend.getTasksUnfiltered();
    return (all || [])
      .filter(t => !t.isReservation)
      .map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
        ...(t.dbId != null ? { dbId: t.dbId } : {}),
        ...(t.parentDbId != null ? { parentDbId: t.parentDbId } : {}),
      }));
  });

  ipcMain.handle('api:tasks.get', async (event, id) => {
    const backend = b(event);
    if (!backend) return null;
    try { return await backend.getTask(id); }
    catch (err) {
      // Electron's invoke bridge serializes Error.message but drops custom statusCode.
      // Return a marker so the renderer can show its localized unavailable-task message.
      if (err.statusCode === 403) return { _taskAccessDenied: true };
      throw err;
    }
  });

  ipcMain.handle('api:tasks.create', async (event, task) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    return backend.createTask(task);
  });

  ipcMain.handle('api:tasks.update', async (event, { id, patch }) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    // Backlog signal: frontend sends sprint_id:null; normalize to priority 0
    // (mirrors the same translation in ws-handlers.js for the HTTP path).
    // tasks table has no sprint_id column — linkage is tasks.priority = sprints.number.
    if (patch && 'sprint_id' in patch && patch.sprint_id === null) {
      patch = { ...patch, priority: 0 };
      delete patch.sprint_id;
    }
    // C1165: objective-chat's absent-target PATCH fallback (buildModifiedTaskPatch)
    // sets this flag instead of a status when the proposal carried none — reopen a
    // completed/canceled target to in_progress. This IPC route is what the Electron
    // app actually uses for api.tasks.update (api-client.js), so the HTTP-only fix in
    // ws-handlers.js's PATCH /api/tasks/:id never fires for the desktop app — this is
    // the primary path there, not a fallback. The flag must never reach backend.updateTask —
    // it is a client-only directive, not a real task field the API understands.
    if (patch && patch.reopen_if_closed) {
      patch = { ...patch };
      delete patch.reopen_if_closed;
      await applyReopenToPatch(backend, id, patch, 'chat-patch-ipc');
    }
    const updateResult = await backend.updateTask(id, patch);
    if (!updateResult) return null;
    const fresh = (await backend.getTask(id)) || updateResult;
    // The main process has no initialized WebSocket server. Its one window per project
    // receives this update from the return value; external edits arrive via task-change-poll.
    // Preserve parentRescheduled from PATCH when rereading the fresh task.
    if (updateResult._parentRescheduled) fresh.parentRescheduled = updateResult._parentRescheduled;
    return fresh;
  });

  ipcMain.handle('api:tasks.delete', async (event, id) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    // (C1269) No broadcast needed — see the invariant note on api:tasks.update above.
    return backend.deleteTask(id);
  });

  ipcMain.handle('api:tasks.saveAll', async (event, tasks) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    return backend.saveTasks(tasks);
  });

  // (C1407) Second arg widened from a bare parentKey string to { parentKey, opts } so the
  // People-filter "All Tasks" mode (opts.unscoped) can thread through subtask drill-down
  // too. A bare string is still accepted (typeof check) — defensive, single caller today
  // (template.html's fetchBoardWindow) but this is a public preload-bridge signature.
  ipcMain.handle('api:tasks.children', async (event, arg) => {
    const backend = b(event);
    if (!backend) return [];
    const parentKey = typeof arg === 'string' ? arg : arg && arg.parentKey;
    const opts = typeof arg === 'string' ? undefined : arg && arg.opts;
    return backend.getChildren(parentKey, opts);
  });

  ipcMain.handle('api:tasks.overwriteRaw', async (event, content) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    return backend.overwriteRaw(content);
  });

  ipcMain.handle('api:tasks.finalizeChanges', async (event, changes) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    return backend.finalizeChanges(changes);
  });

  ipcMain.handle('api:tasks.tokenUsage', async (event, { taskKey, tokens }) => {
    const backend = b(event);
    if (!backend) return;
    return backend.addTokenUsage(taskKey, tokens);
  });

  ipcMain.handle('api:tasks.comments.list', async (event, taskKey) => {
    const backend = b(event);
    if (!backend) return [];
    return backend.getTaskComments(taskKey);
  });

  ipcMain.handle('api:tasks.comments.create', async (event, { taskKey, content, type }) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    return backend.createTaskComment(taskKey, content, type);
  });

  // TPT34 — author-only comment edit; a mismatched-author 403 rides through as a thrown
  // Error (see api-backend.js's updateTaskComment + apiRequest allowForbidden branch).
  ipcMain.handle('api:tasks.comments.update', async (event, { taskKey, commentId, content }) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    return backend.updateTaskComment(taskKey, commentId, content);
  });

  // TPT17 — Notifications tab: task-wide event log + subscription toggle
  ipcMain.handle('api:tasks.events.list', async (event, taskKey) => {
    const backend = b(event);
    if (!backend) return { events: [], total: 0, subscribed: true };
    return backend.getTaskEvents(taskKey);
  });

  ipcMain.handle('api:tasks.events.setSubscription', async (event, { taskKey, subscribed }) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    return backend.setTaskSubscription(taskKey, subscribed);
  });

  // ── Tags ─────────────────────────────────────────────────────────────────────

  ipcMain.handle('api:tags.list', async (event) => {
    const backend = b(event);
    if (!backend) return [];
    return backend.getTags();
  });

  ipcMain.handle('api:tags.listDetailed', async (event) => {
    const backend = b(event);
    if (!backend) return [];
    return backend.getTagsDetailed();
  });

  ipcMain.handle('api:tags.listProject', async (event) => {
    const backend = b(event);
    if (!backend) return [];
    return backend.getProjectTags();
  });

  ipcMain.handle('api:tags.ensure', async (event, { name, description }) => {
    const backend = b(event);
    if (!backend) return;
    return backend.ensureTag(name, description);
  });

  // ── Sprints ──────────────────────────────────────────────────────────────────

  ipcMain.handle('api:sprints.list', async (event) => {
    const backend = b(event);
    if (!backend) return [];
    return backend.getSprints();
  });

  ipcMain.handle('api:sprints.create', async (event, { name, number }) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    return backend.createSprint(name, number);
  });

  // ── Members ──────────────────────────────────────────────────────────────────

  ipcMain.handle('api:members.list', async (event) => {
    const backend = b(event);
    if (!backend) return [];
    return backend.getProjectMembers();
  });

  // ── Statuses (C1184) ─────────────────────────────────────────────────────────

  ipcMain.handle('api:statuses.list', async (event) => {
    const backend = b(event);
    if (!backend || typeof backend.getStatuses !== 'function') return [];
    return backend.getStatuses();
  });

  // C1235 — per-window project settings (task_group_label, + color_scheme since C1305).
  // Must go through the per-window backend `b(event)`, not the HTTP proxy route in
  // ws-handlers.js — that route reads the forked server's process-global backend, wrong
  // project in a multi-window Electron session (same reasoning api:statuses.list above
  // already follows). Keep this shape identical to ws-handlers.js's GET /api/project/settings.
  ipcMain.handle('api:project.settings', async (event) => {
    const backend = b(event);
    const project = backend && typeof backend.getProjectSettings === 'function' ? await backend.getProjectSettings() : null;
    return {
      taskGroupLabel: project?.task_group_label || 'Batches',
      colorScheme: project?.color_scheme || 'default',
      // C1332 — sprints_enabled, kept identical to ws-handlers.js's GET /api/project/settings.
      sprintsEnabled: project?.sprints_enabled === undefined || project?.sprints_enabled === null
        ? true : !!project.sprints_enabled,
      // C1490 — kb_sync_as_you_go, kept identical to ws-handlers.js's GET /api/project/settings.
      kbSyncAsYouGo: project?.kb_sync_as_you_go === undefined || project?.kb_sync_as_you_go === null
        ? true : !!project.kb_sync_as_you_go,
      // C1558 — use_objective_grouping, kept identical to ws-handlers.js's GET /api/project/settings.
      useObjectiveGrouping: project?.use_objective_grouping === undefined || project?.use_objective_grouping === null
        ? true : !!project.use_objective_grouping,
      // C1577 — sprint_sort_order, kept identical to ws-handlers.js's GET /api/project/settings.
      sprintSortOrder: project?.sprint_sort_order === 'desc' ? 'desc' : 'asc',
      // TPT61 — vcs_type/vcs_*_enabled, kept identical to ws-handlers.js's GET
      // /api/project/settings (raw stored values, not normalizeVcsSettings()-masked — see
      // that route's comment for why).
      vcsType: project?.vcs_type === 'git' || project?.vcs_type === 'svn' ? project.vcs_type : null,
      vcsWorktreeEnabled: !!project?.vcs_worktree_enabled,
      vcsCommitEnabled: !!project?.vcs_commit_enabled,
      vcsPrEnabled: !!project?.vcs_pr_enabled,
      vcsMergeEnabled: !!project?.vcs_merge_enabled,
    };
  });

  // C1271 — per-window project write (language/task_group_label), same per-window
  // `b(event)` reasoning as api:project.settings above — the HTTP proxy in
  // ws-handlers.js resolves the forked server's process-global backend, wrong project in
  // a multi-window Electron session. A backend.updateProject() failure surfaces as a
  // rejected IPC promise the renderer already handles (same as api:statuses.create etc).
  ipcMain.handle('api:project.update', async (event, { fields }) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    const project = await backend.updateProject(fields);
    return { project };
  });

  // TPT12 — the caller's per-project `notifications` inbox rows (activity chip + OS push).
  // Same per-window `b(event)` reasoning as api:project.settings above — the HTTP proxy in
  // ws-handlers.js resolves the forked server's process-global backend, wrong project in a
  // multi-window Electron session.
  ipcMain.handle('api:project.notifications.list', async (event, params) => {
    const backend = b(event);
    if (!backend || typeof backend.getNotifications !== 'function') return { notifications: [], unread_count: 0, total: 0 };
    return backend.getNotifications(params || {});
  });

  ipcMain.handle('api:project.notifications.markRead', async (event, { ids }) => {
    const backend = b(event);
    const list = Array.isArray(ids) ? ids : [];
    if (!backend || typeof backend.markNotificationRead !== 'function' || list.length === 0) {
      return { read: 0, results: [] };
    }
    const settled = await Promise.allSettled(list.map((id) => backend.markNotificationRead(id)));
    const results = settled.map((s, i) => ({ id: list[i], ok: s.status === 'fulfilled' && s.value != null }));
    return { read: results.filter((r) => r.ok).length, results };
  });

  // C1182 — Workflow tab CRUD (add/rename/recolor/delete/reorder + move a role).
  ipcMain.handle('api:statuses.create', async (event, fields) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    return backend.createStatus(fields);
  });

  ipcMain.handle('api:statuses.update', async (event, { id, fields }) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    return backend.updateStatus(id, fields);
  });

  ipcMain.handle('api:statuses.remove', async (event, id) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    await backend.deleteStatus(id);
    return { ok: true };
  });

  ipcMain.handle('api:statuses.reorder', async (event, ids) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    return backend.reorderStatuses(ids);
  });

  // ── Recipes ──────────────────────────────────────────────────────────────────

  ipcMain.handle('api:recipes.list', async (event) => {
    const backend = b(event);
    if (!backend) return [];
    return backend.getRecipes();
  });

  ipcMain.handle('api:recipes.save', async (event, content) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    return backend.saveRecipe(content);
  });

  // ── Images ───────────────────────────────────────────────────────────────────

  ipcMain.handle('api:images.upload', async (event, { filename, mimeType, data, taskKey }) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    return backend.uploadImage(filename, mimeType, data, taskKey || null);
  });

  // C1246 — task_files generic attachment upload
  ipcMain.handle('api:files.upload', async (event, { filename, mimeType, data, taskKey }) => {
    const backend = b(event);
    if (!backend) throw new Error('No project loaded');
    return backend.uploadFile(filename, mimeType, data, taskKey || null);
  });

  // ── User / connection status (api backend only) ───────────────────────────────

  ipcMain.handle('api:connection.state', async (event) => {
    const backend = b(event);
    if (!backend || typeof backend.getConnectionState !== 'function') return 'connected';
    return backend.getConnectionState();
  });

  // One real round-trip against the API before the renderer forces the reauth wizard. An
  // 'unauthorized' latch can outlive its cause (a one-off 401/403 on a token that is in fact
  // fine); init() bypasses the latch guard, and on success emits 'connected' itself. Returns
  // the resulting state — the wizard opens only if it is still 'unauthorized'.
  ipcMain.handle('api:connection.reverify', async (event) => {
    const backend = b(event);
    if (!backend || typeof backend.getConnectionState !== 'function') return 'connected';
    if (backend.getConnectionState() === 'unauthorized' && typeof backend.init === 'function') {
      try { await backend.init(); } catch { /* network etc. — report whatever state results */ }
    }
    return backend.getConnectionState();
  });

  ipcMain.handle('api:connection.pendingCount', async (event) => {
    const backend = b(event);
    if (!backend || typeof backend.getPendingMutationCount !== 'function') return 0;
    return backend.getPendingMutationCount();
  });

  // ── GUI reauth: write new project config + hot-swap the backend without restart ────
  ipcMain.handle('api:auth.reauth-save', async (event, { config }) => {
    const { readProjectConfig, mergeRendererProjectConfig } = require('../../src/server/project-config');
    const st = getWindowState(event.sender.id);
    const existing = readProjectConfig(st.projectPath) || st.config || {};
    const merged = mergeRendererProjectConfig(existing, config, { allowApiToken: true });
    const newState = await reconfigureWindowBackend(event.sender.id, merged);
    // Ensure caveman global plugin installed + statusline wired (best-effort, non-fatal).
    try {
      const { projectPath } = getWindowState(event.sender.id);
      if (projectPath) {
        const { runCavemanPluginStep } = require('../../src/cli/plugin-install');
        await runCavemanPluginStep(projectPath);
      }
    } catch (e) {
      console.warn('[caveman-plugin] reauth-save install failed:', e.message);
    }
    return { ok: true, state: newState };
  });

  // ── Current window's bound project config (used by the reauth modal) ───────────────
  ipcMain.handle('api:project.config', async (event) => {
    const st = getWindowState(event.sender.id);
    if (!st.projectPath) return null;
    // C1124 — re-read from disk instead of trusting the cached windowState.config, which
    // goes stale after any write that bypasses mergeConfig/reconfigureWindowBackend (e.g.
    // the forked server's own POST /api/config for AVAILABLE_AGENTS/CLAUDE_MODEL/etc.).
    // Also heals the cache for subsequent mergeConfig() merges. summarizeAgents() adds the
    // Settings "Agents" row summary — see project-config.js.
    const { readProjectConfig, summarizeAgents, rendererProjectConfig } = require('../../src/server/project-config');
    const fresh = readProjectConfig(st.projectPath);
    if (fresh) st.config = fresh;
    const config = fresh || st.config || {};
    return { projectPath: st.projectPath, config: rendererProjectConfig(config), agents: summarizeAgents(config, _agentLabels()) };
  });

  // ── Lightweight partial settings write ──────────────────────────────────────
  // Does not rebind the backend. Credential changes here use explicit key actions.
  ipcMain.handle('api:project.mergeConfig', async (event, { partial }) => {
    const { readProjectConfig, writeProjectConfig, mergeRendererProjectConfig } = require('../../src/server/project-config');
    const st = getWindowState(event.sender.id);
    if (!st.projectPath) return { ok: false, error: 'no project' };
    const existing = readProjectConfig(st.projectPath) || st.config || {};
    const merged = mergeRendererProjectConfig(existing, partial);
    writeProjectConfig(st.projectPath, merged);
    st.config = merged;
    // (C1202) This IS the packaged app's voice-settings save path (Settings > Voice writes
    // here, not through ws-handlers.js's POST /api/project-config — that route only serves
    // browser-mode). Fire-and-forget ping the forked server so switching TO local pre-warms
    // ensureRecognizer()/ensureVadModelReady() instead of paying the ~650MB ORT session build
    // cost lazily inside the user's first recording. Never awaited, never thrown — a failed
    // ping just means the first recording pays the cost it always used to pay.
    if (('voicePreset' in partial || 'voiceLocalModel' in partial) && merged.voicePreset === 'local' && merged.voiceLocalModel) {
      fetch(`http://127.0.0.1:${serverConfig.PORT}/api/voice-prewarm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tipatask-project': st.projectPath },
        body: JSON.stringify({ modelId: merged.voiceLocalModel }),
      }).catch(() => {});
    }
    return { ok: true };
  });

  // (C1259) { enabled, path } for the Settings ▸ Debug row's "open log" affordance —
  // Electron counterpart of GET /api/debug/perf.
  ipcMain.handle('api:debug.perfLogInfo', async (event) => {
    const st = getWindowState(event.sender.id);
    const { readProjectConfig } = require('../../src/server/project-config');
    const cfg = (st.projectPath && readProjectConfig(st.projectPath)) || st.config || {};
    const path = require('node:path');
    // Use Electron userData for perf logs. serverConfig.USER_DATA_ROOT can refer
    // to the checkout in dev or app.asar before packaged main env setup; userData
    // is writable and independent of module initialization order.
    const logPath = path.join(app.getPath('userData'), 'logs', `perf-${new Date().toISOString().slice(0, 10)}.log`);
    return { enabled: !!cfg.debugPerfLog, path: logPath };
  });

  // (C1259) Debug ▸ click-to-render perf log (src/client/perf-log.js) — Electron
  // counterpart of ws-handlers.js's POST /api/debug/perf. Same contract: gated on the
  // current window's own debugPerfLog flag (silent no-op when off), appends NDJSON to
  // USER_DATA_ROOT/logs/perf-YYYY-MM-DD.log — machine-wide, not per-project, like the
  // voice-model store.
  ipcMain.handle('api:debug.perfLog', async (event, entries) => {
    const st = getWindowState(event.sender.id);
    if (!st.projectPath || !Array.isArray(entries) || entries.length === 0) return { ok: true, written: 0 };
    const { readProjectConfig } = require('../../src/server/project-config');
    const cfg = readProjectConfig(st.projectPath) || st.config || {};
    if (!cfg.debugPerfLog) return { ok: true, written: 0 };
    const fs = require('node:fs/promises');
    const path = require('node:path');
    // (C1284 fix) See the identical comment on perfLogInfo above — app.getPath('userData'),
    // not serverConfig.USER_DATA_ROOT.
    const logPath = path.join(app.getPath('userData'), 'logs', `perf-${new Date().toISOString().slice(0, 10)}.log`);
    try {
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      const lines = entries.map(e => JSON.stringify({ ...e, loggedAt: new Date().toISOString() })).join('\n') + '\n';
      await fs.appendFile(logPath, lines, 'utf8');
      return { ok: true, written: entries.length, path: logPath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Agents Edit-modal save (C1124) ──────────────────────────────────────────────
  // One atomic write for TASK_AGENT/AVAILABLE_AGENTS/PI_MODELS/CLAUDE_MODEL/CODEX_MODEL
  // together, replacing the old per-field POST /api/config round trips whose partial
  // writes (plus an unrelated server bug) could crash the whole app mid-save. Deliberately
  // does NOT call reconfigureWindowBackend() — that's a wholesale config rewrite + .mcp.json/
  // skills/codex-config rewrite + backend re-probe, none of which an agent-selection change
  // needs (same reasoning as the mergeConfig() 'theme' write above; the backend cache's own
  // _sig() only covers TASK_BACKEND/API_* fields anyway).
  ipcMain.handle('api:project.saveAgents', async (event, { selection }) => {
    const { readProjectConfig, writeProjectConfig, buildAgentsConfigPatch, summarizeAgents } = require('../../src/server/project-config');
    const st = getWindowState(event.sender.id);
    if (!st.projectPath) return { ok: false, error: 'no project' };
    try {
      const existing = readProjectConfig(st.projectPath) || st.config || {};
      const merged = buildAgentsConfigPatch(existing, selection);
      writeProjectConfig(st.projectPath, merged);
      st.config = merged;
      return { ok: true, agents: summarizeAgents(merged, _agentLabels()) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── User / agent config ───────────────────────────────────────────────────────

  ipcMain.handle('api:config.user', async (event) => {
    const { config, backend } = getWindowState(event.sender.id);
    const agent = getAgentInfo();
    let id = serverConfig.USER_ID;
    if (backend && typeof backend.getCurrentUserId === 'function') {
      try { id = await backend.getCurrentUserId(); } catch { /* keep config fallback */ }
    }
    return {
      id,                // client (template.html → state.currentUser.id) reads this
      userId: id,        // back-compat
      userName: serverConfig.USER_NAME,
      avatarUrl: serverConfig.USER_AVATAR_URL || null,
      taskAgent: agent.id,
      taskAgentLabel: agent.label,
      planApprovalCommand: agent.approvalCommand,
      supportsPlanMode: agent.supportsPlanMode,
      taskBackend: (config && config.TASK_BACKEND) || serverConfig.TASK_BACKEND,
    };
  });
}

module.exports = { registerApiHandlers };
