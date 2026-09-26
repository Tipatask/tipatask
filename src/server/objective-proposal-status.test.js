'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { forcePendingProposalStatuses, forcePendingTodoPayloadNewTasks } = require('./objective-proposal-status');

test('forcePendingProposalStatuses forces new tasks to pending, strips status on modified', () => {
  const changes = [
    { type: 'new', task: { id: 'C1', status: 'completed' } },
    { type: 'modified', task: { id: 'C2', status: 'in_progress' } },
    { type: 'new', task: { id: 'C3' } },
    { type: 'new' },
  ];

  forcePendingProposalStatuses(changes, 'test');

  // C1072: modified task keeps its lifecycle status untouched — not force-pinned.
  assert.equal(changes[0].task.status, 'pending');
  assert.equal(changes[1].task.status, undefined);
  assert.equal(changes[2].task.status, 'pending');
});

test('forcePendingTodoPayloadNewTasks only forces transient new task ids', () => {
  const content = [
    '# TODO',
    '```json',
    JSON.stringify({
      newTaskIds: ['new-1'],
      tasks: [
        { id: 'C1', status: 'completed' },
        { id: 'new-1', status: 'completed' },
      ],
    }, null, 2),
    '```',
  ].join('\n');

  const updated = forcePendingTodoPayloadNewTasks(content, 'test');
  const parsed = JSON.parse(updated.match(/```json\s*\n([\s\S]*)```/)[1]);

  assert.equal(parsed.tasks[0].status, 'completed');
  assert.equal(parsed.tasks[1].status, 'pending');
});
