'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHttpHandler } = require('./ws-handlers');

function fixture({ fail = false } = {}) {
  const saved = [];
  const sprints = [];
  const backend = {
    async getTasksUnfiltered() {
      return [
        { id: 'TPT1', category: 'CODING', status: 'in_progress', priority: 42 },
        { id: 'TPT2', category: 'CODING', status: 'completed', priority: 50 },
      ];
    },
    async getSprints() {
      if (fail) throw new Error('Sprint lookup unavailable');
      return [{ number: 42 }];
    },
    async createSprint(name, number) { sprints.push(number); },
    async overwriteRawWithRemap(content) {
      saved.push(JSON.parse(content.match(/```json\s*\n([\s\S]*?)```/)[1]));
      return new Map();
    },
  };
  return { backend, saved, sprints };
}

async function request(backend, data, url = '/api/todo') {
  const body = url === '/api/todo' ? '# Tasks\n```json\n' + JSON.stringify(data) + '\n```\n' : JSON.stringify(data);
  const req = {
    method: url === '/api/todo' ? 'PUT' : 'POST', url, headers: {},
    async *[Symbol.asyncIterator]() { yield body; },
  };
  const res = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  await createHttpHandler(new Map(), () => backend)(req, res);
  return res;
}

for (const priority of [0, null, undefined]) {
  test(`objective save assigns ${priority} without a successful preview resolve`, async (t) => {
    const { backend, saved } = fixture();
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    const res = await request(backend, {
      tasks: [{ id: 'TPT3', title: 'Product work', priority }], newTaskIds: ['TPT3'],
    });
    assert.equal(res.status, 200);
    assert.equal(saved[0].tasks[0].priority, 42);
    assert.ok(logs.some(line => line.includes('TPT3') && line.includes('-> 42')));
  });
}

test('save respects dependencies on existing tasks and new siblings, without rescheduling resolved tasks', async () => {
  const { backend, saved, sprints } = fixture();
  const res = await request(backend, {
    tasks: [
      { id: 'TPT5', priority: 0, dependencies: ['TPT4'] },
      { id: 'TPT4', priority: null, dependencies: ['TPT3', 'TPT2'] },
      { id: 'TPT3', priority: 45 },
      { id: 'TPT6', priority: 0 },
    ],
    newTaskIds: ['TPT3', 'TPT4', 'TPT5'],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(saved[0].tasks.map(t => t.priority), [52, 51, 45, 0]);
  assert.ok(sprints.includes(51) && sprints.includes(52));
});

test('save preserves user Backlog pins and performance suggestions while coercing planner defaults', async () => {
  const { backend, saved } = fixture();
  const res = await request(backend, {
    tasks: [
      { id: 'TPT3', priority: 0 },
      { id: 'TPT4', priority: 0, tags: ['tt-performance-suggestions'] },
      { id: 'TPT5', priority: 0 },
    ],
    newTaskIds: ['TPT3', 'TPT4', 'TPT5'], newTaskPinnedIds: ['TPT3'],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(saved[0].tasks.map(t => t.priority), [0, 0, 42]);
  assert.equal(saved[0].newTaskPinnedIds, undefined, 'transport metadata never reaches persistence');
});

test('manual creation and existing task edits retain their priorities', async () => {
  const { backend, saved } = fixture({ fail: true });
  const res = await request(backend, { tasks: [{ id: 'TPT3', priority: 0 }] });
  assert.equal(res.status, 200);
  assert.equal(saved[0].tasks[0].priority, 0);
});

test('failed save-time resolution reports error without persisting zero', async () => {
  const { backend, saved } = fixture({ fail: true });
  const res = await request(backend, { tasks: [{ id: 'TPT3', priority: 0 }], newTaskIds: ['TPT3'] });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /Sprint lookup unavailable/);
  assert.equal(saved.length, 0);
});

test('resolve-sprints keeps explicit Backlog pins after ID collision remapping', async () => {
  const { backend } = fixture();
  const res = await request(backend, {
    changes: [{ type: 'new', task: { id: 'TPT1', title: 'Different proposal', priority: 0 } }], pinned: ['TPT1'],
  }, '/api/resolve-sprints');
  assert.equal(res.status, 200);
  assert.notEqual(res.body.changes[0].task.id, 'TPT1');
  assert.equal(res.body.changes[0].task.priority, 0);
});
