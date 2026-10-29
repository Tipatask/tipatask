'use strict';

// (TPT9162) Cowboy-coding chains: which tasks a finished cowboy run starts next. Pure — no IO;
// terminal-session.js launchCowboyChain() reads the inputs, applies the run gates and starts the
// picks. Rules (ai/architecture/tt-claude-session-terminal.md § Cowboy chains):
//  (a) every task that directly depends on the finished task and whose other dependencies are all
//      closed — every one of them starts;
//  (b) only when no dependent qualifies: exactly one other task of the finished task's sprint (same
//      `priority`; the backlog is not a sprint), lowest display order first.
// Both pass the same start checks: not an objective, not a reservation placeholder, a CODING task,
// not assigned to the human agent, not a Pi image task, not assigned to another member, no live
// session, a not-started (workflow-start role) or urgent status, and every other dependency
// closed. (TPT9193) The candidate's own permission mode is not checked. Every candidate that fails
// a check is named in `skipped` with the code of the first check it failed (SKIP_REASONS order).
// (TPT9194) Each pick then runs with the finished run's agent and model, Bypass and Cowboy-coding
// mode: chainInheritance() / chainPickFields() / chainLaunchAgent().

const { validateMode } = require('./permission-policy');
const { isClosedName } = require('./status-roles');

// The urgent status carries no workflow role flag: the registry seeds it under this name
// (status-roles.js LEGACY_STATUSES) and the exit backstop finds it the same way.
const URGENT_STATUS = 'on_fire';
// (TPT9193) One code per start check, in the order the checks run.
const SKIP_REASONS = Object.freeze(['objective', 'reservation', 'category', 'human', 'image_task', 'other_assignee', 'live_session', 'status', 'deps_open']);
// console-modal.js buildTaskSessionPrompt() cuts the description at MAX_DESC_LEN (client
// constants.js); a chained start sends the kickoff a Start click sends.
const KICKOFF_DESC_MAX = 6000;
const LAUNCH_AGENTS = Object.freeze(['claude', 'codex', 'pi']);
// (TPT9194) The task field that pins each launch agent's model.
const MODEL_FIELDS = Object.freeze({ claude: 'claudeModel', codex: 'codexModel', pi: 'piModel' });

function modeOf(value) {
  try { return validateMode(value); } catch { return null; }
}

// The mode a task starts with: its own override, else the project default. An unknown stored
// override is never bypass and never falls back to the project default.
function effectivePermissionMode(task, projectMode) {
  const override = task?.agentPermissionMode ?? task?.agent_permission_mode;
  return override != null ? modeOf(override) : modeOf(projectMode);
}

// Board order: sprint, then display order, then key number.
function boardOrder(a, b) {
  return (Number(a.priority) || 0) - (Number(b.priority) || 0)
    || (Number(a.order) || 0) - (Number(b.order) || 0)
    || String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
}

// finishedTask: the fresh row of the task the run just finished. tasks: every task of the project
// (any assignee), so dependency statuses resolve; a dependency missing from it counts as unresolved.
// statusRoles: status-roles.js fetchStatusRoles(). liveTaskIds: keys with a live, starting or
// queued session. currentUserId: tasks assigned to anyone else are skipped (null skips that check,
// as the start gate fails open). isImageTask: (TPT9194) true for a task whose run is a Pi image
// operation — it never runs in bypass, and inheriting a text model would make it a coding run
// (omitted: no task is one). Returns { tasks, reason: 'dependents'|'sprint'|'none', skipped }:
// `skipped` is [{ key, reason }] in board order — every direct dependent that does not qualify and,
// when the sprint fallback runs, every other open task of that sprint that does not; a closed task
// of the sprint is no candidate and is left out. Each task is listed once.
function selectNextCowboyTasks(finishedTask, tasks, { statusRoles, liveTaskIds = [], currentUserId = null, isImageTask = null } = {}) {
  const finishedKey = finishedTask?.id;
  if (!finishedKey || !statusRoles) return { tasks: [], reason: 'none', skipped: [] };
  const rows = (Array.isArray(tasks) ? tasks : []).filter(t => t && t.id);
  const byKey = new Map(rows.map(t => [t.id, t]));
  const live = new Set(liveTaskIds || []);
  // The first start check `task` fails, as its SKIP_REASONS code, or null when it can start.
  const skipReason = task => {
    if (task.isObjective) return 'objective';
    if (task.isReservation) return 'reservation';
    if (task.category !== 'CODING') return 'category';
    if (task.agentAssignee === 'human') return 'human';
    if (isImageTask && isImageTask(task)) return 'image_task';
    if (currentUserId != null && task.assignee != null && Number(task.assignee) !== Number(currentUserId)) return 'other_assignee';
    if (live.has(task.id)) return 'live_session';
    if (task.status !== statusRoles.start && task.status !== URGENT_STATUS) return 'status';
    const otherDepsClosed = (Array.isArray(task.dependencies) ? task.dependencies : [])
      .every(key => key === finishedKey || isClosedName(byKey.get(key)?.status, statusRoles));
    return otherDepsClosed ? null : 'deps_open';
  };
  const skipped = [];
  const judged = new Set([finishedKey]);
  // The candidates that can start, in board order; the rest go to `skipped`.
  const startable = candidates => candidates.slice().sort(boardOrder).filter(task => {
    if (judged.has(task.id)) return false;
    judged.add(task.id);
    const reason = skipReason(task);
    if (reason) skipped.push({ key: task.id, reason });
    return !reason;
  });

  const dependents = startable(rows.filter(t => Array.isArray(t.dependencies) && t.dependencies.includes(finishedKey)));
  if (dependents.length) return { tasks: dependents, reason: 'dependents', skipped };

  const sprint = Number(finishedTask.priority) || 0;
  if (sprint > 0) {
    const next = startable(rows.filter(t => (Number(t.priority) || 0) === sprint && !isClosedName(t.status, statusRoles)))[0];
    if (next) return { tasks: [next], reason: 'sprint', skipped };
  }
  return { tasks: [], reason: 'none', skipped };
}

// The kickoff a Start click sends for this task (console-modal.js buildTaskSessionPrompt()).
function chainKickoffPrompt(task) {
  const desc = String(task?.description || '');
  const cut = desc.length > KICKOFF_DESC_MAX ? `${desc.slice(0, KICKOFF_DESC_MAX)}... (truncated)` : desc;
  return `Work on task ${task.id}: ${task.title || task.id}. ${cut}`;
}

// (TPT9194) What the next tasks of a chain inherit from the run that finished: its agent
// (session.taskAgent; null when no task can start with it) and the model it ran
// (session.taskAgentModel, the resolved --model; '' when it reported none).
function chainInheritance(run) {
  const agent = LAUNCH_AGENTS.includes(run?.taskAgent) ? run.taskAgent : null;
  const model = agent && typeof run.taskAgentModel === 'string' ? run.taskAgentModel.trim() : '';
  return { agent, model };
}

// (TPT9194) The fields written to a pick before it starts: the task override `bypass`, so the
// chained launch may run (spawnTerminal() refuses one outside bypass), and Cowboy-coding mode, so
// the chain goes on from it; with an inherited agent, also agentAssignee and that agent's model field.
function chainPickFields({ agent = null, model = '' } = {}) {
  const fields = { agentPermissionMode: 'bypass', cowboyMode: true };
  if (LAUNCH_AGENTS.includes(agent)) {
    fields.agentAssignee = agent;
    if (model) fields[MODEL_FIELDS[agent]] = model;
  }
  return fields;
}

// The agent a chained start asks for: (TPT9194) the agent the chain inherited, else the task's own
// agent, else null (the project default).
function chainLaunchAgent(task, inheritedAgent = null) {
  if (LAUNCH_AGENTS.includes(inheritedAgent)) return inheritedAgent;
  return LAUNCH_AGENTS.includes(task?.agentAssignee) ? task.agentAssignee : null;
}

module.exports = {
  URGENT_STATUS,
  SKIP_REASONS,
  KICKOFF_DESC_MAX,
  MODEL_FIELDS,
  effectivePermissionMode,
  selectNextCowboyTasks,
  chainKickoffPrompt,
  chainInheritance,
  chainPickFields,
  chainLaunchAgent,
};
