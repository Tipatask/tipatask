// (TPT9159) Staged edits of the board's bulk action bar. Picking a value in Move to, Status,
// Agent or Assignee only records it here; Apply turns the record into one PATCH body per
// selected task. Pure and import-free, so node:test can drive it directly.
//
// Shape (every key optional, absent = no change):
//   priority          raw sprint-combo value: a sprint number string, 'null' (Backlog), '__new__'
//   status            status name
//   agent             'human' | 'claude' | 'codex' | 'pi'
//   piModel           Pi row id, only beside agent 'pi' when the picker carried one
//   claudeDesignMode  boolean, only beside agent 'claude'
//   assignee          member user id; assigneeName is its display text for the picker input

export const BULK_CHANGE_FIELDS = Object.freeze(['priority', 'status', 'agent', 'assignee']);

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
    next[key] = value;
    Object.assign(next, extra);
  }
  return next;
}

// Design mode belongs to Claude only: staging Claude keeps a value already staged for it
// (false when there is none), staging another agent or none drops it, so the next Claude pick
// starts unchecked again.
export function stageBulkAgent(changes, agent, piModel = null) {
  const next = { ...changes };
  if (!agent) {
    delete next.agent;
    delete next.piModel;
    delete next.claudeDesignMode;
    return next;
  }
  next.agent = agent;
  if (agent === 'pi' && piModel) next.piModel = piModel;
  else delete next.piModel;
  if (agent === 'claude') next.claudeDesignMode = next.claudeDesignMode === true;
  else delete next.claudeDesignMode;
  return next;
}

export function stageBulkDesignMode(changes, on) {
  if (changes?.agent !== 'claude') return { ...changes };
  return { ...changes, claudeDesignMode: !!on };
}

// One PATCH body for one selected task. `priority` is the resolved sprint number (0 = Backlog,
// sent as `sprint_id: null` — the backlog signal both the HTTP and the IPC update routes
// translate; the HTTP route rejects a literal priority 0). `reassign` is false for a task whose
// agent is locked (in progress, canceled): it gets every staged field except the agent, and
// Design mode rides only with the agent.
export function bulkPatchBody(changes, { priority, reassign = true } = {}) {
  const body = {};
  if (!changes) return body;
  if (priority !== undefined && priority !== null) {
    if (priority === 0) body.sprint_id = null;
    else body.priority = priority;
  }
  if (changes.status) body.status = changes.status;
  if (changes.assignee !== undefined) body.assignee = changes.assignee;
  if (changes.agent && reassign) {
    body.agent_assignee = changes.agent;
    if (changes.agent === 'pi' && changes.piModel) body.pi_model = changes.piModel;
    if (changes.agent === 'claude') body.claude_design_mode = changes.claudeDesignMode === true;
  }
  return body;
}
