import state from './state.js';
import { isActiveName } from './status-registry.js';

function _dependencyStatus(taskIndex, key) {
  let entry;
  if (taskIndex instanceof Map) {
    entry = taskIndex.get(key);
  } else if (Array.isArray(taskIndex)) {
    entry = taskIndex.find(task => task?.id === key);
  } else if (taskIndex && typeof taskIndex === 'object') {
    entry = taskIndex[key];
  }
  return typeof entry === 'string' ? entry : entry?.status;
}

/**
 * (TPT9216) One task's status from any index shape the dependency gate reads below —
 * Map<taskKey, status|task>, a task array or a keyed object. undefined when the index
 * does not hold the key. task-card.js dependencyKeyStatus() resolves dependency keys
 * through it.
 */
export function taskIndexStatus(taskIndex, key) {
  return _dependencyStatus(taskIndex, key);
}

/**
 * Return dependency keys whose loaded task status is not completed/canceled.
 * Unknown dependencies deliberately fail open, matching the board's historical
 * behavior when its current task snapshot does not contain a dependency.
 *
 * taskIndex accepts Map<taskKey, status|task>, a task array, or a keyed object.
 */
export function unmetDependencyKeys(task, taskIndex = state.taskStatusById) {
  return (Array.isArray(task?.dependencies) ? task.dependencies : []).filter(key => {
    const status = _dependencyStatus(taskIndex, key);
    return status !== undefined && isActiveName(status);
  });
}

export function hasUnmetDeps(task, taskIndex = state.taskStatusById) {
  return unmetDependencyKeys(task, taskIndex).length > 0;
}

/**
 * (TPT552) True when the task already owns a session the user can reopen — live, exited
 * (scrollback kept) or parked in the server's start queue. Reopening one is not a launch.
 */
export function hasTaskSession(taskId) {
  if (!taskId) return false;
  return state.activeSessions.has(taskId)
    || state.exitedSessions.has(taskId)
    || !!state.queuedSessions?.has(taskId);
}

/**
 * (TPT552) The dependency gate blocks a fresh launch only. A task with an existing session
 * stays resumable even after pending follow-up tasks are added as its dependencies.
 */
export function startBlockedByDeps(task, taskIndex = state.taskStatusById) {
  return !hasTaskSession(task?.id) && hasUnmetDeps(task, taskIndex);
}
