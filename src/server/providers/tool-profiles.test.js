'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TASK_CHAT, PROFILES, toolProfileFor, providerSupportsProfile, codexProfileConfigArgs } = require('./tool-profiles');
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

test('codex objective argv carries no profile overrides', () => {
  const fresh = buildCodexArgs({ type: 'objective', codexSessionId: null }, { cwd: '/p', model: 'm', imagePaths: [] });
  assert.ok(!configOverrides(fresh).some(o => o.startsWith('mcp_servers.') || o.startsWith('sandbox_mode')));
});

test('codexProfileConfigArgs skips a server name a bare TOML key cannot spell', () => {
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
  assert.ok(!args.includes('-e') && !args.includes('--no-extensions'));
});
