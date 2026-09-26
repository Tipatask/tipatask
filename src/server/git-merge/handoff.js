'use strict';

// TPT345 — pure builder of the conflict hand-off: the kickoff prompt for a terminal agent
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

module.exports = { buildConflictHandoff, buildManualCommands, clip, echoSafe, MAX_PROMPT };
