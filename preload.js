'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function inv(channel, ...args) { return ipcRenderer.invoke(channel, ...args); }

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  onSystemResume: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('tiptask:system-resume', handler);
    return () => ipcRenderer.removeListener('tiptask:system-resume', handler);
  },

  // ── Project identity (bound to this window for its lifetime) ─────────────────
  getProjectPath: () => new URLSearchParams(location.search).get('projectPath') || null,

  // ── Workspace & project IPC ───────────────────────────────────────────────────
  // (C1388) onProjectSelectRequested removed — 'project:select-requested' had a live
  // listener in template.html but no sender anywhere in main.js (dead channel, part
  // of C1388's §E). _showProjectModal, its only consumer, is still driven by the
  // 'project-created' DOM event fired after the create wizard completes.
  openProject: (dir, target) => inv('project:open', { dir, target }),
  openProjectDialog: () => inv('project:open-dialog'),
  selectFolder: () => inv('dialog:selectFolder'),
  getCurrentProject: () => inv('project:get-current'),
  onProjectChanged: (cb) => ipcRenderer.on('project:changed', (_, dir, name) => cb(dir, name)),
  // (C1389, payload widened C1559/TPT16) Web→Task App handoff, planning branch — main.js's
  // focusAndSeedObjective() pushes this after /start-task (server child) has fully
  // validated project+account+task and main has focused/created the window. Payload:
  // { taskKey, warning, originTaskKey, title, description }.
  onOpenObjective: (cb) => ipcRenderer.on('open-objective', (_, payload) => cb(payload)),
  // (C1559) Sibling of onOpenObjective for the /start-task route's other 2 dispatch
  // branches (is_objective-with-children / regular task) — main.js's focusAndStartTask()
  // pushes this. Payload: { taskKey, children }.
  onStartTask: (cb) => ipcRenderer.on('start-task', (_, payload) => cb(payload)),
  onProjectMenu: (cb) => ipcRenderer.on('project:menu', (_, action) => cb(action)),
  onForceReauth: (cb) => ipcRenderer.on('force-reauth', (_e) => cb()),
  closeCurrentProject: () => inv('project:close'),
  closeProject: (p) => inv('project:remove', p),
  switchProject: (p) => inv('project:focus-window', p),
  focusProjectWindow: (p) => inv('project:focus-window', p),
  renameProject: (name) => inv('project:rename', { name }),
  loadWorkspace: () => inv('load-workspace'),
  saveWorkspace: (state) => inv('save-workspace', state),
  onWorkspaceLoaded: (cb) => ipcRenderer.on('workspace-loaded', (_, state) => cb(state)),
  pickAndOpenProject: () => inv('open-project'),
  openSetupWindow: (p) => inv('project:open-setup-window', p),
  onSetupOpenForPath: (cb) => ipcRenderer.on('setup:open-for-path', (_, p) => cb(p)),
  focusSelf: () => inv('window:focus-self'),
  notificationDelivery: 'desktop',
  // App-owned desktop notification transport — see notifications.js#_electronNotify.
  notify: (payload) => inv('notify:show', payload),
  dismissTaskNotifications: (taskId) => inv('notify:dismiss-task', { taskId }),
  // (TPT484) Shared alert registry: in-app cards mirror into main (one identity per project +
  // tag), and main decides which surface shows them — this window's in-app panel while it is
  // the focused project window, the always-on-top banner otherwise. See notification-center.js.
  pushSharedNotification: (card) => inv('notify:card', card),
  dismissSharedNotification: (tag) => inv('notify:dismiss', { tag }),
  notificationSurfaceState: () => inv('notify:surface-state'),
  onNotificationSurface: (cb) => {
    const handler = (_, state) => cb(state);
    ipcRenderer.on('notify:surface', handler);
    return () => ipcRenderer.removeListener('notify:surface', handler);
  },
  notificationSurfaceAction: (action, id) => ipcRenderer.send('notify:surface-action', { action, id }),
  setNotificationTheme: (tokens) => ipcRenderer.send('notify:theme', tokens),
  // (TPT487) "Show on Top": on keeps the desktop stack, off sends native OS notifications.
  // App-level (main persists it, set from View ▸ Notifications or the banner's "Show" box,
  // TPT505); every project window hears changes.
  onNotificationsOnTopChanged: (cb) => {
    const handler = (_, state) => cb(state);
    ipcRenderer.on('notify:on-top-changed', handler);
    return () => ipcRenderer.removeListener('notify:on-top-changed', handler);
  },
  // (C1125) One-shot check of whether this bundle is code-signed — an unsigned bundle never
  // gets a Notification Center registration on macOS, so notify:show can silently drop every
  // banner while still resolving `{ok:true}`. See main.js's notify:status handler.
  notifyStatus: () => inv('notify:status'),
  // (C1355) On-demand LaunchServices re-register from the Settings "Repair" button — see
  // main.js's notify:repair-registration handler.
  notifyRepairRegistration: () => inv('notify:repair-registration'),
  // (C1202) OS-level mic permission (TCC), separate from the in-page getUserMedia() prompt —
  // see main.js's voice:mic-access-status/voice:request-mic-access handlers.
  micAccessStatus: () => inv('voice:mic-access-status'),
  requestMicAccess: () => inv('voice:request-mic-access'),
  // (C1210) Main-process route for the global voice shortcut. The renderer's own in-page keydown
  // listener never fires in the packaged app — the combo is claimed by the OS itself before any
  // application's document ever sees the keydown (see tt-audio-input.md § Keyboard Shortcut,
  // C1210) — so it's ALSO owned by the app menu (main.js's "Start / Stop Voice Input" item),
  // which sends this on click/accelerator. index.js subscribes once at boot.
  onVoiceShortcut: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('voice:shortcut', handler);
    return () => ipcRenderer.removeListener('voice:shortcut', handler);
  },
  // (C1069) Payload: { taskId, tag, windowId, projectPath }. windowId/projectPath name the
  // window/project that RAISED the notif, not necessarily this one — main.js routes the click
  // to whichever window owns that project NOW (see main.js resolveNotifyTarget). notifications.js
  // compares projectPath against getProjectPath() before running a click handler.
  onNotificationDismiss: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on('notify:dismissed', handler);
    return () => ipcRenderer.removeListener('notify:dismissed', handler);
  },
  onNotificationClick: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on('notify:clicked', handler);
    return () => ipcRenderer.removeListener('notify:clicked', handler);
  },
  // (TPT480) Full desktop-notification list shown in this window after the banner's
  // "Show More". cb(type, entries): type is 'open' | 'update' | 'close'. Actions go back to
  // main's controller (main/desktop-notifications.js), which only accepts the current owner.
  onDesktopNotificationList: (cb) => {
    const open = (_, entries) => cb('open', entries);
    const update = (_, entries) => cb('update', entries);
    const close = () => cb('close', []);
    ipcRenderer.on('notify:desktop-list-open', open);
    ipcRenderer.on('notify:desktop-list', update);
    ipcRenderer.on('notify:desktop-list-close', close);
    return () => {
      ipcRenderer.removeListener('notify:desktop-list-open', open);
      ipcRenderer.removeListener('notify:desktop-list', update);
      ipcRenderer.removeListener('notify:desktop-list-close', close);
    };
  },
  desktopNotificationListAction: (action, id) => ipcRenderer.send('notify:desktop-list-action', { action, id }),
  saveProjectConfig: (projectRoot, config) => inv('save-project-config', { projectRoot, config }),
  openExternal: (url) => inv('open-external', url),
  revealPerfLog: () => inv('debug:reveal-perf-log'),
  openNotificationSettings: () => inv('settings:open-notifications'),
  // opts.chooseAccount — ask the web sign-in page for an account chooser (Change Account flow).
  setupAuthWeb: (apiBaseUrl, opts) => inv('setup:auth-web', { apiBaseUrl, chooseAccount: !!(opts && opts.chooseAccount) }),
  setupListProjects: (apiBaseUrl, userToken) => inv('setup:list-projects', { apiBaseUrl, userToken }),
  setupGetDeviceName: (apiBaseUrl, userToken) => inv('setup:get-device-name', { apiBaseUrl, userToken }),
  setupExchangeProjectToken: (apiBaseUrl, userToken, projectId) => inv('setup:exchange-project-token', { apiBaseUrl, userToken, projectId }),
  setupGetAvailableAgents: (force) => inv('setup:get-available-agents', force),
  // One-shot re-auth skipping project-pick: OAuth + token exchange + config write + re-probe,
  // all in the main process. Returns { ok, state?, error? }.
  setupForceReauth: (projectPath) => inv('setup:force-reauth', projectPath),
  completeProjectWizard: (detail) => inv('project:create-from-wizard', detail),
  openExistingProject: (detail) => inv('project:open-existing', detail),
  // (C1388) Native-menu locale follow — see main/menu-i18n.js. Pushed from
  // applyProjectLanguage()/writeProjectLanguage() (task-board.js).
  setAppLocale: (lang) => inv('app:set-locale', lang),

  // ── Data API (replaces fetch → Express; each call is per-window scoped) ───────
  api: {
    tasks: {
      list:              (opts)          => inv('api:tasks.list', opts),
      board:             (opts)          => inv('api:tasks.board', opts), // (C1259) sprint-windowed board list — { tasks, window }
      get:               (id)            => inv('api:tasks.get', id),
      create:            (task)          => inv('api:tasks.create', task),
      update:            (id, patch)     => inv('api:tasks.update', { id, patch }),
      delete:            (id)            => inv('api:tasks.delete', id),
      saveAll:           (tasks)         => inv('api:tasks.saveAll', tasks),
      children:          (parentKey, opts) => inv('api:tasks.children', { parentKey, opts }), // (C1407) opts.unscoped — People-filter "All Tasks" mode
      overwriteRaw:      (content)       => inv('api:tasks.overwriteRaw', content),
      finalizeChanges:   (changes)       => inv('api:tasks.finalizeChanges', changes),
      addTokenUsage:     (taskKey, tok)  => inv('api:tasks.tokenUsage', { taskKey, tokens: tok }),
      listAll:           ()              => inv('api:tasks.listAll'),
    },
    comments: {
      list:   (taskKey)              => inv('api:tasks.comments.list', taskKey),
      create: (taskKey, content, type) => inv('api:tasks.comments.create', { taskKey, content, type }),
      update: (taskKey, commentId, content) => inv('api:tasks.comments.update', { taskKey, commentId, content }),
    },
    events: {
      list:            (taskKey)            => inv('api:tasks.events.list', taskKey),
      setSubscription: (taskKey, subscribed) => inv('api:tasks.events.setSubscription', { taskKey, subscribed }),
    },
    tags: {
      list:        ()               => inv('api:tags.list'),
      listDetailed:()               => inv('api:tags.listDetailed'),
      listProject: ()               => inv('api:tags.listProject'),
      ensure:      (name, desc)     => inv('api:tags.ensure', { name, description: desc }),
    },
    sprints: {
      list:   ()                    => inv('api:sprints.list'),
      create: (name, number)        => inv('api:sprints.create', { name, number }),
    },
    members: {
      list: ()                      => inv('api:members.list'),
    },
    debug: {
      // (C1259) Click-to-render perf logging — see src/client/perf-log.js and
      // main/ipc/api-router.js's api:debug.perfLog(Info) handlers.
      perfLog:     (entries)         => inv('api:debug.perfLog', entries),
      perfLogInfo: ()                => inv('api:debug.perfLogInfo'),
    },
    statuses: {
      list:    ()                   => inv('api:statuses.list'),
      create:  (fields)             => inv('api:statuses.create', fields),
      update:  (id, fields)         => inv('api:statuses.update', { id, fields }),
      remove:  (id)                 => inv('api:statuses.remove', id),
      reorder: (ids)                => inv('api:statuses.reorder', ids),
    },
    recipes: {
      list:  ()                     => inv('api:recipes.list'),
      save:  (content)              => inv('api:recipes.save', content),
    },
    images: {
      upload: (filename, mimeType, data, taskKey) => inv('api:images.upload', { filename, mimeType, data, taskKey }),
    },
    files: {
      upload: (filename, mimeType, data, taskKey) => inv('api:files.upload', { filename, mimeType, data, taskKey }),
    },
    connection: {
      state:        () => inv('api:connection.state'),
      pendingCount: () => inv('api:connection.pendingCount'),
      reverify:     () => inv('api:connection.reverify'),
      onChanged: (cb) => {
        const handler = (_, payload) => cb(payload);
        ipcRenderer.on('api:connection:changed', handler);
        return () => ipcRenderer.removeListener('api:connection:changed', handler);
      },
    },
    auth: {
      reauthSave: (config) => inv('api:auth.reauth-save', { config }),
    },
    project: {
      config: () => inv('api:project.config'),
      mergeConfig: (partial) => inv('api:project.mergeConfig', { partial }),
      // (C1124) One atomic TASK_AGENT/AVAILABLE_AGENTS/PI_MODELS/CLAUDE_MODEL/CODEX_MODEL
      // write from the Settings "Edit Agents" modal — see agents-modal.js.
      saveAgents: (selection) => inv('api:project.saveAgents', { selection }),
      // (C1235) Project scalars from the remote API row (today: taskGroupLabel).
      settings: () => inv('api:project.settings'),
      // (C1271) Write project scalars (language/task_group_label) — per-window backend,
      // see api-router.js's api:project.update.
      update: (fields) => inv('api:project.update', { fields }),
      // TPT12 — the caller's per-project `notifications` inbox rows, per-window backend.
      notifications: {
        list: (params) => inv('api:project.notifications.list', params),
        markRead: (ids) => inv('api:project.notifications.markRead', { ids }),
      },
    },
    config: {
      user: () => inv('api:config.user'),
    },
  },

  // ── Push events from main process ─────────────────────────────────────────────
  on: {
    taskCreated:   (cb) => ipcRenderer.on('task:created',        (_, p) => cb(p)),
    taskUpdated:   (cb) => ipcRenderer.on('task:updated',        (_, p) => cb(p)),
    taskDeleted:   (cb) => ipcRenderer.on('task:deleted',        (_, p) => cb(p)),
    tasksFinalized:(cb) => ipcRenderer.on('tasks:finalized',     (_, p) => cb(p)),
    apiStatus:     (cb) => ipcRenderer.on('api-status',          (_, p) => cb(p)),
    agentData:     (cb) => ipcRenderer.on('agent:data',          (_, p) => cb(p)),
    agentState:    (cb) => ipcRenderer.on('agent:state',         (_, p) => cb(p)),
    agentExit:     (cb) => ipcRenderer.on('agent:exit',          (_, p) => cb(p)),
    agentPlanReady:(cb) => ipcRenderer.on('agent:plan-ready',    (_, p) => cb(p)),
  },
});
