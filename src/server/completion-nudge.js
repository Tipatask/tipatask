'use strict';

// Idle completion nudge (TPT612) and exit backstop (TPT613). A task terminal that goes quiet
// (index.js idle fallback) while its task is still in the in-progress role, in a project with
// commits on, gets a short pasted reminder to finish follow-up capture, commit and call the
// guarded completion tool — instead of stopping with the task left in progress (nudge kind
// 'commit'). When verification is already ready but the task is still in progress, any project
// gets the completion-only nudge instead (kind 'complete', TPT650; same MAX_NUDGES budget, see
// nudgeKind() / buildCompleteNudgePrompt()). When the session
// ends in that same state, the exit backstop records it in a resolution comment built here. Pure:
// the callers (terminal-session.js maybeNudgeIdleSession() / flagTaskLeftUncommitted()) supply
// the live status, roles, VCS flags and read-only commit blockers (completion-guard.js
// checkTaskCommit()).
//
// Echo safety: the nudge is pasted into the agent TUI and echoed back through prompt-detect.js,
// so every variant is one line with no `?` anywhere and no bare readiness line ("Plan ready.").
// The exit comment is never pasted anywhere, so it is ordinary multi-line markdown.

const MAX_NUDGES = 2;

// Blockers the agent can clear by committing (or merging) its own work. Anything else — an
// unverified settings read, a failed Git read, a merge mid-conflict — never nudges.
const NUDGE_BLOCKER_CODES = new Set([
  'TASK_COMMIT_MISSING',
  'TASK_WORKTREE_DIRTY',
  'unmerged_branch',
  'dirty_task_worktree',
  'gitlink_mismatch',
]);

const BLOCKER_TEXT = {
  TASK_COMMIT_MISSING: 'no task commit found',
  TASK_WORKTREE_DIRTY: 'uncommitted changes in the task worktree',
  unmerged_branch: 'task branch not merged into the current branch',
  dirty_task_worktree: 'uncommitted changes in the task worktree',
  gitlink_mismatch: 'parent repository gitlink not committed',
};

const MAX_BLOCKER_SUMMARY = 600;

// Claude refuses a message that is only a pasted block (TPT445); this is typed after the paste.
const NUDGE_TYPED_LINE = 'Please finish the steps pasted above.';

// The state both the nudge and the exit backstop act on: the task is in the in-progress role in a
// git project with commits on.
function isInProgress(status, roles) {
  if (status && (status === roles?.complete || status === roles?.canceled)) return false;
  const inProgress = roles && roles.in_progress;
  return typeof status === 'string' && !!inProgress && status === inProgress;
}

function isInProgressWithCommits({ status, roles, vcs } = {}) {
  if (!vcs || vcs.type !== 'git' || vcs.commit !== true) return false;
  return isInProgress(status, roles);
}

function isNudgeCandidate({ status, roles, vcs, nudgeCount = 0 } = {}) {
  if (!(nudgeCount < MAX_NUDGES)) return false;
  return isInProgressWithCommits({ status, roles, vcs });
}

function nudgeBlockers(blockers) {
  return Array.isArray(blockers) ? blockers.filter(b => b && NUDGE_BLOCKER_CODES.has(b.code)) : [];
}

function shouldNudge({ status, roles, vcs, blockers, nudgeCount = 0 } = {}) {
  return isNudgeCandidate({ status, roles, vcs, nudgeCount }) && nudgeBlockers(blockers).length > 0;
}

// Verification passes (task commit reachable, or nothing to verify: commits off, VCS off, svn)
// yet the task is still in progress — only the completion call is missing. No VCS gate.
function shouldNudgeComplete({ status, roles, verified, ready, nudgeCount = 0 } = {}) {
  return nudgeCount < MAX_NUDGES && verified === true && ready === true && isInProgress(status, roles);
}

// 'commit' | 'complete' | null — the blocker nudge wins; an unverified read is never 'complete'.
function nudgeKind({ status, roles, vcs, verified, ready, blockers, nudgeCount = 0 } = {}) {
  if (shouldNudge({ status, roles, vcs, blockers, nudgeCount })) return 'commit';
  if (shouldNudgeComplete({ status, roles, verified, ready, nudgeCount })) return 'complete';
  return null;
}

// Exit backstop: the session ended with the task in that state and a blocker its own commit (or
// merge) would clear. A Git read that fails mid-check leaves its partial blockers next to
// git_verification_failed while the check stays verified, so that code vetoes: an unknown state
// never flags a task. No nudge-count limit — one exit, one decision.
function shouldFlagExit({ status, roles, vcs, blockers } = {}) {
  if (!isInProgressWithCommits({ status, roles, vcs })) return false;
  if (Array.isArray(blockers) && blockers.some(b => b && b.code === 'git_verification_failed')) return false;
  return nudgeBlockers(blockers).length > 0;
}

function oneLine(text) {
  return String(text).replace(/\?/g, '.').replace(/\s+/g, ' ').trim();
}

// One readable line per blocker. The commit-mode blockers carry a message; the merge-walk ones
// (unmerged_branch, dirty_task_worktree, gitlink_mismatch) only say where they are.
function describeBlocker(b) {
  if (!b) return '';
  if (typeof b.message === 'string' && b.message.trim()) return oneLine(b.message);
  const label = BLOCKER_TEXT[b.code] || String(b.code || 'unknown blocker');
  const where = [b.branch || b.nested || '', b.path ? `in ${b.path}` : ''].filter(Boolean).join(' ');
  return where ? `${label}: ${where}` : label;
}

// The eligible blockers as { code, message } — the task-left-uncommitted frame's payload.
function uncommittedBlockers(blockers) {
  return nudgeBlockers(blockers).map(b => ({ code: b.code, message: describeBlocker(b) }));
}

function summarizeBlockers(blockers) {
  const parts = [];
  for (const b of nudgeBlockers(blockers)) {
    const part = oneLine(b.message || BLOCKER_TEXT[b.code] || b.code).replace(/[.\s]+$/, '');
    if (part && !parts.includes(part)) parts.push(part);
  }
  const text = parts.join('; ');
  return text.length > MAX_BLOCKER_SUMMARY ? `${text.slice(0, MAX_BLOCKER_SUMMARY - 3).trimEnd()}...` : text;
}

function completionStep(taskKey, agent) {
  if (agent === 'pi') return `finish with the completion step from your kickoff (tipatask-local__complete_task, or tt complete ${taskKey} with the report on stdin)`;
  const tool = agent === 'claude' ? 'mcp__tipatask-local__complete_task' : 'complete_task';
  return `call ${tool}(${taskKey}, resolution) with your plain-English report`;
}

function followUpStep(agent) {
  return agent === 'pi'
    ? 'If follow-up capture is not done yet, finish it first (search not-started and urgent tasks, comment on affected ones, file the rest).'
    : 'If follow-up capture is not done yet, finish it first: search pending and on_fire tasks, comment on the ones a finding affects, and file the remaining findings as tasks.';
}

function blockedStep(agent) {
  return agent === 'pi'
    ? 'If a blocker truly cannot be cleared, post the same report as a resolution comment, set the task on_fire and state the blocker.'
    : 'If a blocker truly cannot be cleared, post the same report with create_task_comment (type resolution), set the task on_fire and state the blocker.';
}

function buildNudgePrompt(taskKey, blockers, agent) {
  const summary = summarizeBlockers(blockers) || BLOCKER_TEXT.TASK_COMMIT_MISSING;
  return oneLine([
    `[Tipatask] Task ${taskKey} is still in progress and completion is blocked: ${summary}.`,
    'Commits are enabled for this project, so the commit is required before the task can be completed.',
    followUpStep(agent),
    `Then git add only this task's files and commit them with a message starting with ${taskKey}:, run any enabled merge step, and ${completionStep(taskKey, agent)}.`,
    blockedStep(agent),
    'Do not stop with the task left in progress.',
  ].join(' '));
}

// The 'complete' kind: nothing is left to verify, so the text carries no commit wording.
function buildCompleteNudgePrompt(taskKey, agent) {
  return oneLine([
    `[Tipatask] Task ${taskKey} is still in progress and its completion check passes.`,
    followUpStep(agent),
    `Then ${completionStep(taskKey, agent)}.`,
    blockedStep(agent),
    'Do not stop with the task left in progress.',
  ].join(' '));
}

const EXIT_BACKSTOP_HEADER = 'Agent exited without committing / completing';

function describeExit(reason, exitCode) {
  if (reason === 'user-terminated') return 'was terminated by the user';
  if (reason === 'runaway-killed') return 'was killed by the process watchdog';
  return Number.isInteger(exitCode) ? `ended when the agent process exited (code ${exitCode})` : 'ended';
}

// The exit backstop's resolution comment: short blocker labels in the header, one bullet per
// distinct blocker, then how the session ended and what finishing the task takes. `onFire` says
// whether the task was actually moved to on_fire, so the comment never claims a failed write.
function buildExitBackstopComment(taskKey, blockers, { reason, exitCode, inProgress = 'in progress', nudgeCount = 0, onFire = false, merge = false } = {}) {
  const labels = [];
  const details = [];
  for (const b of nudgeBlockers(blockers)) {
    const label = BLOCKER_TEXT[b.code] || b.code;
    if (!labels.includes(label)) labels.push(label);
    const detail = describeBlocker(b);
    if (detail && !details.includes(detail)) details.push(detail);
  }
  const nudges = `${nudgeCount} idle completion nudge${nudgeCount === 1 ? '' : 's'}`;
  const merged = merge ? ', run the enabled merge step' : '';
  return [
    `${EXIT_BACKSTOP_HEADER}: ${labels.join('; ') || BLOCKER_TEXT.TASK_COMMIT_MISSING}`,
    details.map(d => `- ${d}`).join('\n'),
    `The terminal session ${describeExit(reason, exitCode)} while the task was still ${inProgress}, after ${nudges}. `
      + `Commit the task's changes with a message starting with ${taskKey}:${merged}, then finish with complete_task.`
      + (onFire ? ' Status set to on_fire.' : ''),
  ].filter(Boolean).join('\n\n');
}

module.exports = {
  MAX_NUDGES,
  NUDGE_BLOCKER_CODES,
  NUDGE_TYPED_LINE,
  EXIT_BACKSTOP_HEADER,
  isInProgressWithCommits,
  isNudgeCandidate,
  shouldNudge,
  shouldNudgeComplete,
  nudgeKind,
  shouldFlagExit,
  describeBlocker,
  uncommittedBlockers,
  buildNudgePrompt,
  buildCompleteNudgePrompt,
  buildExitBackstopComment,
};
