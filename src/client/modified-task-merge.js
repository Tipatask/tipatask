// ── Pure helpers for merging a `type:"modified"` objective-chat proposal onto a
//    live task (C1071) ──
// Deliberately dependency-light (no state.js/DOM imports) so these can be unit-tested
// directly under plain Node, the same way utils.js is (see utils.test.js) — chat-
// task-preview.js itself pulls in console-modal.js -> xterm, which only resolves through
// the app's esbuild bundle, not a bare Node import. status-registry.js (imported below)
// keeps this same contract — it only imports i18n.js + api-client.js, both of which are
// already safe under bare Node (see status-registry.js's own header comment).
import { isClosedName, inProgressName } from './status-registry.js';

// ── Fields a `modified` proposal may legitimately omit ──
// Mirrors DIFF_FIELDS in api-backend.js — the same set overwriteRaw diffs on.
// `status` is excluded BY DESIGN (C1072), not as a gap to hydrate later: a modified
// card never carries status unless the user explicitly edited it (see
// chat-task-preview.js's displayStatus / template.html's _statusEdited). Hydrating
// it here would bake a stale status into persisted chatState (localStorage) — a card
// saved days later would flip a since-completed task back to the stale value.
export const MODIFIED_HYDRATE_FIELDS = ['title', 'description', 'category', 'priority', 'order',
  'dependencies', 'tags', 'assignee', 'agentAssignee', 'claudeModel', 'codexModel', 'piModel',
  'effort', 'claudeDesignMode', 'due_date', 'parentDbId'];

// ── A field counts as "still needing hydration" ──
// Normally that's just `undefined` (the proposal never named the field). `title` gets
// one extra case (C1158): a whitespace-only string also counts as missing. Pre-C1158,
// a stale/unhydrated DOM read (captureCardEdits, Accept handler) could write a
// *defined* '' onto card.task.title, which then permanently blocked hydration since
// `!== undefined` treated it as "the user's real value" — poisoning the card forever
// (title is rejected empty by every write endpoint, so save then 400s in a loop with
// no way to self-heal). `description` deliberately keeps ONLY the `undefined` check —
// an empty description is a legal, intentional value (C922), unlike title.
function _isMissing(field, value) {
  if (value === undefined) return true;
  if (field === 'title' && typeof value === 'string' && !value.trim()) return true;
  return false;
}

// ── Fill in fields a `modified` card omitted, from the live task it targets ──
// Object.assign(existing, card.task) downstream means a hydrated card writes back
// identical values for untouched fields — a no-op — instead of wiping them. Returns
// true if anything was filled (caller can use this to decide whether to persist).
export function hydrateModifiedCard(card, existing) {
  if (!card || card.type !== 'modified' || !card.task || !existing) return false;
  let filled = false;
  for (const f of MODIFIED_HYDRATE_FIELDS) {
    if (!_isMissing(f, card.task[f])) continue;
    const v = existing[f];
    if (v === undefined) continue;
    card.task[f] = Array.isArray(v) ? [...v] : v;
    filled = true;
  }
  return filled;
}

// ── C1165: closed statuses a chat-driven edit reopens ──
// C1187: resolved via this project's own workflow roles (complete OR canceled) instead of
// a fixed literal-name list — status-registry.js is the shared client twin of
// src/server/status-roles.js. src/server/reopen-closed-task.js is the server-side
// counterpart for the two write paths (absent-target PATCH fallback and spec-chat) that
// don't go through applyModifiedCardToLiveTask below; that module resolves the registry
// itself (via fetchStatusContext) rather than sharing this client-side cache.

// ── Merge a `modified` card onto its live task, reopening it if it was closed (C1165) ──
// This is where a chat-driven edit is allowed to touch status — Object.assign(existing,
// card.task) alone (the pre-C1165 behavior) never does, since card.task.status is always
// absent (C1072). The write lands on `existing` (the live task object embedded in the
// TODO.md payload being rebuilt for PUT /api/todo), never on `card.task` itself, so the
// "a modified card carries no status" contract for the proposal object is untouched.
// `_statusEdited` (C1095/C1111 dual-panel diff modal) means the user explicitly chose a
// status for this card — that always wins over the reopen rule, even if they chose
// the complete/canceled role again on purpose.
export function applyModifiedCardToLiveTask(existing, card) {
  Object.assign(existing, card.task);
  if (!card._statusEdited && isClosedName(existing.status)) {
    existing.status = inProgressName();
  }
  return existing;
}

// Hydrate omitted proposal fields from the live task on every pass. Flip absent
// `modified` to `new` only with a fresh, unscoped snapshot; scoped lists can hide
// existing tasks and cause duplicate creation.
export function reconcileModifiedCards(msg, { flip = false } = {}) {
  if (!(msg?._existingTasksSnapshot instanceof Map)) return false;
  const cards = Array.isArray(msg.cards) ? msg.cards : [];
  const confirmedMask = msg.confirmedMask || [];
  let changed = false;
  cards.forEach((card, i) => {
    if (!card || card.type !== 'modified' || !card.task) return;
    const existing = msg._existingTasksSnapshot.get(card.task.id);
    if (!existing) {
      if (flip && !confirmedMask[i]) {
        card.type = 'new';
        changed = true;
      }
      return;
    }
    if (hydrateModifiedCard(card, existing)) changed = true;
  });
  return changed;
}

// ── Build a PATCH body for a modified preview card whose target is absent from TODO.md ──
// Status intentionally omitted: a modified card carries no status unless the user
// explicitly edited it (C1072), and even then task.status !== undefined already routes
// it correctly — this fn never reads status at all, so it can't overwrite a real
// task's lifecycle status (e.g. in_progress, completed) by accident.
// C1165: when the card has no explicit status (the normal case), the patch instead
// carries `reopen_if_closed: true` — an opt-in signal the server resolves against the
// LIVE task (backend.getTask, in ws-handlers.js's PATCH /api/tasks/:id and the IPC twin
// api:tasks.update) so a closed target reopens to in_progress the same way the primary
// merge path (applyModifiedCardToLiveTask above) does. If the card DOES carry an explicit
// user-chosen status (_statusEdited, C1111), that status is authoritative and the flag is
// omitted — the explicit choice must never be second-guessed by the reopen rule.
// Priority 0 (backlog) maps to sprint_id:null — the PATCH endpoint rejects priority < 1.
// Fields the proposal never touched are left OFF the patch entirely (not defaulted to ''/[])
// so a tags-only or priority-only modification can't wipe title/description/tags it didn't
// mention — the API PATCH endpoint treats an absent field as "leave unchanged".
export function buildModifiedTaskPatch(task) {
  const patch = {};
  if (task.title !== undefined) patch.title = task.title;
  if (task.description !== undefined) patch.description = task.description;
  if (task.tags !== undefined) patch.tags = Array.isArray(task.tags) ? task.tags : [];
  if (task.assignee !== undefined) patch.assignee = task.assignee || null;
  // (TPT197) Agent + per-agent model + design mode, now settable from the proposal-edit modal.
  // Same omit-when-undefined rule as every field above: a card that never touched them must
  // not send a null that clears the live task's pin. ws-handlers.js's PATCH proxy and the IPC
  // api:tasks.update twin both accept these snake_case keys.
  if (task.agentAssignee !== undefined) patch.agent_assignee = task.agentAssignee || null;
  if (task.claudeModel !== undefined) patch.claude_model = task.claudeModel || null;
  if (task.codexModel !== undefined) patch.codex_model = task.codexModel || null;
  if (task.piModel !== undefined) patch.pi_model = task.piModel || null;
  if (task.effort !== undefined) patch.effort = task.effort || null; // (TPT285)
  if (task.claudeDesignMode !== undefined) patch.claude_design_mode = !!task.claudeDesignMode;
  if (task.priority !== undefined) {
    const p = Number(task.priority ?? 0);
    if (p === 0) patch.sprint_id = null;
    else patch.priority = p;
  }
  if (task.status === undefined) patch.reopen_if_closed = true;
  // (C1559) adoptOriginKey() sets isObjective: false on the card it adopts — this is
  // the "turning it into a regular task" write for the absent-origin PATCH fallback.
  // Additive: no pre-C1559 caller ever sets isObjective on a card, so this is a no-op
  // for every existing modified-card patch.
  if (task.isObjective !== undefined) patch.is_objective = task.isObjective;
  return patch;
}

// ── Parse the objective-chat snapshot payload (C1110) ──
// Snapshot-only, deliberately NOT merged with chat-task-preview.js's parseTodoJson(): that one
// throws (a save must fail loudly), this one returns null (a snapshot must degrade silently —
// ensureExistingSnapshot() treats a failed/malformed fetch as "unknown", not "target absent").
// `scope` is echoed by GET /TODO.md?scope=all and is the caller's proof the list spans all
// assignees — only then may an absent target be flipped to `new` (see reconcileModifiedCards
// comment above). A legacy/unmarked payload (no `scope` key) parses fine but yields
// `scope: null`, so callers checking `scope === 'all'` correctly treat it as "unknown".
export function parseSnapshotPayload(text) {
  const match = String(text ?? '').match(/```json\s*([\s\S]*)```/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1].trim());
    return { tasks: Array.isArray(data.tasks) ? data.tasks : [], scope: data.scope ?? null };
  } catch {
    return null;
  }
}
