'use strict';

// TPT623 — providers/one-shot.js: final-answer extraction per provider stream, JSON answer
// parsing, and the Claude fallback. No real CLI spawns.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toml = require('toml');
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
const { buildCodexOneShotArgs, codexOneShotSpec } = require('./codex-session');

function oneShotProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-codex-one-shot-'));
  const projectRoot = path.join(dir, 'project');
  const globalHome = path.join(dir, 'global');
  const cwd = path.join(dir, 'neutral');
  const previousHome = process.env.CODEX_HOME;
  const previousData = process.env.TIPATASK_USER_DATA;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousData === undefined) delete process.env.TIPATASK_USER_DATA;
    else process.env.TIPATASK_USER_DATA = previousData;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.CODEX_HOME = globalHome;
  process.env.TIPATASK_USER_DATA = dir;
  fs.mkdirSync(globalHome);
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(projectRoot, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.tipatask/config.json'), JSON.stringify({
    API_BASE_URL: 'https://example.test', API_PROJECT_ID: '1', MCP_BROWSER_TOOLS: [],
  }));
  const inheritedNames = ['node_repl', 'server.with dots and "quotes"'];
  const globalConfig = path.join(globalHome, 'config.toml');
  fs.writeFileSync(globalConfig, '[features]\napps=true\nplugins=true\n\n' + inheritedNames.map(name =>
    `[mcp_servers.${JSON.stringify(name)}]\ncommand="external"\nenabled=true\n`).join('\n'));
  const targetPath = path.join(projectRoot, '.codex/config.toml');
  return { projectRoot, cwd, globalConfig, targetPath, inheritedNames };
}

function assertMcpExcluded(args, names) {
  const overrides = args.filter(arg => arg.startsWith('mcp_servers='));
  assert.equal(overrides.length, 1);
  const servers = toml.parse(overrides[0]).mcp_servers;
  assert.deepEqual(Object.keys(servers).sort(), names.slice().sort());
  for (const entry of Object.values(servers)) assert.deepEqual({ ...entry }, { enabled: false });
  assert.ok(args.includes('features.apps=false'), 'account app tools bypass the configured MCP map');
  assert.ok(args.includes('features.plugins=false'), 'plugins can contribute additional MCP servers');
  assert.ok(args.indexOf(overrides[0]) < args.indexOf('--json'));
  assert.ok(args.includes('read-only'), 'native filesystem reads retain the read-only sandbox');
  assert.ok(!args.includes('--disable'), 'native tools are not disabled');
}

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

test('buildCodexOneShotArgs: normal argv stays unchanged; tool-less runs explicitly disable every server', t => {
  assert.deepEqual(buildCodexOneShotArgs({ model: 'm', cwd: '/w' }),
    ['exec', '-m', 'm', '--json', '-s', 'read-only', '--skip-git-repo-check', '-C', '/w', '-']);
  const fixture = oneShotProject(t);
  const spec = codexOneShotSpec({ ...fixture, toolless: true });
  assertMcpExcluded(spec.args, [...fixture.inheritedNames, 'tipatask', 'tipatask-local']);
  assert.equal(spec.cwd, fixture.cwd);
  assert.equal(spec.env.CODEX_HOME, path.join(fixture.projectRoot, '.codex'));
  const before = fs.readFileSync(fixture.targetPath, 'utf8');
  buildCodexOneShotArgs({ ...fixture, toolless: true });
  assert.equal(fs.readFileSync(fixture.targetPath, 'utf8'), before, 'exclusion never changes terminal defaults');
  assert.equal(toml.parse(before).features.apps, true);
  assert.equal(toml.parse(before).features.plugins, true);
  for (const name of fixture.inheritedNames) assert.equal(toml.parse(before).mcp_servers[name].enabled, true);

  fs.appendFileSync(fixture.globalConfig, '\n[mcp_servers.newly_inherited]\ncommand="new"\n');
  const refreshed = codexOneShotSpec({ ...fixture, toolless: true });
  assertMcpExcluded(refreshed.args, [...fixture.inheritedNames, 'newly_inherited', 'tipatask', 'tipatask-local']);
  assert.ok(!codexOneShotSpec(fixture).args.some(arg => arg.startsWith('mcp_servers=')));
});

test('tool-less Codex refuses unreadable or invalid MCP configuration instead of launching unfenced', t => {
  const fixture = oneShotProject(t);
  assert.throws(() => buildCodexOneShotArgs({ ...fixture, toolless: true }), /ENOENT/);
  fs.mkdirSync(path.dirname(fixture.targetPath));
  fs.writeFileSync(fixture.targetPath, 'invalid = [');
  assert.throws(() => buildCodexOneShotArgs({ ...fixture, toolless: true }));
  assert.throws(() => codexOneShotSpec({ ...fixture, toolless: true }), /Invalid Codex configuration/);
});

test('default-provider forecast excludes refreshed MCP servers and completes without a Claude retry', async t => {
  const fixture = oneShotProject(t);
  await withProvider('codex', async () => {
    const result = await runOneShotPrompt('forecast', { ...fixture, toolless: true, fallbackToClaude: false, timeoutMs: 60000,
      deps: {
        spawn: (command, args) => {
          assertMcpExcluded(args, [...fixture.inheritedNames, 'tipatask', 'tipatask-local']);
          assert.ok(!args.includes('--tools') && !args.includes('--mcp-config') && !args.includes('--enable'));
          return fakeSpawn(lines({ type: 'item.completed', item: { type: 'agent_message', text: 'forecast complete' } }))();
        },
        runHeadlessClaude: () => assert.fail('forecast must use only the default provider'),
      },
    });
    assert.equal(result, 'forecast complete');
  });
});

test('disabled Claude fallback also covers failed default-provider resolution', async t => {
  t.mock.method(require('./registry'), 'configForProject', () => { throw Error('unreadable project'); });
  assert.equal(await runOneShotPrompt('forecast', { toolless: true, fallbackToClaude: false,
    deps: { runHeadlessClaude: () => assert.fail('must not substitute a provider') },
  }), null);
});
