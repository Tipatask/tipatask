'use strict';

// TPT345 — pure helpers for `task/<KEY>` branch names and the commit messages the merge
// flow writes. No IO. Shared by the merge modules, the MCP git_worktree_status tool
// (src/mcp/git-worktree.js, lazily), and the completion-time dirty-worktree guard.

// `task/TPT347`, `task/TPT347-app`, `refs/heads/task/C1345`. Group 1 = task key, group 2 =
// optional suffix agents sometimes add for a second (nested-repo) worktree of the same task.
const TASK_BRANCH_RE = /^(?:refs\/heads\/)?task\/([A-Z]+\d+)(?:-(.+))?$/;

function parseTaskBranch(name) {
  if (typeof name !== 'string') return null;
  const m = TASK_BRANCH_RE.exec(name);
  if (!m) return null;
  return { branch: name.replace(/^refs\/heads\//, ''), taskKey: m[1], suffix: m[2] || null };
}

function splitKey(key) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(key || ''));
  return m ? { prefix: m[1], num: Number(m[2]) } : { prefix: String(key || ''), num: 0 };
}

// Task-key order: prefix (alpha), then numeric part (TPT2 < TPT10), never lexical.
function taskKeyOrder(a, b) {
  const ka = splitKey(typeof a === 'string' ? a : a?.taskKey);
  const kb = splitKey(typeof b === 'string' ? b : b?.taskKey);
  if (ka.prefix !== kb.prefix) return ka.prefix < kb.prefix ? -1 : 1;
  if (ka.num !== kb.num) return ka.num - kb.num;
  const sa = typeof a === 'string' ? '' : (a?.suffix || '');
  const sb = typeof b === 'string' ? '' : (b?.suffix || '');
  if (sa === sb) return 0;
  if (!sa) return -1; // no suffix sorts first
  if (!sb) return 1;
  return sa < sb ? -1 : 1;
}

// Single-line, control-char-free commit subject capped at `max` chars.
function sanitizeCommitSubject(text, max = 100) {
  const s = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function mergeCommitMessage(taskKey, title) {
  const subject = sanitizeCommitSubject(title);
  return subject ? `Merge task/${taskKey}: ${subject}` : `Merge task/${taskKey}`;
}

function worktreeCommitMessage(taskKey, title) {
  const subject = sanitizeCommitSubject(title);
  return subject ? `${taskKey} ${subject}` : `${taskKey}`;
}

function gitlinkBumpMessage(relPath, sha, keys = []) {
  const short = String(sha || '').slice(0, 12);
  const merged = keys.length ? ` (merged ${keys.join(', ')})` : '';
  return `Bump ${relPath} to ${short}${merged}`;
}

module.exports = {
  TASK_BRANCH_RE,
  parseTaskBranch,
  splitKey,
  taskKeyOrder,
  sanitizeCommitSubject,
  mergeCommitMessage,
  worktreeCommitMessage,
  gitlinkBumpMessage,
};
