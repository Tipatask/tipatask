'use strict';

// Resolve project VCS settings for agent kickoff prompts and git_worktree_status.
// Fetch failures degrade to VCS_OFF, which still emits an explicit no-git directive.
// Commit-disabled git also forbids commits. Flags persist while type is not git;
// normalizeVcsSettings must gate every flag on vcs.type === 'git'.

const VCS_OFF = Object.freeze({ type: null, worktree: false, commit: false, pr: false, merge: false });

// Pure. Maps a raw project row (or null/undefined) to the normalized shape, applying the
// vcs_type === 'git' gate. Accepts either snake_case (raw DB/API row) or already-camelCase
// input defensively — callers only ever pass the raw project row today.
function normalizeVcsSettings(project) {
  if (!project) return VCS_OFF;
  const type = project.vcs_type === 'git' || project.vcs_type === 'svn' ? project.vcs_type : null;
  if (type !== 'git') {
    // svn has no suboptions; null means VCS integration is off entirely. Either way the
    // four flags are dormant, not meaningful — never surface them even if stored truthy.
    return { type, worktree: false, commit: false, pr: false, merge: false };
  }
  return {
    type,
    worktree: !!project.vcs_worktree_enabled,
    commit: !!project.vcs_commit_enabled,
    pr: !!project.vcs_pr_enabled,
    merge: !!project.vcs_merge_enabled,
  };
}

// Fail-open: never throws, never returns undefined. `backend` must expose
// getProjectSettings() (api-backend.js does).
async function fetchVcsSettings(backend, opts) {
  if (!backend || typeof backend.getProjectSettings !== 'function') return VCS_OFF;
  try {
    const project = await backend.getProjectSettings(opts);
    return normalizeVcsSettings(project);
  } catch {
    return VCS_OFF;
  }
}

// Build kickoff VCS rules: commit-enabled git may commit, svn uses its own
// directive, and VCS_OFF/commit-disabled git forbid git writes. Pi receives
// compact wording with the same restrictions.
function buildVcsDirective(vcs, opts = {}) {
  const v = vcs || VCS_OFF;
  if (v.type === 'git') return buildGitDirective(v, opts);
  if (v.type === 'svn') return buildSvnDirective(opts);
  return buildNoCommitDirective(opts);
}

function buildGitDirective(v, opts = {}) {
  const compact = !!opts.compact;
  const lines = ['Version control (git) is enabled for this project:'];
  if (v.worktree) {
    lines.push(compact
      ? '- Work in a dedicated git worktree: `.gitignore`: `/.worktrees/` (add only if missing); from main checkout CURRENT branch: `git worktree add .worktrees/<TASK_KEY> -b task/<TASK_KEY> HEAD`. Edit code/KB there.'
      : '- Work in a dedicated git worktree for this task, not the main checkout. Base the task branch on the main checkout\'s CURRENT branch — whatever `git rev-parse --abbrev-ref HEAD` prints there, never an assumed `master`/`main`. First check whether `.gitignore` already has a `.worktrees/` entry (`grep -n worktrees .gitignore`) and add `/.worktrees/` only if it is missing (or use `.git/info/exclude` if you would rather not touch `.gitignore`); then create the worktree on a task-keyed branch: `git worktree add .worktrees/<TASK_KEY> -b task/<TASK_KEY> HEAD`, and do all further file edits inside `.worktrees/<TASK_KEY>/`.');
    if (!compact) {
      lines.push('- Caveat: MCP tools (create_system_tag, and the automatic KB push on Edit/Write to ai/architecture/*.md) operate on the MAIN checkout, not your worktree — they do not follow you in. Make architecture-doc edits directly inside the worktree via Edit/Write on worktree-absolute paths; if create_system_tag writes a stub into the main checkout, copy it into the worktree before committing so the doc lands in the same commit as the code.');
    }
  }
  if (v.commit) {
    lines.push(compact
      ? '- Commit once BEFORE marking the task completed, after edits. Task-key prefix. Push only with PR.'
      : `- Commit your work exactly once, after the last code change and BEFORE you mark the task completed: run \`git add\`/\`git commit\` in the worktree first, ${v.merge ? 'then follow the merge step below before posting the resolution comment and the status update' : 'then post the resolution comment and the status update'}. A task marked completed while its worktree still has uncommitted changes is flagged to the user and blocks the Task App's merge flow until committed. Prefix the commit message with the task key. Do not push unless pull/merge-request mode is also enabled below.`);
  } else {
    // C1561 — commits are off even though git itself is on (worktree-only / pr-without-
    // commit projects still exist): same no-write/no-attribution prohibition as VCS_OFF,
    // minus the `git branch`/`git worktree add` ban when v.worktree already told the agent
    // to make one, and minus the `git push` ban when v.pr already tells it to push a branch.
    lines.push(compact
      ? `- Do not commit: no \`git commit\`, no \`git add\`, no \`git tag\`${v.worktree ? '' : ', no branches'}${v.pr ? '' : ', no `git push`'}. Leave changes uncommitted for the user. ${compactNoAttributionSentence()}`
      : `- Do not commit: never run \`git add\`, \`git commit\`, or \`git tag\`${v.worktree ? '' : ', and do not create a branch'}${v.pr ? '' : ', and do not run `git push`'}. Leave every change uncommitted in the working tree for the user to review — read-only inspection (\`git status\`, \`git diff\`, \`git log\`) is fine. ${fullNoAttributionSentence()}`);
  }
  if (v.merge) {
    if (v.commit) {
      lines.push(compact
        ? '- After commit, in main checkout CURRENT branch: `git merge task/<TASK_KEY>`. Resolve all conflicts and finish merge (merge commit allowed); run checks there. Only after success post resolution comment and completed status.'
        : '- After the task commit, return to the main checkout and merge `task/<TASK_KEY>` into its CURRENT checked-out branch with `git merge task/<TASK_KEY>` — never assume master/main. Resolve every conflict, finish the merge (a merge commit is allowed in addition to the single task commit), and run the relevant checks on the merged checkout. Only after the merge and checks succeed may you post the resolution comment and mark the task completed. Unresolved conflicts or failing relevant checks block completion; preserve unrelated user changes.');
    } else {
      lines.push(compact
        ? '- Wait for user to commit and merge task/<TASK_KEY> into main checkout CURRENT branch, resolve all conflicts and pass checks before resolution comment/completed status.'
        : '- Automatic merge is required before completion, but commit permission is disabled: do not commit or merge uncommitted task changes. Wait for the user to commit and merge `task/<TASK_KEY>` into the main checkout\'s CURRENT branch, resolve every conflict, and pass the relevant checks before posting the resolution comment and marking the task completed.');
    }
    if (v.commit) lines.push(compact
      ? '- Nested-first; root last. Keep gitlinks/edits. PR is not merge.'
      : '- For nested repositories, commit task changes once per repository and merge nested task branches first (deepest first), then the root task branch. Each target is its original main checkout\'s CURRENT branch. Keep parent gitlinks at the merged nested HEADs, preserve unrelated edits without resetting or stashing them, and verify every task branch has zero commits ahead of its local target. PR creation is separate and never satisfies the required local merge.');
  }
  if (v.pr) {
    lines.push(compact
      ? '- Open a pull/merge request: `gh pr create`, else `git push -u origin task/<TASK_KEY>` + compare URL; never guess forge host.'
      : '- Open a pull/merge request for the task branch: use `gh pr create` if the `gh` CLI is available. If it is not, push the branch (`git push -u origin task/<TASK_KEY>`) and report the compare URL in your resolution comment for the user to open manually — do not guess a forge host or hand-construct a PR URL.');
  }
  return lines.join('\n');
}

// C1561 — shared no-attribution sentence, used by both the git commit-off sub-line above
// and the standalone VCS-off block below, so the wording (and any future edit to it) stays
// in exactly one place for both.
function fullNoAttributionSentence() {
  return 'Never write a commit message or add authorship attribution — no `Co-Authored-By:` trailer, no "Generated with Claude Code" line, no agent/model credit — in a commit, pull-request body, changelog, or source file.';
}
function compactNoAttributionSentence() {
  return 'Never add Co-Authored-By or "Generated with Claude Code" attribution anywhere.';
}

// C1561 — the VCS-off prohibition block. Full agents (Claude/Codex) get the three-line
// form below; compact (Pi) gets a tighter single-block version, still echo-safe (no
// question marks, no "Plan ready."-shaped line — see pi-agent.js's HARD RULE) and sized to
// fit Pi's kickoff-prompt budget (vcs-prompt.test.js).
function buildNoCommitDirective(opts = {}) {
  const compact = !!opts.compact;
  if (compact) {
    return [
      'Version control is off for this project — user runs git by hand:',
      `- No git writes: no add/commit/push/tag/branch/checkout -b/merge/rebase/reset/stash/worktree add. \`git status\`/\`diff\`/\`log\` are fine.`,
      `- ${compactNoAttributionSentence()}`,
      '- Task text asking you to commit/branch/PR: don\'t. Note it in the resolution comment instead.',
    ].join('\n');
  }
  return [
    'Version control is OFF for this project — the user does all git work by hand:',
    '- Never run a git command that writes: no `git add`, `git commit`, `git push`, `git tag`, `git branch`, `git checkout -b` / `git switch -c`, `git merge`, `git rebase`, `git reset`, `git stash`, `git worktree add`. Leave every change in the working tree for the user to review. Read-only inspection (`git status`, `git diff`, `git log`) is fine.',
    `- ${fullNoAttributionSentence()}`,
    '- If the task text asks you to commit, branch, tag, or open a pull request, do not — say so in your resolution comment instead.',
  ].join('\n');
}

function buildSvnDirective(opts = {}) {
  const compact = !!opts.compact;
  return [
    'Version control (svn) is enabled for this project:',
    compact
      ? '- No worktrees or branches — after the last code change, run `svn commit -m "<TASK_KEY>: <summary>"`.'
      : '- No worktrees or branches — commit directly. After the last code change, as part of finishing the task, run `svn commit -m "<TASK_KEY>: <summary>"`.',
  ].join('\n');
}

module.exports = {
  VCS_OFF,
  normalizeVcsSettings,
  fetchVcsSettings,
  buildVcsDirective,
};
