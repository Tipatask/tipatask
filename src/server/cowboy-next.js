'use strict';

// (TPT9162) Cowboy-coding chains: which tasks a finished cowboy run starts next. Pure — no IO;
// terminal-session.js launchCowboyChain() reads the inputs, applies the run gates and starts the
// picks. Rules (ai/architecture/tt-claude-session-terminal.md § Cowboy chains):
//  (a) every task that directly depends on the finished task and whose other dependencies are all
//      closed — every one of them starts;
//  (b) only when no dependent qualifies: exactly one other task of the finished task's sprint (same
//      `priority`; the backlog is not a sprint), lowest display order first.
// Both pass the same start checks: a not-started (workflow-start role) or urgent status, a CODING
// task, not an objective, not a reservation placeholder, not assigned to the human agent or to
// another member, no live session, and an effective permission mode of bypass.

const { validateMode } = require('./permission-policy');
const { isClosedName } = require('./status-roles');

// The urgent status carries no workflow role flag: the registry seeds it under this name
// (status-roles.js LEGACY_STATUSES) and the exit backstop finds it the same way.
const URGENT_STATUS = 'on_fire';
// console-modal.js buildTaskSessionPrompt() cuts the description at MAX_DESC_LEN (client
// constants.js); a chained start sends the kickoff a Start click sends.
const KICKOFF_DESC_MAX = 6000;
const LAUNCH_AGENTS = Object.freeze(['claude', 'codex', 'pi']);

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
// statusRoles: status-roles.js fetchStatusRoles(). projectMode: the project's effective default
// mode (null when unknown — inherited tasks then never qualify). liveTaskIds: keys with a live,
// starting or queued session. currentUserId: tasks assigned to anyone else are skipped (null skips
// that check, as the start gate fails open). Returns { tasks, reason: 'dependents'|'sprint'|'none' }.
function selectNextCowboyTasks(finishedTask, tasks, { statusRoles, projectMode = null, liveTaskIds = [], currentUserId = null } = {}) {
  const finishedKey = finishedTask?.id;
  if (!finishedKey || !statusRoles) return { tasks: [], reason: 'none' };
  const rows = (Array.isArray(tasks) ? tasks : []).filter(t => t && t.id);
  const byKey = new Map(rows.map(t => [t.id, t]));
  const live = new Set(liveTaskIds || []);
  const startable = task => task.id !== finishedKey
    && (task.status === statusRoles.start || task.status === URGENT_STATUS)
    && task.category === 'CODING'
    && !task.isObjective && !task.isReservation
    && task.agentAssignee !== 'human'
    && !(currentUserId != null && task.assignee != null && Number(task.assignee) !== Number(currentUserId))
    && !live.has(task.id)
    && effectivePermissionMode(task, projectMode) === 'bypass';
  const otherDepsClosed = task => (Array.isArray(task.dependencies) ? task.dependencies : [])
    .every(key => key === finishedKey || isClosedName(byKey.get(key)?.status, statusRoles));

  const dependents = rows
    .filter(t => Array.isArray(t.dependencies) && t.dependencies.includes(finishedKey) && startable(t) && otherDepsClosed(t))
    .sort(boardOrder);
  if (dependents.length) return { tasks: dependents, reason: 'dependents' };

  const sprint = Number(finishedTask.priority) || 0;
  if (sprint > 0) {
    const next = rows.filter(t => (Number(t.priority) || 0) === sprint && startable(t) && otherDepsClosed(t)).sort(boardOrder)[0];
    if (next) return { tasks: [next], reason: 'sprint' };
  }
  return { tasks: [], reason: 'none' };
}

// The kickoff a Start click sends for this task (console-modal.js buildTaskSessionPrompt()).
function chainKickoffPrompt(task) {
  const desc = String(task?.description || '');
  const cut = desc.length > KICKOFF_DESC_MAX ? `${desc.slice(0, KICKOFF_DESC_MAX)}... (truncated)` : desc;
  return `Work on task ${task.id}: ${task.title || task.id}. ${cut}`;
}

// The agent a chained start asks for: the task's own agent, else null (the project default).
function chainLaunchAgent(task) {
  return LAUNCH_AGENTS.includes(task?.agentAssignee) ? task.agentAssignee : null;
}

module.exports = {
  URGENT_STATUS,
  KICKOFF_DESC_MAX,
  effectivePermissionMode,
  selectNextCowboyTasks,
  chainKickoffPrompt,
  chainLaunchAgent,
};
