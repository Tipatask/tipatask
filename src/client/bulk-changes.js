// (TPT9159) Staged edits of the board's bulk action bar. Picking a value in Move to, Status,
// Agent (with its Model and Effort), Assignee, Permission mode or Cowboy scope only records it here; Apply turns the record
// into one PATCH body per selected task. Pure, so node:test can drive it directly.
//
// Shape (every key optional, absent = no change):
//   priority          raw sprint-combo value: a sprint number string, 'null' (Backlog), '__new__'
//   status            status name
//   agent             'human' | 'claude' | 'codex' | 'pi'
//   model             (TPT9212) the Model select's explicit pick for the staged agent: a Claude or
//                     Codex model id, or a Pi row id. Absent = the agent's resolved default
//                     (resolveBulkAgentModel()). Never beside Human; dropped when another agent
//                     is staged
//   effort            (TPT9323) the agent picker's Effort flyout pick for the staged agent: an
//                     EFFORT_LEVELS entry ('low' | 'medium' | 'high' | 'max'), or null for Agent
//                     default, which clears each task's saved level (tasks.effort, the field the
//                     Task Edit modal's Effort row saves). Absent = every task keeps its own
//                     effort. Only beside 'claude' or 'codex' (BULK_EFFORT_AGENTS); dropped when
//                     another agent, Human or none is staged
//   claudeDesignMode  boolean, only beside agent 'claude'
//   assignee          member user id; assigneeName is its display text for the picker input
//   permissionMode    'plan' | 'auto' | 'bypass' | null (Project Default clears the override)
//   cowboyScope       'disabled' | 'related' | 'project'; (TPT9322) only beside permissionMode
//                     'bypass', so Apply always saves it together with Bypass
//
// (TPT9417) The record applies only to the selected tasks this user may change: a task whose
// canEdit (the API's can_edit, task-edit-rule.js) is false gets no PATCH, and Apply reports it as
// skipped — splitBulkEditable(), bulkApplyWrites().

import { normalizeCowboyScope, effectivePermissionMode } from './permission-mode.js';
import { EFFORT_LEVELS } from './constants.js';
import { taskEditLocked } from './task-edit-rule.js';

export const BULK_CHANGE_FIELDS = Object.freeze(['priority', 'status', 'agent', 'assignee', 'permissionMode', 'cowboyScope']);

// (TPT9212) The task field each agent's model is saved in. Human runs no model.
export const BULK_MODEL_FIELDS = Object.freeze({ claude: 'claude_model', codex: 'codex_model', pi: 'pi_model' });

// (TPT9323) The agents whose launch reads a task's effort: Claude (CLAUDE_CODE_EFFORT_LEVEL and
// --effort) and Codex (model_reasoning_effort). Pi has no effort setting and Human runs no agent,
// the same Claude/Codex gate as the Task Edit modal's Effort row.
export const BULK_EFFORT_AGENTS = Object.freeze(['claude', 'codex']);

function agentHasModels(agent) {
  return typeof agent === 'string' && Object.hasOwn(BULK_MODEL_FIELDS, agent);
}

export function agentHasEffort(agent) {
  return BULK_EFFORT_AGENTS.includes(agent);
}

// An effort a PATCH may carry: a known level, or null (Agent default).
function isEffortValue(effort) {
  return effort === null || EFFORT_LEVELS.includes(effort);
}

// (TPT9212) The model Apply saves with a staged agent, or null when the agent has none to offer
// (Human, or Pi before its rows are known). `models` is the agent's available list —
// `{ value, isLatest? }` entries or plain ids — and only one of its ids is ever returned, in
// this order:
//   1. `picked`, the Model select's explicit choice;
//   2. `configuredDefault`, the project's own default for the agent (CLAUDE_MODEL, CODEX_MODEL,
//      or for Pi the row a start without a model runs), skipped when the agent no longer
//      offers it, so a stale setting is never written;
//   3. the agent's recommended model: the first entry flagged isLatest, else the first entry.
// Saving the answer gives every launch an explicit model: a Codex task with none falls back to
// the model in its Codex config, which the CLI may no longer serve.
export function resolveBulkAgentModel(agent, { picked = null, models = [], configuredDefault = null } = {}) {
  if (!agentHasModels(agent)) return null;
  const entries = (Array.isArray(models) ? models : []).map((m) => (m && typeof m === 'object'
    ? { id: String(m.value ?? m.id ?? '').trim(), isLatest: m.isLatest === true }
    : { id: String(m ?? '').trim(), isLatest: false })).filter(m => m.id);
  if (!entries.length) return null;
  const offered = (value) => {
    const id = String(value ?? '').trim();
    return id ? (entries.find(m => m.id === id)?.id ?? null) : null;
  };
  return offered(picked) ?? offered(configuredDefault) ?? (entries.find(m => m.isLatest) ?? entries[0]).id;
}

export function hasBulkChanges(changes) {
  return !!changes && BULK_CHANGE_FIELDS.some(key => changes[key] !== undefined);
}

export function stagedBulkFields(changes) {
  return changes ? BULK_CHANGE_FIELDS.filter(key => changes[key] !== undefined) : [];
}

// Returns a new record with `key` staged, or unstaged when `value` is undefined, null or ''.
// Permission mode keeps null as an explicit Project Default pick; '' still unstages it.
// (TPT9322) A Cowboy scope belongs to a staged Bypass, the way Design mode belongs to a staged
// Claude: it stages only while permissionMode is 'bypass', and staging any other permission
// mode (Plan, Auto, Project Default) or unstaging the mode drops it.
export function stageBulkField(changes, key, value, extra = {}) {
  const next = { ...changes };
  if (value === undefined || (value === null && key !== 'permissionMode') || value === '') {
    delete next[key];
    for (const extraKey of Object.keys(extra)) delete next[extraKey];
  } else if (key === 'cowboyScope' && next.permissionMode !== 'bypass') {
    return next;
  } else {
    next[key] = key === 'cowboyScope' ? normalizeCowboyScope(value) : value;
    Object.assign(next, extra);
  }
  if (key === 'permissionMode' && next.permissionMode !== 'bypass') delete next.cowboyScope;
  return next;
}

// Design mode belongs to Claude only: staging Claude keeps a value already staged for it
// (false when there is none), staging another agent or none drops it, so the next Claude pick
// starts unchecked again. (TPT9212) A Model pick belongs to the agent it was made for the same
// way: staging that agent again keeps it, any other agent (or none) drops it, so the new agent
// starts on its own resolved default. `model` stages a pick together with the agent, for a
// picker option that carries one (a Pi row). (TPT9323) So does an Effort pick: picking the same
// agent's row again keeps it, another agent, Human or none drops it, and every task then keeps
// its own effort.
export function stageBulkAgent(changes, agent, model = null) {
  const next = { ...changes };
  if (!agent) {
    delete next.agent;
    delete next.model;
    delete next.effort;
    delete next.claudeDesignMode;
    return next;
  }
  const sameAgent = next.agent === agent;
  next.agent = agent;
  if (agentHasModels(agent) && model) next.model = model;
  else if (!sameAgent || !agentHasModels(agent)) delete next.model;
  if (!sameAgent || !agentHasEffort(agent)) delete next.effort;
  if (agent === 'claude') next.claudeDesignMode = next.claudeDesignMode === true;
  else delete next.claudeDesignMode;
  return next;
}

// (TPT9323) The Effort flyout's pick for the staged agent — stage the agent first
// (stageBulkAgent()), so one flyout pick records both. A level stages that level; null stages
// Agent default, which Apply saves as a cleared effort; '' or undefined removes the pick, so
// every task keeps its own effort. Nothing stages without a staged Claude or Codex, and an
// unknown level leaves the record as it was.
export function stageBulkEffort(changes, effort) {
  const next = { ...changes };
  if (!agentHasEffort(next.agent)) {
    delete next.effort;
    return next;
  }
  if (effort === undefined || effort === '') {
    delete next.effort;
    return next;
  }
  const level = typeof effort === 'string' ? effort.trim().toLowerCase() : effort;
  if (isEffortValue(level)) next.effort = level;
  return next;
}

// (TPT9212) The Model select's explicit pick for the staged agent. An empty value removes the
// pick, which puts the agent back on its resolved default. Nothing to pick without a staged
// agent that has models.
export function stageBulkModel(changes, model) {
  const next = { ...changes };
  if (!agentHasModels(next.agent)) {
    delete next.model;
    return next;
  }
  if (model === undefined || model === null || model === '') delete next.model;
  else next.model = model;
  return next;
}

export function stageBulkDesignMode(changes, on) {
  if (changes?.agent !== 'claude') return { ...changes };
  return { ...changes, claudeDesignMode: !!on };
}

// Enabling Cowboy requires every selected task's effectivePermissionMode(), including the
// project default it inherits, to be Bypass. A staged permissionMode replaces the saved
// override (null clears it), so permissions and scope can be applied together. Apply runs it
// before any write as a backstop: a record built with stageBulkField() always carries Bypass
// beside a scope (TPT9322), which passes. Disabling needs no permission change.
export function bulkCowboyBlockedTaskIds(changes, tasks, projectDefault) {
  if (changes?.cowboyScope === undefined || normalizeCowboyScope(changes.cowboyScope) === 'disabled') return [];
  return tasks.filter(task => effectivePermissionMode(changes.permissionMode !== undefined
    ? { agentPermissionMode: changes.permissionMode } : task, projectDefault).mode !== 'bypass').map(task => task.id);
}

// One PATCH body for one selected task. `priority` is the resolved sprint number (0 = Backlog,
// sent as `sprint_id: null` — the backlog signal both the HTTP and the IPC update routes
// translate; the HTTP route rejects a literal priority 0). `model` is the model the staged agent
// is saved with — Apply passes resolveBulkAgentModel()'s answer; left out, it is the record's
// explicit pick. It goes in that agent's own field (BULK_MODEL_FIELDS); the other agents' model
// fields are left as they are. (TPT9323) A staged effort goes in `effort` (null = Agent
// default), beside Claude or Codex only. `reassign` is false for a task whose agent is locked (in
// progress, canceled): it gets every staged field except the agent, and the model, effort and
// Design mode ride only with the agent.
export function bulkPatchBody(changes, { priority, reassign = true, model = changes?.model } = {}) {
  const body = {};
  if (!changes) return body;
  if (priority !== undefined && priority !== null) {
    if (priority === 0) body.sprint_id = null;
    else body.priority = priority;
  }
  if (changes.status) body.status = changes.status;
  if (changes.assignee !== undefined) body.assignee = changes.assignee;
  if (changes.permissionMode !== undefined) body.agent_permission_mode = changes.permissionMode;
  if (changes.cowboyScope !== undefined) body.cowboy_mode = normalizeCowboyScope(changes.cowboyScope);
  if (changes.agent && reassign) {
    body.agent_assignee = changes.agent;
    if (agentHasModels(changes.agent) && model) body[BULK_MODEL_FIELDS[changes.agent]] = model;
    if (agentHasEffort(changes.agent) && isEffortValue(changes.effort)) body.effort = changes.effort;
    if (changes.agent === 'claude') body.claude_design_mode = changes.claudeDesignMode === true;
  }
  return body;
}

// (TPT9417) The selected tasks split by the API's task edit rule, ids in selection order:
// `viewOnly` holds every task whose canEdit is false (taskEditLocked()) — another member's task of
// the same or a higher role, or any task when the user's role cannot write — and `editable` the
// rest, a task without the flag (an API from before TPT9415) included. `tasks` are `{ id, canEdit }`
// rows; one without an id is dropped.
export function splitBulkEditable(tasks) {
  const editable = [];
  const viewOnly = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task?.id == null || task.id === '') continue;
    (taskEditLocked(task) ? viewOnly : editable).push(task.id);
  }
  return { editable, viewOnly };
}

// (TPT9417) Apply's writes: one `{ id, body }` per editable selected task with something to save
// (bulkPatchBody()), never one for a view-only task, which comes back in `skipped` for the bar to
// report. `reassignable` is the Set of ids whose agent may change (not in progress or canceled);
// without one, every task may.
export function bulkApplyWrites(changes, tasks, { priority, reassignable = null, model = changes?.model } = {}) {
  const { editable, viewOnly } = splitBulkEditable(tasks);
  const writes = [];
  for (const id of editable) {
    const body = bulkPatchBody(changes, { priority, reassign: !reassignable || reassignable.has(id), model });
    if (Object.keys(body).length) writes.push({ id, body });
  }
  return { writes, skipped: viewOnly };
}
