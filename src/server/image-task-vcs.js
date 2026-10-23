'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { runGit, runCommand } = require('./git-merge/git-runner');
const { discoverRepos } = require('./git-merge/repo-discovery');
const { readVcsContext } = require('./vcs-context');
const { imageError } = require('./pi-image-provider');
const { inside, safeFolder, digest } = require('./image-task-store');

async function verifiedVcs(backend, expected) {
  const context = await readVcsContext(backend);
  if (!context.verified || (expected && JSON.stringify(context.vcs) !== JSON.stringify(expected))) throw imageError('completion');
  return context.vcs;
}

async function prepareImageVcs({ backend, projectRoot, folder, taskId, git = runGit }) {
  const vcs = await verifiedVcs(backend);
  const project = await fs.realpath(projectRoot);
  const output = path.resolve(project, folder);
  if (!inside(project, output)) throw imageError('save');
  if (vcs.type !== 'git') return { vcs, root: project, folder, repoPath: project, branch: null };
  const repos = await discoverRepos(project, { git });
  const repo = repos.filter(r => inside(r.path, output)).sort((a, b) => b.path.length - a.path.length)[0];
  const read = async args => {
    const result = await git(args, { cwd: repo.path });
    if (result.status !== 0 || result.error) throw imageError('completion');
    return result.stdout.trim();
  };
  const top = await read(['rev-parse', '--show-toplevel']);
  if (path.resolve(top) !== repo.path) throw imageError('completion');
  const current = await read(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  let root = repo.path;
  let branch = current;
  if (vcs.worktree) {
    branch = `task/${taskId}`;
    root = path.join(repo.path, '.worktrees', taskId);
    const list = await read(['worktree', 'list', '--porcelain']);
    if (list.includes(`worktree ${root}\n`)) {
      const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root });
      if (head.status !== 0 || head.stdout.trim() !== branch) throw imageError('completion');
    } else {
      // Do not reuse somebody else's branch or directory.
      if ((await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo.path })).status === 0) throw imageError('completion');
      await safeFolder(repo.path, '.worktrees');
      await verifiedVcs(backend, vcs);
      const created = await git(['worktree', 'add', root, '-b', branch, 'HEAD'], { cwd: repo.path });
      if (created.status !== 0 || created.error) throw imageError('completion');
    }
  }
  return { vcs, root, folder: path.relative(repo.path, output), repoPath: repo.path, repoId: repo.id, branch };
}

async function finishImageVcs({ backend, projectRoot, taskId, state, persist, git = runGit, command = runCommand }) {
  const plan = state.vcsPlan;
  const vcs = await verifiedVcs(backend, plan.vcs);
  // Check generated files again immediately before recording them or completing.
  for (const file of state.files) {
    const stat = await fs.lstat(file.path);
    if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(file.path)) !== file.sha256) throw imageError('save');
  }
  const writeGit = async (args, opts = {}) => {
    await verifiedVcs(backend, vcs);
    const result = await git(args, { cwd: plan.root, ...opts });
    if (result.status !== 0 || result.error) throw imageError('completion');
    return result;
  };
  if (vcs.type === 'svn') {
    // SVN projects require a real commit too; never include unrelated paths.
    if (!state.commit) {
      await verifiedVcs(backend, vcs);
      const files = state.files.map(f => path.relative(plan.root, f.path));
      const added = await command('svn', ['add', '--parents', '--force', '--', ...files], { cwd: plan.root });
      if (added.status !== 0) throw imageError('completion');
      await verifiedVcs(backend, vcs);
      const result = await command('svn', ['commit', '-m', `${taskId}: Save generated images`, '--', ...files], { cwd: plan.root });
      if (result.status !== 0) throw imageError('completion');
      state.commit = 'svn'; await persist();
    }
  }
  if (vcs.type !== 'git') return;
  if (vcs.commit && !state.commit) {
    const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: plan.root });
    if (branch.status !== 0 || branch.stdout.trim() !== plan.branch) throw imageError('completion');
    const files = state.files.map(f => path.relative(plan.root, f.path));
    await writeGit(['add', '--', ...files]);
    // --only leaves other staged files out of this commit and preserves their staged state.
    await writeGit(['commit', '--only', '-m', `${taskId}: Save generated images`, '--', ...files]);
    const head = await git(['rev-parse', 'HEAD'], { cwd: plan.root });
    if (head.status !== 0) throw imageError('completion');
    state.commit = head.stdout.trim(); await persist();
  }
  if (vcs.pr && !state.prUrl) {
    // A PR needs a separate task branch; do not push a user's current main branch.
    if (!vcs.commit || plan.branch !== `task/${taskId}`) throw imageError('completion');
    const { pushRepo, createPr } = require('./git-merge/publish');
    const { detectMainBranch } = require('./git-merge/repo-discovery');
    const repo = { path: plan.repoPath };
    const base = (await detectMainBranch(repo.path, { git })).mainBranch;
    if (!base || base === plan.branch) throw imageError('completion');
    const pushed = await pushRepo({ repo, target: plan.branch, git: writeGit });
    if (!pushed.ok) throw imageError('completion');
    await verifiedVcs(backend, vcs);
    const pr = await createPr({ repo, base, head: plan.branch, title: `${taskId}: Generate images`, body: 'Generated image assets with validated formats and project-relative output paths.' });
    if (!pr.ok) throw imageError('completion');
    state.prUrl = pr.url; await persist();
  }
  if (vcs.merge && vcs.worktree && !state.merged) {
    const { buildPlan } = require('./git-merge/merge-plan');
    const { MergeJob } = require('./git-merge/merge-job');
    const repos = await discoverRepos(await fs.realpath(projectRoot), { git });
    for (const repo of repos) {
      const current = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repo.path });
      if (current.status !== 0) throw imageError('completion');
      repo.currentBranch = repo.target = current.stdout.trim();
      repo.taskBranches = repo.id === plan.repoId ? [{ branch: plan.branch, taskKey: taskId, headSha: state.commit }] : [];
    }
    const steps = buildPlan({ repos, selections: [{ repoId: plan.repoId, branch: plan.branch }], checks: { test: false, build: false, baseline: false } });
    // Generated bytes/digests above are the relevant checks for these asset-only commits.
    const job = new MergeJob({ projectRoot, repos, plan: steps, options: { commitEnabled: true }, git: async (args, opts) => {
      if (['merge', 'commit', 'add', 'update-index', 'checkout'].includes(args[0])) await verifiedVcs(backend, vcs);
      if (args[0] === 'commit' && args[1] === '-m' && args[2]?.startsWith('Bump ')) {
        const parent = repos.find(r => r.path === opts.cwd);
        const links = repos.filter(r => r.parentId === parent?.id && inside(r.path, plan.repoPath)).map(r => r.relToParent);
        if (!links.length) throw imageError('completion');
        args = ['commit', '--only', '-m', `${taskId}: Record generated image assets`, '--', ...links];
      }
      return git(args, opts);
    } });
    await job.start();
    if (job.state !== 'done') throw imageError('completion');
    state.merged = true; await persist();
  }
}

module.exports = { prepareImageVcs, finishImageVcs, verifiedVcs };
