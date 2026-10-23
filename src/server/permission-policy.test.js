'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MODES, validateMode, resolvePermissionMode, buildPermissionPolicy, assertPermissionSupport } = require('./permission-policy');
const { createPermissionGate, assessAction, isReadCommand, claudePermissionHooks } = require('./permission-gate');
const { codexPermissionOverrides } = require('./codex-env');
const { codexTerminalLaunchOptions } = require('./codex-env');
const toml = require('toml');

test('inheritance fetches effective settings at each launch; overrides and running snapshots stay fixed', async () => {
  let mode = 'plan';
  let reads = 0;
  const backend = { async getEffectiveProjectSettings(opts) {
    assert.deepEqual(opts, { strict: true, refresh: true });
    reads++;
    return { settings: { agent_permission_mode: mode } };
  } };
  const first = await resolvePermissionMode({ backend, task: { agentPermissionMode: null } });
  mode = 'bypass';
  const second = await resolvePermissionMode({ backend, task: { agent_permission_mode: null } });
  assert.equal(first.mode, 'plan');
  assert.equal(second.mode, 'bypass');
  assert.ok(Object.isFrozen(first));
  assert.equal((await resolvePermissionMode({ backend, task: { agentPermissionMode: 'always_ask' } })).source, 'task');
  assert.equal(reads, 2);
  mode = null;
  assert.equal((await resolvePermissionMode({ backend, task: {} })).source, 'legacy');
  assert.equal((await resolvePermissionMode({ backend, task: { agentPermissionMode: 'bypass' }, planOnly: true })).mode, 'plan');
});

test('missing task, invalid modes, stale/unavailable settings refuse instead of granting permission', async () => {
  for (const args of [
    {}, { taskId: 'T1', backend: { getTask: async () => null } },
    { task: { agentPermissionMode: 'typo' } },
    { backend: { getEffectiveProjectSettings: async () => ({ settings: {} }) } },
    { backend: { getEffectiveProjectSettings: async () => { throw new Error('offline'); } } },
    { backend: { getEffectiveProjectSettings: async () => ({ settings: { agent_permission_mode: 'typo' } }) } },
  ]) await assert.rejects(resolvePermissionMode(args), { code: 'EPERMISSION' });
});

test('bulk-start overflow resolves inheritance when its queued launch actually starts', async () => {
  const { createSessionQueue } = require('./session-queue');
  const sessions = new Map();
  let mode = 'plan';
  const backend = { getEffectiveProjectSettings: async () => ({ settings: { agent_permission_mode: mode } }) };
  const queue = createSessionQueue({ getSessions: () => sessions, defaultProject: '/p',
    resolveLimits: () => ({ deviceSessionCap: 1, maxConcurrentSessions: 1 }), log: () => {} });
  for (const id of ['first', 'queued']) {
    const session = { type: 'terminal', taskId: id, tabId: id, projectPath: '/p', alive: false };
    sessions.set(id, session);
    queue.submit({ key: id, session, taskId: id, start: async () => {
      session.permissionPolicy = await resolvePermissionMode({ backend, task: {} });
      session._launching = false; session.alive = true;
    } });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sessions.get('first').permissionPolicy.mode, 'plan');
  assert.equal(sessions.get('queued').permissionPolicy, undefined);
  mode = 'bypass';
  sessions.get('first').alive = false;
  queue.drain();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sessions.get('queued').permissionPolicy.mode, 'bypass');
  assert.equal(sessions.get('first').permissionPolicy.mode, 'plan');
});

test('provider capability matrix rejects unsupported modes and unknown/old runtimes', () => {
  for (const agent of ['claude', 'codex', 'pi']) for (const mode of MODES) {
    const policy = buildPermissionPolicy({ mode, source: 'task' }, agent);
    const version = { claude: '2.1.306', codex: '0.163.0', pi: '0.84.1' }[agent];
    assert.doesNotThrow(() => assertPermissionSupport(policy, version, 'darwin'));
  }
  for (const agent of ['codex', 'pi']) {
    assert.throws(() => assertPermissionSupport(buildPermissionPolicy({ mode: 'auto' }, agent), ''), { code: 'EPERMISSION' });
  }
  for (const mode of MODES) for (const version of ['', '2.1.241', '2.1.294']) {
    assert.doesNotThrow(() => assertPermissionSupport(buildPermissionPolicy({ mode }, 'claude'), version));
  }
  assert.throws(() => assertPermissionSupport(buildPermissionPolicy({ mode: 'auto' }, 'unknown'), ''), { code: 'EPERMISSION' });
  assert.doesNotThrow(() => assertPermissionSupport(buildPermissionPolicy({ mode: 'plan' }, 'codex'), '', 'win32'));
});

test('Claude Auto directs approvals to the native terminal dialog without changing other providers', () => {
  const claude = buildPermissionPolicy({ mode: 'auto' }, 'claude');
  assert.match(claude.prompt, /file edits are accepted automatically/);
  assert.match(claude.prompt, /Claude's native allow \/ allow-all \/ deny permission dialog, answered in the terminal/);
  for (const agent of ['codex', 'pi']) {
    assert.match(buildPermissionPolicy({ mode: 'auto' }, agent).prompt, /uncertain actions require approval/);
  }
});

test('read-command assessment rejects command execution, redirects, pipelines and tool escape flags', () => {
  for (const cmd of ['pwd', 'ls -la', 'cat src/a.js', 'head -n 30 src/a.js', 'rg --files', 'rg -n needle src']) assert.ok(isReadCommand(cmd), cmd);
  for (const cmd of ['cat a > b', 'ls; touch b', 'ls | sh', 'rg --pre=sh x', 'rg --pre sh x', 'sed -i s/a/b/ f',
    'find . -exec sh x', 'git diff --output=f', 'python3 -c x', 'cat $(touch x)', 'echo `touch x`', 'ls\nrm x', 'env cat a']) {
    assert.equal(isReadCommand(cmd), false, cmd);
  }
});

test('policy gates file, shell and MCP actions; protected and escaping edits require approval', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.codex'));
  fs.symlinkSync(os.tmpdir(), path.join(root, 'outside'));
  const action = (mode, name, input = {}) => assessAction(mode, name, input, root);
  for (const name of ['Read', 'Bash', 'Write', 'mcp__tipatask__update_task']) assert.equal(action('always_ask', name), 'ask');
  assert.equal(action('plan', 'Read'), 'allow');
  assert.equal(action('plan', 'Bash', { command: 'rg --files' }), 'deny');
  assert.equal(action('plan', 'Write', { file_path: 'a' }), 'deny');
  assert.equal(action('plan', 'mcp__tipatask__update_task'), 'deny');
  assert.equal(action('plan', 'tipatask-local__complete_task'), 'deny');
  assert.equal(action('plan', 'mcp__tipatask__get_task'), 'allow');
  assert.equal(action('plan', 'mcp__unknown__read_and_delete'), 'deny');
  assert.equal(action('accept_edits', 'Write', { file_path: 'a' }), 'allow');
  assert.equal(action('accept_edits', 'Write', { file_path: path.join(fs.realpathSync(root), 'new-file') }), 'allow');
  assert.equal(action('accept_edits', 'Read'), 'ask');
  assert.equal(action('accept_edits', 'Bash', { command: 'touch a' }), 'ask');
  for (const file_path of ['../outside', 'outside/escape', '.codex/config.toml', 'AGENTS.md']) {
    assert.equal(action('accept_edits', 'Write', { file_path }), 'ask');
  }
  assert.equal(action('auto', 'Read'), 'allow');
  assert.equal(action('auto', 'Bash', { command: 'npm test' }), 'ask');
  assert.equal(action('auto', 'spawn_agent'), 'deny');
  assert.equal(action('bypass', 'Bash', { command: 'npm test' }), 'allow');
});

test('approval bridge waits for a one-use answer, denies cancellation and isolates runs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-gate-'));
  const session = { permissionPolicy: buildPermissionPolicy({ mode: 'auto' }, 'claude') };
  const gate = await createPermissionGate(session, { root, timeoutMs: 1000 });
  t.after(() => { gate.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = async (event, token = gate.token) => fetch(gate.url, { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify(event) });
  assert.equal((await call({}, 'wrong')).status, 403);
  await call({ hook_event_name: 'SessionStart' });
  assert.equal(gate.ready, true);
  const file = path.join(root, 'approved');
  async function edit() {
    const response = await call({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'touch approved' } });
    const result = await response.json();
    if (result.hookSpecificOutput.permissionDecision === 'allow') fs.writeFileSync(file, 'edited');
    return result;
  }
  const first = edit();
  await new Promise(resolve => { const poll = () => gate.snapshot() ? resolve() : setTimeout(poll, 5); poll(); });
  assert.equal(fs.existsSync(file), false);
  const id = gate.snapshot().id;
  assert.equal(gate.answer('other-run', true), false);
  assert.equal(gate.answer(id, true), true);
  assert.equal(gate.answer(id, true), false);
  await first;
  assert.equal(fs.readFileSync(file, 'utf8'), 'edited');
  const second = edit();
  await new Promise(resolve => { const poll = () => gate.snapshot() ? resolve() : setTimeout(poll, 5); poll(); });
  gate.answer(gate.snapshot().id, false);
  assert.equal((await second).hookSpecificOutput.permissionDecision, 'deny');
  const third = edit();
  await new Promise(resolve => { const poll = () => gate.snapshot() ? resolve() : setTimeout(poll, 5); poll(); });
  gate.close();
  assert.equal((await third).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(claudePermissionHooks(gate).hooks.PreToolUse[0].hooks[0].onFailure, 'block');
});

test('Codex Plan keeps legacy configuration; execution overrides replace inherited approvals', () => {
  const parsed = { mcp_servers: { tipatask: { tools: { update_task: { approval_mode: 'approve' } } },
    'tipatask-local': {}, custom: {} }, apps: { external: { enabled: true } } };
  assert.deepEqual(codexPermissionOverrides(buildPermissionPolicy({ mode: 'plan' }, 'codex'), parsed), { approval_policy: 'on-request', approvals_reviewer: 'user' });
  const auto = codexPermissionOverrides(buildPermissionPolicy({ mode: 'auto' }, 'codex'), parsed);
  assert.equal(auto['sandbox_workspace_write.network_access'], false);
  assert.deepEqual(auto['sandbox_workspace_write.writable_roots'], []);
  assert.throws(() => codexPermissionOverrides(buildPermissionPolicy({ mode: 'auto' }, 'codex'), { default_permissions: 'custom' }), { code: 'EPERMISSION' });
  assert.equal(auto.approvals_reviewer, 'auto_review');
  assert.equal(auto['features.guardian_approval'], true);
  assert.equal(auto['mcp_servers."tipatask".tools."update_task".approval_mode'], 'prompt');
  const bypass = codexPermissionOverrides(buildPermissionPolicy({ mode: 'bypass' }, 'codex'), parsed);
  assert.equal(bypass.sandbox_mode, 'danger-full-access');
  assert.equal(bypass.approval_policy, 'never');
});

test('Codex enforced launches serialize whole policy tables without invalid quoted CLI keys', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, '.codex'); fs.mkdirSync(home);
  const original = '[mcp_servers.tipatask-local]\ncommand="node"\nargs=["fixture.js"]\n'
    + '[mcp_servers."custom.with.dots"]\ncommand="node"\n';
  fs.writeFileSync(path.join(home, 'config.toml'), original);
  const launch = codexTerminalLaunchOptions(root, home, 'low', {}, buildPermissionPolicy({ mode: 'auto' }, 'codex'));
  assert.equal(launch.args[0], '--no-daemon');
  const settings = {};
  for (let i = 1; i < launch.args.length; i += 2) {
    assert.equal(launch.args[i], '-c');
    Object.assign(settings, toml.parse(launch.args[i + 1]));
  }
  assert.equal(settings.mcp_servers['tipatask-local'].command, 'node');
  assert.equal(settings.mcp_servers['custom.with.dots'].default_tools_approval_mode, 'prompt');
  assert.equal(settings.features.guardian_approval, true);
  assert.equal(settings.sandbox_mode, 'workspace-write');
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), original);
});

test('three canonical modes normalize retired values and Plan uses legacy policy', async () => {
  assert.deepEqual(MODES, ['plan', 'auto', 'bypass']);
  for (const mode of ['always_ask', 'accept_edits']) {
    assert.equal(validateMode(mode), 'auto');
    assert.equal((await resolvePermissionMode({ task: { agentPermissionMode: mode } })).mode, 'auto');
    assert.equal((await resolvePermissionMode({ task: {}, backend: { getEffectiveProjectSettings: async () => ({ settings: { agent_permission_mode: mode } }) } })).mode, 'auto');
  }
  for (const agent of ['claude', 'codex', 'pi']) for (const mode of [null, 'plan']) {
    const policy = buildPermissionPolicy({ mode }, agent);
    assert.equal(policy.enforced, false);
    assert.equal(policy.planning, true);
    if (mode === null) assert.equal(policy.prompt, '');
    else {
      assert.match(policy.prompt, /First study the task, relevant source code, configuration files, and architecture docs/);
      assert.match(policy.prompt, /standalone line reading Plan ready\./);
      assert.match(policy.prompt, /Wait for user approval before implementing/);
      assert.match(policy.prompt, /After approval, implement the approved plan in this same session/);
      assert.match(policy.prompt, /Project VCS permissions and guarded completion remain mandatory/);
      assert.doesNotMatch(policy.prompt, /restart|Plan mode is read-only/);
    }
    assert.equal(policy.communication, '');
  }
});
