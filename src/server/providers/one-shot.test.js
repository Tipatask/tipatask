'use strict';

// TPT623 — providers/one-shot.js: final-answer extraction per provider stream, JSON answer
// parsing, and the Claude fallback. No real CLI spawns.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { extractFinalText, parseJsonAnswer, runOneShotPrompt } = require('./one-shot');

const lines = (...events) => events.map(e => JSON.stringify(e)).join('\n') + '\n';

test('codex: the last agent_message of `codex exec --json`', () => {
  const out = lines(
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
    { type: 'item.completed', item: { type: 'agent_message', text: '[{"name":"a","description":"b"}]' } },
    { type: 'turn.completed', usage: {} },
  );
  assert.equal(extractFinalText('codex', out), '[{"name":"a","description":"b"}]');
});

test('gemini: assistant deltas concatenated, user echo ignored', () => {
  const out = lines(
    { type: 'init', session_id: 's' },
    { type: 'message', role: 'user', content: 'prompt' },
    { type: 'message', role: 'assistant', content: '[{"name":', delta: true },
    { type: 'message', role: 'assistant', content: '"a"}]', delta: true },
    { type: 'result', status: 'success' },
  );
  assert.equal(extractFinalText('gemini', out), '[{"name":"a"}]');
});

test('pi: text_delta deltas, else the last assistant message_end', () => {
  const deltas = lines(
    { type: 'session', id: 's' },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hel' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'lo' } },
  );
  assert.equal(extractFinalText('pi', deltas), 'hello');
  const ended = lines({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  assert.equal(extractFinalText('pi', ended), 'done');
});

test('parseJsonAnswer reads fenced, bare and embedded JSON', () => {
  assert.deepEqual(parseJsonAnswer('```json\n[1,2]\n```'), [1, 2]);
  assert.deepEqual(parseJsonAnswer('[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(parseJsonAnswer('Here you go: [{"a":1}] cheers'), [{ a: 1 }]);
  assert.equal(parseJsonAnswer('no json'), null);
  assert.equal(parseJsonAnswer(''), null);
});

function fakeSpawn(stdout, code = 0) {
  return () => {
    const proc = new EventEmitter();
    proc.pid = 1234;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = Object.assign(new EventEmitter(), { write() {}, end() {
      setImmediate(() => { proc.stdout.emit('data', Buffer.from(stdout)); proc.emit('close', code); });
    } });
    return proc;
  };
}

function withProvider(provider, fn) {
  const config = require('../config');
  const saved = config.OBJECTIVE_PROVIDER;
  config.OBJECTIVE_PROVIDER = provider;
  return Promise.resolve().then(fn).finally(() => { config.OBJECTIVE_PROVIDER = saved; });
}

test('runOneShotPrompt runs the default non-Claude provider and parses its answer', async () => {
  await withProvider('codex', async () => {
    let claudeCalled = false;
    const result = await runOneShotPrompt('describe', {
      parseJson: true,
      deps: {
        specBuilders: { codex: () => ({ command: 'codex', args: ['exec', '-'], env: {}, cwd: '/tmp' }) },
        spawn: fakeSpawn(lines({ type: 'item.completed', item: { type: 'agent_message', text: '[{"name":"x","description":"y"}]' } })),
        runHeadlessClaude: async () => { claudeCalled = true; return null; },
      },
    });
    assert.deepEqual(result, [{ name: 'x', description: 'y' }]);
    assert.equal(claudeCalled, false);
  });
});

test('runOneShotPrompt falls back to Claude when the default provider gives nothing usable', async () => {
  await withProvider('pi', async () => {
    const result = await runOneShotPrompt('describe', {
      parseJson: true,
      deps: {
        specBuilders: { pi: () => ({ command: 'pi', args: [], env: {}, cwd: '/tmp' }) },
        spawn: fakeSpawn('', 1),
        runHeadlessClaude: async () => '```json\n[{"name":"x","description":"from claude"}]\n```',
      },
    });
    assert.deepEqual(result, [{ name: 'x', description: 'from claude' }]);
  });
});

test('runOneShotPrompt never throws — a spec builder error falls back too', async () => {
  await withProvider('gemini', async () => {
    const result = await runOneShotPrompt('describe', {
      deps: {
        specBuilders: { gemini: () => { throw new Error('no gemini'); } },
        runHeadlessClaude: async () => null,
      },
    });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------- TPT701: explicit selection, tool-less runs

const { stripSensitiveEnv } = require('./one-shot');
const { buildCodexOneShotArgs } = require('./codex-session');

test('runOneShotPrompt: selection, toolless, cwd and sanitizeEnv reach the spec + spawn; no Claude fallback when off', async () => {
  await withProvider('claude', async () => {
    const seen = {};
    let claudeCalled = false;
    const result = await runOneShotPrompt('describe', {
      selection: { providerId: 'codex', model: 'gpt-x' },
      toolless: true,
      cwd: '/tmp/neutral',
      sanitizeEnv: (env) => { const out = { ...env }; delete out.API_TOKEN; return out; },
      fallbackToClaude: false,
      deps: {
        specBuilders: { codex: (o) => { Object.assign(seen, o); return { command: 'codex', args: ['exec', '-'], env: { API_TOKEN: 'secret', PATH: '/bin' }, cwd: '/proj' }; } },
        spawn: (cmd, args, options) => { seen.spawnEnv = options.env; seen.spawnCwd = options.cwd; return fakeSpawn('', 1)(); },
        runHeadlessClaude: async () => { claudeCalled = true; return 'from claude'; },
      },
    });
    assert.equal(result, null);
    assert.equal(claudeCalled, false);
    assert.equal(seen.model, 'gpt-x');
    assert.equal(seen.toolless, true);
    assert.equal(seen.cwd, '/tmp/neutral');
    assert.equal(typeof seen.projectRoot, 'string');
    assert.equal(seen.spawnEnv.API_TOKEN, undefined);
    assert.equal(seen.spawnEnv.PATH, '/bin');
    assert.equal(seen.spawnCwd, '/tmp/neutral');
  });
});

test('runOneShotPrompt: the Claude leg gets toolless, cwd and a sanitized env; an unknown selection uses the project default', async () => {
  await withProvider('claude', async () => {
    let got;
    const result = await runOneShotPrompt('describe', {
      selection: { providerId: 'nope' },
      toolless: true,
      cwd: '/tmp/neutral',
      sanitizeEnv: stripSensitiveEnv,
      deps: { runHeadlessClaude: async (prompt, o) => { got = o; return 'ok'; } },
    });
    assert.equal(result, 'ok');
    assert.equal(got.toolless, true);
    assert.equal(got.cwd, '/tmp/neutral');
    assert.equal(typeof got.env.PATH, 'string');
    assert.equal(got.env.TERM, 'dumb');
    assert.equal(got.env.API_TOKEN, undefined);
    assert.equal(got.env.CLAUDECODE, undefined);
  });
});

test('runOneShotPrompt: without sanitizeEnv the Claude leg keeps its default env (no env override)', async () => {
  await withProvider('claude', async () => {
    let got;
    await runOneShotPrompt('describe', { deps: { runHeadlessClaude: async (prompt, o) => { got = o; return 'ok'; } } });
    assert.equal(got.env, undefined);
    assert.equal(got.toolless, false);
  });
});

test('stripSensitiveEnv drops credentials, task identity and Claude Code nesting markers only', () => {
  const env = stripSensitiveEnv({
    PATH: '/bin', API_TOKEN: 't', TIPATASK_API_TOKEN: 't', API_BASE_URL: 'u', API_PROJECT_ID: '2',
    TIPATASK_TASK_ID: 'TPT1', TIPATASK_TRACK_DIR: '/x', TIPATASK_TOOL_EXEC: '/e', TIPATASK_TOOL_SCRIPT: '/s',
    TIPATASK_LOCAL_SECRET: 's', TIPATASK_OBJECTIVE_TASK_ID: 'o', TIPATASK_ELECTRON_HOST: '1',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_CHILD_SESSION: '1',
    CODEX_HOME: '/c', PI_API_KEY: 'k', TIPATASK_SERVER_ROOT: '/r', TIPATASK_USER_DATA: '/u',
  });
  assert.deepEqual(env, { PATH: '/bin', CODEX_HOME: '/c', PI_API_KEY: 'k', TIPATASK_SERVER_ROOT: '/r', TIPATASK_USER_DATA: '/u' });
  assert.deepEqual(stripSensitiveEnv(undefined), {});
});

test('buildCodexOneShotArgs: tool-less run replaces the whole MCP map before --json and runs in cwd', () => {
  assert.deepEqual(buildCodexOneShotArgs({ model: 'm', cwd: '/w' }),
    ['exec', '-m', 'm', '--json', '-s', 'read-only', '--skip-git-repo-check', '-C', '/w', '-']);
  assert.deepEqual(buildCodexOneShotArgs({ toolless: true, cwd: '/w' }),
    ['exec', '-c', 'mcp_servers={}', '--json', '-s', 'read-only', '--skip-git-repo-check', '-C', '/w', '-']);
});
