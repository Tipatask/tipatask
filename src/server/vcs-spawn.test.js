'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('node-pty');
const { spawnTerminal } = require('./terminal-session');
const { createSession } = require('./session-state');
const { getTaskAgent } = require('./task-agent');

test('actual terminal launch passes fresh project settings through the real Codex spawn specification', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-vcs-spawn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask/config.json'), JSON.stringify({ MCP_BROWSER_TOOLS: [] }));
  t.mock.method(os, 'homedir', () => root);
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'seed');
  t.after(() => { if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome; });
  const agent = getTaskAgent('codex');
  t.mock.method(agent, 'cachedDetect', async () => ({ available: true }));
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let captured;
  t.mock.method(pty, 'spawn', (command, args, options) => {
    captured = { command, args, options };
    return { pid: 424242, write() {}, onData() {}, onExit() {}, resize() {}, kill() {} };
  });
  let row = { id: 1, vcs_type: 'git', vcs_worktree_enabled: 1, vcs_commit_enabled: 1, vcs_pr_enabled: 1, vcs_merge_enabled: 1, kb_sync_as_you_go: false };
  const reads = [];
  const backend = {
    async getProjectSettings(opts) { reads.push(opts); return row; },
    async getStatuses() { return [{ name: 'done', is_workflow_complete: true }]; },
    async getTaskComments() { return []; },
  };
  for (const merge of [1, 0, 1]) {
    row = { ...row, vcs_merge_enabled: merge };
    const session = createSession(null, false, 'TPT1', root);
    session.projectPath = root;
    session.taskAgent = 'codex';
    session.backend = backend;
    await spawnTerminal(session, 'Work on task TPT1: scratch', 'TPT1', [], { backend });
    const prompt = captured.args.at(-1);
    assert.equal(captured.options.cwd, root);
    assert.equal(prompt.includes('`git merge task/'), !!merge);
    assert.match(prompt, /tipatask-local complete_task/);
    assert.equal(session.vcsContext.vcs.merge, !!merge);
    assert.equal(session.vcsContext.verified, true);
    session.alive = false;
  }
  assert.ok(reads.filter(x => x?.strict && x?.refresh).length >= 3);
});
