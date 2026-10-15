'use strict';

// The conflict hand-off prompt is handed to a terminal agent session whose kickoff is also
// wrapped in the project's Version Control directive (vcs-settings.js). The two must never
// contradict: with commits off the directive forbids `git add`/`git commit`, so the hand-off
// must not tell the agent to run them; with commits on it must still finish the merge.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildConflictHandoff, buildFinishHandoff, MAX_PROMPT } = require('./handoff');
const { buildVcsDirective } = require('../vcs-settings');

const BASE = {
  repo: { path: '/tmp/repo', relPath: '', id: 'root' },
  branch: 'task/TPT1',
  taskKey: 'TPT1',
  target: 'main',
  conflictedPaths: ['src/a.js'],
  task: { title: 'Feature one', description: 'Adds feature one.' },
};

const TELLS_AGENT_TO_COMMIT = /git add the resolved files|then run git commit --no-edit/;

test('buildConflictHandoff: commitEnabled true -> stage + git commit --no-edit, closing line waits for the merge commit', () => {
  const { prompt, ingredients } = buildConflictHandoff({ ...BASE, commitEnabled: true });
  assert.match(prompt, /4\. git add the resolved files, then run git commit --no-edit \(keep the prepared merge message\)/);
  assert.match(prompt, /When the merge commit exists, say "Conflict resolved"/);
  assert.doesNotMatch(prompt, /Commit permission is disabled/);
  assert.equal(ingredients.commitEnabled, true);
});

test('buildConflictHandoff: commitEnabled false, or omitted -> no git add/commit instruction; user stages and presses Continue', () => {
  for (const args of [{ ...BASE, commitEnabled: false }, { ...BASE }]) {
    const { prompt, manualCommands, ingredients } = buildConflictHandoff(args);
    assert.match(prompt, /4\. Commit permission is disabled for this project: do not run git add or git commit\./);
    assert.doesNotMatch(prompt, TELLS_AGENT_TO_COMMIT);
    assert.match(prompt, /the user stages them, then presses Continue in the Task App/);
    assert.match(prompt, /Do not add Co-Authored-By/);
    assert.match(prompt, /Do not push/);
    // The manual command list is for the human at a shell, not the agent — it keeps the commit.
    assert.ok(manualCommands.includes('git commit --no-edit'));
    assert.equal(ingredients.commitEnabled, false);
  }
});

test('buildConflictHandoff: echo-safe in both flag states (no line ends in ?, no bare "Plan ready.", no [y/n])', () => {
  for (const commitEnabled of [true, false]) {
    const { prompt } = buildConflictHandoff({ ...BASE, commitEnabled });
    for (const line of prompt.split('\n')) {
      assert.ok(!/\?\s*$/.test(line), `line ends with ?: ${line}`);
      assert.doesNotMatch(line, /^\s*plan ready[.!]?\s*$/i);
    }
    assert.doesNotMatch(prompt, /\[y\/n\]/i);
  }
});

// Every git flag combination x full/compact directive: the hand-off's commit wording must agree
// with the directive it is wrapped in. `commit` is the only flag the hand-off depends on.
test('hand-off and Version Control directive never contradict, for every flag combination', () => {
  for (const worktree of [false, true]) for (const commit of [false, true]) for (const pr of [false, true]) for (const merge of [false, true]) {
    const vcs = { type: 'git', worktree, commit, pr, merge };
    const { prompt } = buildConflictHandoff({ ...BASE, commitEnabled: vcs.commit });
    for (const compact of [false, true]) {
      const directive = buildVcsDirective(vcs, { compact });
      const label = `worktree=${worktree} commit=${commit} pr=${pr} merge=${merge} compact=${compact}`;
      if (/Do not commit:/.test(directive)) {
        assert.doesNotMatch(prompt, TELLS_AGENT_TO_COMMIT, `directive forbids commits but hand-off tells the agent to commit (${label})`);
        assert.match(prompt, /do not run git add or git commit/, label);
      } else {
        assert.match(directive, /Commit (?:your work exactly )?once/, label);
        assert.match(prompt, /then run git commit --no-edit/, `directive allows the commit but hand-off withholds it (${label})`);
      }
    }
  }
});

// ── TPT614: Finish hand-off (the card's Finish action for a task the exit backstop flagged) ──
// Same contract as the conflict hand-off above — wrapped in the Version Control directive, so the
// commit wording follows the flag — plus the TPT611 done gate that directive ends with when commits
// are on: never an offer to commit or complete later, complete_task as the only completion path,
// and the TPT616 follow-up capture step kept.
const FINISH_BLOCKERS = [
  { code: 'TASK_COMMIT_MISSING', message: 'Commits are enabled for this project and no commit starting with TPT1 is reachable from the main checkout HEAD: git add the task changes and commit them with a message starting with TPT1 before completing the task.' },
  { code: 'unmerged_branch', path: '/tmp/repo', target: 'main', branch: 'task/TPT1', ahead: 2 },
];
const FINISH_TELLS_AGENT_TO_COMMIT = /git add only this task's own files and commit them with a message starting with TPT1:/;

test('buildFinishHandoff: commitEnabled true -> commit with the key prefix, then complete_task; one readable line per blocker', () => {
  const { prompt, ingredients } = buildFinishHandoff({ taskKey: 'TPT1', blockers: FINISH_BLOCKERS, commitEnabled: true });
  assert.match(prompt, /^You are finishing task TPT1\./);
  assert.match(prompt, /Blockers found by a read-only check just now:\n- TASK_COMMIT_MISSING: Commits are enabled/);
  assert.match(prompt, /\n- unmerged_branch: task branch not merged into the current branch: task\/TPT1 in \/tmp\/repo\n/);
  assert.match(prompt, FINISH_TELLS_AGENT_TO_COMMIT);
  assert.match(prompt, /Run any merge step that block enables/);
  assert.match(prompt, /5\. Call complete_task\(TPT1, resolution\)/);
  assert.match(prompt, /on Pi, run tt complete TPT1 with the report on stdin/);
  assert.match(prompt, /set the task on_fire and state the blocker/);
  assert.doesNotMatch(prompt, /Commit permission is disabled/);
  assert.deepEqual(ingredients, { taskKey: 'TPT1', commitEnabled: true, blockers: [
    { code: 'TASK_COMMIT_MISSING', message: FINISH_BLOCKERS[0].message },
    { code: 'unmerged_branch', message: 'task branch not merged into the current branch: task/TPT1 in /tmp/repo' },
  ] });
});

test('buildFinishHandoff: commitEnabled false, or omitted -> no git add/commit instruction, still complete_task', () => {
  for (const args of [{ taskKey: 'TPT1', blockers: FINISH_BLOCKERS, commitEnabled: false }, { taskKey: 'TPT1', blockers: FINISH_BLOCKERS }]) {
    const { prompt, ingredients } = buildFinishHandoff(args);
    assert.match(prompt, /4\. Commit permission is disabled for this project: do not run git add or git commit\./);
    assert.doesNotMatch(prompt, FINISH_TELLS_AGENT_TO_COMMIT);
    assert.match(prompt, /5\. Call complete_task\(TPT1, resolution\)/);
    assert.match(prompt, /Do not add Co-Authored-By/);
    assert.match(prompt, /Do not push/);
    assert.equal(ingredients.commitEnabled, false);
  }
});

test('buildFinishHandoff: no blockers, duplicates and junk -> generic line, each distinct blocker once, at most 8 listed, capped prompt', () => {
  const none = buildFinishHandoff({ taskKey: 'TPT1', blockers: [] });
  assert.match(none.prompt, /could not name a specific blocker/);
  assert.deepEqual(none.ingredients.blockers, []);
  const dup = buildFinishHandoff({ taskKey: 'TPT1', blockers: [FINISH_BLOCKERS[0], { ...FINISH_BLOCKERS[0] }, null, { message: 'no code' }] });
  assert.equal(dup.ingredients.blockers.length, 1);
  const huge = buildFinishHandoff({ taskKey: 'TPT1', blockers: Array.from({ length: 40 }, (_, i) => ({ code: `C${i}`, message: 'x'.repeat(390) })) });
  assert.ok(huge.prompt.length <= MAX_PROMPT);
  assert.equal((huge.prompt.match(/^- C\d+: /gm) || []).length, 8);
  assert.equal(huge.ingredients.blockers.length, 40);
});

test('buildFinishHandoff: echo-safe in both flag states (no ? at all, no bare "Plan ready.", no [y/n])', () => {
  for (const commitEnabled of [true, false]) {
    const { prompt } = buildFinishHandoff({ taskKey: 'TPT1', blockers: [{ code: 'TASK_COMMIT_MISSING', message: 'Is the commit missing?' }], commitEnabled });
    for (const line of prompt.split('\n')) {
      assert.ok(!/\?\s*$/.test(line), `line ends with ?: ${line}`);
      assert.doesNotMatch(line, /^\s*plan ready[.!]?\s*$/i);
    }
    assert.doesNotMatch(prompt, /\?/);
    assert.doesNotMatch(prompt, /\[y\/n\]/i);
  }
});

test('finish hand-off and Version Control directive never contradict, for every flag combination', () => {
  for (const worktree of [false, true]) for (const commit of [false, true]) for (const pr of [false, true]) for (const merge of [false, true]) {
    const vcs = { type: 'git', worktree, commit, pr, merge };
    const { prompt } = buildFinishHandoff({ taskKey: 'TPT1', blockers: FINISH_BLOCKERS, commitEnabled: vcs.commit });
    for (const compact of [false, true]) {
      const directive = buildVcsDirective(vcs, { compact });
      const label = `worktree=${worktree} commit=${commit} pr=${pr} merge=${merge} compact=${compact}`;
      if (/Do not commit:/.test(directive)) {
        assert.doesNotMatch(prompt, FINISH_TELLS_AGENT_TO_COMMIT, `directive forbids commits but the finish hand-off tells the agent to commit (${label})`);
        assert.match(prompt, /do not run git add or git commit/, label);
      } else {
        assert.match(directive, /Commit (?:your work exactly )?once/, label);
        assert.match(directive, /Definition of done|Done only when/, `directive lacks the TPT611 done gate (${label})`);
        assert.match(prompt, FINISH_TELLS_AGENT_TO_COMMIT, `directive requires the commit but the finish hand-off withholds it (${label})`);
      }
      // The done gate the directive ends with: no deferred commit or completion, one completion
      // path (never update_task), and follow-up capture never skipped.
      assert.doesNotMatch(prompt, /ready to commit when you confirm|wait for the user|ask the user whether|when you confirm/i, label);
      assert.match(prompt, /complete_task\(TPT1, resolution\)/, label);
      assert.equal((prompt.match(/update_task/g) || []).length, 1, `update_task may appear only in its prohibition (${label})`);
      assert.match(prompt, /never write the completion status with update_task/, label);
      assert.doesNotMatch(prompt, /skip(?:ping)? (?:the )?follow-up/i, label);
      assert.match(prompt, /3\. Do follow-up capture/, label);
    }
  }
});
