'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createChatPersistence } = require('./chat-persistence');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, overrides = {}) {
  const userDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-chat-persist-'));
  t.after(() => fs.rm(userDataRoot, { recursive: true, force: true }));
  return {
    userDataRoot,
    store: createChatPersistence({ userDataRoot, fsOps: { ...fs, ...overrides } }),
    draftPath(projectPath) {
      const hash = crypto.createHash('md5').update(projectPath).digest('hex').slice(0, 8);
      return path.join(userDataRoot, `.chat-draft-${hash}.json`);
    },
    statePath(projectPath) {
      const hash = crypto.createHash('md5').update(projectPath).digest('hex').slice(0, 8);
      return path.join(userDataRoot, `chat-state-${hash}.json`);
    },
  };
}

test('draft readers see a complete old or new document while rename is held', async (t) => {
  const atRename = deferred();
  const continueRename = deferred();
  let hold = false;
  const f = await fixture(t, {
    async rename(from, to) {
      if (hold) {
        atRename.resolve();
        await continueRename.promise;
      }
      return fs.rename(from, to);
    },
  });
  const project = '/project/atomic';
  await f.store.writeChatDraft([{ role: 'user', content: 'old' }], 'task', {}, project);
  hold = true;
  const writing = f.store.writeChatDraft([{ role: 'user', content: 'new' }], 'task', {}, project);
  await atRename.promise;
  assert.equal(JSON.parse(await fs.readFile(f.draftPath(project), 'utf8')).messages[0].content, 'old');
  continueRename.resolve();
  await writing;
  assert.equal(JSON.parse(await fs.readFile(f.draftPath(project), 'utf8')).messages[0].content, 'new');
});

test('concurrent window saves retain hidden history and serialize each merge', async (t) => {
  const atRename = deferred();
  const continueRename = deferred();
  let hold = false;
  const f = await fixture(t, {
    async rename(from, to) {
      if (hold) {
        hold = false;
        atRename.resolve();
        await continueRename.promise;
      }
      return fs.rename(from, to);
    },
  });
  const project = '/project/window';
  const rows = (...names) => names.map((content) => ({ role: 'user', content }));
  await f.store.writeChatDraft(rows('root', 'a', 'b', 'c', 'd', 'e'), 'task', {}, project);
  hold = true;
  const first = f.store.writeChatDraft(rows('root', 'c1', 'd1', 'e1'), 'task', { historyWindowStart: 3 }, project);
  await atRename.promise;
  const second = f.store.writeChatDraft(rows('root', 'd2', 'e2', 'f'), 'task', { historyWindowStart: 4 }, project);
  continueRename.resolve();
  await Promise.all([first, second]);
  assert.deepEqual((await f.store.readChatDraft(project)).messages.map((row) => row.content),
    ['root', 'a', 'b', 'c1', 'd2', 'e2', 'f']);
});

test('delete waits for an earlier draft write and cannot be undone by it', async (t) => {
  const atRename = deferred();
  const continueRename = deferred();
  const f = await fixture(t, {
    async rename(from, to) {
      atRename.resolve();
      await continueRename.promise;
      return fs.rename(from, to);
    },
  });
  const project = '/project/clear';
  const writing = f.store.writeChatDraft([{ content: 'in flight' }], 'task', {}, project);
  await atRename.promise;
  const deleting = f.store.deleteChatDraft(project);
  continueRename.resolve();
  await Promise.all([writing, deleting]);
  assert.equal(await f.store.readChatDraft(project), null);
});

test('state deletion waits for an in-flight state write in the same project', async (t) => {
  const atRename = deferred();
  const continueRename = deferred();
  const f = await fixture(t, {
    async rename(from, to) {
      atRename.resolve();
      await continueRename.promise;
      return fs.rename(from, to);
    },
  });
  const project = '/project/state-clear';
  const writing = f.store.writeChatState('{"cards":[1]}', project);
  await atRename.promise;
  const deleting = f.store.deleteChatState(project);
  continueRename.resolve();
  await Promise.all([writing, deleting]);
  assert.equal(await f.store.readChatState(project), null);
});

test('other projects make progress while one project is waiting on disk', async (t) => {
  const atRename = deferred();
  const continueRename = deferred();
  const f = await fixture(t, {
    async rename(from, to) {
      if (to.includes('chat-state-') && to === f.statePath('/project/slow')) {
        atRename.resolve();
        await continueRename.promise;
      }
      return fs.rename(from, to);
    },
  });
  const slow = f.store.writeChatState('{"value":"slow"}', '/project/slow');
  await atRename.promise;
  try {
    await Promise.race([
      f.store.writeChatState('{"value":"fast"}', '/project/fast'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('other project was blocked')), 1000)),
    ]);
    assert.equal(JSON.parse(await f.store.readChatState('/project/fast')).value, 'fast');
  } finally {
    continueRename.resolve();
    await slow;
  }
});

test('partial write and rename failures leave the last valid state and remove temps', async (t) => {
  let failWrite = false;
  let failRename = false;
  const f = await fixture(t, {
    async open(filePath, flags, mode) {
      const handle = await fs.open(filePath, flags, mode);
      if (!failWrite) return handle;
      return {
        async writeFile() {
          await handle.writeFile('{"partial":');
          throw new Error('injected write failure');
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    async rename(from, to) {
      if (failRename) throw new Error('injected rename failure');
      return fs.rename(from, to);
    },
  });
  const project = '/project/fail';
  await f.store.writeChatState('{"value":"saved"}', project);
  failWrite = true;
  await assert.rejects(f.store.writeChatState('{"value":"lost"}', project), /injected write failure/);
  failWrite = false;
  failRename = true;
  await assert.rejects(f.store.writeChatState('{"value":"lost"}', project), /injected rename failure/);
  assert.deepEqual(JSON.parse(await f.store.readChatState(project)), { value: 'saved' });
  assert.equal((await fs.readdir(f.userDataRoot)).filter((name) => name.includes('.tmp-')).length, 0);
  failRename = false;
  await f.store.writeChatState('{"value":"recovered"}', project);
  assert.equal(JSON.parse(await f.store.readChatState(project)).value, 'recovered');
});

test('stale crash temp is ignored and removed without replacing the live draft', async (t) => {
  const f = await fixture(t);
  const project = '/project/crash';
  await f.store.writeChatDraft([{ content: 'saved' }], 'task', {}, project);
  const orphan = `${f.draftPath(project)}.tmp-dead`;
  await fs.writeFile(orphan, '{"partial":');
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(orphan, old, old);
  assert.equal((await f.store.readChatDraft(project)).messages[0].content, 'saved');
  await assert.rejects(fs.stat(orphan), { code: 'ENOENT' });
});
