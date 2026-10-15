'use strict';

// (TPT664) The exit backstop's server-side flag registry — the source every window rebuilds
// state.leftUncommitted from. Pure module; the websocket.js hook is exercised with no wss attached.
// (TPT670) Persistence runs against throwaway temp dirs only: the registry stays memory-only until
// a test calls load(), and beforeEach's _reset() detaches the file again.

process.env.TASK_BACKEND = 'api';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const registry = require('./left-uncommitted');

const BLOCKERS = [{ code: 'TASK_COMMIT_MISSING', message: 'no commit starting with TPT1' }];
const entry = (over = {}) => ({ exitId: 'TPT1@1', blockers: BLOCKERS, status: 'on_fire', agent: 'claude', nudgeCount: 1, at: 5, closedNames: ['completed', 'canceled'], ...over });
const DAY = 24 * 60 * 60 * 1000;

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-left-uncommitted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const fileIn = root => path.join(root, registry.FILE_NAME);
const readSaved = root => JSON.parse(fs.readFileSync(fileIn(root), 'utf8'));
const writeSaved = (root, projects) => fs.writeFileSync(fileIn(root), JSON.stringify({ version: 1, projects }));

test.beforeEach(() => registry._reset());

test('record + list: the public entry carries the live frame extras and never the closed names', () => {
  registry.record('/p/a', 'TPT1', entry());
  assert.deepEqual(registry.list('/p/a'), { TPT1: { exitId: 'TPT1@1', blockers: BLOCKERS, status: 'on_fire', agent: 'claude', nudgeCount: 1, at: 5 } });
  assert.deepEqual(registry.get('/p/a', 'TPT1'), registry.list('/p/a').TPT1);
  assert.equal(registry.get('/p/a', 'TPT2'), null);
});

test('list is project-scoped; an empty project path merges every project (the no-header rule)', () => {
  registry.record('/p/a', 'TPT1', entry());
  registry.record('/p/b', 'TPT7', entry({ exitId: 'TPT7@1' }));
  assert.deepEqual(Object.keys(registry.list('/p/a')), ['TPT1']);
  assert.deepEqual(Object.keys(registry.list('/p/b')), ['TPT7']);
  assert.deepEqual(Object.keys(registry.list('')).sort(), ['TPT1', 'TPT7']);
  assert.deepEqual(registry.list('/p/none'), {});
});

test('a newer exit replaces the entry for the same task', () => {
  registry.record('/p/a', 'TPT1', entry());
  registry.record('/p/a', 'TPT1', entry({ exitId: 'TPT1@2', nudgeCount: 3 }));
  assert.equal(registry.get('/p/a', 'TPT1').exitId, 'TPT1@2');
  assert.equal(registry.get('/p/a', 'TPT1').nudgeCount, 3);
});

test('clear returns the removed entry once, null when there was none; an empty project path clears everywhere', () => {
  registry.record('/p/a', 'TPT1', entry());
  registry.record('/p/b', 'TPT1', entry({ exitId: 'TPT1@9' }));
  assert.equal(registry.clear('/p/a', 'TPT1').exitId, 'TPT1@1');
  assert.equal(registry.clear('/p/a', 'TPT1'), null);
  assert.equal(registry.get('/p/b', 'TPT1').exitId, 'TPT1@9', 'other project untouched');
  assert.equal(registry.clear('', 'TPT1').exitId, 'TPT1@9');
  assert.deepEqual(registry.list(''), {});
  assert.equal(registry.clear('/p/a', ''), null);
});

test('noteTaskUpdate drops the entry only for a status among the closed names recorded at flag time', () => {
  registry.record('/p/a', 'TPT1', entry({ closedNames: ['done', 'dropped'] }));
  assert.equal(registry.noteTaskUpdate({ id: 'TPT1', status: 'completed' }, '/p/a'), null, 'a renamed registry: the literal is not closed here');
  assert.equal(registry.noteTaskUpdate({ id: 'TPT1', status: 'in_progress' }, '/p/a'), null);
  assert.equal(registry.noteTaskUpdate({ id: 'TPT2', status: 'done' }, '/p/a'), null);
  assert.equal(registry.noteTaskUpdate(null, '/p/a'), null);
  assert.ok(registry.get('/p/a', 'TPT1'));
  assert.equal(registry.noteTaskUpdate({ id: 'TPT1', status: 'dropped' }, '/p/a').exitId, 'TPT1@1');
  assert.equal(registry.get('/p/a', 'TPT1'), null);
  // No project scope on the update (a global task:updated) still finds the task.
  registry.record('/p/a', 'TPT1', entry());
  assert.equal(registry.noteTaskUpdate({ id: 'TPT1', status: 'canceled' }).exitId, 'TPT1@1');
});

test('websocket.emitTaskUpdated retires the flag of a task that reached a closed status (no wss: broadcast is a no-op)', () => {
  const websocket = require('./websocket');
  registry.record('/p/a', 'TPT1', entry());
  websocket.emitTaskUpdated({ id: 'TPT1', status: 'on_fire' }, null, '/p/a');
  assert.ok(registry.get('/p/a', 'TPT1'), 'a non-closed update keeps it');
  websocket.emitTaskUpdated({ id: 'TPT1', status: 'completed' }, null, '/p/a');
  assert.equal(registry.get('/p/a', 'TPT1'), null);
});

test('clear with an exitId removes only that exit, so a newer flag of the task survives', () => {
  registry.record('/p/a', 'TPT1', entry({ exitId: 'TPT1@2' }));
  assert.equal(registry.clear('/p/a', 'TPT1', { exitId: 'TPT1@1' }), null);
  assert.equal(registry.get('/p/a', 'TPT1').exitId, 'TPT1@2');
  assert.equal(registry.clear('', 'TPT1', { exitId: 'TPT1@2' }).exitId, 'TPT1@2');
  assert.equal(registry.get('/p/a', 'TPT1'), null);
});

test('(TPT670) memory-only until load(); then every record saves the whole registry — mode 0600, closed names kept', t => {
  const root = tempRoot(t);
  registry.record('/p/a', 'TPT1', entry());
  assert.equal(fs.existsSync(fileIn(root)), false);
  assert.deepEqual(registry.load({ root }), { restored: 0, dropped: 0 });
  assert.equal(fs.existsSync(fileIn(root)), false, 'a missing file is not created until something changes');
  registry.record('/p/b', 'TPT7', entry({ exitId: 'TPT7@1', agent: 'codex' }));
  const saved = { exitId: 'TPT1@1', blockers: BLOCKERS, status: 'on_fire', agent: 'claude', nudgeCount: 1, at: 5, closedNames: ['completed', 'canceled'] };
  assert.deepEqual(readSaved(root), { version: 1, projects: {
    '/p/a': { TPT1: saved },
    '/p/b': { TPT7: { ...saved, exitId: 'TPT7@1', agent: 'codex' } },
  } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(fileIn(root)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(root), [registry.FILE_NAME], 'no temp file left behind');
});

test('(TPT670) clear and a closed noteTaskUpdate save the removal; a call that removes nothing writes nothing', t => {
  const root = tempRoot(t);
  registry.load({ root });
  registry.record('/p/a', 'TPT1', entry());
  registry.record('/p/a', 'TPT2', entry({ exitId: 'TPT2@1' }));
  registry.clear('/p/a', 'TPT1');
  assert.deepEqual(Object.keys(readSaved(root).projects['/p/a']), ['TPT2']);
  registry.noteTaskUpdate({ id: 'TPT2', status: 'completed' }, '/p/a');
  assert.deepEqual(readSaved(root), { version: 1, projects: {} });
  fs.rmSync(fileIn(root));
  assert.equal(registry.clear('/p/a', 'TPT1'), null);
  assert.equal(registry.noteTaskUpdate({ id: 'TPT9', status: 'completed' }, '/p/a'), null);
  assert.equal(fs.existsSync(fileIn(root)), false);
});

test('(TPT670) load restores the saved flags with their closed names, drops ones older than 14 days and rewrites the file without them', t => {
  const root = tempRoot(t);
  const now = 1_800_000_000_000;
  writeSaved(root, {
    '/p/a': { TPT1: entry({ at: now - DAY }), TPT2: entry({ exitId: 'TPT2@1', at: now - 15 * DAY }) },
    '/p/b': { TPT7: entry({ exitId: 'TPT7@1', at: now - 13 * DAY, closedNames: ['done'] }) },
  });
  assert.deepEqual(registry.load({ root, now }), { restored: 2, dropped: 1 });
  assert.equal(registry.MAX_AGE_MS, 14 * DAY);
  assert.deepEqual(registry.list('/p/a'), { TPT1: { exitId: 'TPT1@1', blockers: BLOCKERS, status: 'on_fire', agent: 'claude', nudgeCount: 1, at: now - DAY } });
  assert.deepEqual(Object.keys(readSaved(root).projects['/p/a']), ['TPT1'], 'the expired entry is gone from disk too');
  assert.equal(registry.noteTaskUpdate({ id: 'TPT7', status: 'completed' }, '/p/b'), null, 'judged by the restored closed names, not a literal');
  assert.equal(registry.noteTaskUpdate({ id: 'TPT7', status: 'done' }, '/p/b').exitId, 'TPT7@1');
});

test('(TPT670) a corrupt, wrong-shape or oversize file loads empty without throwing, and the next change replaces it', t => {
  const now = Date.now();
  const contents = ['not json{', '[]', 'null', '{"version":1,"projects":[]}', '{"version":1,"projects":{"/p/a":[1]}}', 'x'.repeat(1024 * 1024 + 1)];
  for (const content of contents) {
    registry._reset();
    const root = tempRoot(t);
    fs.writeFileSync(fileIn(root), content);
    assert.deepEqual(registry.load({ root, now }), { restored: 0, dropped: 0 }, content.slice(0, 40));
    assert.deepEqual(registry.list(''), {});
    registry.record('/p/a', 'TPT1', entry({ at: now }));
    assert.equal(readSaved(root).projects['/p/a'].TPT1.exitId, 'TPT1@1');
  }
});

test('(TPT670) load drops malformed entries one by one and coerces the fields of a kept one', t => {
  const root = tempRoot(t);
  const now = Date.now();
  writeSaved(root, { '/p/a': {
    TPT1: entry({ at: now }),
    TPT2: { at: now }, // no exit id
    TPT3: { exitId: 'TPT3@1', at: 'soon' },
    TPT4: null,
    TPT5: { exitId: 7, at: now },
    TPT6: { exitId: 'TPT6@1', at: now, status: 5, agent: {}, nudgeCount: 'x', blockers: [{ code: 1 }, { code: 'TASK_COMMIT_MISSING', message: 'm' }], closedNames: ['done', 3] },
  } });
  assert.deepEqual(registry.load({ root, now }), { restored: 2, dropped: 4 });
  assert.deepEqual(registry.get('/p/a', 'TPT6'), { exitId: 'TPT6@1', blockers: [{ code: 'TASK_COMMIT_MISSING', message: 'm' }], status: '', agent: null, nudgeCount: 0, at: now });
  assert.equal(registry.noteTaskUpdate({ id: 'TPT6', status: 'done' }, '/p/a').exitId, 'TPT6@1');
});

test('(TPT670) a failed save never throws and leaves the in-memory registry intact', t => {
  const dir = tempRoot(t);
  const notADir = path.join(dir, 'not-a-dir');
  fs.writeFileSync(notADir, '');
  const warn = t.mock.method(console, 'warn', () => {});
  registry.load({ root: notADir }); // the file would live under a regular file: every write fails
  assert.doesNotThrow(() => registry.record('/p/a', 'TPT1', entry()));
  assert.equal(registry.get('/p/a', 'TPT1').exitId, 'TPT1@1');
  assert.doesNotThrow(() => registry.noteTaskUpdate({ id: 'TPT1', status: 'completed' }, '/p/a'));
  assert.equal(registry.get('/p/a', 'TPT1'), null);
  assert.equal(warn.mock.callCount(), 2);
});

test('(TPT670) takeRestored hands out each restored entry of that exact project once; a live record is never restored', t => {
  const root = tempRoot(t);
  const now = Date.now();
  writeSaved(root, {
    '/p/a': { TPT1: entry({ at: now }), TPT2: entry({ exitId: 'TPT2@1', at: now }) },
    '': { TPT5: entry({ exitId: 'TPT5@1', at: now }) },
  });
  assert.deepEqual(registry.load({ root, now }), { restored: 3, dropped: 0 });
  registry.record('/p/a', 'TPT2', entry({ exitId: 'TPT2@2', at: now })); // a newer live flag replaces the restored one
  registry.record('/p/a', 'TPT3', entry({ exitId: 'TPT3@1', at: now }));
  assert.deepEqual(registry.takeRestored('/p/a'), [{ taskKey: 'TPT1', exitId: 'TPT1@1' }]);
  assert.deepEqual(registry.takeRestored('/p/a'), []);
  assert.deepEqual(registry.takeRestored(''), [{ taskKey: 'TPT5', exitId: 'TPT5@1' }], 'the empty path is its own bucket here, not every project');
  assert.deepEqual(registry.takeRestored('/p/none'), []);
  assert.equal('restored' in readSaved(root).projects['/p/a'].TPT1, false, 'the marker never reaches disk');
});

test('(TPT670) a flag one server process records is restored by the next process that loads the same root', t => {
  const root = tempRoot(t);
  // Exits right after record(): the synchronous save must already be on disk.
  const script = `const r = require(${JSON.stringify(require.resolve('./left-uncommitted'))});
r.load({ root: ${JSON.stringify(root)} });
r.record('/p/a', 'TPT1', { exitId: 'TPT1@1', blockers: [{ code: 'TASK_COMMIT_MISSING', message: 'm' }], status: 'on_fire', agent: 'codex', nudgeCount: 2, at: Date.now(), closedNames: ['completed'] });
process.exit(0);`;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(registry.load({ root }), { restored: 1, dropped: 0 });
  assert.equal(registry.get('/p/a', 'TPT1').agent, 'codex');
  assert.deepEqual(registry.takeRestored('/p/a'), [{ taskKey: 'TPT1', exitId: 'TPT1@1' }]);
});
// The boot-time load() call itself is pinned by index-session-safety.test.js (real bootstrap in a vm).
