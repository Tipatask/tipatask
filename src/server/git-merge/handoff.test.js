'use strict';

// The conflict hand-off prompt is handed to a terminal agent session whose kickoff is also
// wrapped in the project's Version Control directive (vcs-settings.js). The two must never
// contradict: with commits off the directive forbids `git add`/`git commit`, so the hand-off
// must not tell the agent to run them; with commits on it must still finish the merge.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildConflictHandoff } = require('./handoff');
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
