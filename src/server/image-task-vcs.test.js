'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareImageVcs, finishImageVcs } = require('./image-task-vcs');
const { digest } = require('./image-task-store');
const { verifyTaskCompletion } = require('./git-merge/completion-guard');

function git(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function init(root) {
  await fs.mkdir(root, { recursive: true });
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Test User'); git(root, 'config', 'user.email', 'test@example.test');
  await fs.writeFile(path.join(root, 'source.txt'), 'original\n');
  git(root, 'add', 'source.txt'); git(root, 'commit', '-m', 'Initial');
}
function backend(flags) {
  const project = { id: 99, vcs_type: 'git', vcs_commit_enabled: false, vcs_worktree_enabled: false, vcs_merge_enabled: false, vcs_pr_enabled: false, ...flags };
  return { getProjectSettings: async () => project, getCredentials: () => ({ projectId: 99 }), project };
}
async function fixture(t, flags = {}, nested = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-image-vcs-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await init(root);
  if (nested) {
    await init(path.join(root, 'module'));
    git(root, 'add', 'module'); git(root, 'commit', '-m', 'Add module');
  }
  const api = backend(flags);
  const plan = await prepareImageVcs({ backend: api, projectRoot: root, folder: nested ? 'module/generated' : 'generated', taskId: 'IMG1' });
  const dir = path.join(plan.root, plan.folder); await fs.mkdir(dir, { recursive: true });
  const filename = path.join(dir, 'unique.png'); const bytes = Buffer.from('validated image fixture'); await fs.writeFile(filename, bytes);
  const state = { vcsPlan: plan, files: [{ path: filename, sha256: digest(bytes) }] };
  return { root, api, state, run: () => finishImageVcs({ backend: api, projectRoot: root, taskId: 'IMG1', state, persist: async () => {} }) };
}

test('VCS-off and commit-disabled image tasks leave generated assets uncommitted', async t => {
  const f = await fixture(t);
  const before = git(f.root, 'rev-parse', 'HEAD'); await f.run();
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before);
  assert.equal(git(f.root, 'diff', '--cached', '--name-only'), '');
  f.api.project.vcs_type = null;
  const plan = await prepareImageVcs({ backend: f.api, projectRoot: f.root, folder: 'other', taskId: 'IMG2' });
  assert.equal(plan.vcs.type, null);
});

test('asset commit excludes and preserves unrelated staged edits', async t => {
  const f = await fixture(t, { vcs_commit_enabled: true });
  await fs.writeFile(path.join(f.root, 'source.txt'), 'user staged content'); git(f.root, 'add', 'source.txt');
  await f.run();
  assert.match(git(f.root, 'log', '-1', '--format=%s'), /^IMG1:/);
  assert.equal(git(f.root, 'diff', '--cached', '--name-only'), 'source.txt');
  assert.equal(git(f.root, 'show', 'HEAD:source.txt'), 'original');
  const commit = f.state.commit; await f.run(); assert.equal(f.state.commit, commit);
});

test('worktree images merge through nested repositories and required completion verification', async t => {
  const f = await fixture(t, { vcs_commit_enabled: true, vcs_worktree_enabled: true, vcs_merge_enabled: true }, true);
  await fs.writeFile(path.join(f.root, 'source.txt'), 'user staged content'); git(f.root, 'add', 'source.txt');
  await f.run();
  assert.equal(f.state.merged, true);
  assert.match(git(f.root, 'log', '-1', '--format=%s'), /^IMG1:/);
  assert.equal(git(f.root, 'diff', '--cached', '--name-only'), 'source.txt');
  assert.ok(await fs.stat(path.join(f.root, 'module/generated/unique.png')));
  const result = await verifyTaskCompletion({ backend: f.api, projectRoot: f.root, taskId: 'IMG1' });
  assert.equal(result.ready, true, JSON.stringify(result.blockers));
});

test('live settings changes and missing settings block VCS writes and completion', async t => {
  const f = await fixture(t, { vcs_commit_enabled: true });
  const before = git(f.root, 'rev-parse', 'HEAD');
  f.api.project.vcs_commit_enabled = false;
  await assert.rejects(f.run(), { code: 'completion' });
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before);
  f.api.getProjectSettings = async () => { throw new Error('offline'); };
  await assert.rejects(prepareImageVcs({ backend: f.api, projectRoot: f.root, folder: 'images', taskId: 'IMG2' }), { code: 'completion' });
});
