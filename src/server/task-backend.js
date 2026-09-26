'use strict';

/**
 * Backend interface contract — the (only, api) backend implements:
 *
 *   init()                   → Promise<void>       Startup initialization
 *   getTasks()               → Promise<Array>       Tasks scoped to current user (assignee==me OR NULL)
 *   getTasksUnfiltered()     → Promise<Array>       All project tasks regardless of assignee — use for saves/agents/system paths
 *   updateTask(id, fields)   → Promise<object|null> Update task, return it (null if missing). api-backend.js's impl also
 *                              carries a best-effort side effect (TPT29): a fields.isObjective/is_objective true→false
 *                              transition (the C1559 single-task objective-adoption flow) captures the task's prior
 *                              title/description — plus its task_images/task_files attachment refs — as a
 *                              comment_type='spec' comment before the write lands. See origin-spec-capture.js.
 *   deleteTask(id)           → Promise<boolean>     Delete task, return true/false
 *   createTask(task)         → Promise<object>      Create new task, return it
 *   saveTasks(tasks)         → Promise<void>        Bulk overwrite all tasks
 *   overwriteRaw(content)    → Promise<void>        Raw overwrite of the full task set (server-synthesized TODO.md wire format)
 *   finalizeChanges(changes) → Promise<void>        Apply new/modified task changes
 *   getSprints()             → Promise<Array>       List sprint objects
 *   createSprint(name, num)  → Promise<object|null> Create sprint
 *   getStatuses()            → Promise<StatusRow[]>           Project's status registry: [{id, name, color, display_order, is_workflow_start, is_in_progress, is_workflow_complete, task_count}]. Live from GET /statuses (30s cache). Never throws — falls back to the legacy 5 on any failure (C1184).
 *   createStatus({name,color?,is_*?}) → Promise<StatusRow>    Add a status, appended last (C1182)
 *   updateStatus(id, fields) → Promise<StatusRow>             Rename/recolor/reorder/move-a-role on one status; a role can only be moved, never cleared (C1182)
 *   deleteStatus(id)         → Promise<boolean>               Delete a status; API 400s if it holds a role or has tasks (C1182)
 *   reorderStatuses(ids)     → Promise<StatusRow[]>            Renumber every status's display_order to match `ids`' position; `ids` must be the project's full status id set (C1182)
 *   getTags()                → Promise<string[]>              All tag name strings (for existing consumers)
 *   getTagsDetailed()        → Promise<{name,description}[]>  Tags with descriptions, from DB
 *   getProjectTags()         → Promise<Array>                 Project tag registry for modal typeahead
 *   ensureTag(name, desc?)   → Promise<void>                  Ensure tag exists
 *   getProjectMembers()      → Promise<Array>       Project members for mention UI
 *   getTaskComments(key)     → Promise<Array>       Task comments by task_key
 *   createTaskComment(key, content, type?) → Promise<object> Create task comment (type='comment'|'resolution'|'spec')
 *   updateTaskComment(key, commentId, content) → Promise<object|null> Edit an existing comment's content; author-only server-side — a mismatched author surfaces as a thrown Error with .statusCode=403 (TPT34)
 *   getTaskEvents(key)       → Promise<{events,total,subscribed}|null> Task-wide event log (reverse-chronological) + caller's effective subscription state (TPT17)
 *   setTaskSubscription(key, subscribed) → Promise<{subscribed}|null>  Set caller's per-task mute/follow override (TPT17)
 *   uploadImage(filename, mimeType, data, taskKey?) → Promise<{id,url}|null> Upload image, optionally linked to a task
 *   listTaskImages(taskKey)  → Promise<Array>       Images linked to task_key: [{id,url,filename,mime_type,created_at}] (C1012)
 *   uploadFile(filename, mimeType, data, taskKey?) → Promise<{id,url,filename,size_bytes}|null> Upload generic (non-image) file attachment, 1 MB cap (C1246)
 *   listTaskFiles(taskKey)   → Promise<Array>       Files linked to task_key: [{id,url,filename,mime_type,size_bytes,created_at}] (C1246)
 *   getRecipes()             → Promise<Array>       List recipe objects
 *   saveRecipe(content)      → Promise<object>      Save recipe, return {filename, duplicate}
 *   getChildren(parentKey)   → Promise<Array>       Child tasks of a parent (by task_key string)
 *   configure(cfg)           → void                 Switch runtime credentials/project; invalidates task cache.
 *
 * Task object shape:
 *   { id, title, description, category, status, priority, order, dependencies, tags: string[], assignee: number | null,
 *     hasChildren: boolean,   // derived by backend from parent relationships
 *     parentDbId: number|null,  // raw API parent_id integer
 *     parentId: string|null }   // task_key of parent, used for subtask creation
 *
 * cfg passed to createBackend() selects the backend. api-backend uses projectRoot
 * to live-read .tipatask/config.json; legacy .env is never a credential source.
 */

const { SEALING_REASONS, validateCredentials } = require('./auth-guard');

let _warnedRetired = false;

// (C1383) Fail closed on a known-dead token. Both factories below are synchronous —
// createBackend() is called at module top level (server/index.js) and
// createPerProjectBackend() from sync Electron paths (main/window-state.js) — so this
// runs auth-guard's validateCredentials() (sync, pure, no network) directly rather than
// awaiting api-backend.js's async method of the same name, and seals rather than throws:
// a throw here would crash the forked server at boot (createBackend() has no enclosing
// try/catch at its call site) or leave a sync Electron caller with no backend and no
// reauth UI. A sealed instance is still handed back — every apiRequest() on it rejects
// immediately with AuthCorruptedError instead of silently working, or worse, silently
// failing open. `missing` is deliberately NOT a sealing reason (see SEALING_REASONS) —
// an unconfigured project must still reach the setup wizard.
function _sealIfCorrupted(backend, projectRoot) {
  let verdict;
  try {
    verdict = validateCredentials(projectRoot);
  } catch {
    return; // never block a backend hand-off on this guard's own failure
  }
  if (!verdict.ok && SEALING_REASONS.has(verdict.reasonCode)) {
    console.warn(`[task-backend] Sealing backend — ${verdict.reason} (${verdict.reasonCode})`);
    backend.markAuthCorrupted(verdict.reason);
  }
}

// (C1352) The file task backend is retired — tasks are api-only now, on disk the app only
// caches knowledge-base files. Any config still carrying TASK_BACKEND="file" (stale
// .tipatask/config.json or legacy .env from before the retirement), or nothing at all,
// coerces to "api" instead of crashing at boot / every Electron window bind. An unrecognized
// value passes through unchanged — createBackend/createPerProjectBackend still throw on it.
function coerceBackendType(value) {
  const t = typeof value === 'string' ? value.trim() : '';
  if (t === 'api') return 'api';
  if (t === '' || t === 'file') {
    if (!_warnedRetired) {
      _warnedRetired = true;
      console.warn(`[task-backend] TASK_BACKEND="${t || '(unset)'}" is retired — the file task backend no longer exists; using "api".`);
    }
    return 'api';
  }
  return t;
}

function createBackend(cfg) {
  const type = coerceBackendType(cfg && cfg.TASK_BACKEND);

  if (type === 'api') {
    const b = require('./api-backend');
    b.configure(cfg);
    _sealIfCorrupted(b, cfg && cfg.PROJECT_ROOT); // (C1383) — both call sites pass the full config module as cfg
    return b;
  }

  throw new Error(`Unknown TASK_BACKEND: "${type}". Only "api" is supported ("file" is retired).`);
}

// Creates an isolated per-project backend instance (no shared singleton state).
// Used by Electron main process to give each BrowserWindow its own backend.
function createPerProjectBackend(cfg, projectRoot) {
  const type = coerceBackendType(cfg && cfg.TASK_BACKEND);

  if (type === 'api') {
    const { createApiBackend } = require('./api-backend');
    const b = createApiBackend(cfg, projectRoot);
    _sealIfCorrupted(b, projectRoot); // (C1383)
    return b;
  }

  throw new Error(`Unknown TASK_BACKEND: "${type}". Only "api" is supported ("file" is retired).`);
}

module.exports = { createBackend, createPerProjectBackend, coerceBackendType };
