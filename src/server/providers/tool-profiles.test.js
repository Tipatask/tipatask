'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TASK_CHAT, PROFILES, toolProfileFor, providerSupportsProfile, codexProfileConfigArgs, piToolAllowlist, PI_OBJECTIVE_PROFILE } = require('./tool-profiles');
const { buildObjectiveArgs } = require('../claude-session');
const { buildCodexArgs } = require('./codex-session');
const { buildPiArgs } = require('./pi-session');

// The task-chat fence, checked where it is enforced: in each provider's argv.

const chat = (extra = {}) => ({ type: 'taskChat', toolProfile: TASK_CHAT, taskKey: 'TPT1', systemPrompt: 'TASK_CHAT_SYSTEM', ...extra });
const flag = (args, name) => args[args.indexOf(name) + 1];
const configOverrides = args => args.filter((a, i) => args[i - 1] === '-c');

test('a session without a profile keeps its provider default', () => {
  assert.equal(toolProfileFor({ type: 'objective' }, 'claude'), null);
  assert.equal(toolProfileFor({ type: 'specChat', toolProfile: null }, 'codex'), null);
  assert.equal(toolProfileFor({ toolProfile: 'no-such-profile' }, 'claude'), null);
  assert.equal(toolProfileFor(chat(), 'gemini'), null);
});

test('only providers with an enforceable fence may run a profiled session', () => {
  for (const provider of ['claude', 'codex', 'pi']) assert.equal(providerSupportsProfile(chat(), provider), true, provider);
  assert.equal(providerSupportsProfile(chat(), 'gemini'), false);
  assert.equal(providerSupportsProfile({ type: 'objective' }, 'gemini'), true, 'unprofiled sessions are unaffected');
});

test('claude task chat: task tools allowed, file-editing and shell tools denied', () => {
  const args = buildObjectiveArgs(chat());
  const allowed = flag(args, '--allowedTools').split(',');
  const denied = flag(args, '--disallowedTools').split(',');

  for (const tool of ['Read', 'mcp__tipatask-local__batch_grep_tags', 'mcp__tipatask__update_task',
    'mcp__tipatask__create_task', 'mcp__tipatask__delete_task', 'mcp__tipatask__create_task_comment',
    'mcp__tipatask__get_tag_architectures', 'mcp__tipatask__list_system_tags']) {
    assert.ok(allowed.includes(tool), `${tool} must be allowed`);
    assert.ok(!denied.includes(tool), `${tool} must not be denied`);
  }
  // AskUserQuestion: nobody can answer it in a headless turn — the chat asks via ask_user blocks.
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'AskUserQuestion']) {
    assert.ok(denied.includes(tool), `${tool} must be denied`);
    assert.ok(!allowed.includes(tool), `${tool} must not be allowed`);
  }
  // .claude/settings.local.json allows the tipatask servers wholesale — the local tools that
  // write the checkout or run the completion flow are only out because they are denied by name.
  for (const tool of ['mcp__tipatask-local__push_knowledge', 'mcp__tipatask-local__pull_knowledge', 'mcp__tipatask-local__complete_task']) {
    assert.ok(denied.includes(tool), `${tool} must be denied`);
  }
  assert.ok(!denied.includes('ToolSearch'), 'deferred MCP tool schemas stay loadable');
  assert.equal(flag(args, '--permission-mode'), 'default');
  assert.equal(flag(args, '--append-system-prompt'), 'TASK_CHAT_SYSTEM');
  assert.ok(!args.includes('--resume'));
  assert.equal(flag(buildObjectiveArgs(chat({ claudeSessionId: 'sid' })), '--resume'), 'sid');
});

test('claude objective argv is untouched by the profile branch', () => {
  const args = buildObjectiveArgs({ type: 'objective', claudeSessionId: null, systemPrompt: 'S' });
  const allowed = flag(args, '--allowedTools');
  assert.match(allowed, /^Read,/);
  assert.doesNotMatch(allowed, /update_task/);
  assert.match(flag(args, '--disallowedTools'), /mcp__tipatask__update_task/);
});

test('codex task chat: read-only sandbox on fresh and resumed turns, MCP narrowed by config', () => {
  const opts = { cwd: '/p', model: 'm', imagePaths: [], otherMcpServers: ['tipatask', 'tipatask-local', 'playwright', 'chrome-devtools'] };
  const fresh = buildCodexArgs(chat(), opts);
  assert.equal(flag(fresh, '-s'), 'read-only');
  assert.equal(fresh.at(-1), '-');

  const resume = buildCodexArgs(chat({ codexSessionId: 'tid' }), opts);
  assert.deepEqual(resume.slice(0, 3), ['exec', 'resume', 'tid']);
  assert.ok(!resume.includes('-s'), '`codex exec resume` rejects -s');
  assert.ok(configOverrides(resume).includes('sandbox_mode="read-only"'), 'the sandbox is re-stated on resume');

  for (const args of [fresh, resume]) {
    const overrides = configOverrides(args);
    assert.ok(overrides.includes('mcp_servers.tipatask-local.enabled_tools=["batch_grep_tags"]'));
    assert.ok(overrides.includes('mcp_servers.tipatask.disabled_tools=["purge_stale_reservations","reserve_task_keys"]'));
    assert.ok(overrides.includes('mcp_servers.playwright.enabled=false'));
    assert.ok(overrides.includes('mcp_servers.chrome-devtools.enabled=false'));
    assert.ok(!overrides.some(o => /^mcp_servers\.tipatask(-local)?\.enabled=false$/.test(o)), 'the tipatask servers stay on');
  }
});

test('codex objective argv denies task mutations and local completion', () => {
  const fresh = buildCodexArgs({ type: 'objective', codexSessionId: null }, { cwd: '/p', model: 'm', imagePaths: [] });
  assert.ok(configOverrides(fresh).some(o => o.includes('disabled_tools') && o.includes('update_task')));
  assert.ok(configOverrides(fresh).includes('mcp_servers.tipatask-local.enabled_tools=["batch_grep_tags"]'));
});

test('legacy dotted overrides only use bare server names; real spawns replace the entire map', () => {
  const profile = PROFILES[TASK_CHAT].codex;
  const overrides = configOverrides(codexProfileConfigArgs(profile, { otherMcpServers: ['ok_name', 'we.ird', 'has space', 'a"b'] }));
  assert.ok(overrides.includes('mcp_servers.ok_name.enabled=false'));
  assert.equal(overrides.filter(o => o.endsWith('.enabled=false')).length, 1);
  assert.deepEqual(codexProfileConfigArgs(null), []);
});

test('pi task chat: no shell or file-writing tool, only the staged extension', () => {
  const args = buildPiArgs(chat({ providerType: 'pi' }), { extensionPath: '/data/pi-ext/task-tools.mjs' });
  const tools = flag(args, '--tools').split(',');
  assert.deepEqual(tools, ['read', 'grep', 'find', 'ls', 'tipatask_api']);
  for (const tool of ['bash', 'edit', 'write']) assert.ok(!tools.includes(tool), `${tool} must not be enabled`);
  assert.ok(args.includes('--no-extensions'), 'project and user extensions are not discovered');
  assert.equal(flag(args, '-e'), '/data/pi-ext/task-tools.mjs');
  assert.ok(buildPiArgs(chat({ providerType: 'pi', piSessionId: 'p' }), { extensionPath: '/x' }).includes('--session'));
});

test('pi objective argv stays read-only with no extension flags', () => {
  const args = buildPiArgs({ type: 'objective', providerType: 'pi' });
  assert.equal(flag(args, '--tools'), 'read');
  assert.ok(!args.includes('-e') && args.includes('--no-extensions'));
});

const eFlags = args => args.filter((a, i) => args[i - 1] === '-e');
// Every MCP tool a Pi turn must never reach under its bridged name.
const PI_NEVER_BRIDGED = ['tipatask__purge_stale_reservations', 'tipatask__reserve_task_keys',
  'tipatask-local__push_knowledge', 'tipatask-local__pull_knowledge', 'tipatask-local__complete_task',
  'tipatask-local__git_worktree_status'];

test('pi task chat with the MCP bridge: bridged task tools replace the REST tool, writes stay off', () => {
  const args = buildPiArgs(chat({ providerType: 'pi' }), { extensionPath: '/data/pi-ext/task-tools.mjs', mcpBridgePath: '/data/pi-ext/mcp-bridge.mjs' });
  const tools = flag(args, '--tools').split(',');
  for (const tool of ['read', 'grep', 'find', 'ls', 'tipatask__update_task', 'tipatask__create_task_comment',
    'tipatask__create_task', 'tipatask__get_task', 'tipatask__get_tag_architecture', 'tipatask-local__batch_grep_tags']) {
    assert.ok(tools.includes(tool), `${tool} must be allowed`);
  }
  for (const tool of ['bash', 'edit', 'write', 'tipatask_api', ...PI_NEVER_BRIDGED]) assert.ok(!tools.includes(tool), `${tool} must not be enabled`);
  assert.ok(args.includes('--no-extensions'));
  assert.deepEqual(eFlags(args), ['/data/pi-ext/task-tools.mjs', '/data/pi-ext/mcp-bridge.mjs']);
  // The bridged list mirrors Claude's named remote allowlist exactly.
  const claudeRemote = PROFILES[TASK_CHAT].claude.allowedTools.filter(t => t.startsWith('mcp__')).map(t => t.replace(/^mcp__/, '')).sort();
  assert.deepEqual(PROFILES[TASK_CHAT].pi.mcpTools.slice().sort(), claudeRemote);
});

test('pi objective with the MCP bridge: read plus read-only bridged tools, bridge loaded alone', () => {
  const args = buildPiArgs({ type: 'objective', providerType: 'pi' }, { mcpBridgePath: '/data/pi-ext/mcp-bridge.mjs' });
  const tools = flag(args, '--tools').split(',');
  for (const tool of ['read', 'tipatask__get_task', 'tipatask__list_tasks', 'tipatask__get_tag_architecture',
    'tipatask__get_project_tags', 'tipatask-local__batch_grep_tags']) {
    assert.ok(tools.includes(tool), `${tool} must be allowed`);
  }
  for (const tool of ['bash', 'edit', 'write', 'grep', 'tipatask_api', 'tipatask__update_task', 'tipatask__create_task',
    'tipatask__delete_task', 'tipatask__create_task_comment', 'tipatask__create_system_tag', 'tipatask__ensure_project_tag', ...PI_NEVER_BRIDGED]) {
    assert.ok(!tools.includes(tool), `${tool} must not be enabled`);
  }
  assert.deepEqual(eFlags(args), ['/data/pi-ext/mcp-bridge.mjs'], 'no REST extension for a planner');
});

test('piToolAllowlist falls back to the objective fence and to the REST tools without a bridge', () => {
  assert.deepEqual(piToolAllowlist(null), ['read']);
  assert.deepEqual(piToolAllowlist(PI_OBJECTIVE_PROFILE, { bridge: false }), ['read']);
  assert.deepEqual(piToolAllowlist(PROFILES[TASK_CHAT].pi), ['read', 'grep', 'find', 'ls', 'tipatask_api']);
});
