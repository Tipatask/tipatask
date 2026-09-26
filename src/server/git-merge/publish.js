'use strict';

// TPT345 — optional push + pull-request step after a merge run. Nested repos first (the
// root gitlink references their commits), root last and skipped when a nested push
// failed. `gh pr create --base <main> --head <target>` per repo — the forge default branch
// can differ from the local main branch. Never writes attribution.

const { runGit, runCommand } = require('./git-runner');
const { detectMainBranch } = require('./repo-discovery');
const { executionOrder } = require('./repo-discovery');

function buildPrTitle(keys = []) {
  if (!keys.length) return 'Merge task branches';
  const t = `Merge ${keys.join(', ')}`;
  return t.length <= 70 ? t : `Merge ${keys.length} task branches`;
}

function buildPrBody({ mergedTasks = [], repoRelPath = '' }) {
  const lines = ['Merged task branches' + (repoRelPath ? ` (${repoRelPath})` : '') + ':', ''];
  for (const t of mergedTasks) lines.push(`- ${t.key}${t.title ? ` — ${t.title}` : ''}`);
  return lines.join('\n') + '\n';
}

async function pushRepo({ repo, target, git = runGit }) {
  const r = await git(['push', '-u', 'origin', target], { cwd: repo.path, timeoutMs: 120_000 });
  if (!r.error && r.status === 0) return { ok: true, output: (r.stderr || r.stdout).trim().slice(-2000) };
  const stderr = r.error ? (r.timedOut ? 'git push timed out' : r.error.message) : (r.stderr || r.stdout).trim();
  return { ok: false, error: stderr.slice(0, 2000), suggested: `cd ${JSON.stringify(repo.path)} && git push -u origin ${target}` };
}

async function createPr({ repo, base, head, title, body, exec }) {
  const args = ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body-file', '-'];
  const r = await runCommand('gh', args, { cwd: repo.path, timeoutMs: 60_000, exec, input: body });
  if (r.error && r.error.code === 'ENOENT') return { ok: false, skipped: 'gh-not-found', error: 'gh CLI not found on PATH', suggested: `cd ${JSON.stringify(repo.path)} && gh ${args.slice(0, -2).map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' ')}` };
  if (r.error || r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || (r.error && r.error.message) || '').trim().slice(0, 2000) };
  const url = (r.stdout.match(/https?:\/\/\S+/) || [null])[0];
  return { ok: true, url, output: r.stdout.trim().slice(-1000) };
}

// repos: preflighted scan repos (with .target); merged: { repoId: [taskKey] };
// tasksByKey: Map; pr: boolean; bases: { repoId: mainBranchOverride }.
async function publishProject({ repos, merged = {}, tasksByKey = new Map(), pr = true, bases = {}, repoIds = null, git = runGit, exec } = {}) {
  const results = [];
  let nestedFailed = false;
  for (const repo of executionOrder(repos)) {
    if (repoIds && !repoIds.includes(repo.id)) continue;
    const target = repo.targetSpec && repo.targetSpec.createBranch ? repo.targetSpec.createBranch : (repo.target || repo.currentBranch);
    const row = { repoId: repo.id, relPath: repo.relPath, target, pushed: false, prUrl: null, prSkipped: null, error: null, suggested: null };
    if (repo.kind === 'root' && nestedFailed) {
      row.error = 'Skipped: a nested repository push failed, so the root gitlink would reference unpushed commits';
      results.push(row); continue;
    }
    const push = await pushRepo({ repo, target, git });
    if (!push.ok) {
      row.error = push.error; row.suggested = push.suggested;
      if (repo.kind !== 'root') nestedFailed = true;
      results.push(row); continue;
    }
    row.pushed = true;
    if (pr) {
      const main = bases[repo.id] || repo.mainBranch || (await detectMainBranch(repo.path, { git, exec })).mainBranch;
      if (!main) { row.prSkipped = 'no-main-branch'; row.error = 'Could not determine the main branch (no origin/HEAD, gh unavailable)'; results.push(row); continue; }
      if (main === target) { row.prSkipped = 'target-is-main'; results.push(row); continue; }
      const keys = merged[repo.id] || [];
      const mergedTasks = keys.map(k => ({ key: k, title: (tasksByKey.get(k) || {}).title || '' }));
      const res = await createPr({ repo, base: main, head: target, title: buildPrTitle(keys), body: buildPrBody({ mergedTasks, repoRelPath: repo.relPath }), exec });
      if (res.ok) row.prUrl = res.url; else { row.prSkipped = res.skipped || null; row.error = res.error; row.suggested = res.suggested || null; }
    }
    results.push(row);
  }
  return { repos: results };
}

module.exports = { publishProject, pushRepo, createPr, buildPrBody, buildPrTitle };
