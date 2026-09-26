#!/usr/bin/env node
'use strict';

// MCP protocol uses stdout — redirect console to stderr
console.log = (...args) => console.error(...args);

const fs = require('fs');
const path = require('path');
const config = require('../server/config');
const { getApiCredentials } = require('../server/api-credentials');
const cache = require('./architecture-cache');
const { ARCHITECTURE_DIR } = cache;
const taskCache = require('./task-cache');
const { resolveCreatePriority, shouldDefaultPriorityOnFinalize, applyDependencyFloor } = require('./priority-fallback');
const { isReservationPlaceholder } = require('../server/reservation-placeholder');
const { resolveDepAwareUpdate } = require('./dep-priority');
const { fetchStatusContext } = require('../server/status-roles');
const { isPlaceholderDescription, placeholderError } = require('./tag-description');
const { AuthCorruptedError } = require('../server/auth-guard');
const { isValidTaskKey, maxNumbersByPrefix } = require('../server/task-key-format');

// Agents frequently pass keys with surrounding whitespace, brackets, quotes,
// trailing punctuation, or lowercase prefixes (e.g. "c287", "[c287]", "c287.", "tpt214").
// Normalize into canonical "C123" / "H123" / "TPT214" form before lookup. (C1483: was
// [a-zA-Z] single-char only — a lowercase per-project prefix like "tpt214" never
// uppercased.) Verbatim-copied twin: api/src/routes/mcp.js — keep in sync.
function normalizeTaskKey(raw) {
  if (typeof raw !== 'string') return '';
  let k = raw.trim().replace(/^[\["'`]+|[\]"'`.,;:)]+$/g, '').trim();
  const m = k.match(/^([a-zA-Z]{1,6})\s*(\d+)$/);
  if (m) k = m[1].toUpperCase() + m[2];
  return k;
}

async function main() {
  const timingEnabled = process.env.OBJECTIVE_TIMING_ENABLED !== 'false';
  const t0 = timingEnabled ? Date.now() : 0;
  if (timingEnabled) process.stderr.write(`[mcp:tipatask:checkpoint name=requires ts=${Date.now()}]\n`);

  const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('zod'),
  ]);

  if (timingEnabled) process.stderr.write(`[mcp:tipatask:checkpoint name=imports ts=${Date.now()}]\n`);

  // Lazy backend — require + init deferred to first task tool call
  let backend = null;
  let initialized = false;

  let kbSynced = false;
  function ensureKbSynced() {
    if (kbSynced) return;
    if (config.TASK_BACKEND !== 'api') return;
    kbSynced = true;
    try {
      const { baseUrl, projectId, token } = getApiCredentials(config.PROJECT_ROOT);
      const { fireSessionSync } = require('../cli/knowledge-sync');
      fireSessionSync(baseUrl, projectId, token, config.PROJECT_ROOT, 'mcp');
    } catch (err) {
      console.error(`[mcp] KB sync skipped: ${err.message}`);
    }
  }

  async function ensureBackend() {
    if (!backend) {
      const { createBackend } = require('../server/task-backend');
      backend = createBackend(config);
    }
    if (!initialized) {
      await backend.init();
      initialized = true;
    }
    // (C1383) createBackend() may have handed back a pre-sealed instance (known-dead
    // token), and init() itself soft-returns (no throw) on an auth failure — so a
    // successful init() proves nothing about credentials. Surface it explicitly here
    // rather than letting every subsequent tool call fail as a generic rejection.
    if (backend.getConnectionState() === 'unauthorized') {
      throw new AuthCorruptedError('Authentication expired or invalid for this project — sign in again.', { reasonCode: 'unauthorized' });
    }
  }

  // arch cache is lazy — listSystemTags/getTagArchitecture self-bootstrap on first call
  const archCacheLog = process.env.MCP_ARCH_CACHE_LOG === '1';

  // C1382 — remote HTTP transport (api/src/routes/mcp.js) now carries 18 of these 22
  // tools (C1541 adds list_task_resolutions to both) with the API's own MySQL directly,
  // retiring this stdio server as the primary registration. TIPATASK_MCP_LOCAL_ONLY (set
  // to "1" by every config writer as of C1382 — see .mcp.json / codex-mcp-config.js)
  // registers only the local tools below that still need this: a checked-out repo
  // (batch_grep_tags) or an API round-trip this process happens to already be set up for
  // (push_knowledge/pull_knowledge, git_worktree_status, complete_task). Registered under the server name
  // 'tipatask-local' — see the McpServer name below. Defaults to full 22-tool mode
  // (LOCAL_ONLY=false) so a stale .mcp.json/config.toml predating C1382, or a bare
  // `node server.js` invocation, keeps working exactly as before rather than silently
  // losing 18 tools.
  const LOCAL_ONLY = process.env.TIPATASK_MCP_LOCAL_ONLY === '1';

  const server = new McpServer({
    name: LOCAL_ONLY ? 'tipatask-local' : 'tipatask',
    version: '1.0.0',
  });
  const projectId = config.API_PROJECT_ID ?? null;
  const projectScopeNote = `Scoped to project ${projectId ?? 'none'} (API_PROJECT_ID from .tipatask/config.json).`;

  // ── The 18 tools now also served remotely (api/src/routes/mcp.js) — skipped when
  // TIPATASK_MCP_LOCAL_ONLY=1 so a client registering both 'tipatask' (remote) and
  // 'tipatask-local' (this process) never gets two divergent implementations of the
  // same tool name space. See tt-mcp-server.md § Remote HTTP Transport. ──
  if (!LOCAL_ONLY) {

  // ── list_task_id_meta ──
  // Returns maxCId, maxHId across ALL statuses + compact active-task list.
  // Purpose: WORKFLOW step 0 in objective chat — replaces the no-filter list_tasks call
  // that produced 3774-line files and triggered Agent (Explore) subagent spawns.

  server.tool(
    'list_task_id_meta',
    `Returns the max task-ID number per prefix across ALL statuses (for next-ID computation — see maxByPrefix; maxCId/maxHId kept for back-compat, they're just maxByPrefix.C/.H) plus all active tasks (not completed/canceled — C1187: resolved via this project's own workflow roles, so a renamed/custom status registry is handled correctly) with summary fields. Single round-trip, <5KB response. Use for WORKFLOW step 0 instead of list_tasks with no filter. ${projectScopeNote}`,
    {},
    async () => {
      ensureKbSynced();
      await ensureBackend();
      const [tasks, statusCtx] = await Promise.all([
        taskCache.getTasks(backend),
        fetchStatusContext(backend),
      ]);

      // (C1483) Per-prefix max suffix — was a C/H-only regex scan, blind to a project's
      // own derived task_prefix (e.g. 'TPT'). maxCId/maxHId kept as named fields for
      // back-compat (documented in tt-mcp-server.md, injected into the objective
      // prompt) — now just reads off the same map instead of a second parallel scan.
      const byPrefix = maxNumbersByPrefix(tasks);
      const maxCId = byPrefix.get('C') ?? 0;
      const maxHId = byPrefix.get('H') ?? 0;
      const maxByPrefix = Object.fromEntries(byPrefix);
      const active = [];

      for (const t of tasks) {
        if (statusCtx.active.has(t.status)) {
          active.push({ id: t.id, projectId: t.projectId, title: t.title, category: t.category, status: t.status, priority: t.priority, tags: t.tags });
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, maxCId, maxHId, maxByPrefix, active }, null, 2) }],
      };
    }
  );

  // ── list_tasks ──

  function toSummary(t) {
    return {
      id: t.id,
      projectId: t.projectId,
      title: t.title,
      status: t.status,
      category: t.category,
      priority: t.priority,
      order: t.order,
      tags: t.tags,
      assignee: t.assignee,
      dependencies: t.dependencies,
      parentDbId: t.parentDbId,
      hasChildren: t.hasChildren,
    };
  }

  server.tool(
    'list_tasks',
    `List tasks with cursor-based pagination. Default mode returns summary fields only (no description/tokens/cost — call get_task for full detail). Use detail:"full" for the complete object. ${projectScopeNote}`,
    {
      // C1184: statuses are per-project custom now (a project can rename/add/remove
      // them), so this can't be a fixed z.enum. Not runtime-validated here — an unknown
      // name just filters to zero results, same harmless behavior as any other filter
      // with no matches. Use get_task/list_tasks with no filter to see real status names.
      status: z.string().optional().describe("Filter by status — one of this project's configured status names (defaults: pending, in_progress, on_fire, completed, canceled). An unrecognized name returns zero results, not an error."),
      category: z.enum(['CODING', 'HUMAN']).optional().describe('Filter by category'),
      cursor: z.string().optional().describe('Pagination cursor (nextCursor from previous response). Omit for first page.'),
      limit: z.number().int().min(1).max(200).optional().describe('Max tasks to return (default 50, max 200)'),
      detail: z.enum(['summary', 'full']).optional().describe('summary (default) = id/title/status/priority/tags; full = all fields'),
    },
    async ({ status, category, cursor, limit, detail }) => {
      ensureKbSynced();
      await ensureBackend();

      const offsetN = Math.max(0, parseInt(cursor || '0', 10) || 0);
      const limN = Math.min(200, Math.max(1, limit || 50));
      const mode = detail === 'full' ? 'full' : 'summary';

      // Push filters/pagination to server when any filter or cursor/limit is active.
      // No-filter calls (e.g. list_task_id_meta) still use the full-list cache path.
      const usePushdown = (!!status || !!cursor || limit != null) && backend.getTasksServerFiltered;
      if (usePushdown) {
        // Fetch limN+1 to detect next page without an extra COUNT query.
        let tasks = await backend.getTasksServerFiltered({
          status, category, limit: limN + 1, offset: offsetN,
          fields: mode, unscoped: true,
        });
        const hasMore = tasks.length > limN;
        const slice = hasMore ? tasks.slice(0, limN) : tasks;
        const projected = mode === 'full' ? slice : slice.map(toSummary);
        return {
          content: [{ type: 'text', text: JSON.stringify({
            project_id: projectId,
            tasks: projected,
            nextCursor: hasMore ? String(offsetN + limN) : null,
            returned: slice.length,
            detail: mode,
          }, null, 2) }],
        };
      }

      // Full-list cache path (no filters, no explicit limit/cursor).
      let tasks = await taskCache.getTasks(backend);
      if (status) tasks = tasks.filter(t => t.status === status);
      if (category) tasks = tasks.filter(t => t.category === category);

      const total = tasks.length;
      const slice = tasks.slice(offsetN, offsetN + limN);
      const nextCursor = offsetN + slice.length < total ? String(offsetN + slice.length) : null;
      const projected = mode === 'full' ? slice : slice.map(toSummary);

      return {
        content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, tasks: projected, nextCursor, total, returned: slice.length, detail: mode }, null, 2) }],
      };
    }
  );

  // ── get_task ──

  server.tool(
    'get_task',
    `Get a single task by its key (e.g. "C192"). ${projectScopeNote}`,
    {
      task_key: z.string().describe('Task key, e.g. "C192"'),
    },
    async ({ task_key }) => {
      ensureKbSynced();
      const normalized = normalizeTaskKey(task_key);
      if (!normalized) {
        return { content: [{ type: 'text', text: `Invalid task_key: ${JSON.stringify(task_key)}` }], isError: true };
      }
      try {
        await ensureBackend();
      } catch (err) {
        return { content: [{ type: 'text', text: `Backend unavailable: ${err.message}` }], isError: true };
      }
      let task;
      try {
        task = await taskCache.getTask(backend, normalized);
      } catch (err) {
        return { content: [{ type: 'text', text: `Lookup failed for ${normalized}: ${err.message}` }], isError: true };
      }
      if (!task) {
        const hint = normalized !== task_key ? ` (normalized from "${task_key}")` : '';
        return { content: [{ type: 'text', text: `Task ${normalized}${hint} not found` }], isError: true };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, task }, null, 2) }],
      };
    }
  );

  // ── update_task ──

  server.tool(
    'update_task',
    `Update a task. Use to change status, title, description, priority, tags, or dependencies. ${projectScopeNote}`,
    {
      task_key: z.string().describe('Task key to update'),
      // C1184: per-project custom statuses — validated at call time against the
      // project's own registry (status-roles.js), not a fixed enum.
      status: z.string().optional().describe("New status — one of this project's configured status names. An invalid value returns an error listing the valid names; call get_task on any task or list_tasks to see real names in use."),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      priority: z.number().optional().describe("Priority (higher = more important). Normally OMIT means \"leave unchanged\" — EXCEPT when finalizing a reserve_task_keys placeholder (title being set for the first time): then priority is defaulted the same way create_task does (session task → in_progress CODING task → max(active)+1), never silently left at the reservation's priority 0/backlog (C1049)."),
      tags: z.array(z.string()).optional().describe('Replace tags'),
      dependencies: z.array(z.string()).optional().describe("Replace the dependency list (task keys). Priority is auto-healed (C1053): if this task's sprint is at or below a dep's sprint it is bumped above it, and any active task depending on this one cascades upward too. Backlog (priority 0) tasks and backlog deps are exempt."),
      // assignee intentionally omitted — Task App tasks are owned by their creator and
      // may only be reassigned through the web app (api/web/). Accepting it here would
      // allow agents to silently reassign tasks.
    },
    async ({ task_key, ...fields }) => {
      ensureKbSynced();
      const normalized = normalizeTaskKey(task_key);
      if (!normalized) {
        return { content: [{ type: 'text', text: `Invalid task_key: ${JSON.stringify(task_key)}` }], isError: true };
      }
      await ensureBackend();
      // C1184/C1187: resolve this project's status registry once — names for validation,
      // roles/active set for the priority-heal helpers below. One forced re-read before
      // rejecting an unrecognized status, so a status renamed/created seconds ago is
      // never refused on a stale cache.
      let statusCtx = await fetchStatusContext(backend);
      if (fields.status !== undefined && !statusCtx.names.includes(fields.status)) {
        statusCtx = await fetchStatusContext(backend, { refresh: true });
        if (!statusCtx.names.includes(fields.status)) {
          return { content: [{ type: 'text', text: `Invalid status ${JSON.stringify(fields.status)}. This project's statuses are: ${statusCtx.names.join(', ')}.` }], isError: true };
        }
      }
      const update = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) update[k] = v;
      }
      if (update.dependencies !== undefined) {
        update.dependencies = update.dependencies
          .map(d => normalizeTaskKey(d))
          .filter(d => d && d !== normalized);
      }
      // C1049: reserve_task_keys books placeholders at priority 0 (backlog) since the real
      // priority isn't known at reservation time. Finalizing one via update_task (title
      // being set for the first time) with priority omitted must not silently leave it
      // stuck at 0 — invisible on the active sprint board — the way a plain PATCH would.
      // Mirror create_task's own priority default (resolveCreatePriority) in that one case;
      // every other update_task call (status-only, etc.) is untouched. Cheap local checks
      // first (mirrors shouldDefaultPriorityOnFinalize's own priority/title conditions) so
      // the extra getTask() fetch only happens for calls that could plausibly qualify.
      if (update.priority === undefined && update.title !== undefined) {
        try {
          const current = await taskCache.getTask(backend, normalized);
          if (shouldDefaultPriorityOnFinalize(update, isReservationPlaceholder(current))) {
            const tasksSnapshot = await taskCache.getTasks(backend);
            const sessionTaskId = process.env.TIPATASK_OBJECTIVE_TASK_ID || process.env.TIPATASK_TASK_ID || '';
            const resolved = resolveCreatePriority({ tasks: tasksSnapshot, sessionTaskId, activeStatuses: statusCtx.active, inProgressName: statusCtx.roles.in_progress });
            update.priority = resolved.priority;
            console.error(`[update_task] finalizing reservation ${normalized}: priority defaulted to ${update.priority} (${resolved.reason}${resolved.from ? ` from ${resolved.from}` : ''})`);
          }
        } catch (err) {
          console.error(`[update_task] reservation priority default lookup failed for ${normalized} (${err.message}); leaving priority untouched`);
        }
      }
      // C1053: retroactive dep-aware priority heal. Only runs when this patch touches
      // `dependencies` — a plain status/title/priority-only PATCH is never re-ordered.
      // Reuses sprint-assign.js's minStepForDeps directly (via dep-priority.js), same
      // as create_task's own dep-aware assignment (C1052) — not the changes[]/pinned-id
      // shaped healDependencyOrdering(), which belongs to the bulk resolve-sprints flow.
      let depHeal = null;
      if (update.dependencies !== undefined) {
        try {
          const current = await taskCache.getTask(backend, normalized);
          const tasksSnapshot = await taskCache.getTasks(backend);
          const effectivePriority = update.priority !== undefined ? update.priority : (current ? current.priority : 0);
          const resolved = resolveDepAwareUpdate({
            taskId: normalized,
            dependencies: update.dependencies,
            currentPriority: effectivePriority,
            tasks: tasksSnapshot,
            activeStatuses: statusCtx.active,
          });
          if (resolved.bumped) {
            update.priority = resolved.priority;
            depHeal = { from: effectivePriority, to: resolved.priority, cascade: resolved.cascade };
            const cascadeLog = resolved.cascade.length
              ? `; cascade: ${resolved.cascade.map(c => `${c.id} ${c.from}->${c.to}`).join(', ')}`
              : '';
            console.error(`[update_task] dep-aware heal: ${normalized} ${effectivePriority} -> ${resolved.priority}${cascadeLog}`);
          }
        } catch (err) {
          console.error(`[update_task] dep-aware heal lookup failed for ${normalized} (${err.message}); leaving priority untouched`);
        }
      }
      const result = await backend.updateTask(normalized, update);
      if (!result) {
        return { content: [{ type: 'text', text: `Task ${normalized} not found` }], isError: true };
      }
      // Persist cascade bumps (dependents pulled up above their now-moved dep) and
      // best-effort create any sprint rows the new priorities land on — mirrors
      // resolveAndAssign's own createSprint-if-missing behavior for the bulk path.
      if (depHeal && depHeal.cascade.length > 0) {
        for (const c of depHeal.cascade) {
          try {
            await backend.updateTask(c.id, { priority: c.to });
          } catch (err) {
            console.error(`[update_task] cascade bump failed for ${c.id} -> ${c.to}: ${err.message}`);
          }
        }
      }
      if (depHeal) {
        try {
          const targetPriorities = new Set([depHeal.to, ...depHeal.cascade.map(c => c.to)]);
          const existingSprints = await backend.getSprints();
          const existingNumbers = new Set((existingSprints || []).map(s => s.number));
          for (const n of targetPriorities) {
            if (n > 0 && !existingNumbers.has(n)) {
              await backend.createSprint(`Sprint ${n}`, n);
              existingNumbers.add(n);
            }
          }
        } catch (err) {
          console.error(`[update_task] dep-heal sprint row creation failed: ${err.message}`);
        }
      }
      taskCache.invalidate();
      return {
        content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, task: result, ...(depHeal ? { depHeal } : {}) }, null, 2) }],
      };
    }
  );

  // ── create_task ──

  server.tool(
    'create_task',
    `Create a new task. ${projectScopeNote}`,
    {
      task_key: z.string().describe('Unique task key, e.g. "C200"'),
      title: z.string().describe('Task title'),
      description: z.string().describe('Task description'),
      category: z.enum(['CODING', 'HUMAN']).default('CODING').describe('Category'),
      // C1184: no fixed default — resolved in the handler to this project's
      // is_workflow_start status name (legacy projects: 'pending').
      status: z.string().optional().describe("Initial status — one of this project's configured status names. OMIT to use this project's workflow-start status (legacy projects: 'pending'). An invalid value returns an error listing the valid names."),
      priority: z.number().optional().describe("Priority (higher = more important). OMIT to inherit the current task's priority — resolved from the session's TIPATASK_OBJECTIVE_TASK_ID/TIPATASK_TASK_ID, else the in_progress CODING task's priority (C874), else max(active priority)+1 — keeps deferred follow-up tasks in the same sprint as their parent (C956). Explicit 0 = backlog. NOTE: if `dependencies` is non-empty, this is a floor, not a fixed value — it is raised above every active dependency's sprint (C1052)."),
      dependencies: z.array(z.string()).default([]).describe('Task keys this depends on. Adding a dependency on an active task (not complete/canceled by this project\'s own workflow roles, C1187) moves this task into a LATER sprint than that dependency (C1052) — only list deps this task genuinely cannot start without.'),
      tags: z.array(z.string()).default([]).describe('Tag names'),
    },
    async (args) => {
      ensureKbSynced();
      await ensureBackend();

      // C1184/C1187: default status is this project's workflow-start status (legacy
      // projects: 'pending'), not a hardcoded literal. An explicit status is
      // validated against the project's own registry — one forced re-read before
      // rejecting, same "never reject on a stale cache" discipline as update_task above.
      // Also resolves roles/active set once, reused by the priority-default and
      // dependency-floor blocks below instead of each re-deriving the legacy sets.
      let statusCtx = await fetchStatusContext(backend);
      let status = args.status;
      if (status === undefined) {
        status = statusCtx.roles.start;
      } else if (!statusCtx.names.includes(status)) {
        statusCtx = await fetchStatusContext(backend, { refresh: true });
        if (!statusCtx.names.includes(status)) {
          return { content: [{ type: 'text', text: `Invalid status ${JSON.stringify(status)}. This project's statuses are: ${statusCtx.names.join(', ')}.` }], isError: true };
        }
      }

      // Fetched lazily, at most once, and reused by both the priority-default block
      // (C874) and the order computation (C945) below.
      let all = null;
      async function getAllTasks() {
        if (all === null) all = await taskCache.getTasks(backend);
        return all;
      }

      // C956: when priority is omitted (typical for agent-deferred follow-up tasks),
      // inherit the current task's priority so the new task lands in the same sprint
      // as its parent — not the backlog. Session task id comes from whichever spawn
      // env var is set: TIPATASK_OBJECTIVE_TASK_ID (objective-chat/planner sessions)
      // or TIPATASK_TASK_ID (task-agent terminal sessions — the mid-task create_task
      // case this fixes). Falls back to the in_progress CODING task's priority (C874),
      // then max(active priority)+1, when no session task id is set or it isn't found.
      let priority = args.priority;
      if (priority === undefined || priority === null) {
        process.stderr.write('[mcp:create_task] priority omitted - defaulting\n');
        try {
          const tasksSnapshot = await getAllTasks();
          const sessionTaskId = process.env.TIPATASK_OBJECTIVE_TASK_ID || process.env.TIPATASK_TASK_ID || '';
          const resolved = resolveCreatePriority({ tasks: tasksSnapshot, sessionTaskId, activeStatuses: statusCtx.active, inProgressName: statusCtx.roles.in_progress });
          priority = resolved.priority;
          console.error(`[create_task] priority defaulted to ${priority} (${resolved.reason}${resolved.from ? ` from ${resolved.from}` : ''})`);
        } catch (err) {
          priority = 1;
          console.error(`[create_task] priority default lookup failed (${err.message}); using 1`);
        }
      }

      // C1052: dependency floor. Sibling of update_task's own retroactive heal (C1053,
      // dep-priority.js) but for a brand-new task — no cascade needed, since nothing
      // can already depend on a task that didn't exist a moment ago. Same
      // minStepForDeps() call as the objective-chat bulk path (sprint-assign.js), but
      // applyDependencyFloor (priority-fallback.js) builds its priorityMap from ACTIVE
      // tasks only — a completed/canceled dep is satisfied and must not defer this task
      // a sprint (see priority-fallback.js docblock for why this deliberately differs
      // from computeSprintAssignments' all-tasks map). Normalize deps the same way
      // update_task does (line ~258) — agents pass keys with whitespace/brackets/
      // lowercase prefixes (normalizeTaskKey) and the un-normalized form would silently
      // miss the priorityMap lookup. Persist the normalized form too, matching C1053.
      const normalizedTaskKey = normalizeTaskKey(args.task_key);
      // C1482: task_key must be reserve_task_keys output (prefix+number) — never an
      // agent-invented descriptive slug (e.g. "C-kb-dev-scripts", the reported bug).
      if (!isValidTaskKey(normalizedTaskKey)) {
        return { content: [{ type: 'text', text: `Invalid task_key ${JSON.stringify(args.task_key)} — keys must be prefix+number (reserve_task_keys output, e.g. "C214" or "TPT214"), never a descriptive slug. Call mcp__tipatask__reserve_task_keys to get a real key.` }], isError: true };
      }
      const normalizedDeps = (args.dependencies || [])
        .map(d => normalizeTaskKey(d))
        .filter(d => d && d !== normalizedTaskKey);
      let depBump = null;
      if (normalizedDeps.length > 0) {
        try {
          const tasksSnapshot = await getAllTasks();
          const resolved = applyDependencyFloor({
            priority,
            dependencies: normalizedDeps,
            tasks: tasksSnapshot,
            taskId: args.task_key,
            status,
            normalizeKey: normalizeTaskKey,
            activeStatuses: statusCtx.active,
          });
          if (resolved.bumped) {
            depBump = { from: priority, to: resolved.priority, dep: resolved.from };
            priority = resolved.priority;
            console.error(`[create_task] dependency floor raised priority ${depBump.from} -> ${depBump.to} (dep ${depBump.dep} at ${depBump.to - 1})`);
          }
        } catch (err) {
          console.error(`[create_task] dependency floor lookup failed (${err.message}); leaving priority untouched`);
        }
      }

      // C945: append at end of the same-priority tier (max order + 1) instead of
      // colliding at display_order 0. Mirrors api-backend's _finalizeChangesInner.
      // taskCache is invalidated after each create, so
      // consecutive create_task calls into the same tier re-fetch and increment.
      // Runs after the dep-floor block so it tiers into the FINAL (possibly bumped)
      // priority, not the pre-bump one.
      let order = 0;
      try {
        const tasksSnapshot = await getAllTasks();
        const samePriority = tasksSnapshot.filter(t => t.priority === priority);
        order = (samePriority.length > 0 ? Math.max(...samePriority.map(t => t.order ?? 0)) : 0) + 1;
      } catch (err) {
        order = 0;
        console.error(`[create_task] order computation failed (${err.message}); using 0`);
      }

      const task = {
        id: args.task_key,
        title: args.title,
        description: args.description,
        category: args.category,
        status,
        priority,
        order,
        dependencies: normalizedDeps,
        tags: args.tags,
        assignee: null,
      };
      const result = await backend.createTask(task);
      taskCache.invalidate();
      // Best-effort sprint row for a dependency-floor bump — mirrors C1053's own
      // sprint-row creation for its cascade/heal bumps. Idempotent end-to-end:
      // api-backend swallows 409 (sprint number already exists) -> null.
      // Placed after createTask (not before) so a slow/failed
      // sprint POST can neither delay nor orphan the actual task creation, and no
      // highestActiveCodingPriority gate — that would false-negative whenever some
      // other active task already sits above the bumped priority.
      if (depBump && typeof backend.createSprint === 'function') {
        try {
          await backend.createSprint(`Sprint ${priority}`, priority);
        } catch (err) {
          console.error(`[create_task] sprint ${priority} creation skipped (${err.message})`);
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, task: result, ...(depBump ? { depBump } : {}) }, null, 2) }],
      };
    }
  );

  // ── reserve_task_keys ──
  // Atomically books N real, collision-proof task keys (C980) — creates lightweight
  // placeholder rows server-side so no two concurrently-running Task App instances or
  // web-frontend clients sharing this project can ever mint the same task_key. This is
  // the ONE mutation-adjacent tool the objective-chat planner is allowed to call
  // (see OBJECTIVE_SYSTEM_PROMPT in client/utils.js) — it claims a key, it does NOT
  // create real task content; title/description still only land at Accept/Save time.

  server.tool(
    'reserve_task_keys',
    `Atomically reserve N real, collision-proof task keys for tasks you are about to PROPOSE this turn. Creates lightweight placeholder rows server-side and returns their keys (e.g. ["C214","C215"]). Use the returned keys, IN ORDER, as the "id" values in your proposal JSON. This does NOT create the task's real content — title/description/tags are filled in only when the user Accepts/Saves. Call ONCE per category per turn after you know how many new CODING/HUMAN tasks you will propose. On a later turn, call again ONLY for additional new tasks beyond those already reserved earlier in this session; reuse previously-reserved keys for tasks you are carrying over. ${projectScopeNote}`,
    {
      count: z.number().int().min(1).max(50).describe('How many NEW task keys to reserve this turn'),
      category: z.enum(['CODING', 'HUMAN']).default('CODING').describe('Category — determines the key prefix (CODING→this project\'s own task_prefix, HUMAN→H; C1481)'),
      priority: z.number().optional().describe('Priority for the placeholder rows (default 0 backlog); final priority is set at Accept/Save time by sprint resolution'),
    },
    async ({ count, category, priority }) => {
      ensureKbSynced();
      await ensureBackend();
      if (!backend.reserveTaskKeys) {
        return { content: [{ type: 'text', text: 'reserve_task_keys is not supported by the active backend.' }], isError: true };
      }
      const { keys } = await backend.reserveTaskKeys({ count, category, priority: priority ?? 0 });
      taskCache.invalidate();
      return {
        content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, category, keys }, null, 2) }],
      };
    }
  );

  // ── purge_stale_reservations ──
  // Reaps stale, never-finalized reserve_task_keys placeholder rows (C1017) — the
  // "New task" rows left behind when an objective proposal is partially accepted,
  // rejected, or the chat is abandoned before Save. See reserveTaskKeys() (C980) in
  // api/src/routes/tasks.js for how these rows get created.

  server.tool(
    'purge_stale_reservations',
    `Delete stale, never-finalized reserve_task_keys placeholder rows ('New task' / pending / untouched) older than a threshold. Use when the board accumulates leftover reservation cards. Pass dry_run:true first to preview which keys would be removed. Rows with tags, comments, children, or device sessions are never touched — only untouched reservations qualify. ${projectScopeNote}`,
    {
      older_than_hours: z.number().min(1).max(8760).optional().describe('Age threshold in hours (default 24)'),
      dry_run: z.boolean().optional().describe('Preview only — report which keys would be purged without deleting them'),
    },
    async ({ older_than_hours, dry_run }) => {
      ensureKbSynced();
      await ensureBackend();
      if (!backend.purgeStaleReservations) {
        return { content: [{ type: 'text', text: 'purge_stale_reservations is not supported by the active backend.' }], isError: true };
      }
      const result = await backend.purgeStaleReservations({ olderThanHours: older_than_hours ?? 24, dryRun: dry_run === true });
      if (!dry_run && result.purged > 0) taskCache.invalidate();
      return {
        content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, dry_run: dry_run === true, ...result }, null, 2) }],
      };
    }
  );

  // ── delete_task ──

  server.tool(
    'delete_task',
    `Delete a task by key. ${projectScopeNote}`,
    {
      task_key: z.string().describe('Task key to delete'),
    },
    async ({ task_key }) => {
      ensureKbSynced();
      const normalized = normalizeTaskKey(task_key);
      if (!normalized) {
        return { content: [{ type: 'text', text: `Invalid task_key: ${JSON.stringify(task_key)}` }], isError: true };
      }
      await ensureBackend();
      const ok = await backend.deleteTask(normalized);
      if (!ok) {
        return { content: [{ type: 'text', text: `Task ${normalized} not found` }], isError: true };
      }
      taskCache.invalidate();
      return {
        content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, task_key: normalized, deleted: true, message: `Task ${normalized} deleted` }, null, 2) }],
      };
    }
  );

  // ── create_task_comment ──

  server.tool(
    'create_task_comment',
    `Post a comment on a task. Defaults to type='resolution' — call this with a real report (what was implemented and why, key files touched, how to use/verify the result, any follow-ups/caveats) in the SAME tool-call batch as the final update_task call that sets this project's completed status (C1184: a project can rename its statuses — call get_task or list_tasks if unsure which name that is). Write resolution comments in plain English prose, never in a compressed/caveman style, even if the rest of the session is running in one — this is a report read later, not a live status update. Pass type='comment' explicitly for regular discussion, or type='spec' for original objective/spec captures. ${projectScopeNote}`,
    {
      task_key: z.string().describe('Task key, e.g. "C192"'),
      content: z.string().min(1).describe('Comment body (non-empty)'),
      type: z.enum(['comment', 'resolution', 'spec']).optional().default('resolution').describe("'resolution' (default) for task completion reports, 'spec' for original objective/spec captures, 'comment' for regular notes"),
    },
    async ({ task_key, content, type = 'resolution' }) => {
      ensureKbSynced();
      const normalized = normalizeTaskKey(task_key);
      if (!normalized) {
        return { content: [{ type: 'text', text: `Invalid task_key: ${JSON.stringify(task_key)}` }], isError: true };
      }
      await ensureBackend();
      const comment = await backend.createTaskComment(normalized, content, type);
      if (!comment) {
        return { content: [{ type: 'text', text: `Task ${normalized} not found` }], isError: true };
      }
      taskCache.invalidate();
      return {
        content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, comment }, null, 2) }],
      };
    }
  );

  // ── list_task_resolutions ──
  // C1541 — read counterpart of create_task_comment above. Browse past task comment
  // history (all comment types: comment/resolution/spec) navigated by tag, so agents can
  // learn how similar past work was resolved WITHOUT that per-task narrative ever needing
  // to live in the architecture KB (ai/architecture/tt-*.md), which must stay standing
  // system concepts only. The auto-posted terminal-tail comment (raw PTY log dump,
  // ws-handlers.js session-lifecycle hook) is excluded by default — it's a machine
  // artifact, not narrative, and a single one can be ~6000 chars on its own. Registered
  // here (not LOCAL_ONLY) because it needs an API round-trip and has a remote-transport
  // twin (api/src/routes/mcp.js) — same C1382 placement criterion as every other tool in
  // this block.

  server.tool(
    'list_task_resolutions',
    `Browse past task comment history (all comment types — resolution reports, spec captures, regular discussion) by tag, to see how similar work was resolved before. Per-task narrative belongs here, not in the architecture KB — read this instead of writing task-specific explanations into ai/architecture/tt-*.md files. Excludes the auto-posted terminal-tail log comment by default (raw PTY dump, not narrative) — pass include_agent_logs:true to see it. ${projectScopeNote}`,
    {
      tags: z.array(z.string()).min(1).max(10).describe('Tag names to search for (ANY match qualifies — OR semantics, not AND). Case-insensitive.'),
      limit: z.number().int().min(1).max(20).optional().describe('Max tasks to return (default 5, max 20).'),
      status: z.string().optional().describe("Restrict to one of this project's configured status names. Omit to default to closed statuses only (this project's workflow-complete/workflow-canceled roles) — 'past resolutions' implies finished work."),
      include_agent_logs: z.boolean().optional().describe('Include the auto-posted terminal-tail log comment (default false — excluded as machine-generated noise, not narrative).'),
    },
    async ({ tags, limit, status, include_agent_logs }) => {
      ensureKbSynced();
      await ensureBackend();
      if (!backend.getTasksByTags) {
        return { content: [{ type: 'text', text: 'list_task_resolutions is not supported by the active backend.' }], isError: true };
      }
      try {
        const result = await backend.getTasksByTags(tags, { limit, status, includeAgentLogs: include_agent_logs === true });
        return {
          content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, ...result }, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
    }
  );

  // ── list_system_tags ──

  server.tool(
    'list_system_tags',
    'List all system-wide tt-* architecture tags. Returns { tag, description, file } per tag — description is the one-line summary from the H1 of ai/architecture/{tag}.md. Use this to find the right tags when creating or updating tasks. For project-level task tags from the database, use get_project_tags instead.',
    {},
    () => {
      ensureKbSynced();
      try {
        const t = archCacheLog ? Date.now() : 0;
        const tags = cache.listSystemTags();
        if (archCacheLog) {
          const s = cache.getStats();
          process.stderr.write(`[mcp:arch-cache] tool=list_system_tags ms=${Date.now() - t} tags=${tags.length} hits=${s.hits} reads=${s.contentReads} rescans=${s.dirRescans}\n`);
        }
        return { content: [{ type: 'text', text: JSON.stringify(tags, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Cannot read architecture dir: ${err.message}` }], isError: true };
      }
    }
  );

  // ── get_tag_architecture ──

  server.tool(
    'get_tag_architecture',
    'Read the full architecture documentation for a system-specific tag. Returns the content of ai/architecture/{tag_name}.md. Use before implementing anything in that module.',
    {
      tag_name: z.string().describe('Tag name, e.g. "tt-api-auth" or "tt-task-cards"'),
    },
    ({ tag_name }) => {
      ensureKbSynced();
      try {
        const t = archCacheLog ? Date.now() : 0;
        const statsBefore = archCacheLog ? cache.getStats() : null;
        const content = cache.getTagArchitecture(tag_name);
        if (archCacheLog) {
          const s = cache.getStats();
          const outcome = content === null ? 'miss'
            : s.hits > statsBefore.hits ? 'hit'
            : s.mtimeRevalidations > statsBefore.mtimeRevalidations ? 'revalidated'
            : 'read';
          process.stderr.write(`[mcp:arch-cache] tag=${tag_name} outcome=${outcome} ms=${Date.now() - t} totalHits=${s.hits} reads=${s.contentReads}\n`);
        }
        if (content === null) {
          return {
            content: [{ type: 'text', text: `No architecture file found for tag "${tag_name}". File expected at: ai/architecture/${tag_name}.md` }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: content }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error reading file: ${err.message}` }], isError: true };
      }
    }
  );

  // ── get_tag_architectures ──

  server.tool(
    'get_tag_architectures',
    'Read architecture docs for multiple tags in one call. Returns map { tag_name: content_or_null }. Use when loading 2+ tags — single-call replacement for repeated get_tag_architecture.',
    {
      tag_names: z.array(z.string()).min(1).max(50).describe('Tag names, e.g. ["tt-api-auth", "tt-task-cards"]'),
    },
    ({ tag_names }) => {
      ensureKbSynced();
      try {
        const t = archCacheLog ? Date.now() : 0;
        const statsBefore = archCacheLog ? cache.getStats() : null;
        const map = {};
        for (const name of tag_names) {
          map[name] = cache.getTagArchitecture(name);
        }
        if (archCacheLog) {
          const s = cache.getStats();
          process.stderr.write(`[mcp:arch-cache] tool=get_tag_architectures count=${tag_names.length} ms=${Date.now() - t} hits=${s.hits - statsBefore.hits} reads=${s.contentReads - statsBefore.contentReads}\n`);
        }
        return { content: [{ type: 'text', text: JSON.stringify(map, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error reading architecture files: ${err.message}` }], isError: true };
      }
    }
  );

  } // end if (!LOCAL_ONLY) — list_task_id_meta .. get_tag_architectures

  // ── batch_grep_tags ── (LOCAL_ONLY — always registered; see tt-mcp-server.md)

  server.tool(
    'batch_grep_tags',
    'Scan codebase ONCE and group hits by tt-* tag. ALWAYS pass every tag in scope as one array — multiple invocations per turn is a bug. Single file scan replaces N tool round-trips (~30ms vs ~1.2s×N). Derives search patterns from each tag\'s KB doc. Returns { results: { tag: [{file,line,text,pattern}] }, tagPatterns, totalHits, elapsedMs }. Optional: symbols (extra identifiers → results.__symbols__), cross_refs (tag-file overlap map), validate_only (counts only).',
    {
      tag_names: z.array(z.string()).min(1).max(20).describe('tt-* tag names to search for, e.g. ["tt-api-tasks","tt-task-board"]'),
      paths: z.array(z.string()).optional().describe('Paths to search (relative to the project root). Defaults to whichever of src, lib, app, api, packages, ai/architecture exist; the whole project when none does.'),
      max_hits_per_tag: z.number().int().min(1).max(100).optional().describe('Max hits per tag (default 30)'),
      symbols: z.array(z.string()).optional().describe('Extra identifiers to search (e.g. function/class names). Hits returned under results.__symbols__[name].'),
      cross_refs: z.boolean().optional().describe('Compute cross-tag file overlap: which tagA patterns appear in files listed by tagB\'s arch doc. Adds crossRefs map to result.'),
      validate_only: z.boolean().optional().describe('Return hit counts only (no detail). Adds counts:{tag:n} and missingTags:[...]. Fast existence check.'),
    },
    ({ tag_names, paths, max_hits_per_tag, symbols, cross_refs, validate_only }) => {
      ensureKbSynced();
      try {
        const { runBatchGrep } = require('./batch-grep');
        const result = runBatchGrep({
          tagNames: tag_names,
          paths: paths || undefined,
          maxHitsPerTag: max_hits_per_tag || undefined,
          symbols: symbols || undefined,
          crossRefs: cross_refs || false,
          validateOnly: validate_only || false,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `batch_grep_tags error: ${err.message}` }], isError: true };
      }
    }
  );

  if (!LOCAL_ONLY) {

  // ── create_system_tag ──

  server.tool(
    'create_system_tag',
    'Create a new tt-* system tag: writes an architecture stub file at ai/architecture/{tag_name}.md and registers the tag in the project database. Returns { tag, file, created: true } on success, or { tag, exists: true } if the file already exists.',
    {
      tag_name: z.string().describe('Tag name, e.g. "tt-new-module"'),
      description: z.string().trim().min(1, 'description required — one-line summary of module purpose').describe('One-line description used in the h1 heading'),
      architecture_hint: z.string().trim().min(1, 'architecture_hint required — key files, endpoints, DB tables, behavior').describe('Module purpose, key files, endpoints — written as the stub body'),
    },
    async ({ tag_name, description, architecture_hint }) => {
      ensureKbSynced();
      if (isPlaceholderDescription(description)) {
        return { content: [{ type: 'text', text: placeholderError(tag_name) }], isError: true };
      }
      const file = path.join(ARCHITECTURE_DIR, `${tag_name}.md`);
      // Defense-in-depth: if TIPATASK_PROJECT_ROOT is set, ensure the resolved path stays
      // inside it. Guards against ../traversal in tag_name and misconfigured env that could
      // silently point ARCHITECTURE_DIR at the app bundle (C867).
      const _projectRoot = process.env.TIPATASK_PROJECT_ROOT;
      if (_projectRoot) {
        const _resolvedFile = path.resolve(file);
        const _resolvedRoot = path.resolve(_projectRoot);
        if (_resolvedFile !== _resolvedRoot && !_resolvedFile.startsWith(_resolvedRoot + path.sep)) {
          return { content: [{ type: 'text', text: `Refusing to write arch doc outside project root: ${_resolvedFile}` }], isError: true };
        }
      }
      if (fs.existsSync(file)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ tag: tag_name, exists: true }) }],
        };
      }
      // C1237: shared with the objective-save KB-doc-link path (tag-doc-link.js) so
      // the two tt-* stub-creation paths can never drift apart.
      const { buildTagStub, archFileKey } = require('../server/tag-doc-link');
      const stub = buildTagStub(tag_name, description, architecture_hint);
      fs.writeFileSync(file, stub, 'utf8');
      cache.invalidate(tag_name);
      const fileKey = archFileKey(tag_name);
      // Push the new stub to the API knowledge store FIRST (C891, mirrors discover.js
      // tag-creation push) — reordered ahead of ensureTag (was after) because the new
      // tags.knowledge_file_id FK (046) can only point at a project_knowledge_files row
      // that already exists, so the KB file must land before ensureTag links to it by
      // file_key. api backend only; best-effort — a push failure just means this tag
      // creation goes out without a link, self-healed by the next Re-Index run.
      let pushedFileKey;
      if (config.TASK_BACKEND === 'api') {
        try {
          const { baseUrl, projectId: liveProjectId, token } = getApiCredentials(config.PROJECT_ROOT);
          const { pushFile } = require('../cli/knowledge-sync');
          await pushFile(baseUrl, liveProjectId, token, fileKey, stub, 0, config.PROJECT_ROOT);
          pushedFileKey = fileKey;
        } catch (err) {
          console.error(`[mcp] create_system_tag: pushFile failed: ${err.message}`);
        }
      }
      try {
        await ensureBackend();
        await backend.ensureTag(tag_name, description, pushedFileKey);
        taskCache.invalidate();
      } catch (err) {
        console.error(`[mcp] create_system_tag: ensureTag failed: ${err.message}`);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ tag: tag_name, file: fileKey, description, created: true }) }],
      };
    }
  );

  // ── ensure_project_tag ──
  // C1038: register/describe a plain (non-tt-*) project tag — the counterpart to
  // create_system_tag for tags that aren't a tt-* architecture module (e.g. "validation",
  // "drag-and-drop"). create_system_tag deliberately stays tt-*-only (it writes an
  // architecture stub); this tool is the registration path for everything else, now that
  // api-backend.js no longer auto-registers unknown tags with a placeholder description
  // (see api-backend.js _rawCreateTask/overwriteRaw). Idempotent: also updates the
  // description of an already-registered tag (e.g. its meaning drifted after a KB change).

  server.tool(
    'ensure_project_tag',
    'Register a project tag with a real one-line description, or update an existing tag\'s description. Use for plain (non-tt-*) tags before putting them on a task — create_system_tag is for tt-* architecture tags only (it also writes an architecture stub). A placeholder description ("Auto-registered by..." or similar) is rejected.',
    {
      tag_name: z.string().trim().min(1, 'tag_name required').describe('Tag name, e.g. "validation" or "drag-and-drop"'),
      description: z.string().trim().min(1, 'description required — one-line summary of what this tag covers').describe('One-line description stored in tags.description'),
    },
    async ({ tag_name, description }) => {
      ensureKbSynced();
      if (isPlaceholderDescription(description)) {
        return { content: [{ type: 'text', text: placeholderError(tag_name) }], isError: true };
      }
      await ensureBackend();
      if (!backend.ensureTag) {
        return { content: [{ type: 'text', text: 'ensure_project_tag is not supported by the active backend.' }], isError: true };
      }
      try {
        await backend.ensureTag(tag_name, description);
      } catch (err) {
        return { content: [{ type: 'text', text: `ensure_project_tag failed for "${tag_name}": ${err.message}` }], isError: true };
      }
      taskCache.invalidate();
      return {
        content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, tag: tag_name, description }) }],
      };
    }
  );

  // ── get_project_tags ──

  server.tool(
    'get_project_tags',
    'List all project-level task tags from the database with descriptions. Returns [{name, description}] — description is null when not set. These are tags assigned to tasks — not system architecture tags (use list_system_tags for tt-* architecture tags).',
    {},
    async () => {
      ensureKbSynced();
      await ensureBackend();
      const tags = await backend.getTagsDetailed();
      return {
        content: [{ type: 'text', text: JSON.stringify(tags, null, 2) }],
      };
    }
  );

  } // end if (!LOCAL_ONLY) — create_system_tag .. get_project_tags

  // ── push_knowledge ── (LOCAL_ONLY — always registered; see tt-mcp-server.md)

  server.tool(
    'push_knowledge',
    `Push local KB files to the Tipatask API knowledge store. Without file_key: pushes all watched KB files (CLAUDE.md, AGENTS.md, GENERAL.md, CONVENTIONS.md) and all ai/architecture/tt-*.md files. With file_key: pushes a single file. Returns { pushed: N, files? }. ${projectScopeNote}`,
    {
      file_key: z.string().optional().describe('Relative path of a single KB file to push, e.g. "ai/architecture/tt-api-tasks.md". Omit to push all watched KB files (core + all tt-*.md).'),
    },
    async ({ file_key }) => {
      const rootPath = config.PROJECT_ROOT;

      if (config.TASK_BACKEND !== 'api') {
        return {
          content: [{ type: 'text', text: 'push_knowledge requires TASK_BACKEND=api with API_BASE_URL, API_PROJECT_ID, and API_TOKEN set' }],
          isError: true,
        };
      }

      try {
        const { baseUrl, projectId: pid, token } = getApiCredentials(rootPath);
        const { pushFile: ksPushFile, pushAll: ksPushAll, pushArchitectureDocs, getLocalVersions: ksGetLocalVersions, readEntry: ksReadEntry } = require('../cli/knowledge-sync');

        if (file_key) {
          const abs = require('node:path').resolve(rootPath, file_key);
          if (!require('node:fs').existsSync(abs)) {
            return { content: [{ type: 'text', text: `File not found on disk: ${file_key}` }], isError: true };
          }
          const content = require('node:fs').readFileSync(abs, 'utf8');
          const localVersion = ksReadEntry(ksGetLocalVersions(rootPath), file_key).version;
          await ksPushFile(baseUrl, pid, token, file_key, content, localVersion, rootPath);
          return { content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, pushed: 1, files: [file_key] }, null, 2) }] };
        }

        const coreReport = await ksPushAll(baseUrl, pid, token, rootPath);
        const archReport = await pushArchitectureDocs(baseUrl, pid, token, rootPath);
        const allPushed = [...(coreReport.pushed || []), ...(archReport.pushed || [])];
        return {
          content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, pushed: allPushed.length, files: allPushed }, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `push_knowledge error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── pull_knowledge ──

  server.tool(
    'pull_knowledge',
    `Pull KB files from the Tipatask API knowledge store to local disk. Without file_key: pulls all files whose remote version exceeds the local cached version (same as session-start sync); a file whose version matches or whose content is byte-identical is skipped (no disk write) even though it was checked. With file_key: checks a single file against the remote version/content the same way — not an unconditional overwrite. Returns { pulledCount, remoteIsEmpty } or { pulled: 0|1, skipped, file, version }. pulled:0/pulledCount:0 means nothing needed writing, not that the check was skipped. ${projectScopeNote}`,
    {
      file_key: z.string().optional().describe('Relative path of a single KB file to pull, e.g. "ai/architecture/tt-api-tasks.md". Omit to pull all stale KB files (same as session-start sync).'),
    },
    async ({ file_key }) => {
      const rootPath = config.PROJECT_ROOT;

      if (config.TASK_BACKEND !== 'api') {
        return {
          content: [{ type: 'text', text: 'pull_knowledge requires TASK_BACKEND=api with API_BASE_URL, API_PROJECT_ID, and API_TOKEN set' }],
          isError: true,
        };
      }

      try {
        const { baseUrl, projectId: pid, token } = getApiCredentials(rootPath);
        const { pullFile: ksPullFile, syncOnSessionStart } = require('../cli/knowledge-sync');

        if (file_key) {
          // C1231 — pulled reflects whether a write actually happened; a version/content
          // match still checks the remote copy but is truthfully reported as pulled:0.
          const r = await ksPullFile(baseUrl, pid, token, file_key, rootPath);
          // C1545 — materializing a never-synced tt-*.md stub (e.g. right after a remote
          // create_system_tag call) only helps THIS session if list_system_tags/
          // get_tag_architecture see it immediately. Only on an actual write: a
          // version-match/content-match skip changed nothing on disk. Best-effort — a
          // cache-invalidation failure must never fail a pull that already succeeded.
          if (r.written) {
            try {
              cache.invalidateArchForKeys([file_key], rootPath);
            } catch (err) {
              console.error(`[mcp] pull_knowledge: arch cache invalidation failed for ${file_key}: ${err.message}`);
            }
          }
          return { content: [{ type: 'text', text: JSON.stringify(
            { project_id: projectId, pulled: r.written ? 1 : 0, skipped: r.skipped, file: file_key, version: r.version },
            null, 2,
          ) }] };
        }

        const { pulledCount, remoteIsEmpty, pulledKeys } = await syncOnSessionStart(baseUrl, pid, token, rootPath);
        if (pulledKeys && pulledKeys.length > 0) {
          try {
            cache.invalidateArchForKeys(pulledKeys, rootPath);
          } catch (err) {
            console.error(`[mcp] pull_knowledge: arch cache invalidation failed for bulk pull: ${err.message}`);
          }
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, pulledCount, remoteIsEmpty, pulledKeys }, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `pull_knowledge error: ${err.message}` }], isError: true };
      }
    }
  );

  if (!LOCAL_ONLY) {

  // ── list_knowledge_conflicts ──
  // C1220 — a KB write that overwrote genuinely diverged remote content records what it
  // destroyed server-side (see api/src/routes/knowledge.js POST /:id/knowledge-conflicts).
  // These two tools are how an agent on ANY machine recovers that content, not just the
  // machine that did the overwriting (which has a .tipatask/conflicts/ sidecar on disk).

  server.tool(
    'list_knowledge_conflicts',
    `List KB conflict-record metadata (no content) — content the local-wins auto-push policy overwrote on the remote copy, recoverable via get_knowledge_conflict. Returns { conflicts: [{id, file_key, overwritten_version, created_at, content_bytes, overwritten_by}], total }. ${projectScopeNote}`,
    {
      file_key: z.string().optional().describe('Scope to one KB file, e.g. "ai/architecture/tt-api-tasks.md". Omit to list across all files.'),
      since: z.string().optional().describe('ISO timestamp — only records created after this time.'),
      limit: z.number().int().min(1).max(200).optional().describe('Max records to return, default 50.'),
    },
    async ({ file_key, since, limit }) => {
      const rootPath = config.PROJECT_ROOT;

      if (config.TASK_BACKEND !== 'api') {
        return {
          content: [{ type: 'text', text: 'list_knowledge_conflicts requires TASK_BACKEND=api with API_BASE_URL, API_PROJECT_ID, and API_TOKEN set' }],
          isError: true,
        };
      }

      try {
        const { baseUrl, projectId: pid, token } = getApiCredentials(rootPath);
        const { fetchConflictRecords } = require('../cli/knowledge-sync');
        const data = await fetchConflictRecords(baseUrl, pid, token, { fileKey: file_key, since, limit });
        return { content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, ...data }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `list_knowledge_conflicts error: ${err.message}` }], isError: true };
      }
    }
  );

  // ── get_knowledge_conflict ──

  server.tool(
    'get_knowledge_conflict',
    `Fetch one full KB conflict record by id, including the overwritten content that was clobbered by another writer's push (C1220). Get the id from list_knowledge_conflicts. Returns { id, file_key, overwritten_content, overwritten_version, created_at, overwritten_by }. ${projectScopeNote}`,
    {
      record_id: z.number().int().min(1).describe('Conflict record id, from list_knowledge_conflicts.'),
    },
    async ({ record_id }) => {
      const rootPath = config.PROJECT_ROOT;

      if (config.TASK_BACKEND !== 'api') {
        return {
          content: [{ type: 'text', text: 'get_knowledge_conflict requires TASK_BACKEND=api with API_BASE_URL, API_PROJECT_ID, and API_TOKEN set' }],
          isError: true,
        };
      }

      try {
        const { baseUrl, projectId: pid, token } = getApiCredentials(rootPath);
        const { fetchConflictRecord } = require('../cli/knowledge-sync');
        const data = await fetchConflictRecord(baseUrl, pid, token, record_id);
        return { content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, ...data }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `get_knowledge_conflict error: ${err.message}` }], isError: true };
      }
    }
  );

  } // end if (!LOCAL_ONLY) — list_knowledge_conflicts .. get_knowledge_conflict

  // ── git_worktree_status ── (LOCAL_ONLY — always registered; see tt-mcp-server.md)
  // C1215 — read-only. Reports git worktree state so an agent can confirm where it is
  // (which worktree, which branch, is it clean) before committing — never creates or
  // mutates a worktree or the working tree itself. Gated at CALL time, not registration
  // time (registration is sync at MCP boot, on the critical path of every agent spawn):
  // if this project's vcs_type isn't 'git', return a plain explanatory message rather
  // than isError, mirroring how a VCS-off project simply gets no prompt directive at all.

  server.tool(
    'git_worktree_status',
    `Read live VCS permissions and runtime identity. With task_key, verify automatic merge completion across root and nested repos. Require verified:true before VCS writes and ready:true before completing; PR creation does not replace local merge. Never mutates git. ${projectScopeNote}`,
    { task_key: z.string().optional().describe('Task key to check before completion') },
    async ({ task_key }) => {
      await ensureBackend();
      if (task_key) {
        const result = await require('../server/git-merge/completion-guard').verifyTaskCompletion({
          backend, projectRoot: config.PROJECT_ROOT, taskId: normalizeTaskKey(task_key),
        });
        return { content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, ...result }) }], isError: !result.verified };
      }
      const context = await require('../server/vcs-context').readVcsContext(backend);
      const { getGitWorktreeStatus } = require('./git-worktree');
      const result = context.verified && context.vcs.type === 'git' ? getGitWorktreeStatus(config.PROJECT_ROOT) : {};
      return { content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, ...context, ...result }) }], isError: !context.verified };
    }
  );

  server.tool(
    'complete_task',
    `Verify live VCS settings and required local merges, then post one resolution report and set the project's completion status. Refuses unmerged/dirty task branches, conflicts, incorrect gitlinks, and unknown verification. Run relevant checks first. Does not perform git writes. ${projectScopeNote}`,
    { task_key: z.string(), resolution: z.string().min(1).describe('Plain-English report: changes, files, verification results, follow-ups/caveats') },
    async ({ task_key, resolution }) => {
      await ensureBackend();
      const taskId = normalizeTaskKey(task_key);
      const result = await require('../server/git-merge/completion-guard').completeVerifiedTask({
        backend, projectRoot: config.PROJECT_ROOT, taskId, resolution,
      });
      taskCache.invalidate();
      return { content: [{ type: 'text', text: JSON.stringify({ project_id: projectId, ...result }) }], isError: !result.completed };
    }
  );

  if (timingEnabled) process.stderr.write(`[mcp:tipatask:checkpoint name=tools-registered ts=${Date.now()}]\n`);

  // ── Start ──

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Signal to parent claude-session.js stderr handler that MCP is ready.
  // Used to capture mcpServerStartedAt timing milestone for proc_startup profiling.
  process.stderr.write(`[mcp:tipatask:ready ts=${Date.now()}]\n`);
  if (timingEnabled) console.error(`[mcp] tipatask ready in ${Date.now() - t0}ms (imports + tools-registered + connect)`);
  else console.error('[mcp] tipatask server running');

  // Warm arch cache after handshake — off the critical path; listSystemTags/_rescan handles
  // first-call correctness if a tool call beats this.
  setImmediate(() => {
    try {
      const primed = cache.loadAll();
      console.error(`[mcp] arch cache primed (deferred): ${primed.count} tags in ${primed.ms}ms`);
    } catch (err) {
      console.error(`[mcp] arch cache prime failed: ${err.message}`);
    }
  });
}

main().catch((err) => {
  console.error('[mcp] Fatal:', err.message);
  process.exit(1);
});
