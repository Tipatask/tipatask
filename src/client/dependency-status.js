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
