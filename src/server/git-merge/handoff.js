'use strict';

// TPT345 — pure builder of the conflict hand-off (and, TPT614, the Finish hand-off below): the
// kickoff prompt for a terminal agent
// session scoped to resolving one stopped merge, plus the manual command list the panel
// shows. Echo-safe for every agent (no line ends in `?`, no bare "Plan ready." line, no
// `[y/n]`) — Pi echoes its kickoff prompt verbatim and prompt-detect.js scans it.
//
// The terminal session that receives this prompt is also wrapped in the project's Version
// Control directive (vcs-settings.js). With `vcs_commit_enabled` off that directive says
// "Do not commit" and forbids `git add`, so `commitEnabled` (default false — the same
// fail-open-to-prohibition as the directive) switches steps 4/closing to a no-stage,
// no-commit wording: the agent only resolves the files, the user stages them and presses
// Continue (resume commits the prepared merge message once no unmerged paths remain).

const MAX_TASK_DESC = 1500;
const MAX_PRIOR_DESC = 600;
const MAX_PROMPT = 6000;

function clip(text, max) {
  const s = String(text || '').replace(/\r\n/g, '\n').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 15).trimEnd() + ' ... (truncated)';
}

function echoSafe(text) {
  return String(text || '').split('\n').map(l => l.replace(/\?\s*$/, '.')).join('\n');
}

function buildManualCommands({ repoPath, conflictedPaths }) {
  const paths = (conflictedPaths || []).map(p => JSON.stringify(p)).join(' ');
  return [
    `cd ${JSON.stringify(repoPath)}`,
    'git status',
    '# edit each conflicted file, keep BOTH tasks working, then:',
    `git add ${paths || '<paths>'}`,
    'git commit --no-edit',
    '# then press Continue in the Task App (or undo this merge with: git merge --abort)',
  ];
}

function buildConflictHandoff({ repo, branch, taskKey, target, conflictedPaths = [], task = null, priorTasks = [], mergeMessage = '', commitEnabled = false }) {
  const repoPath = repo && repo.path ? repo.path : String(repo || '');
  const repoLabel = repo && repo.relPath ? repo.relPath : 'root';
  const commitRange = `${target}..${branch}`;
  const lines = [];
  lines.push(`You are resolving a git merge conflict for task ${taskKey} in the ${repoLabel} repository at ${repoPath}.`);
  lines.push(`The Task App ran \`git merge --no-ff ${branch}\` into ${target} (commit message "${mergeMessage || `Merge ${branch}`}") and it stopped with conflicts in:`);
  for (const p of conflictedPaths) lines.push(`- ${p}`);
  lines.push('');
  if (task) {
    lines.push(`Task ${taskKey} (${task.title || 'no title'}), branch ${branch}, commits ${commitRange}:`);
    lines.push(echoSafe(clip(task.description, MAX_TASK_DESC)) || '(no description)');
    lines.push('');
  }
  if (priorTasks.length) {
    lines.push('Already merged into the target earlier in this run and touching the same files:');
    for (const t of priorTasks) {
      lines.push(`- ${t.key} (${t.title || 'no title'}): ${echoSafe(clip(t.description, MAX_PRIOR_DESC)) || '(no description)'}`);
    }
    lines.push('');
  }
  lines.push('Steps:');
  lines.push(`1. cd ${JSON.stringify(repoPath)} and run git status, then git diff, to see the conflict markers.`);
  lines.push('2. Open each conflicted file and combine BOTH sides so every task listed above keeps working. Do not pick one side wholesale; both changes are intentional.');
  lines.push('3. Run the relevant tests for the touched files.');
  lines.push(commitEnabled
    ? '4. git add the resolved files, then run git commit --no-edit (keep the prepared merge message). Do not add Co-Authored-By or any tool attribution. Do not push.'
    : '4. Commit permission is disabled for this project: do not run git add or git commit. Leave the resolved files in the working tree; the user stages them and finishes the merge commit. Do not add Co-Authored-By or any tool attribution. Do not push.');
  lines.push('5. Do not run git merge --abort, git reset, or git rebase. Do not touch other worktrees or branches.');
  lines.push(commitEnabled
    ? 'When the merge commit exists, say "Conflict resolved" so the user can press Continue in the Task App.'
    : 'When every conflict marker is gone and the tests pass, say "Conflict resolved" and list the files; the user stages them, then presses Continue in the Task App.');
  let prompt = lines.join('\n');
  if (prompt.length > MAX_PROMPT) prompt = prompt.slice(0, MAX_PROMPT - 15).trimEnd() + ' ... (truncated)';
  return {
    prompt,
    manualCommands: buildManualCommands({ repoPath, conflictedPaths }),
    ingredients: {
      repoPath,
      commitEnabled: !!commitEnabled,
      repoId: repo && repo.id ? repo.id : repoLabel,
      commitRange,
      conflictedPaths: [...conflictedPaths],
      task: task ? { key: task.key || taskKey, title: task.title || '', description: clip(task.description, MAX_TASK_DESC) } : null,
      priorTasks: priorTasks.map(t => ({ key: t.key, title: t.title || '', description: clip(t.description, MAX_PRIOR_DESC) })),
    },
  };
}

// TPT614 — the Finish card action's kickoff. A task the exit backstop flagged (terminal-session.js
// flagTaskLeftUncommitted(): its terminal ended with the task still in progress and its required
// commit missing) is reopened in a fresh terminal with this prompt, so the agent picks up where the
// last run stopped — finish, follow-up capture, commit, guarded completion — instead of starting the
// task over from its description. `blockers` is the read-only commit check's actionable set
// (completion-nudge.js uncommittedBlockers(), served by GET /api/tasks/:key/finish-prompt), one
// readable line each. `commitEnabled` follows the live commit flag exactly like
// buildConflictHandoff above, because the same Version Control directive wraps this prompt; with
// commits on that directive also ends with a definition-of-done line (vcs-settings.js
// buildDefinitionOfDone()), so this prompt never offers to commit later, never stops to hand the
// completion back, and names the guarded completion tool as the only way to complete. Echo-safe
// like the conflict hand-off (no `?`, no bare readiness line, no [y/n]).
const MAX_FINISH_BLOCKERS = 8;
const MAX_BLOCKER_LINE = 400;

function buildFinishHandoff({ taskKey, blockers = [], commitEnabled = false } = {}) {
  const key = String(taskKey || '').trim();
  const { describeBlocker } = require('../completion-nudge');
  const rows = [];
  for (const b of Array.isArray(blockers) ? blockers : []) {
    const code = b && typeof b.code === 'string' ? b.code : '';
    const message = code ? echoSafe(clip(describeBlocker(b), MAX_BLOCKER_LINE)) : '';
    if (!code || !message || rows.some(r => r.code === code && r.message === message)) continue;
    rows.push({ code, message });
  }
  const lines = [];
  lines.push(`You are finishing task ${key}. Its previous terminal session ended while the task was still in progress and its completion was blocked; the Task App's exit backstop recorded that on the task.`);
  lines.push(rows.length
    ? 'Blockers found by a read-only check just now:'
    : 'A read-only check just now could not name a specific blocker; treat the task as not yet committed and not yet completed.');
  for (const r of rows.slice(0, MAX_FINISH_BLOCKERS)) lines.push(`- ${r.code}: ${r.message}`);
  lines.push('');
  lines.push('Steps:');
  lines.push(`1. Read task ${key} and its comments; the resolution comment headed "Agent exited without committing / completing" says how the last run ended. Run git status and git diff to see what that run left in the working tree. Do not start the task over and do not revert or discard any of its changes.`);
  lines.push('2. Finish whatever the previous run left incomplete, then run the relevant tests for the touched files.');
  lines.push('3. Do follow-up capture unless the task comments already show it was done: search the pending and on_fire tasks, comment on the ones a finding affects, and file the remaining findings as tasks.');
  lines.push(commitEnabled
    ? `4. git add only this task's own files and commit them with a message starting with ${key}: (one commit per repository you changed, in the checkout or task worktree the version-control block above names). Do not add Co-Authored-By or any tool attribution. Do not push unless that block enables pull requests. Run any merge step that block enables.`
    : '4. Commit permission is disabled for this project: do not run git add or git commit. Leave the changes in the working tree for the user and name the changed files in your report. Do not add Co-Authored-By or any tool attribution. Do not push.');
  lines.push(`5. Call complete_task(${key}, resolution) with your plain-English resolution report (what changed and why, key files, how to verify, follow-ups); on Pi, run tt complete ${key} with the report on stdin. That guarded tool is the only way to complete this task: never write the completion status with update_task, and never end this session with the task still in progress or with an offer to commit or complete it later.`);
  lines.push('If a blocker truly cannot be cleared, post the same report with create_task_comment (type resolution), set the task on_fire and state the blocker.');
  let prompt = lines.join('\n');
  if (prompt.length > MAX_PROMPT) prompt = prompt.slice(0, MAX_PROMPT - 15).trimEnd() + ' ... (truncated)';
  return { prompt, ingredients: { taskKey: key, commitEnabled: !!commitEnabled, blockers: rows } };
}

module.exports = { buildConflictHandoff, buildFinishHandoff, buildManualCommands, clip, echoSafe, MAX_PROMPT };
