import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { Window } from 'happy-dom';

const source = readFileSync(new URL('./task-merge.js', import.meta.url), 'utf8');
const snapshot = (unmerged = true, merge = false, type = 'git') => ({ vcs: { type, merge }, tasks: { TPT1: { unmerged } } });
// (TPT9211) The project settings bundle api.project.settings() answers.
const settings = (vcsType = 'git', vcsMergeEnabled = false) => ({ vcsType, vcsMergeEnabled });
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)); };
const markers = card => card.querySelectorAll('.merge-attention-dot, .btn-merge-task').length;
const dots = card => card.querySelectorAll('.merge-attention-dot').length;
const focusWindow = window => window.dispatchEvent(new window.Event('focus'));
// Dispatched by the Version Control settings save and by merge:done/error/conflict frames.
const statusChanged = window => window.document.dispatchEvent(new window.CustomEvent('tiptask:merge-status-changed'));

function harness(t, { api: apiOverrides, ...overrides } = {}) {
  const window = new Window();
  t.after(() => window.happyDOM.close());
  window.document.body.innerHTML = '<div id="app"><div class="card" data-id="TPT1"><div class="card-btn-group"><button class="btn-select-card"><span class="select-dot"></span></button><div class="card-action-menu"></div></div></div></div>';
  const timer = {};
  const env = {
    window, document: window.document, state: { taskMergeStatus: snapshot() },
    api: {
      project: { settings: async () => settings() },
      merge: { status: async () => snapshot(), task: async () => ({ jobId: 'j1' }) },
      ...apiOverrides,
    },
    t: key => key, escapeAttr: value => String(value).replaceAll('"', '&quot;'),
    showToast: () => {}, projectHeader: () => ({}), openMergeBranchesModal: () => {},
    // The visible-window interval; tests run its callback through timer.tick().
    setInterval: fn => { timer.tick = fn; return 1; }, ...overrides,
  };
  vm.createContext(env);
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), env);
  return { env, window, timer, card: window.document.querySelector('.card'), app: window.document.getElementById('app') };
}

test('only manual unmerged board cards show both dots; refresh clears them without a board rebuild', t => {
  const { env, card } = harness(t);
  env.syncTaskMergeCard(card);
  assert.equal(card.querySelectorAll('.merge-attention-dot').length, 2);
  assert.ok(card.classList.contains('has-unmerged-worktree'));
  assert.match(card.querySelector('.btn-select-card').getAttribute('aria-label'), /unmergedWorktree/);
  for (const next of [snapshot(false), snapshot(true, true), snapshot(true, false, 'svn'), null]) {
    env.state.taskMergeStatus = next;
    env.syncTaskMergeCard(card);
    assert.equal(card.querySelectorAll('.merge-attention-dot, .btn-merge-task').length, 0);
    assert.equal(card.classList.contains('has-unmerged-worktree'), false);
  }
  env.state.taskMergeStatus = snapshot();
  card.classList.add('card--preview');
  env.syncTaskMergeCard(card);
  assert.equal(card.querySelectorAll('.btn-merge-task').length, 0);
});

test('merge submits once, opens progress, and clears dots only after refreshed status', async t => {
  let resolve;
  let calls = 0;
  let opens = 0;
  let merged = false;
  const { env, card } = harness(t, {
    api: { merge: {
      task: key => { assert.equal(key, 'TPT1'); calls++; return new Promise(r => { resolve = r; }); },
      status: async () => snapshot(!merged),
    } },
    openMergeBranchesModal: () => { opens++; },
  });
  env.syncTaskMergeCard(card);
  const run = env.mergeTaskFromCard('TPT1');
  await env.mergeTaskFromCard('TPT1');
  assert.equal(calls, 1);
  assert.equal(card.querySelector('.btn-merge-task').disabled, true);
  assert.equal(card.querySelectorAll('.merge-attention-dot').length, 2);
  resolve({ jobId: 'j1' });
  await run;
  assert.equal(opens, 1);
  assert.equal(card.querySelectorAll('.merge-attention-dot').length, 2);
  merged = true;
  await env.refreshTaskMergeStatus(true);
  assert.equal(card.querySelectorAll('.merge-attention-dot, .btn-merge-task').length, 0);
});

test('failed submit reports blocker details and retains unmerged indicators', async t => {
  let message;
  const { env, card } = harness(t, {
    api: { merge: { status: async () => snapshot(), task: async () => { throw Object.assign(new Error('blocked'), { details: { blockers: [{ message: 'Commit worktree first' }] } }); } } },
    t: (key, vars) => vars?.msg || key, showToast: msg => { message = msg; },
  });
  await env.mergeTaskFromCard('TPT1');
  assert.equal(message, 'Commit worktree first');
  assert.equal(card.querySelectorAll('.merge-attention-dot').length, 2);
});

test('forced refresh during an old scan queues a fresh read; initialization binds one listener', async t => {
  let first;
  let calls = 0;
  const { env, app, card } = harness(t, {
    api: { merge: { status: () => ++calls === 1 ? new Promise(r => { first = r; }) : Promise.resolve(snapshot(false)) } },
  });
  env.initializeTaskMerge(app);
  env.initializeTaskMerge(app);
  const pending = env.refreshTaskMergeStatus(true);
  await settle(); // the settings gate answered; the first scan is in flight
  first(snapshot());
  await pending;
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 2);
  assert.equal(card.querySelectorAll('.merge-attention-dot').length, 0);
});

test('non-forced reads wait the re-check gap while merge does not apply; forced reads look again', async t => {
  let calls = 0;
  let clock = 1e6;
  let reply = () => snapshot(true, true);
  const { env, card } = harness(t, {
    Date: { now: () => clock },
    api: { merge: { status: async () => { calls++; return reply(); } } },
  });
  await env.refreshTaskMergeStatus(true);
  clock += 20000;
  await env.refreshTaskMergeStatus();
  assert.equal(calls, 1, 'an automatic-merge answer is not re-read inside the 30 s re-check gap');
  clock += 10000;
  await env.refreshTaskMergeStatus();
  assert.equal(calls, 2, 'and is read again after it');
  reply = () => snapshot();
  await env.refreshTaskMergeStatus(true);
  assert.equal(calls, 3);
  clock += 10000;
  await env.refreshTaskMergeStatus();
  assert.equal(calls, 4, 'manual-merge project keeps the 10 s cadence');
  // Settings said git, the server still says off: its own settings cache lags a save made
  // through the window's backend by up to 30 s.
  reply = () => { throw Object.assign(new Error('not git'), { code: 'VCS_NOT_GIT' }); };
  await env.refreshTaskMergeStatus(true);
  assert.equal(env.state.taskMergeStatus, null);
  assert.equal(markers(card), 0);
  clock += 20000;
  await env.refreshTaskMergeStatus();
  assert.equal(calls, 5, 'VCS_NOT_GIT is not re-read inside the re-check gap');
  reply = () => snapshot();
  clock += 10000;
  await env.refreshTaskMergeStatus();
  assert.equal(calls, 6, 'and recovers once the gap is over');
  assert.equal(dots(card), 2);
});

test('shouldFetchMergeStatus() follows the live settings: only git with automatic merge off scans', async t => {
  let current = settings();
  let reads = 0;
  const { env } = harness(t, { api: { project: { settings: async () => { reads++; return current; } } } });
  assert.equal(await env.shouldFetchMergeStatus(), true);
  for (const next of [settings(null), settings('svn'), settings('svn', true), settings('git', true), null, {}]) {
    current = next;
    assert.equal(await env.shouldFetchMergeStatus(), false, JSON.stringify(next));
  }
  current = { vcsType: 'git' }; // no merge flag in the bundle: manual merge
  assert.equal(await env.shouldFetchMergeStatus(), true);
  current = settings();
  assert.equal(await env.shouldFetchMergeStatus(), true);
  assert.equal(reads, 9, 'one settings read per call, never a remembered answer');
  env.api.project.settings = async () => { throw new Error('IPC unavailable'); };
  assert.equal(await env.shouldFetchMergeStatus(), false, 'an unreadable bundle fails closed');
});

// The gate reads what the real GET /api/project/settings route reports, and the projects it keeps
// from scanning are exactly the ones GET /api/project/merge/status refuses (or, automatic merge,
// has no card UI for): the real createHttpHandler over a stub backend per stored setting.
test('the gate follows the real settings route; the status route still refuses the projects it skips', async t => {
  process.env.TASK_BACKEND = 'api';
  const { createHttpHandler } = createRequire(import.meta.url)('../server/ws-handlers.js');
  const request = async (handler, url) => {
    const req = { method: 'GET', url, headers: {}, async *[Symbol.asyncIterator]() {} };
    const res = { statusCode: null, body: '', writeHead(status) { res.statusCode = status; }, end(chunk) { res.body = chunk || ''; } };
    await handler(req, res);
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
  };
  const rows = [
    [null, false, true],
    [{ vcs_type: null, vcs_merge_enabled: 0 }, false, true],
    [{ vcs_type: 'svn', vcs_merge_enabled: 1 }, false, true],
    [{ vcs_type: 'git', vcs_merge_enabled: 1 }, false, false],
    [{ vcs_type: 'git', vcs_merge_enabled: 0 }, true, false],
  ];
  for (const [row, scans, refused] of rows) {
    const label = JSON.stringify(row);
    const backend = {
      async getProjectSettings() { return row; },
      getCredentials() { return { baseUrl: 'https://tt.example.test', projectId: '2', token: 'tok' }; },
    };
    const handler = createHttpHandler(new Map(), () => backend, null);
    const settingsRes = await request(handler, '/api/project/settings');
    assert.equal(settingsRes.status, 200, label);
    const { env } = harness(t, { api: { project: { settings: async () => settingsRes.body } } });
    assert.equal(await env.shouldFetchMergeStatus(), scans, label);
    if (refused) {
      const statusRes = await request(handler, '/api/project/merge/status');
      assert.equal(statusRes.status, 409, label);
      assert.equal(statusRes.body.code, 'VCS_NOT_GIT', label);
    }
  }
});

test('off, svn and automatic-merge projects send no merge-status request from any trigger', async t => {
  for (const bundle of [settings(null), settings('svn'), settings('git', true)]) {
    const label = JSON.stringify(bundle);
    let statusCalls = 0;
    let settingsReads = 0;
    let clock = 1e6;
    const { env, app, card, window, timer } = harness(t, {
      Date: { now: () => clock },
      api: {
        project: { settings: async () => { settingsReads++; return bundle; } },
        merge: { status: async () => { statusCalls++; return snapshot(); }, task: async () => ({}) },
      },
    });
    env.initializeTaskMerge(app);
    await settle();
    focusWindow(window);
    await settle();
    statusChanged(window);
    await settle();
    clock += 60000;
    timer.tick();
    await settle();
    clock += 60000;
    await env.refreshTaskMergeStatus(); // a board re-render
    assert.equal(statusCalls, 0, label);
    assert.equal(settingsReads, 5, `${label}: every trigger re-checks the settings instead`);
    assert.equal(env.state.taskMergeStatus, null, label);
    assert.equal(markers(card), 0, label);
    assert.equal(card.classList.contains('has-unmerged-worktree'), false, label);
  }
});

test('git projects with manual merge keep refreshing on every trigger', async t => {
  let statusCalls = 0;
  let clock = 1e6;
  const { env, app, card, window, timer } = harness(t, {
    Date: { now: () => clock },
    api: { merge: { status: async () => { statusCalls++; return snapshot(); }, task: async () => ({}) } },
  });
  env.initializeTaskMerge(app);
  await settle();
  assert.equal(statusCalls, 1);
  assert.equal(dots(card), 2);
  focusWindow(window);
  await settle();
  statusChanged(window);
  await settle();
  assert.equal(statusCalls, 3);
  clock += 5000;
  await env.refreshTaskMergeStatus();
  assert.equal(statusCalls, 3, 'a re-render inside the 10 s throttle reads nothing');
  clock += 60000;
  timer.tick();
  await settle();
  assert.equal(statusCalls, 4);
  assert.equal(dots(card), 2);
});

test('switching Git off clears stale merge markers at once, even over a scan in flight', async t => {
  let current = settings();
  let statusCalls = 0;
  let release;
  const { env, app, card, window } = harness(t, {
    api: {
      project: { settings: async () => current },
      merge: { status: () => ++statusCalls === 2 ? new Promise(r => { release = r; }) : Promise.resolve(snapshot()), task: async () => ({}) },
    },
  });
  env.initializeTaskMerge(app);
  await settle();
  assert.equal(dots(card), 2);
  assert.ok(card.classList.contains('has-unmerged-worktree'));
  // A focus read is mid-scan when the Version Control save turns Git off.
  focusWindow(window);
  await settle();
  current = settings(null);
  statusChanged(window);
  release(snapshot()); // the older answer still says git
  await settle();
  assert.equal(statusCalls, 2, 'no status request once the settings say off');
  assert.equal(env.state.taskMergeStatus, null);
  assert.equal(markers(card), 0);
  assert.equal(card.classList.contains('has-unmerged-worktree'), false);
  assert.doesNotMatch(card.querySelector('.btn-select-card').getAttribute('aria-label'), /unmergedWorktree/);
});

test('switching Git on resumes scans: at once on a forced read, within the re-check gap otherwise', async t => {
  let current = settings(null);
  let statusCalls = 0;
  let clock = 1e6;
  const { env, app, card, window, timer } = harness(t, {
    Date: { now: () => clock },
    api: {
      project: { settings: async () => current },
      merge: { status: async () => { statusCalls++; return snapshot(); }, task: async () => ({}) },
    },
  });
  env.initializeTaskMerge(app);
  await settle();
  assert.equal(statusCalls, 0);
  // Saved in this window: the settings save dispatches the forced read.
  current = settings();
  statusChanged(window);
  await settle();
  assert.equal(statusCalls, 1);
  assert.equal(dots(card), 2);
  current = settings('svn');
  statusChanged(window);
  await settle();
  assert.equal(markers(card), 0);
  // Back to git from another device or the web app: no forced trigger here.
  current = settings();
  clock += 20000;
  await env.refreshTaskMergeStatus(); // a board re-render inside the re-check gap
  assert.equal(statusCalls, 1);
  clock += 40000;
  timer.tick();
  await settle();
  assert.equal(statusCalls, 2);
  assert.equal(dots(card), 2);
});

test('project switch: the old project\'s settings answer neither scans nor paints; each project reads its own', async t => {
  let scope = 'A';
  let releaseA;
  const reads = [];
  const scans = [];
  const bundles = { A: settings(), B: settings(null) };
  const { env, card } = harness(t, {
    projectHeader: () => ({ 'x-tipatask-project': scope }),
    api: {
      project: { settings: () => {
        reads.push(scope);
        return reads.length === 1 ? new Promise(r => { releaseA = r; }) : Promise.resolve(bundles[scope]);
      } },
      merge: { status: async () => { scans.push(scope); return snapshot(); }, task: async () => ({}) },
    },
  });
  const first = env.refreshTaskMergeStatus(true);
  scope = 'B'; // the window now shows project B, its VCS off
  const second = env.refreshTaskMergeStatus(true);
  releaseA(bundles.A); // A says git, too late
  await first;
  await second;
  await settle();
  assert.deepEqual(reads, ['A', 'B']);
  assert.deepEqual(scans, [], 'A was left before its gate answered and B is off');
  assert.equal(env.state.taskMergeStatus, null);
  assert.equal(markers(card), 0);
  scope = 'A';
  await env.refreshTaskMergeStatus(true);
  assert.deepEqual(scans, ['A']);
  assert.equal(dots(card), 2);
  scope = 'B';
  const leaving = env.refreshTaskMergeStatus(true);
  assert.equal(markers(card), 0, 'A\'s markers go before B\'s settings answer');
  await leaving;
  await settle();
  assert.deepEqual(scans, ['A']);
  assert.equal(env.state.taskMergeStatus, null);
});
