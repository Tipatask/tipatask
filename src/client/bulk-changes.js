// (TPT9159) Staged edits of the board's bulk action bar. Picking a value in Move to, Status,
// Agent (with its Model), Assignee or Cowboy scope only records it here; Apply turns the record
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
//   claudeDesignMode  boolean, only beside agent 'claude'
//   assignee          member user id; assigneeName is its display text for the picker input
//   cowboyScope       'disabled' | 'related' | 'project'; never changes permission mode

import { normalizeCowboyScope, effectivePermissionMode } from './permission-mode.js';

export const BULK_CHANGE_FIELDS = Object.freeze(['priority', 'status', 'agent', 'assignee', 'cowboyScope']);

// (TPT9212) The task field each agent's model is saved in. Human runs no model.
export const BULK_MODEL_FIELDS = Object.freeze({ claude: 'claude_model', codex: 'codex_model', pi: 'pi_model' });

function agentHasModels(agent) {
  return typeof agent === 'string' && Object.hasOwn(BULK_MODEL_FIELDS, agent);
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
export function stageBulkField(changes, key, value, extra = {}) {
  const next = { ...changes };
  if (value === undefined || value === null || value === '') {
    delete next[key];
    for (const extraKey of Object.keys(extra)) delete next[extraKey];
  } else {
    next[key] = key === 'cowboyScope' ? normalizeCowboyScope(value) : value;
    Object.assign(next, extra);
  }
  return next;
}

// Design mode belongs to Claude only: staging Claude keeps a value already staged for it
// (false when there is none), staging another agent or none drops it, so the next Claude pick
// starts unchecked again. (TPT9212) A Model pick belongs to the agent it was made for the same
// way: staging that agent again keeps it, any other agent (or none) drops it, so the new agent
// starts on its own resolved default. `model` stages a pick together with the agent, for a
// picker option that carries one (a Pi row).
export function stageBulkAgent(changes, agent, model = null) {
  const next = { ...changes };
  if (!agent) {
    delete next.agent;
    delete next.model;
    delete next.claudeDesignMode;
    return next;
  }
  const sameAgent = next.agent === agent;
  next.agent = agent;
  if (agentHasModels(agent) && model) next.model = model;
  else if (!sameAgent || !agentHasModels(agent)) delete next.model;
  if (agent === 'claude') next.claudeDesignMode = next.claudeDesignMode === true;
  else delete next.claudeDesignMode;
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

// Enabling Cowboy requires every selected task to start in Bypass, including inherited
// defaults. Apply refuses the whole batch before writing; disabling needs no permission change.
export function bulkCowboyBlockedTaskIds(changes, tasks, projectDefault) {
  if (changes?.cowboyScope === undefined || normalizeCowboyScope(changes.cowboyScope) === 'disabled') return [];
  return tasks.filter(task => effectivePermissionMode(task, projectDefault).mode !== 'bypass').map(task => task.id);
}

// One PATCH body for one selected task. `priority` is the resolved sprint number (0 = Backlog,
// sent as `sprint_id: null` — the backlog signal both the HTTP and the IPC update routes
// translate; the HTTP route rejects a literal priority 0). `model` is the model the staged agent
// is saved with — Apply passes resolveBulkAgentModel()'s answer; left out, it is the record's
// explicit pick. It goes in that agent's own field (BULK_MODEL_FIELDS); the other agents' model
// fields are left as they are. `reassign` is false for a task whose agent is locked (in
// progress, canceled): it gets every staged field except the agent, and the model and Design
// mode ride only with the agent.
export function bulkPatchBody(changes, { priority, reassign = true, model = changes?.model } = {}) {
  const body = {};
  if (!changes) return body;
  if (priority !== undefined && priority !== null) {
    if (priority === 0) body.sprint_id = null;
    else body.priority = priority;
  }
  if (changes.status) body.status = changes.status;
  if (changes.assignee !== undefined) body.assignee = changes.assignee;
  if (changes.cowboyScope !== undefined) body.cowboy_mode = normalizeCowboyScope(changes.cowboyScope);
  if (changes.agent && reassign) {
    body.agent_assignee = changes.agent;
    if (agentHasModels(changes.agent) && model) body[BULK_MODEL_FIELDS[changes.agent]] = model;
    if (changes.agent === 'claude') body.claude_design_mode = changes.claudeDesignMode === true;
  }
  return body;
}
