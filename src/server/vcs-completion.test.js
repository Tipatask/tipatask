'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const fx = require('./git-merge/test-fixture');
const { readVcsContext, refreshSessionVcs, buildVcsContextDirective } = require('./vcs-context');
const { verifyTaskCompletion, completeVerifiedTask, guardCompletionTransition } = require('./git-merge/completion-guard');
const { createApiBackend } = require('./api-backend');
const CodexAgent = require('./task-agent/codex-agent');

const all = { id: 7, vcs_type: 'git', vcs_worktree_enabled: 1, vcs_commit_enabled: 1, vcs_pr_enabled: 1, vcs_merge_enabled: 1 };
function backend(row = { ...all }) {
  const calls = [];
  const task = { id: 'TPT1', status: 'working' };
  return { row, calls, task,
    getCredentials: () => ({ projectId: 7 }),
    async getProjectSettings(opts) { calls.push(['settings', opts]); return this.row; },
    async getTask() { return { ...task }; },
    async getStatuses() { return [{ name: 'done', is_workflow_complete: true }, { name: 'working', is_in_progress: true }]; },
    async createTaskComment(id, content, type) { calls.push(['comment', id, content, type]); },
    async updateTask(id, fields) { calls.push(['update', id, fields]); Object.assign(task, fields); return { ...task }; },
  };
}

test('replaced packaged runtime requires restart instead of granting permissions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-runtime-stale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archive = path.join(dir, 'app.asar');
  const root = path.resolve(__dirname, '../..');
  for (const file of ['package.json', 'src/server/vcs-settings.js', 'src/server/vcs-context.js', 'src/server/vcs-runtime.js',
    'src/server/api-backend.js', 'src/server/ws-handlers.js', 'src/server/index.js', 'src/mcp/server.js',
    'src/server/task-agent/base-agent.js', 'src/server/task-agent/codex-agent.js', 'src/server/terminal-session.js',
    'src/server/git-merge/completion-guard.js']) {
    fs.mkdirSync(path.dirname(path.join(archive, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(archive, file));
  }
  const { readVcsContext: read } = require(path.join(archive, 'src/server/vcs-context'));
  assert.equal((await read(backend())).verified, true);
  fs.appendFileSync(path.join(archive, 'src/server/vcs-settings.js'), '\n// replacement\n');
  const result = await read(backend());
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'runtime_replaced_restart_required');
  assert.equal(result.vcs.commit, false);
});

test('live VCS reads reject incomplete flags, wrong projects, and failures without authorizing writes', async () => {
  for (const row of [null, {}, { ...all, vcs_merge_enabled: undefined }, { ...all, id: 9 }, { ...all, vcs_commit_enabled: '0' }]) {
    const context = await readVcsContext(backend(row));
    assert.equal(context.verified, false);
    assert.equal(context.vcs.commit, false);
  }
  const b = backend();
  b.getProjectSettings = async () => { throw new Error('secret-token'); };
  const context = await readVcsContext(b);
  assert.equal(context.verified, false);
  assert.ok(!JSON.stringify(context).includes('secret-token'));
  assert.match(buildVcsContextDirective(context), /No VCS writes/);
});

test('real backend strict refresh cannot authorize from a previously cached row', async t => {
  let row = { ...all };
  let fail = false;
  const server = http.createServer((req, res) => {
    res.writeHead(fail ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fail ? { error: 'offline' } : { project: row }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-vcs-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask/config.json'), JSON.stringify({ API_PROJECT_ID: 7, API_TOKEN: 'test-token', API_BASE_URL: `http://127.0.0.1:${server.address().port}` }));
  const b = createApiBackend(null, root);
  assert.equal((await readVcsContext(b)).vcs.merge, true);
  row = { ...all, vcs_merge_enabled: 0, vcs_commit_enabled: 0 };
  assert.equal((await readVcsContext(b)).vcs.merge, false);
  assert.equal((await readVcsContext(b)).vcs.commit, false);
  fail = true;
  assert.equal((await readVcsContext(b)).verified, false);
  assert.ok(await b.getProjectSettings(), 'UI retains its separate stale-read contract');
});

test('fresh and resumed Codex prompts use current flags and guarded completion', async () => {
  const b = backend();
  const session = { backend: b };
  const agent = new CodexAgent();
  let context = await refreshSessionVcs(session);
  let prompt = agent.buildPrompt('Work on task TPT1: scratch change', { vcsContext: context, vcsSettings: context.vcs });
  assert.match(prompt, /nested task branches first/);
  assert.match(prompt, /PR creation is separate/);
  assert.match(prompt, /complete_task/);
  assert.match(prompt, /Effective VCS context:/);
  b.row = { ...all, vcs_merge_enabled: 0 };
  context = await refreshSessionVcs(session);
  prompt = agent.buildPrompt('Resume task TPT1', { vcsContext: context, vcsSettings: context.vcs });
  assert.doesNotMatch(prompt, /git merge task/);
  assert.equal(session.vcsContext.vcs.merge, false);
  b.row = { ...all, vcs_commit_enabled: 0 };
  context = await refreshSessionVcs(session);
  prompt = agent.buildPrompt('Resume task TPT1', { vcsContext: context, vcsSettings: context.vcs });
  assert.match(prompt, /Do not commit/);
  assert.doesNotMatch(prompt, /`git merge task/);
  assert.ok(b.calls.every(c => c[1].strict && c[1].refresh));
});

test('completion rejects clean unmerged branches, then accepts nested-first merge preserving unrelated edits', async t => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const b = backend();
  f.git(f.root, ['branch', '-m', 'review-root']);
  f.git(f.nested, ['branch', '-m', 'review-nested']);
  fs.appendFileSync(path.join(f.root, 'README.md'), 'unrelated root edit\n');
  fs.appendFileSync(path.join(f.nested, 'README.md'), 'unrelated nested edit\n');
  const args = { backend: b, projectRoot: f.root, taskId: 'TPT1' };
  let check = await verifyTaskCompletion(args);
  assert.equal(check.ready, false);
  assert.equal(check.blockers.filter(x => x.code === 'unmerged_branch').length, 2);
  assert.deepEqual(check.repositories.map(r => r.target), ['review-nested', 'review-root']);
  let complete = await completeVerifiedTask({ ...args, resolution: 'Changed both repositories. Checks passed. Follow-ups: none.' });
  assert.equal(complete.completed, false);
  assert.ok(!b.calls.some(c => ['comment', 'update'].includes(c[0])));
  f.git(f.nested, ['merge', '--ff-only', 'task/TPT1']);
  check = await verifyTaskCompletion(args);
  assert.equal(check.ready, false);
  assert.ok(check.blockers.some(x => x.code === 'gitlink_mismatch'));
  f.git(f.root, ['merge', '--ff-only', 'task/TPT1']);
  check = await verifyTaskCompletion(args);
  assert.equal(check.ready, true, JSON.stringify(check.blockers));
  complete = await completeVerifiedTask({ ...args, resolution: 'Changed both repositories. Checks passed. Follow-ups: none.' });
  assert.equal(complete.completed, true);
  assert.deepEqual(b.calls.filter(c => ['comment', 'update'].includes(c[0])).map(c => c[0]), ['comment', 'update']);
  assert.match(fs.readFileSync(path.join(f.root, 'README.md'), 'utf8'), /unrelated root edit/);
  assert.match(fs.readFileSync(path.join(f.nested, 'README.md'), 'utf8'), /unrelated nested edit/);
  fs.writeFileSync(path.join(f.nested, '.worktrees/TPT1/uncommitted'), 'x');
  assert.ok((await verifyTaskCompletion(args)).blockers.some(x => x.code === 'dirty_task_worktree'));
});

test('merge off never runs git; commit off never merges; failed git cannot pass; remote bypass reopens', async t => {
  const off = backend({ ...all, vcs_merge_enabled: 0 });
  assert.equal((await verifyTaskCompletion({ backend: off, taskId: 'TPT1', git: () => { throw new Error('must not run'); } })).ready, true);
  const unknown = await verifyTaskCompletion({ backend: backend(), projectRoot: '/missing', taskId: 'TPT1', git: async () => ({ status: 128 }) });
  assert.equal(unknown.ready, false);
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const b = backend({ ...all, vcs_commit_enabled: 0 });
  const before = f.git(f.root, ['rev-parse', 'HEAD']);
  assert.equal((await verifyTaskCompletion({ backend: b, projectRoot: f.root, taskId: 'TPT1' })).ready, false);
  assert.equal(f.git(f.root, ['rev-parse', 'HEAD']), before);
  const gate = await guardCompletionTransition({ session: { taskId: 'TPT1' }, backend: b, projectRoot: f.root });
  assert.equal(gate.allowed, false);
  assert.equal(gate.task.status, 'working');
  assert.equal(f.git(f.root, ['rev-parse', 'HEAD']), before);
});

test('legacy slug task keys: accepted when the API has the task, blocked when unknown or malformed', async () => {
  const off = backend({ ...all, vcs_merge_enabled: 0 });
  const args = { backend: off, taskId: 'C-kb-docs-site', resolution: 'Slug-key task done. Checks passed. Follow-ups: none.' };
  const check = await verifyTaskCompletion(args);
  assert.equal(check.ready, true, JSON.stringify(check.blockers));
  assert.ok(!check.blockers.some(x => x.code === 'invalid_task_key'));
  const done = await completeVerifiedTask(args);
  assert.equal(done.completed, true);
  assert.deepEqual(off.calls.filter(c => ['comment', 'update'].includes(c[0])).map(c => c[0]), ['comment', 'update']);

  const missing = backend({ ...all, vcs_merge_enabled: 0 });
  missing.getTask = async () => null;
  assert.deepEqual((await verifyTaskCompletion({ backend: missing, taskId: 'C-kb-docs-site' })).blockers, [{ code: 'unknown_task_key' }]);
  const broken = backend({ ...all, vcs_merge_enabled: 0 });
  broken.getTask = async () => { throw new Error('boom'); };
  assert.deepEqual((await verifyTaskCompletion({ backend: broken, taskId: 'C-kb-docs-site' })).blockers, [{ code: 'task_lookup_failed' }]);
  for (const bad of ['', '   ', null, undefined, 42, 'a/b', '../x']) {
    assert.deepEqual((await verifyTaskCompletion({ backend: off, taskId: bad })).blockers, [{ code: 'invalid_task_key' }], String(bad));
  }
});

test('legacy slug task key: unmerged task/<slug> branch blocks completion, prefix-sibling does not', async t => {
  if (fx.skipUnless(t)) return;
  const f = fx.buildFixture(t);
  const b = backend();
  f.git(f.root, ['branch', '-m', 'review-root']);
  f.git(f.nested, ['branch', '-m', 'review-nested']);
  f.git(f.root, ['branch', 'task/C-kb-docs-site', 'task/TPT1']);
  const check = await verifyTaskCompletion({ backend: b, projectRoot: f.root, taskId: 'C-kb-docs-site' });
  assert.ok(check.blockers.some(x => x.code === 'unmerged_branch' && x.branch === 'task/C-kb-docs-site'), JSON.stringify(check.blockers));
  const sibling = await verifyTaskCompletion({ backend: b, projectRoot: f.root, taskId: 'C-kb-docs' });
  assert.ok(!sibling.blockers.some(x => x.branch === 'task/C-kb-docs-site'), JSON.stringify(sibling.blockers));
});
