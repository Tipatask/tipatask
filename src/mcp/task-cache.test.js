'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cache = require('./task-cache');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function listBackend() {
  const reads = [];
  return {
    reads,
    getTasksUnfiltered() {
      const read = deferred();
      reads.push(read);
      return read.promise;
    },
  };
}

function taskBackend() {
  const reads = [];
  return {
    reads,
    getTask(id) {
      const read = deferred();
      reads.push({ id, ...read });
      return read.promise;
    },
  };
}

for (const order of ['old-first', 'new-first']) {
  test(`list invalidation keeps fresh cache when requests finish ${order}`, async () => {
    const backend = listBackend();
    const key = {};
    const old = cache.getTasks(backend, key);
    cache.invalidate(key);
    const fresh = cache.getTasks(backend, key);
    const joined = cache.getTasks(backend, key);
    assert.equal(backend.reads.length, 2);

    const staleRows = [{ id: 'TPT1', title: 'stale' }];
    const freshRows = [{ id: 'TPT1', title: 'fresh' }];
    if (order === 'old-first') {
      backend.reads[0].resolve(staleRows);
      assert.strictEqual(await old, staleRows);
      const joinedAfterOld = cache.getTasks(backend, key);
      assert.equal(backend.reads.length, 2, 'old cleanup must leave the new request in flight');
      backend.reads[1].resolve(freshRows);
      assert.strictEqual(await joinedAfterOld, freshRows);
    } else {
      backend.reads[1].resolve(freshRows);
      assert.strictEqual(await fresh, freshRows);
      backend.reads[0].resolve(staleRows);
      assert.strictEqual(await old, staleRows);
    }
    assert.strictEqual(await fresh, freshRows);
    assert.strictEqual(await joined, freshRows);
    assert.strictEqual(await cache.getTasks(backend, key), freshRows);
    assert.equal((await cache.getTask(backend, 'TPT1', key)).title, 'fresh');
    assert.equal(backend.reads.length, 2);
  });

  test(`single-task invalidation keeps fresh cache when requests finish ${order}`, async () => {
    const backend = taskBackend();
    const key = {};
    const old = cache.getTask(backend, 'TPT1', key);
    cache.invalidate(key);
    const fresh = cache.getTask(backend, 'TPT1', key);
    const joined = cache.getTask(backend, 'TPT1', key);
    assert.deepEqual(backend.reads.map(read => read.id), ['TPT1', 'TPT1']);

    const staleTask = { id: 'TPT1', title: 'stale' };
    const freshTask = { id: 'TPT1', title: 'fresh' };
    if (order === 'old-first') {
      backend.reads[0].resolve(staleTask);
      assert.strictEqual(await old, staleTask);
      const joinedAfterOld = cache.getTask(backend, 'TPT1', key);
      assert.equal(backend.reads.length, 2, 'old cleanup must leave the new request in flight');
      backend.reads[1].resolve(freshTask);
      assert.strictEqual(await joinedAfterOld, freshTask);
    } else {
      backend.reads[1].resolve(freshTask);
      assert.strictEqual(await fresh, freshTask);
      backend.reads[0].resolve(staleTask);
      assert.strictEqual(await old, staleTask);
    }
    assert.strictEqual(await fresh, freshTask);
    assert.strictEqual(await joined, freshTask);
    assert.strictEqual(await cache.getTask(backend, 'TPT1', key), freshTask);
    assert.equal(backend.reads.length, 2);
  });
}

test('failed list and task requests release their in-flight slots for retry', async () => {
  const list = listBackend();
  const task = taskBackend();
  const listKey = {};
  const taskKey = {};

  const failedList = cache.getTasks(list, listKey);
  list.reads[0].reject(new Error('list unavailable'));
  await assert.rejects(failedList, /list unavailable/);
  const retriedList = cache.getTasks(list, listKey);
  assert.equal(list.reads.length, 2);
  list.reads[1].resolve([]);
  assert.deepEqual(await retriedList, []);

  const failedTask = cache.getTask(task, 'TPT1', taskKey);
  task.reads[0].reject(new Error('task unavailable'));
  await assert.rejects(failedTask, /task unavailable/);
  const retriedTask = cache.getTask(task, 'TPT1', taskKey);
  assert.equal(task.reads.length, 2);
  task.reads[1].resolve({ id: 'TPT1', title: 'retried' });
  assert.equal((await retriedTask).title, 'retried');
});

test('keyed invalidation clears every task in its slot and preserves other slots', async () => {
  const backend = { calls: [], async getTask(id) {
    this.calls.push(id);
    return { id, version: this.calls.length };
  } };
  const firstKey = {};
  const otherKey = {};
  await cache.getTask(backend, 'TPT1', firstKey);
  await cache.getTask(backend, 'TPT2', firstKey);
  const otherTask = await cache.getTask(backend, 'TPT1', otherKey);
  cache.invalidate(firstKey);

  assert.strictEqual(await cache.getTask(backend, 'TPT1', otherKey), otherTask);
  assert.equal((await cache.getTask(backend, 'TPT1', firstKey)).version, 4);
  assert.equal((await cache.getTask(backend, 'TPT2', firstKey)).version, 5);
  assert.equal(backend.calls.length, 5);
});

test('no-arg invalidation clears cached tasks across all slots', async () => {
  let version = 0;
  const backend = { async getTask(id) { return { id, version: ++version }; } };
  const firstKey = {};
  const otherKey = {};
  await cache.getTask(backend, 'TPT1', firstKey);
  await cache.getTask(backend, 'TPT1', otherKey);
  cache.invalidate();
  assert.equal((await cache.getTask(backend, 'TPT1', firstKey)).version, 3);
  assert.equal((await cache.getTask(backend, 'TPT1', otherKey)).version, 4);
});

test('list and task entries expire at the configured TTL', async () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    let listCalls = 0;
    let taskCalls = 0;
    const backend = {
      async getTasksUnfiltered() { return [{ id: 'TPT1', version: ++listCalls }]; },
      async getTask(id) { return { id, version: ++taskCalls }; },
    };
    const listKey = {};
    const taskKey = {};
    assert.equal((await cache.getTasks(backend, listKey))[0].version, 1);
    assert.equal((await cache.getTask(backend, 'TPT1', taskKey)).version, 1);
    now += cache.TTL_MS - 1;
    assert.equal((await cache.getTasks(backend, listKey))[0].version, 1);
    assert.equal((await cache.getTask(backend, 'TPT1', taskKey)).version, 1);
    now++;
    assert.equal((await cache.getTasks(backend, listKey))[0].version, 2);
    assert.equal((await cache.getTask(backend, 'TPT1', taskKey)).version, 2);
  } finally {
    Date.now = originalNow;
  }
});
