'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_NUDGES, NUDGE_TYPED_LINE, EXIT_BACKSTOP_HEADER, isNudgeCandidate, shouldNudge, buildNudgePrompt,
  shouldNudgeComplete, nudgeKind, buildCompleteNudgePrompt,
  shouldFlagExit, describeBlocker, uncommittedBlockers, buildExitBackstopComment,
} = require('./completion-nudge');
const {
  matchPromptLine,
  CODEX_PROMPT_PATTERNS,
  PI_PROMPT_PATTERNS,
  GENERIC_PROMPT_PATTERNS,
  buildLegacyPatternTable,
} = require('./task-agent/prompt-detect');

const ROLES = { start: 'pending', in_progress: 'in_progress', complete: 'completed', canceled: 'canceled' };
const COMMIT_ON = { type: 'git', worktree: false, commit: true, pr: false, merge: false };
const MISSING = [{ code: 'TASK_COMMIT_MISSING', message: 'Commits are enabled for this project and no commit starting with TPT9 is reachable from the main checkout HEAD: git add the task changes and commit them with a message starting with TPT9 before completing the task.' }];
const base = { status: 'in_progress', roles: ROLES, vcs: COMMIT_ON, blockers: MISSING, nudgeCount: 0 };

test('closed workflow roles never produce either idle nudge, including overlapping role flags', () => {
  const roles = { in_progress: 'Doing', complete: 'Shipped', canceled: 'Dropped' };
  for (const status of [roles.complete, roles.canceled]) {
    const input = { ...base, status, roles, verified: true, ready: true };
    assert.equal(nudgeKind(input), null);
    assert.equal(nudgeKind({ ...input, roles: { ...roles, in_progress: status } }), null);
  }
});

test('shouldNudge: only an in-progress task, commits on, with a commit/merge blocker, under the cap', () => {
  assert.equal(shouldNudge(base), true);
  assert.equal(shouldNudge({ ...base, nudgeCount: MAX_NUDGES - 1 }), true);
  assert.equal(shouldNudge({ ...base, nudgeCount: MAX_NUDGES }), false, 'max 2 nudges per session');
  assert.equal(MAX_NUDGES, 2);
  for (const status of ['completed', 'canceled', 'on_fire', 'pending', undefined]) {
    assert.equal(shouldNudge({ ...base, status }), false, `status ${status}`);
  }
  const custom = { ...ROLES, in_progress: 'Doing', complete: 'Shipped' };
  assert.equal(shouldNudge({ ...base, roles: custom, status: 'Doing' }), true, 'role name, not a literal');
  assert.equal(shouldNudge({ ...base, roles: custom, status: 'in_progress' }), false);
  assert.equal(shouldNudge({ ...base, vcs: { ...COMMIT_ON, commit: false } }), false, 'commits off');
  assert.equal(shouldNudge({ ...base, vcs: { type: 'svn', commit: true } }), false, 'svn');
  assert.equal(shouldNudge({ ...base, vcs: null }), false);
  assert.equal(shouldNudge({ ...base, blockers: [] }), false, 'reachable task commit');
  assert.equal(shouldNudge({ ...base, blockers: null }), false);
  for (const code of ['git_verification_failed', 'settings_unavailable', 'merge_in_progress', 'unresolved_conflicts']) {
    assert.equal(shouldNudge({ ...base, blockers: [{ code }] }), false, `${code} never nudges`);
  }
  for (const code of ['TASK_WORKTREE_DIRTY', 'unmerged_branch', 'dirty_task_worktree', 'gitlink_mismatch']) {
    assert.equal(shouldNudge({ ...base, blockers: [{ code }] }), true, `${code} nudges`);
  }
  assert.equal(isNudgeCandidate({ status: 'in_progress', roles: ROLES, vcs: COMMIT_ON }), true);
  assert.equal(shouldNudge(), false);
});

test('buildNudgePrompt: one line, follow-up capture before commit and completion, per-agent completion tool', () => {
  for (const agent of ['claude', 'codex', 'pi']) {
    const prompt = buildNudgePrompt('TPT9', MISSING, agent);
    assert.doesNotMatch(prompt, /[\r\n]/, `${agent}: single line`);
    assert.doesNotMatch(prompt, /\?/, `${agent}: no question mark anywhere`);
    assert.match(prompt, /TPT9 is still in progress/);
    assert.match(prompt, /commit them with a message starting with TPT9:/);
    assert.match(prompt, /follow-up capture/i);
    assert.match(prompt, /on_fire/);
    const followUps = prompt.search(/follow-up capture/i);
    assert.ok(followUps < prompt.indexOf('git add only'), `${agent}: follow-up capture comes before the commit`);
    assert.ok(followUps < prompt.search(/complete_task|tt complete/), `${agent}: follow-up capture comes before completion`);
  }
  assert.match(buildNudgePrompt('TPT9', MISSING, 'claude'), /mcp__tipatask-local__complete_task\(TPT9, resolution\)/);
  assert.match(buildNudgePrompt('TPT9', MISSING, 'codex'), /call complete_task\(TPT9, resolution\)/);
  assert.match(buildNudgePrompt('TPT9', MISSING, 'pi'), /tt complete TPT9/);
  assert.doesNotMatch(NUDGE_TYPED_LINE, /[\r\n?]/);
});

test('buildNudgePrompt: blocker summary is deduplicated, sanitized and capped; unknown blockers fall back', () => {
  const noisy = [
    { code: 'TASK_WORKTREE_DIRTY', message: 'Dirty\nworktree?' },
    { code: 'TASK_WORKTREE_DIRTY', message: 'Dirty\nworktree?' },
    { code: 'unmerged_branch' },
    { code: 'git_verification_failed' },
    { code: 'TASK_COMMIT_MISSING', message: 'x'.repeat(2000) },
  ];
  const prompt = buildNudgePrompt('TPT9', noisy, 'codex');
  assert.equal(prompt.match(/Dirty worktree/g).length, 1);
  assert.match(prompt, /task branch not merged/);
  assert.doesNotMatch(prompt, /git_verification_failed/);
  assert.ok(prompt.length < 1600, `capped: ${prompt.length}`);
  assert.match(buildNudgePrompt('TPT9', [], 'claude'), /no task commit found/);
});

// The nudge is pasted into the agent TUI and echoed back; it must never read as a prompt, a
// dialog or a readiness sentinel (same sweep as vcs-prompt.test.js for Pi's kickoff).
test('buildNudgePrompt / buildCompleteNudgePrompt: echoed text cannot false-trigger attention or plan-ready detection', () => {
  const tables = { pi: PI_PROMPT_PATTERNS, codex: CODEX_PROMPT_PATTERNS };
  for (const agent of ['claude', 'codex', 'pi']) {
    for (const prompt of [buildNudgePrompt('TPT9', [...MISSING, { code: 'unmerged_branch' }], agent), buildCompleteNudgePrompt('TPT9', agent)]) {
      if (tables[agent]) assert.equal(matchPromptLine(prompt, tables[agent]), null, `${agent} table matched`);
      assert.equal(matchPromptLine(prompt, GENERIC_PROMPT_PATTERNS), null, `${agent}: generic table matched`);
      for (const { re, agents } of buildLegacyPatternTable()) {
        if (agents && !agents.includes(agent)) continue;
        assert.ok(!re.test(prompt), `${agent}: tail-scoped pattern matched: ${re}`);
      }
      assert.doesNotMatch(prompt, /^[\s>│┃╎┆❯➤▶›*]*(plan|questions) ready[.!]?\s*$/im);
    }
  }
});

// ── Completion-only nudge (TPT650) ──
const READY = { status: 'in_progress', roles: ROLES, vcs: COMMIT_ON, verified: true, ready: true, blockers: [], nudgeCount: 0 };

test('nudgeKind: ready verification with an in-progress task is a completion nudge in every project shape', () => {
  for (const vcs of [COMMIT_ON, { ...COMMIT_ON, commit: false }, { ...COMMIT_ON, commit: false, merge: true }, { type: 'off' }, { type: 'svn', commit: true }, null]) {
    assert.equal(nudgeKind({ ...READY, vcs }), 'complete', JSON.stringify(vcs));
  }
  assert.equal(shouldNudgeComplete(READY), true);
  for (const status of ['completed', 'canceled', 'on_fire', 'pending', undefined]) {
    assert.equal(nudgeKind({ ...READY, status }), null, `status ${status}`);
  }
  const custom = { ...ROLES, in_progress: 'Doing', complete: 'Shipped' };
  assert.equal(nudgeKind({ ...READY, roles: custom, status: 'Doing' }), 'complete', 'role name, not a literal');
  assert.equal(nudgeKind({ ...READY, roles: custom, status: 'in_progress' }), null);
  assert.equal(nudgeKind({ ...READY, verified: false }), null, 'unverified settings read');
  assert.equal(nudgeKind({ ...READY, ready: false }), null, 'not ready, no nudge blocker');
  assert.equal(nudgeKind({ ...READY, ready: false, blockers: [{ code: 'git_verification_failed' }] }), null);
  assert.equal(nudgeKind({ ...READY, ready: 'yes' }), null, 'strict booleans');
  assert.equal(nudgeKind({ ...READY, nudgeCount: MAX_NUDGES - 1 }), 'complete');
  assert.equal(nudgeKind({ ...READY, nudgeCount: MAX_NUDGES }), null, 'shared MAX_NUDGES budget');
  assert.equal(nudgeKind({ ...READY, ready: false, blockers: MISSING }), 'commit', 'blocker nudge unchanged');
  assert.equal(nudgeKind({ ...READY, vcs: { ...COMMIT_ON, commit: false }, ready: false, blockers: MISSING }), null, 'blocker nudge stays commits-on only');
  assert.equal(nudgeKind(), null);
});

test('buildCompleteNudgePrompt: one line, no commit wording, follow-up capture before the per-agent completion tool', () => {
  for (const agent of ['claude', 'codex', 'pi']) {
    const prompt = buildCompleteNudgePrompt('TPT9', agent);
    assert.doesNotMatch(prompt, /[\r\n]/, `${agent}: single line`);
    assert.doesNotMatch(prompt, /\?/, `${agent}: no question mark anywhere`);
    assert.doesNotMatch(prompt, /commit/i, `${agent}: no commit wording`);
    assert.match(prompt, /TPT9 is still in progress and its completion check passes/);
    assert.match(prompt, /on_fire/);
    const followUps = prompt.search(/follow-up capture/i);
    assert.ok(followUps >= 0 && followUps < prompt.search(/complete_task|tt complete/), `${agent}: follow-up capture comes before completion`);
  }
  assert.match(buildCompleteNudgePrompt('TPT9', 'claude'), /mcp__tipatask-local__complete_task\(TPT9, resolution\)/);
  assert.match(buildCompleteNudgePrompt('TPT9', 'codex'), /call complete_task\(TPT9, resolution\)/);
  assert.match(buildCompleteNudgePrompt('TPT9', 'pi'), /tt complete TPT9/);
});

// ── Exit backstop (TPT613) ──
const EXIT = { status: 'in_progress', roles: ROLES, vcs: COMMIT_ON, blockers: MISSING };

test('shouldFlagExit: in-progress task, commits on, an eligible blocker; no nudge cap; a failed Git read vetoes', () => {
  assert.equal(shouldFlagExit(EXIT), true);
  assert.equal(shouldFlagExit({ ...EXIT, nudgeCount: 99 }), true, 'nudge count is irrelevant');
  for (const status of ['completed', 'canceled', 'on_fire', 'pending', undefined]) {
    assert.equal(shouldFlagExit({ ...EXIT, status }), false, `status ${status}`);
  }
  const custom = { ...ROLES, in_progress: 'Doing' };
  assert.equal(shouldFlagExit({ ...EXIT, roles: custom, status: 'Doing' }), true, 'role name, not a literal');
  assert.equal(shouldFlagExit({ ...EXIT, vcs: { ...COMMIT_ON, commit: false } }), false, 'commits off');
  assert.equal(shouldFlagExit({ ...EXIT, vcs: { type: 'svn', commit: true } }), false, 'svn');
  assert.equal(shouldFlagExit({ ...EXIT, vcs: undefined }), false, 'unknown settings');
  assert.equal(shouldFlagExit({ ...EXIT, blockers: [] }), false, 'clean commit');
  assert.equal(shouldFlagExit({ ...EXIT, blockers: [{ code: 'merge_in_progress' }] }), false, 'not a commit blocker');
  for (const code of ['TASK_WORKTREE_DIRTY', 'unmerged_branch', 'dirty_task_worktree', 'gitlink_mismatch']) {
    assert.equal(shouldFlagExit({ ...EXIT, blockers: [{ code }] }), true, code);
  }
  assert.equal(shouldFlagExit({ ...EXIT, blockers: [...MISSING, { code: 'git_verification_failed' }] }), false,
    'partial blockers next to a failed Git read are an unknown state');
});

test('describeBlocker / uncommittedBlockers: the message when there is one, else label and where', () => {
  assert.equal(describeBlocker(MISSING[0]), MISSING[0].message);
  assert.equal(describeBlocker({ code: 'unmerged_branch', path: '/repo', target: 'master', branch: 'task/TPT9', ahead: 2 }),
    'task branch not merged into the current branch: task/TPT9 in /repo');
  assert.equal(describeBlocker({ code: 'gitlink_mismatch', path: '/repo', nested: 'ai/todo/server' }),
    'parent repository gitlink not committed: ai/todo/server in /repo');
  assert.equal(describeBlocker({ code: 'dirty_task_worktree' }), 'uncommitted changes in the task worktree');
  assert.deepEqual(uncommittedBlockers([...MISSING, { code: 'git_verification_failed' }, { code: 'dirty_task_worktree', path: '/wt', branch: 'task/TPT9' }]), [
    { code: 'TASK_COMMIT_MISSING', message: MISSING[0].message },
    { code: 'dirty_task_worktree', message: 'uncommitted changes in the task worktree: task/TPT9 in /wt' },
  ]);
});

test('buildExitBackstopComment: header, one bullet per blocker, how the session ended, what finishing takes', () => {
  const text = buildExitBackstopComment('TPT9', [...MISSING, MISSING[0]], { reason: 'user-terminated', inProgress: 'in_progress', nudgeCount: 2, onFire: true });
  const [header, bullets, tail, ...rest] = text.split('\n\n');
  assert.deepEqual(rest, []);
  assert.equal(header, `${EXIT_BACKSTOP_HEADER}: no task commit found`);
  assert.equal(header, 'Agent exited without committing / completing: no task commit found');
  assert.equal(bullets, `- ${MISSING[0].message}`, 'a repeated blocker is listed once');
  assert.match(tail, /^The terminal session was terminated by the user while the task was still in_progress, after 2 idle completion nudges\./);
  assert.match(tail, /Commit the task's changes with a message starting with TPT9:, then finish with complete_task\. Status set to on_fire\.$/);

  const natural = buildExitBackstopComment('TPT9', [{ code: 'unmerged_branch', path: '/r', branch: 'task/TPT9' }], { exitCode: 0, inProgress: 'Doing', nudgeCount: 1, merge: true });
  assert.match(natural, /^Agent exited without committing \/ completing: task branch not merged into the current branch\n/);
  assert.match(natural, /ended when the agent process exited \(code 0\) while the task was still Doing, after 1 idle completion nudge\./);
  assert.match(natural, /starting with TPT9:, run the enabled merge step, then finish with complete_task\.$/);
  assert.doesNotMatch(natural, /on_fire/, 'never claims on_fire unless the status was set');
  assert.match(buildExitBackstopComment('TPT9', MISSING, { reason: 'runaway-killed' }), /session was killed by the process watchdog/);
});
