'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadMutexWithCount() {
  // Inspect the real module's private map without adding a production export.
  const source = fs.readFileSync(path.join(__dirname, 'project-mutex.js'), 'utf8');
  const context = { module: { exports: {} } };
  vm.runInNewContext(`${source}\nmodule.exports.lockCount = () => locks.size;`, context);
  return context.module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('completed operations leave no retained project keys', async () => {
  const { withProjectLock, lockCount } = loadMutexWithCount();
  const keys = Array.from({ length: 200 }, (_, i) => `project-${i}`);
  const values = await Promise.all(keys.map((key, i) => withProjectLock(key, async () => i)));
  assert.deepEqual(values, keys.map((_, i) => i));
  assert.equal(lockCount(), 0);
});

test('same-key callbacks run FIFO and never overlap', async () => {
  const { withProjectLock, lockCount } = loadMutexWithCount();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const started = [];
  let active = 0;
  const jobs = Array.from({ length: 20 }, (_, i) => withProjectLock('shared', async () => {
    active++;
    assert.equal(active, 1);
    started.push(i);
    if (i === 0) {
      firstStarted.resolve();
      await releaseFirst.promise;
    } else {
      await Promise.resolve();
    }
    active--;
  }));

  await firstStarted.promise;
  assert.deepEqual(started, [0]);
  assert.equal(lockCount(), 1);
  releaseFirst.resolve();
  await Promise.all(jobs);
  assert.deepEqual(started, Array.from({ length: 20 }, (_, i) => i));
  assert.equal(lockCount(), 0);
});

test('different project keys run concurrently', async () => {
  const { withProjectLock, lockCount } = loadMutexWithCount();
  const release = deferred();
  const started = [];
  const a = withProjectLock('a', async () => { started.push('a'); await release.promise; });
  const b = withProjectLock('b', async () => { started.push('b'); await release.promise; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['a', 'b']);
    assert.equal(lockCount(), 2);
  } finally {
    release.resolve();
    await Promise.all([a, b]);
  }
  assert.equal(lockCount(), 0);
});

test('a throwing callback releases its key for later work', async () => {
  const { withProjectLock, lockCount } = loadMutexWithCount();
  const failure = new Error('callback failed');
  await assert.rejects(withProjectLock('shared', async () => { throw failure; }), failure);
  assert.equal(lockCount(), 0);
  assert.equal(await withProjectLock('shared', async () => 'recovered'), 'recovered');
  assert.equal(lockCount(), 0);
});

test('finishing holder preserves a waiter queued before release', async () => {
  const { withProjectLock, lockCount } = loadMutexWithCount();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const secondStarted = deferred();
  const releaseSecond = deferred();
  const order = [];
  const first = withProjectLock('shared', async () => {
    order.push('first start');
    firstStarted.resolve();
    await releaseFirst.promise;
    order.push('first end');
  });
  await firstStarted.promise;
  const second = withProjectLock('shared', async () => {
    order.push('second start');
    secondStarted.resolve();
    await releaseSecond.promise;
    order.push('second end');
  });
  assert.equal(lockCount(), 1);
  releaseFirst.resolve();
  await first;
  await secondStarted.promise;
  assert.deepEqual(order, ['first start', 'first end', 'second start']);
  assert.equal(lockCount(), 1);
  releaseSecond.resolve();
  await second;
  assert.equal(lockCount(), 0);
});
