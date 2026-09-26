import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Window } from 'happy-dom';

const source = readFileSync(new URL('./task-merge.js', import.meta.url), 'utf8');
const snapshot = (unmerged = true, merge = false, type = 'git') => ({ vcs: { type, merge }, tasks: { TPT1: { unmerged } } });
function harness(t, overrides = {}) {
  const window = new Window();
  t.after(() => window.happyDOM.close());
  window.document.body.innerHTML = '<div id="app"><div class="card" data-id="TPT1"><div class="card-btn-group"><button class="btn-select-card"><span class="select-dot"></span></button><div class="card-action-menu"></div></div></div></div>';
  const env = {
    window, document: window.document, state: { taskMergeStatus: snapshot() },
    api: { merge: { status: async () => snapshot(), task: async () => ({ jobId: 'j1' }) } },
    t: key => key, escapeAttr: value => String(value).replaceAll('"', '&quot;'),
    showToast: () => {}, projectHeader: () => ({}), openMergeBranchesModal: () => {},
    setInterval: () => 1, ...overrides,
  };
  vm.createContext(env);
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), env);
  return { env, card: window.document.querySelector('.card'), app: window.document.getElementById('app') };
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
  first(snapshot());
  await pending;
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 2);
  assert.equal(card.querySelectorAll('.merge-attention-dot').length, 0);
});

test('non-forced reads stop while merge does not apply; forced reads look again', async t => {
  let calls = 0;
  let clock = 1e6;
  let reply = () => snapshot(true, true);
  const { env } = harness(t, {
    Date: { now: () => clock },
    api: { merge: { status: async () => { calls++; return reply(); } } },
  });
  await env.refreshTaskMergeStatus(true);
  clock += 20000;
  await env.refreshTaskMergeStatus();
  assert.equal(calls, 1, 'auto-merge project is not re-polled');
  reply = () => snapshot();
  await env.refreshTaskMergeStatus(true);
  assert.equal(calls, 2);
  clock += 20000;
  await env.refreshTaskMergeStatus();
  assert.equal(calls, 3, 'manual-merge project keeps polling');
  reply = () => { throw Object.assign(new Error('not git'), { code: 'VCS_NOT_GIT' }); };
  await env.refreshTaskMergeStatus(true);
  assert.equal(env.state.taskMergeStatus, null);
  clock += 20000;
  await env.refreshTaskMergeStatus();
  assert.equal(calls, 4, 'VCS_NOT_GIT is not re-polled');
});
