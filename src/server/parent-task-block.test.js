'use strict';

// (C1575) fetchParentTaskBlock() — resolves a child task's parent context for its kickoff
// prompt. Pure over a fake backend, same style as resolve-objective-descendants.test.js: no
// real PTY, no network, no DB. task.parentDbId is a numeric FK; the API has no
// GET /tasks/:numericId route, so this scans backend.getTasksUnfiltered() for the matching
// dbId — same idiom resolveObjectiveDescendants() (ws-handlers.js) and getChildren()
// (api-backend.js) already use. See ai/architecture/tt-task-agent.md § Parent Task Injection
// (C1575).

const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchParentTaskBlock } = require('./terminal-session');

const PARENT_ROW = { id: 'C1200', dbId: 1, parentDbId: null, title: 'Rework the sprint board', description: 'Objective description.' };
const CHILD_WITH_PARENT = { id: 'C1201', dbId: 2, parentDbId: 1 };
const CHILD_WITHOUT_PARENT = { id: 'C1202', dbId: 3, parentDbId: null };

function fakeBackend({ rows = [PARENT_ROW], comments = [], throwOnList = false, throwOnComments = false, noComments = false } = {}) {
  const backend = {
    getTasksUnfiltered: async () => {
      if (throwOnList) throw new Error('list failed');
      return rows;
    },
  };
  if (!noComments) {
    backend.getTaskComments = async () => {
      if (throwOnComments) throw new Error('comments failed');
      return comments;
    };
  }
  return backend;
}

test('fetchParentTaskBlock: task.parentDbId null -> null', async () => {
  const backend = fakeBackend();
  assert.equal(await fetchParentTaskBlock(backend, CHILD_WITHOUT_PARENT), null);
});

test('fetchParentTaskBlock: no task at all -> null', async () => {
  const backend = fakeBackend();
  assert.equal(await fetchParentTaskBlock(backend, null), null);
});

test('fetchParentTaskBlock: no backend -> null', async () => {
  assert.equal(await fetchParentTaskBlock(null, CHILD_WITH_PARENT), null);
});

test('fetchParentTaskBlock: backend missing getTasksUnfiltered -> null', async () => {
  const backend = { getTaskComments: async () => [] };
  assert.equal(await fetchParentTaskBlock(backend, CHILD_WITH_PARENT), null);
});

test('fetchParentTaskBlock: parent dbId not found among the rows -> null', async () => {
  const backend = fakeBackend({ rows: [{ id: 'C9', dbId: 9, parentDbId: null, title: 'Unrelated', description: '' }] });
  assert.equal(await fetchParentTaskBlock(backend, CHILD_WITH_PARENT), null);
});

test('fetchParentTaskBlock: getTasksUnfiltered() throws -> null (fail-open)', async () => {
  const backend = fakeBackend({ throwOnList: true });
  assert.equal(await fetchParentTaskBlock(backend, CHILD_WITH_PARENT), null);
});

test('fetchParentTaskBlock: getTaskComments() throws -> block still returned, comments just dropped', async () => {
  const backend = fakeBackend({ throwOnComments: true });
  const block = await fetchParentTaskBlock(backend, CHILD_WITH_PARENT);
  assert.ok(block, 'parent title/description context must still come through');
  assert.match(block, /C1200/);
  assert.ok(!block.includes('Parent Task Comments'));
});

test('fetchParentTaskBlock: backend has no getTaskComments at all -> block still returned, no comments section', async () => {
  const backend = fakeBackend({ noComments: true });
  const block = await fetchParentTaskBlock(backend, CHILD_WITH_PARENT);
  assert.ok(block);
  assert.match(block, /C1200/);
  assert.ok(!block.includes('Parent Task Comments'));
});

test('fetchParentTaskBlock: happy path — non-null block containing the parent key and title', async () => {
  const backend = fakeBackend({
    comments: [
      { id: 1, content: 'Spec note.', type: 'spec', user: { name: 'Alice' }, created_at: '2026-01-01T00:00:00Z' },
    ],
  });
  const block = await fetchParentTaskBlock(backend, CHILD_WITH_PARENT);
  assert.match(block, /C1200/);
  assert.match(block, /Rework the sprint board/);
  assert.match(block, /Objective description\./);
  assert.match(block, /Spec note\./);
});

test('fetchParentTaskBlock: unfiltered scan finds a parent owned by a different assignee', async () => {
  // getTasksUnfiltered() is deliberately unscoped — assignee is irrelevant to this test, but
  // the point is the lookup doesn't filter on it at all; a plain row with no assignee field
  // still resolves.
  const backend = fakeBackend({ rows: [{ ...PARENT_ROW, assignee: 999 }] });
  const block = await fetchParentTaskBlock(backend, CHILD_WITH_PARENT);
  assert.match(block, /C1200/);
});
