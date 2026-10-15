'use strict';

// (TPT664) GET /api/sessions exposes the exit backstop's flag registry as a project-scoped
// `leftUncommitted` key, and a connecting __attention__ / __board__ subscriber gets the same
// entries replayed as `task-left-uncommitted` frames marked `replay: true` — (TPT670) including
// the ones restored from disk after a restart.

process.env.TASK_BACKEND = 'api';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHttpHandler, replayLeftUncommitted } = require('./ws-handlers');
const registry = require('./left-uncommitted');

const BLOCKERS = [{ code: 'TASK_COMMIT_MISSING', message: 'no commit starting with TPT1' }];

function fakeReq(url, project) {
  const req = { method: 'GET', url, headers: project ? { 'x-tipatask-project': project } : {} };
  req[Symbol.asyncIterator] = async function* () {};
  return req;
}
function fakeRes() {
  const res = { statusCode: null, body: '', writeHead(s) { res.statusCode = s; }, end(c) { res.body = c || ''; } };
  return res;
}

test.beforeEach(() => registry._reset());

test('GET /api/sessions lists the project\'s flagged tasks under leftUncommitted, never another project\'s', async () => {
  registry.record('/projects/tpt664-a', 'TPT1', { exitId: 'TPT1@1', blockers: BLOCKERS, status: 'on_fire', agent: 'claude', nudgeCount: 1, at: 5, closedNames: ['completed'] });
  registry.record('/projects/tpt664-b', 'TPT7', { exitId: 'TPT7@1', blockers: BLOCKERS, status: 'on_fire', agent: 'codex', nudgeCount: 0, at: 6, closedNames: ['completed'] });
  const handler = createHttpHandler(new Map(), () => ({}), null);
  const res = fakeRes();
  await handler(fakeReq('/api/sessions', '/projects/tpt664-a'), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.leftUncommitted, { TPT1: { exitId: 'TPT1@1', blockers: BLOCKERS, status: 'on_fire', agent: 'claude', nudgeCount: 1, at: 5 } });
  assert.deepEqual(body.attention, []);
  assert.equal(body.projectPath, '/projects/tpt664-a');
});

test('replayLeftUncommitted sends one replay-marked frame per flagged task of the socket\'s project', () => {
  registry.record('/projects/tpt664-a', 'TPT1', { exitId: 'TPT1@1', blockers: BLOCKERS, status: 'on_fire', agent: 'claude', nudgeCount: 2, at: 5 });
  registry.record('/projects/tpt664-b', 'TPT7', { exitId: 'TPT7@1', blockers: BLOCKERS, status: 'on_fire', agent: 'codex', nudgeCount: 0, at: 6 });
  const frames = [];
  replayLeftUncommitted({ _projectPath: '/projects/tpt664-a', send: d => frames.push(JSON.parse(d)) });
  assert.deepEqual(frames, [{ type: 'task-left-uncommitted', projectPath: '/projects/tpt664-a', taskId: 'TPT1', blockers: BLOCKERS,
    status: 'on_fire', agent: 'claude', nudgeCount: 2, exitId: 'TPT1@1', replay: true }]);
  const none = [];
  replayLeftUncommitted({ _projectPath: '/projects/none', send: d => none.push(d) });
  assert.deepEqual(none, []);
});

test('(TPT670) after a restart the flags restored from disk are in GET /api/sessions and the connect replay', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-left-uncommitted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const at = Date.now();
  fs.writeFileSync(path.join(root, registry.FILE_NAME), JSON.stringify({ version: 1, projects: {
    '/projects/tpt670': { TPT1: { exitId: 'TPT1@1', blockers: BLOCKERS, status: 'on_fire', agent: 'claude', nudgeCount: 1, at, closedNames: ['completed'] } },
  } }));
  assert.deepEqual(registry.load({ root }), { restored: 1, dropped: 0 });
  const handler = createHttpHandler(new Map(), () => ({}), null);
  const res = fakeRes();
  await handler(fakeReq('/api/sessions', '/projects/tpt670'), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).leftUncommitted, { TPT1: { exitId: 'TPT1@1', blockers: BLOCKERS, status: 'on_fire', agent: 'claude', nudgeCount: 1, at } });
  const frames = [];
  assert.equal(replayLeftUncommitted({ _projectPath: '/projects/tpt670', send: d => frames.push(JSON.parse(d)) }), undefined, 'no backend: replay only, no check');
  assert.deepEqual(frames, [{ type: 'task-left-uncommitted', projectPath: '/projects/tpt670', taskId: 'TPT1', blockers: BLOCKERS,
    status: 'on_fire', agent: 'claude', nudgeCount: 1, exitId: 'TPT1@1', replay: true }]);
});
