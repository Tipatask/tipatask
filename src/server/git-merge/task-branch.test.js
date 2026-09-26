'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTaskBranch, taskKeyOrder, sanitizeCommitSubject, mergeCommitMessage, worktreeCommitMessage, gitlinkBumpMessage } = require('./task-branch');

test('parseTaskBranch: key, suffix, refs/heads prefix, non-task names', () => {
  assert.deepEqual(parseTaskBranch('task/TPT347'), { branch: 'task/TPT347', taskKey: 'TPT347', suffix: null });
  assert.deepEqual(parseTaskBranch('task/TPT347-app'), { branch: 'task/TPT347-app', taskKey: 'TPT347', suffix: 'app' });
  assert.deepEqual(parseTaskBranch('refs/heads/task/C1345'), { branch: 'task/C1345', taskKey: 'C1345', suffix: null });
  assert.equal(parseTaskBranch('master'), null);
  assert.equal(parseTaskBranch('task/lowercase1'), null);
  assert.equal(parseTaskBranch(null), null);
});

test('taskKeyOrder: numeric within prefix, suffix-less first', () => {
  const keys = ['TPT10', 'TPT2', 'C99', 'TPT1'];
  assert.deepEqual([...keys].sort(taskKeyOrder), ['C99', 'TPT1', 'TPT2', 'TPT10']);
  const objs = [{ taskKey: 'TPT3', suffix: 'app' }, { taskKey: 'TPT3', suffix: null }, { taskKey: 'TPT2', suffix: null }];
  assert.deepEqual([...objs].sort(taskKeyOrder).map(o => `${o.taskKey}${o.suffix ? '-' + o.suffix : ''}`), ['TPT2', 'TPT3', 'TPT3-app']);
});

test('commit messages: sanitized, capped, never multi-line', () => {
  assert.equal(sanitizeCommitSubject('  a\r\nb\tc  '), 'a b c');
  assert.equal(sanitizeCommitSubject('x'.repeat(200)).length, 100);
  assert.equal(mergeCommitMessage('TPT1', 'Fix\nthing'), 'Merge task/TPT1: Fix thing');
  assert.equal(mergeCommitMessage('TPT1', ''), 'Merge task/TPT1');
  assert.equal(worktreeCommitMessage('TPT1', 'Title'), 'TPT1 Title');
  assert.equal(gitlinkBumpMessage('ai/todo/server', 'abcdef0123456789', ['TPT1', 'TPT2']), 'Bump ai/todo/server to abcdef012345 (merged TPT1, TPT2)');
  assert.equal(gitlinkBumpMessage('ai/todo/server', 'abcdef0123456789'), 'Bump ai/todo/server to abcdef012345');
});
