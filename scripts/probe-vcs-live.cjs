'use strict';

// Opt-in, real Codex acceptance probe. Only inference leaves the machine: project API
// and PR creation are local fixtures. Run with packaged Electron as Node and app.asar.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

async function main() {
  if (!process.versions.electron) throw new Error('Run with packaged Electron as Node');
  const archive = path.resolve(process.argv[2]);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-live-vcs-'));
  const root = path.join(scratch, 'project');
  const nested = path.join(root, 'nested');
  const auth = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  fs.mkdirSync(nested, { recursive: true });
  for (const key of Object.keys(process.env)) if (/^(API_|TIPATASK_|CODEX_|TASK_|CLAUDE_|PI_|GEMINI_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { TIPATASK_PROJECT_ROOT: root, TIPATASK_USER_DATA: path.join(scratch, 'state'),
    TIPATASK_SERVER_ROOT: archive, TASK_BACKEND: 'api', CODEX_HOME: path.join(scratch, 'seed') });
  fs.mkdirSync(process.env.TIPATASK_USER_DATA);
  fs.mkdirSync(process.env.CODEX_HOME);
  fs.symlinkSync(auth, path.join(process.env.CODEX_HOME, 'auth.json'));
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), '');
  const task = { id: 1, project_id: 1, task_key: 'TPT1', title: 'Scratch nested merge', category: 'CODING', status: 'working', tags: [], dependencies: [], priority: 1 };
  const row = { id: 1, vcs_type: 'git', vcs_worktree_enabled: 1, vcs_commit_enabled: 1, vcs_pr_enabled: 1, vcs_merge_enabled: 1, kb_sync_as_you_go: false };
  const statuses = [{ name: 'working', is_in_progress: true }, { name: 'done', is_workflow_complete: true }];
  const events = [];
  const comments = [];
  let backend, verifyTaskCompletion;
  const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    let body = '';
    for await (const c of req) body += c;
    const data = body ? JSON.parse(body) : {};
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url === '/api/auth/me') return send({ user: { id: 1 } });
    if (url === '/api/projects/1') return send({ project: row });
    if (url.endsWith('/statuses')) return send({ statuses });
    if (url.endsWith('/comments')) {
      if (req.method === 'POST') {
        if (data.type === 'resolution') {
          const check = await verifyTaskCompletion({ backend, projectRoot: root, taskId: 'TPT1' });
          if (!check.ready) return send({ error: 'Resolution before merge verification', blockers: check.blockers }, 409);
          events.push('resolution');
        }
        const comment = { id: comments.length + 1, content: data.content, type: data.type };
        comments.push(comment); return send({ comment }, 201);
      }
      return send({ comments });
    }
    if (url.endsWith('/tasks/TPT1')) {
      if (req.method === 'PATCH') {
        if (data.status === 'done') {
          const check = await verifyTaskCompletion({ backend, projectRoot: root, taskId: 'TPT1' });
          if (!check.ready || !events.includes('resolution')) return send({ error: 'Completion before merge and resolution' }, 409);
          events.push('completed');
        }
        Object.assign(task, data);
      }
      return send({ task });
    }
    if (url.endsWith('/tasks')) return send({ tasks: [task] });
    return send({ tags: [], files: [], images: [], recipes: [], sprints: [] });
  });
  await new Promise((r, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', r); });
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask/config.json'), JSON.stringify({ API_BASE_URL: `http://127.0.0.1:${server.address().port}`, API_PROJECT_ID: 1, API_TOKEN: 'scratch-token', TASK_BACKEND: 'api', MCP_BROWSER_TOOLS: [] }));
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (const dir of [root, nested]) {
    git(dir, ['init', '-q', '-b', 'review-current']);
    git(dir, ['config', 'user.name', 'Fixture']); git(dir, ['config', 'user.email', 'fixture@example.invalid']);
    git(dir, ['config', 'commit.gpgsign', 'false']); git(dir, ['config', 'core.hooksPath', os.devNull]);
    fs.writeFileSync(path.join(dir, '.gitignore'), '/.worktrees/\n/.tipatask/\n/.codex/\n');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'original\n');
    git(dir, ['add', '.gitignore', 'keep.txt']); git(dir, ['commit', '-qm', 'initial']);
  }
  git(root, ['update-index', '--add', '--cacheinfo', `160000,${git(nested, ['rev-parse', 'HEAD'])},nested`]);
  git(root, ['commit', '-qm', 'record nested']);
  for (const dir of [root, nested]) fs.appendFileSync(path.join(dir, 'keep.txt'), 'unrelated edit\n');
  const bin = path.join(scratch, 'bin'); fs.mkdirSync(bin);
  const prLog = path.join(scratch, 'pr.log');
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$VCS_PROBE_PR_LOG"\nprintf "%s\\n" "https://example.invalid/scratch/pull/1"\n', { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.VCS_PROBE_PR_LOG = prLog;
  const { createApiBackend } = require(path.join(archive, 'src/server/api-backend'));
  backend = createApiBackend(null, root);
  ({ verifyTaskCompletion } = require(path.join(archive, 'src/server/git-merge/completion-guard')));
  const { readVcsContext, buildVcsContextDirective } = require(path.join(archive, 'src/server/vcs-context'));
  const CodexAgent = require(path.join(archive, 'src/server/task-agent/codex-agent'));
  const config = require(path.join(archive, 'src/server/config'));
  const context = await readVcsContext(backend);
  const brief = `Work on task TPT1: Create feature.txt containing "isolated change" plus newline in BOTH the root repository and its nested repository at ./nested. Preserve keep.txt edits. This is a scratch acceptance project: no architecture docs, tags, or remote task CRUD are needed. Use the local task tools. Use the local PR fixture at ${path.join(bin, "gh")} for gh pr create (never the system gh); no real hosting service or git push is needed. Verify feature.txt and keep.txt in both original checkouts before completing. Do not delegate or access any other project.`;
  const spec = await new CodexAgent().getSpawnSpec(config, brief, 'TPT1', { projectPath: root, vcsContext: context, vcsSettings: context.vcs });
  const toml = require(path.join(archive, 'node_modules/toml'));
  const local = toml.parse(fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf8')).mcp_servers['tipatask-local'];
  let settings = `[mcp_servers.tipatask-local]\ncommand = ${JSON.stringify(local.command)}\nargs = ${JSON.stringify(local.args)}\n`;
  settings += '[mcp_servers.tipatask-local.env]\n';
  for (const [key, value] of Object.entries(local.env || {})) settings += `${key} = ${JSON.stringify(value)}\n`;
  fs.writeFileSync(path.join(root, '.codex/config.toml'), settings);
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(spec.command, args, { cwd: root, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(JSON.stringify({ phase: 'codex-start', pid: child.pid, scratch }));
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Codex probe timed out')); }, 12 * 60_000);
    child.stdout.on('data', d => { output += d; process.stdout.write(d); });
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`Codex exit ${code}`)); });
  });
  try {
    const output = await run(['--approve-for-me', 'exec', '--json', ...spec.args.filter(a => a !== '--no-alt-screen')]);
    const started = output.split('\n').map(l => { try { return JSON.parse(l); } catch { return {}; } }).find(e => e.type === 'thread.started');
    assert.ok(started?.thread_id, 'real plan session id');
    assert.equal(task.status, 'working', 'planning must not complete');
    await run(['--approve-for-me', 'exec', 'resume', '--json', started.thread_id,
      `Plan approved. Implement the approved plan now.\n${buildVcsContextDirective(await readVcsContext(backend))}`]);
    assert.equal(task.status, 'done');
    assert.deepEqual(events, ['resolution', 'completed']);
    assert.match(fs.readFileSync(prLog, 'utf8'), /pr create/);
    for (const dir of [nested, root]) {
      assert.equal(git(dir, ['rev-list', '--count', 'HEAD..task/TPT1']), '0');
      assert.equal(fs.readFileSync(path.join(dir, 'feature.txt'), 'utf8'), 'isolated change\n');
      assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'original\nunrelated edit\n');
    }
    console.log(JSON.stringify({ ok: true, runtime: context.runtime, scratch, events, realCodex: true, prTransport: 'local fixture' }));
  } finally {
    await new Promise(r => server.close(r));
    console.log(`Scratch evidence retained at ${scratch}`);
  }
}
main().catch(err => { console.error(err.stack); process.exitCode = 1; });
