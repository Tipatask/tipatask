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

test('Claude Auto text follows the run\'s native mode: classifier for native auto, the dialog for the acceptEdits fallback', () => {
  const native = buildPermissionPolicy({ mode: 'auto', nativeAuto: 'auto' }, 'claude');
  assert.match(native.prompt, /native auto mode is on: its classifier checks each tool call/);
  assert.doesNotMatch(native.prompt, /allow \/ allow-all \/ deny/);
  assert.match(native.prompt, /do not impose a separate plan-approval pause/);
  for (const nativeAuto of ['acceptEdits', undefined, 'bogus']) {
    const fallback = buildPermissionPolicy({ mode: 'auto', nativeAuto }, 'claude');
    assert.match(fallback.prompt, /file edits are accepted automatically/);
    assert.match(fallback.prompt, /allow \/ allow-all \/ deny permission dialog/);
  }
  // The choice survives a live rebuild and reaches the switch directive.
  const { applyLivePolicy } = require('./permission-policy');
  const session = { taskAgent: 'claude', permissionPolicy: buildPermissionPolicy({ mode: 'bypass', source: 'task', nativeAuto: 'auto' }, 'claude') };
  applyLivePolicy(session, 'auto');
  assert.equal(session.permissionPolicy.nativeAuto, 'auto');
  assert.match(session.permissionPolicy.prompt, /native auto mode is on/);
  const ClaudeAgent = require('./task-agent/claude-agent');
  assert.match(new ClaudeAgent().buildModeSwitchDirective('auto', { nativeAuto: 'auto' }), /native auto mode is on/);
  assert.match(new ClaudeAgent().buildModeSwitchDirective('auto'), /allow \/ allow-all \/ deny/);
  // Other providers ignore it.
  assert.match(buildPermissionPolicy({ mode: 'auto', nativeAuto: 'auto' }, 'pi').prompt, /uncertain actions require approval/);
});

test('project default mode for launch decisions: the inherited mode, a strict fresh read for task overrides, null otherwise', async () => {
  const { resolveProjectPermissionMode } = require('./permission-policy');
  const backend = (value) => ({ calls: [], async getEffectiveProjectSettings(o) { this.calls.push(o); if (value instanceof Error) throw value; return { settings: { agent_permission_mode: value } }; } });
  assert.equal(await resolveProjectPermissionMode({ resolved: { mode: 'auto', source: 'project' } }), 'auto');
  const fetched = backend('bypass');
  assert.equal(await resolveProjectPermissionMode({ backend: fetched, resolved: { mode: 'plan', source: 'task' } }), 'bypass');
  assert.deepEqual(fetched.calls, [{ strict: true, refresh: true }]);
  for (const [b, resolved] of [
    [backend('bypass'), { mode: 'plan', source: 'planning' }],
    [backend('bypass'), { mode: null, source: 'legacy' }],
    [backend(new Error('offline')), { mode: 'auto', source: 'task' }],
    [backend('nonsense'), { mode: 'auto', source: 'task' }],
    [null, { mode: 'auto', source: 'task' }],
  ]) assert.equal(await resolveProjectPermissionMode({ backend: b, resolved }), null, JSON.stringify(resolved));
});

test('live-switch refusals name what to do: starting, a prompt in the terminal, bypass not enabled at launch', () => {
  const { modeSwitchError } = require('./permission-policy');
  assert.match(modeSwitchError('starting').message, /still starting/);
  assert.match(modeSwitchError('prompt_open').message, /prompt is open in the terminal/);
  assert.match(modeSwitchError('bypass_unavailable').message, /Bypass was not enabled when this run started/);
  for (const reason of ['starting', 'prompt_open', 'bypass_unavailable']) assert.equal(modeSwitchError(reason).reason, reason);
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


test('live policy rebuild covers Plan to execution and Auto/Bypass in both directions without changing constraints', () => {
  const { applyLivePolicy } = require('./permission-policy');
  for (const agent of ['claude', 'codex', 'pi']) {
    for (const [from, to] of [['plan', 'auto'], ['plan', 'bypass'], ['auto', 'bypass'], ['bypass', 'auto'], [null, 'auto']]) {
      const vcsContext = { verified: true, vcs: { type: 'git', commit: false } };
      const session = { taskAgent: agent, vcsContext,
        permissionPolicy: buildPermissionPolicy({ mode: from, source: 'task', completionGuard: 'required' }, agent) };
      const launch = session.permissionPolicy;
      const policy = applyLivePolicy(session, to);
      assert.equal(session.permissionPolicy, policy);
      assert.equal(policy.mode, to);
      assert.equal(policy.source, 'session');
      assert.equal(policy.inherited, false);
      assert.equal(policy.completionGuard, 'required');
      assert.equal(policy.planning, false);
      assert.equal(session.vcsContext, vcsContext);
      assert.equal(launch.mode, from, 'old snapshots remain immutable');
      assert.ok(Object.isFrozen(policy));
      assert.match(policy.prompt, /VCS permissions and guarded completion remain mandatory/);
      if (to === 'auto') assert.match(policy.prompt, /require approval|native allow/);
    }
    const session = { taskAgent: agent, permissionPolicy: buildPermissionPolicy({ mode: 'bypass' }, agent) };
    const original = session.permissionPolicy;
    for (const mode of ['plan', null, undefined, 'typo', 'always_ask', {}, 'accept_edits']) {
      assert.throws(() => applyLivePolicy(session, mode), { code: 'EPERMISSION_MODE', reason: mode === 'plan' ? 'plan_target' : 'invalid_target' });
      assert.equal(session.permissionPolicy, original);
    }
  }
});

test('BaseTaskAgent live switching defaults to unsupported; mode directives authorize implementation and retain guards', async () => {
  const BaseTaskAgent = require('./task-agent/base-agent');
  const agent = new BaseTaskAgent('stub', 'Stub');
  assert.deepEqual(await agent.switchPermissionMode({}, 'auto'), { supported: false });
  for (const mode of ['auto', 'bypass']) {
    const directive = agent.buildModeSwitchDirective(mode);
    assert.match(directive, /Leaving Plan explicitly authorizes implementation now/);
    assert.match(directive, /existing conversation context and progress/);
    assert.match(directive, /VCS restrictions, guarded completion requirements and explicit user instructions/);
    assert.match(directive, /does not cancel or reverse an action already running/);
    assert.match(directive, new RegExp(`Permission policy for this run \\(${mode}\\)`));
  }
  assert.throws(() => agent.buildModeSwitchDirective('plan'), { reason: 'plan_target' });
});

// What requestPermissionMode() does around a provider's answer (terminal-session.js).
function beginSwitch(session, mode) {
  Object.assign(session.permissionMode, { requested: mode, pending: true });
}
function settleSwitch(session, gate, mode) {
  if (mode) {
    require('./permission-policy').applyLivePolicy(session, mode);
    session.permissionMode.confirmed = mode;
  }
  session.permissionMode.pending = false;
  gate.policyChanged();
}
const settledWithin = (promise, ms) => Promise.race([promise.then(() => true), new Promise(r => setTimeout(() => r(false), ms))]);
const untilSnapshot = gate => new Promise(resolve => { const poll = () => gate.snapshot() ? resolve() : setTimeout(poll, 5); poll(); });

test('live changes revoke every queued approval, reject stale answers and hold new gate requests until confirmation', async t => {
  const session = { permissionPolicy: buildPermissionPolicy({ mode: 'auto' }, 'pi'),
    permissionMode: { requested: 'auto', confirmed: 'auto', pending: false, error: null } };
  const gate = await createPermissionGate(session, { root: os.tmpdir(), timeoutMs: 1000 });
  t.after(() => gate.close());
  const call = () => fetch(gate.url, { method: 'POST', headers: { Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'touch x' } }) }).then(r => r.json());
  const pending = call();
  await untilSnapshot(gate);
  const id = gate.snapshot().id;
  beginSwitch(session, 'bypass');
  assert.equal(gate.answer(id, true), false);
  gate.cancelPending();
  assert.equal((await pending).decision, 'deny');
  assert.equal(gate.snapshot(), null);
  const held = call();
  assert.equal(await settledWithin(held, 100), false, 'a call during the switch waits for it');
  assert.equal(gate.snapshot(), null, 'a held call never becomes an approval request under the old mode');
  settleSwitch(session, gate, 'bypass');
  assert.deepEqual(await held, { decision: 'allow', mode: 'bypass', reason: 'Allowed by the run permission policy.',
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Allowed by the run permission policy.' } });
  assert.equal(gate.answer(id, true), false);
  assert.equal((await call()).decision, 'allow');

  // Bypass to Auto: the next action is prompted again, with a fresh request.
  beginSwitch(session, 'auto');
  const prompted = call();
  assert.equal(await settledWithin(prompted, 100), false);
  settleSwitch(session, gate, 'auto');
  await untilSnapshot(gate);
  assert.notEqual(gate.snapshot().id, id, 'Bypass to Auto restores fresh approval requests');
  gate.answer(gate.snapshot().id, false);
  assert.deepEqual([(await prompted).decision, (await prompted).mode], ['deny', 'auto']);

  // A failed switch decides held calls under the mode that is still confirmed.
  beginSwitch(session, 'bypass');
  const kept = call();
  assert.equal(await settledWithin(kept, 100), false);
  settleSwitch(session, gate, null);
  await untilSnapshot(gate);
  gate.answer(gate.snapshot().id, true);
  assert.deepEqual([(await kept).decision, (await kept).mode], ['allow', 'auto']);

  // A switch that never settles releases its held calls as denials at the gate deadline.
  beginSwitch(session, 'bypass');
  const stuck = await call();
  assert.equal(stuck.decision, 'deny');
  assert.match(stuck.reason, /did not finish/);
  session.permissionMode.pending = false;
});

test('the gate enforces the confirmed mode: Plan is read-only until approval, Auto prompts, Bypass allows', async t => {
  const { gatePolicy } = require('./permission-policy');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-gate-mode-'));
  const session = { permissionPolicy: buildPermissionPolicy({ mode: 'plan' }, 'pi'), terminalPhase: 'planning',
    permissionMode: { requested: 'plan', confirmed: 'plan', pending: false, error: null } };
  const decisions = [];
  const gate = await createPermissionGate(session, { root, timeoutMs: 1000, onDecision: d => decisions.push(d) });
  t.after(() => { gate.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = (tool_name, tool_input = {}) => fetch(gate.url, { method: 'POST', headers: { Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input }) }).then(r => r.json());

  assert.deepEqual(gatePolicy(session), { mode: 'plan', assess: 'plan' });
  assert.equal((await call('read', { path: 'a' })).decision, 'allow');
  for (const [tool, input] of [['write', { path: 'a', content: 'x' }], ['edit', { path: 'a' }], ['bash', { command: 'ls' }], ['tipatask__update_task', {}]]) {
    const result = await call(tool, input);
    assert.deepEqual([result.decision, result.mode], ['deny', 'plan'], tool);
    assert.match(result.reason, /Plan mode allows only read-only tools until the plan is approved/);
  }
  assert.equal(decisions.at(-1).mode, 'plan');
  session.terminalPhase = 'executing'; // approved in place: the legacy unattended loop
  assert.deepEqual(gatePolicy(session), { mode: 'plan', assess: 'approved' });
  assert.deepEqual([(await call('write', { path: 'a' })).decision, (await call('bash', { command: 'npm test' })).reason],
    ['allow', 'Allowed: the plan was approved.']);
  for (const confirmed of [null, 'plan']) {
    session.permissionMode.confirmed = confirmed;
    session.terminalPhase = 'planning';
    assert.equal((await call('bash', { command: 'ls' })).decision, 'deny', `${confirmed} plans read-only`);
  }
  // The policy object can be ahead of the confirmation; only the confirmed mode counts.
  session.permissionPolicy = buildPermissionPolicy({ mode: 'bypass' }, 'pi');
  session.permissionMode = { requested: 'bypass', confirmed: 'auto', pending: false, error: null };
  assert.deepEqual(gatePolicy(session), { mode: 'auto', assess: 'auto' });
  assert.equal((await call('write', { path: 'new-file' })).decision, 'allow');
  const asked = call('bash', { command: 'npm test' });
  await untilSnapshot(gate);
  gate.answer(gate.snapshot().id, true);
  assert.deepEqual([(await asked).decision, decisions.at(-1).prompted], ['allow', true]);
  session.permissionMode.confirmed = 'bypass';
  assert.equal((await call('spawn_agent')).decision, 'allow');
  session.permissionMode.confirmed = 'typo';
  session.terminalPhase = 'executing';
  assert.deepEqual(gatePolicy(session), { mode: 'typo', assess: 'plan' }, 'an unknown mode fails closed');
  assert.deepEqual(gatePolicy({ permissionPolicy: buildPermissionPolicy({ mode: 'auto' }, 'pi') }), { mode: 'auto', assess: 'auto' });
});

test('a live switch is confirmed only by the report of its submitted directive', async t => {
  const session = { permissionPolicy: buildPermissionPolicy({ mode: 'auto' }, 'pi'),
    permissionMode: { requested: 'bypass', confirmed: 'auto', pending: true, error: null } };
  const gate = await createPermissionGate(session, { root: os.tmpdir(), timeoutMs: 1000 });
  t.after(() => gate.close());
  const report = permission_mode => fetch(gate.url, { method: 'POST', headers: { Authorization: `Bearer ${gate.token}` },
    body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', permission_mode }) }).then(r => r.json());
  const expected = gate.expectModeSwitch('bypass', { timeoutMs: 1000 });
  assert.deepEqual(await report('bypass'), { decision: 'allow', mode: 'auto', reason: 'Input accepted.' },
    'a report before the directive was submitted confirms nothing');
  expected.markSubmitted();
  assert.equal((await report('auto')).mode, 'auto', 'a report for another mode confirms nothing');
  assert.equal(await settledWithin(expected.promise, 50), false);
  assert.deepEqual(await report('bypass'), { decision: 'allow', mode: 'bypass', reason: 'Permission mode change delivered.' });
  assert.equal(await expected.promise, 'bypass');
  assert.equal((await report('bypass')).mode, 'auto', 'a confirmation is single-use');

  const late = gate.expectModeSwitch('auto', { timeoutMs: 30 });
  await assert.rejects(late.promise, { code: 'EPERMISSION_MODE', reason: 'unconfirmed' });
  const replaced = gate.expectModeSwitch('auto');
  const newer = gate.expectModeSwitch('bypass');
  await assert.rejects(replaced.promise, { reason: 'session_changed' });
  gate.close();
  await assert.rejects(newer.promise, { reason: 'session_changed' });
  await assert.rejects(gate.expectModeSwitch('auto').promise, { reason: 'session_changed' });
});
