// ── Application state ──
// Exported as a mutable object so that both bundle modules
// and the inline <script> in template.html share the same reference.

const state = {
  // Latest project-scoped merge scan; null until successfully loaded.
  taskMergeStatus: null,
  // Navigation
  activeTab: 'board', // 'board' | 'list' | 'todo' | 'backlog' | 'objective' | 'new_task'
  todoDrawerTaskId: null,
  todoSprintPriority: null,
  mobileMenuOpen: false,
  subtaskStack: [], // [{ taskKey, title }, …]  empty = root, last = current subtask context
  subtaskParentTask: null, // (C1461) full parent task object for .parent-task-pane — fetched
                            // alongside a drill-down; null when at root OR fetch failed
  // (C1462) One tab per objective with a started subtask session — additive-until-closed
  // (only C1463's close-button ever removes an entry; C1462 only FIFO-evicts at the cap and
  // clears the list on project switch). [{ parentKey, parentDbId, title }, …]
  objectiveTabs: [],

  // Manual task creation
  // (C1245) full field parity w/ task edit modal: { title, description, priority,
  // type, category, status, agentAssignee, assignee, claudeModel, codexModel,
  // piModel, claudeDesignMode, dependencies, tags, phase: 'form' | 'preview', previewTask }
  manualTaskState: null,

  // Search
  searchQuery: '',

  // Current user (bridged from template.html after /api/user fetch)
  currentUser: null,
  currentUserAvatar: null,
  // Numeric user id from board WS config; null in file mode — guards Start button assignee check
  currentUserId: null,
  // Human-readable project name, fed by the board WS `config` frame (C1137) — used to
  // disambiguate OS notification titles across multiple open Electron project windows.
  projectName: '',
  taskAgent: 'claude',
  taskAgentLabel: 'Claude Code',
  // C1285 — canonical id -> display label map from the task-agent registry. The current
  // taskAgent only controls ordering/current styling in the launch picker, never labels.
  agentLabels: {},
  planApprovalCommand: '/approve-plan',
  supportsPlanMode: false,
  availableAgents: [],
  agentStatuses: [],
  sessionAgent: null,
  sessionAgentModel: null, // (C1122) Pi model paired with sessionAgent when "Remember for this session" picked a specific row
  deviceId: 0,

  // Human tasks filter
  humanFilterActive: false,

  // (C1407) People filter — replaces the old bare Human-filter button with a panel.
  // assigneeScope: 'me' (default, board's own scoped fetch) | 'all' (fetch every
  // assignee — the C1407 owner-exemption override is bypassed server-side too). This
  // dimension changes what gets FETCHED (see _boardTaskCacheContext() in template.html),
  // unlike assigneeFilter below.
  assigneeScope: 'me',
  // Member sub-selection, only meaningful while assigneeScope === 'all'. Set of member
  // ids (Number) plus the sentinel string 'none' for unassigned. Empty Set = all members
  // shown (mirrors statusFilter's empty-Set-means-all below) — a pure client-side filter
  // over the already-fetched unscoped rows, deliberately NOT part of the fetch.
  assigneeFilter: new Set(),

  // Status filter — empty Set = all, else a subset of STATUSES (C1164)
  statusFilter: new Set(),

  // Tag filters
  activeTagFilters: new Set(),

  // Load More — whether all steps are shown
  allStepsLoaded: false,
  extraStepsLoaded: 0,

  // (C1259) Server-side board sprint window. { floor, has_older, extended } from the
  // last fetch's `window` key, or null (unwindowed fetch / file backend without an
  // opinion). extended tracks how many sprint-steps "Load More" has widened the fetch
  // by so far — server floor = oldest sprint with an open task, minus this many further
  // distinct sprints. See fetchBoardWindow()/loadAndRender() in template.html.
  boardWindow: null,
  sprintWindowExtend: 0,

  // (C1259) The last full render's `visibleTasks` array (reservations already filtered
  // out) — lets a filter-toggle handler recompute status-filter facet counts and patch
  // the filter bar chrome without a full loadAndRender(). See
  // task-board.js#refreshFilterBarChrome().
  _lastVisibleTasks: [],

  // (C1259) Debug ▸ click-to-render perf logging. Mirrors the persisted
  // .tipatask/config.json `debugPerfLog` boolean (Settings modal), hydrated at boot by
  // applyProjectBoardFilters()/initSettingsModal() — see src/client/perf-log.js.
  debugPerfLog: false,

  // (TPT95) Mirrors the persisted .tipatask/config.json `MCP_BROWSER_TOOLS` array
  // (Codex-only browser-tools MCP presets: Playwright, Chrome DevTools). Hydrated at
  // boot/project-switch by applyProjectBrowserTools(); both ids present = default-on.
  // Read by the Task Edit Modal's Codex-agent row, written by writeProjectBrowserTools()
  // — see src/client/task-board.js.
  browserTools: ['playwright', 'chrome-devtools'],

  // Tier collapse state
  collapsedTiers: new Set(),
  expandedTiers: new Set(),

  // Terminal restore context
  pendingRestoreContext: null, // { scrollY, cardId, cardMode }
  // One-shot flag: next loadAndRender should scroll to top (set before tiptask:reload-routed navigations)
  pendingScrollTop: false,

  // Chain dependency highlights
  chainHighlightedTaskId: null,
  chainHighlightColorIndex: 0,
  // (C1433/C1569) which applyXHighlight() produced the current chainHighlightedTaskId —
  // 'deps' (applyChainHighlight, dependency chain only — legacy, no longer wired to a
  // button, still the restore-path default), 'objective' (applyObjectiveHighlight, subtask
  // subtree), or 'related' (applyRelatedHighlight, C1569 — deps chain UNION family: subtask
  // descendants + parent objective + siblings; what .btn-chain-deps and the Task Edit
  // Modal's "chain" action both produce today). Lets the re-render restore path
  // (template.html) and the click toggle logic (task-card.js) tell the highlight kinds apart.
  chainHighlightMode: 'deps',

  // Chat/objective state
  chatState: null,
  // [{ tabId, title, status:'idle'|'streaming'|'done'|'error', chatState,
  //    titlePinned?, subtaskCtx?:{taskKey,title}|null }] max 10.
  // titlePinned/subtaskCtx set by chat-ui.js spawnObjectiveTab() (C1162).
  tabsState: [],
  activeTabId: null,
  // (TPT271/TPT283) Board task keys locked by an open Rehash → Discuss/Split tab. Recomputed
  // ONLY by chat-ui.js#syncDiscussLocks() (from tabsState, via discuss-lock.js); read with
  // discuss-lock.js#isTaskDiscussing(). Changes fire 'tiptask:discuss-lock-changed'.
  discussingTaskKeys: new Set(),
  // (TPT283) Same keys → locking intent ('discuss' | 'split'); read with lockIntentOf().
  discussLockIntents: new Map(),
  lastSentPrompt: '',
  cleanupInProgress: false, // guard: blocks debounced saveChatDraft() from racing cleanupChat() DELETE
  // (TPT19) Monotonic counter bumped ONLY by cleanupChat()'s persistence-purge branch
  // (console-modal.js). Every debounced saveChatDraft()/saveChatState() timer (chat-ui.js)
  // captures this at schedule time and re-checks it before writing — a write scheduled
  // before a purge can never resurrect a file the purge just deleted. Deterministic fix for
  // the 300ms/2000ms debounce-vs-500ms-guard-window mismatch that let an orphaned
  // saveChatState() PUT recreate chat-state.json after cleanupChat() had already DELETEd it.
  chatPersistEpoch: 0,

  // Chat-model-selector (C1029) — objectiveProviders comes from the WS `config` frame
  // (server-authoritative availability + model lists). objectiveModel is the sticky
  // cross-session default ("provider:model", e.g. "claude:claude-opus-5"); a per-tab
  // override lives on chatState.objectiveModel and wins when set (see chat-ui.js).
  objectiveProviders: [],
  objectiveModel: null,

  // Terminal overlay
  activeTerminal: null, // { overlay, term, ws, onResize, processRunning, phase, taskAgentLabel }
  activeSessions: new Set(), // taskIds with running server-side sessions
  lostSessions: new Map(), // taskId -> { reason?, at? }; not running, retained for recovery
  exitedSessions: new Set(), // taskIds with exited server-side sessions (alive=false)
  // (C1144) taskId -> { agent, label, type, alive } from GET /api/sessions —
  // the only source of a session's agent id; the left-nav active-sessions list needs it for the icon.
  sessionMeta: new Map(),

  // Attention (idle terminal sessions)
  attentionSessions: new Set(),
  // (C1057) taskId -> { kind, promptText, agent } — what the agent is actually asking,
  // surfaced in the OS notification body (attention-notifications.js#buildAttentionBody).
  attentionDetails: new Map(),

  // Green attention (newly assigned tasks)
  newlyAssignedTasks: new Set(),
  newlyAssignedTimers: new Map(),

  // (TPT12) taskId -> { count, ids, latest } — unread `notifications` inbox rows per task,
  // reduced server-side by task-change-poll.js and applied via task-activity.js. Drives the
  // card's activity chip + OS push. See task-activity.js's module doc for how this differs
  // from TPT17's Notifications-tab `te-seen` marker.
  taskActivity: new Map(),

  // Children map — Map<parentTaskId, Task[]> built per loadAndRender from all tasks
  childrenByParent: new Map(),

  // Full task status map — Map<taskId, status> built per loadAndRender from all tasks (incl. subtasks + backlog)
  // Used by renderCard to gate the Start button on dependency completion.
  taskStatusById: new Map(),
  // Full task title map — Map<taskId, title>, same build site as taskStatusById (C1058).
  // Attention notifications fall back to this when no card is rendered for the task (filtered,
  // collapsed tier, backlog, other tab) — the attention-needed WS payload carries no title.
  taskTitleById: new Map(),

  // Sprint records from API (array of { id, name, number, goal, task_count })
  sprints: [],

  // Tag descriptions registry — Map<name, description|null>
  tagDescriptions: new Map(),

  // Project members — assignee pickers, @mention suggestions, card badges. `null`
  // means never fetched, `[]` means fetched (or failed) empty; no reader
  // distinguishes them. Hydrated once at boot, then re-checked on every
  // assignee-picker focus / task-edit-modal open (see member-cache.js, C1520).
  projectMembers: null,

  // Recipes
  recipesCache: null,

  // Last successful loadAndRender task count — guards error path so transient
  // API failures don't wipe the rendered board when tasks have been shown.
  lastLoadedTaskCount: 0,

  // AI token stats visibility (set from WS config message)
  showAiStats: false,

  // Card selection (reset at start of each loadAndRender call)
  selectedCardId: null,
  expandedCardMode: null, // null | 'hover' | 'pinned'
  hoverScrollHandler: null,

  // Multi-select for bulk actions (persists across re-renders)
  selectedCardIds: new Set(),

  // Task ids with locally-queued mutations (pending-sync highlight)
  pendingTaskIds: new Set(),
};

export default state;
