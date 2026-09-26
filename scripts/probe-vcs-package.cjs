'use strict';

// Run with the packaged Electron executable and ELECTRON_RUN_AS_NODE=1:
//   <app executable> scripts/probe-vcs-package.cjs <absolute app.asar>
// Loads real packaged modules and spawn preparation; all project/API/Git state is scratch.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const http = require('node:http');

async function main() {
  const archive = path.resolve(process.argv[2]);
  if (!process.versions.electron || !archive.endsWith('app.asar')) throw new Error('Use packaged Electron with app.asar');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-packaged-vcs-'));
  const root = path.join(scratch, 'project');
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  const cleanEnv = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (/^(API_|TIPATASK_|CODEX_|TASK_|OBJECTIVE_|CLAUDE_|PI_|GEMINI_)/.test(k)) delete process.env[k];
  }
  process.env.TIPATASK_PROJECT_ROOT = root;
  process.env.TIPATASK_USER_DATA = path.join(scratch, 'state');
  process.env.TIPATASK_SERVER_ROOT = archive;
  process.env.TASK_BACKEND = 'api';
  // Keep config writers away from the real global Codex config, even in this probe.
  process.env.CODEX_HOME = path.join(scratch, 'codex-seed');
  fs.mkdirSync(process.env.CODEX_HOME);
  fs.mkdirSync(process.env.TIPATASK_USER_DATA);
  let row = { id: 1, vcs_type: 'git', vcs_worktree_enabled: 1, vcs_commit_enabled: 1, vcs_pr_enabled: 1, vcs_merge_enabled: 1, kb_sync_as_you_go: false };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/projects/1' ? { project: row } : { images: [], files: [], comments: [], tags: [] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask/config.json'), JSON.stringify({ API_BASE_URL: `http://127.0.0.1:${server.address().port}`, API_PROJECT_ID: 1, API_TOKEN: 'scratch-token', TASK_BACKEND: 'api', MCP_BROWSER_TOOLS: [] }));
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    for (const dir of [root, nested]) {
      git(dir, ['init', '-q', '-b', 'review-current']);
      fs.writeFileSync(path.join(dir, '.gitignore'), '/.worktrees/\n/.tipatask/\n/.codex/\n');
      fs.writeFileSync(path.join(dir, 'keep.txt'), 'original\n');
      git(dir, ['add', '.gitignore', 'keep.txt']);
      git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial']);
    }
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${git(nested, ['rev-parse', 'HEAD'])},nested`]);
    git(root, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'record nested']);
    const { createApiBackend } = require(path.join(archive, 'src/server/api-backend'));
    const backend = createApiBackend(null, root);
    const { readVcsContext, refreshSessionVcs } = require(path.join(archive, 'src/server/vcs-context'));
    const { verifyTaskCompletion, completeVerifiedTask } = require(path.join(archive, 'src/server/git-merge/completion-guard'));
    const CodexAgent = require(path.join(archive, 'src/server/task-agent/codex-agent'));
    const agent = new CodexAgent();
    const config = require(path.join(archive, 'src/server/config'));
    const session = { backend };
    for (const [merge, commit] of [[1, 1], [0, 1], [1, 0], [1, 1]]) {
      row = { ...row, vcs_merge_enabled: merge, vcs_commit_enabled: commit };
      const context = await refreshSessionVcs(session);
      assert.equal(context.verified, true);
      assert.equal(context.runtime.packaged, true);
      const spec = await agent.getSpawnSpec(config, 'Work on task TPT1: scratch merge verification', 'TPT1', {
        projectPath: root, vcsContext: context, vcsSettings: context.vcs,
      });
      const prompt = spec.args.at(-1);
      assert.equal(spec.cwd, root);
      assert.ok(spec.env.TIPATASK_SERVER_ROOT === archive);
      assert.match(prompt, /complete_task/);
      assert.equal(prompt.includes('`git merge task/'), !!(merge && commit));
      if (merge && commit) assert.match(prompt, /nested task branches first/);
      if (!commit) assert.match(prompt, /Do not commit/);
    }
    for (const dir of [nested, root]) {
      const wt = path.join(dir, '.worktrees/TPT1');
      git(dir, ['worktree', 'add', '-qb', 'task/TPT1', wt]);
      fs.writeFileSync(path.join(wt, 'feature.txt'), 'isolated change\n');
      git(wt, ['add', 'feature.txt']);
      if (dir === root) git(wt, ['update-index', '--cacheinfo', `160000,${git(nested, ['rev-parse', 'task/TPT1'])},nested`]);
      git(wt, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'TPT1 isolated change']);
      fs.appendFileSync(path.join(dir, 'keep.txt'), 'unrelated edit\n');
    }
    const args = { backend, projectRoot: root, taskId: 'TPT1' };
    assert.equal((await verifyTaskCompletion(args)).ready, false);
    const writes = [];
    backend.getTask = async () => ({ id: 'TPT1', status: writes.includes('status') ? 'done' : 'working' });
    backend.getStatuses = async () => [{ name: 'done', is_workflow_complete: true }];
    backend.createTaskComment = async () => writes.push('resolution');
    backend.updateTask = async () => writes.push('status');
    assert.equal((await completeVerifiedTask({ ...args, resolution: 'Scratch verification.' })).completed, false);
    assert.deepEqual(writes, []);
    git(nested, ['merge', '--ff-only', 'task/TPT1']);
    assert.equal((await verifyTaskCompletion(args)).ready, false);
    git(root, ['merge', '--ff-only', 'task/TPT1']);
    for (const dir of [nested, root]) {
      assert.equal(fs.readFileSync(path.join(dir, 'feature.txt'), 'utf8'), 'isolated change\n');
      assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'original\nunrelated edit\n');
    }
    assert.equal((await completeVerifiedTask({ ...args, resolution: 'Both checkouts verified after nested-first merge. Follow-ups: none.' })).completed, true);
    assert.deepEqual(writes, ['resolution', 'status']);
    console.log(JSON.stringify({ ok: true, runtime: (await readVcsContext(backend)).runtime, scenarios: ['fresh-spawn', 'resume-refresh', 'merge-off', 'commit-off', 'nested-first', 'unrelated-edits', 'completion-order'] }));
  } finally {
    await new Promise(r => server.close(r));
    fs.rmSync(scratch, { recursive: true, force: true });
    Object.assign(process.env, cleanEnv);
  }
}
main().catch(err => { console.error(err.stack); process.exitCode = 1; });
