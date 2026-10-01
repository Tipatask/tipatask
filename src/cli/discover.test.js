'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { seedDiscoveryTasks } = require('./discover');
const { TASK_KEY_RE } = require('../server/task-key-format');

function fakeMcp({ reserved }) {
  const calls = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'reserve_task_keys') return { keys: reserved };
      return { task: { id: args.task_key } };
    },
  };
}

test('seedDiscoveryTasks finalizes reserved keys via update_task, never create_task', async () => {
  const mcp = fakeMcp({ reserved: ['TPT101', 'TPT102'] });
  const res = await seedDiscoveryTasks(mcp, ['tt-api', 'tt-web']);
  assert.equal(res.seeded, 2);
  assert.equal(res.failed, 0);
  assert.equal(mcp.calls.filter((c) => c.name === 'create_task').length, 0);
  const updates = mcp.calls.filter((c) => c.name === 'update_task');
  assert.deepEqual(updates.map((c) => c.args.task_key), ['TPT101', 'TPT102']);
  for (const u of updates) assert.match(u.args.task_key, TASK_KEY_RE);
  assert.ok(updates[0].args.title.includes('tt-api'));
  assert.equal(updates[0].args.id, undefined);
});

test('seedDiscoveryTasks rejects a slug key from the reservation and writes nothing', async () => {
  const mcp = fakeMcp({ reserved: ['C-kb-docs-site'] });
  const res = await seedDiscoveryTasks(mcp, ['tt-docs']);
  assert.equal(res.seeded, 0);
  assert.equal(res.failed, 1);
  assert.equal(mcp.calls.filter((c) => c.name === 'update_task').length, 0);
  assert.equal(mcp.calls.filter((c) => c.name === 'create_task').length, 0);
});

test('seedDiscoveryTasks with no tags does nothing', async () => {
  const mcp = fakeMcp({ reserved: [] });
  const res = await seedDiscoveryTasks(mcp, []);
  assert.deepEqual(res, { seeded: 0, failed: 0, keys: [] });
  assert.equal(mcp.calls.length, 0);
});
