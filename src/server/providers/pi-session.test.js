'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const config = require('../config');
const { spawnPiTurn, buildPiArgs, assistantErrorOf } = require('./pi-session');
const { piCustomProviderId, piDefaultSessionDir } = require('../pi-custom-endpoint');

const MODEL = 'openrouter/deepseek/deepseek-v4-flash-0731';

// No API credentials on purpose — localizeAttachments() bails out before any network call.
function makeProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-pi-session-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.tipatask', 'config.json'),
    JSON.stringify({ PI_MODELS: [{ model: MODEL, apiKey: 'sk-or-test' }] }),
    'utf8',
  );
  return dir;
}

function makeSession(projectPath) {
  return {
    tabId: 'tab-1',
    projectPath,
    selectedModel: MODEL,
    systemPrompt: 'SYSTEM',
    firstPrompt: 'Plan something',
    messages: [{ role: 'user', content: 'Plan something', timestamp: 0 }],
    timingMilestones: {},
    totalTokens: { input: 0, output: 0 },
    piSessionId: null,
    ws: null,
  };
}

// killed:true keeps emitPiError() from signalling a process group for a made-up pid.
function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {}, end() {} };
  proc.pid = 0;
  proc.killed = true;
  return proc;
}

function startTurn(t) {
  const dir = makeProjectDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const session = makeSession(dir);
  const proc = makeFakeProc();
  const frames = [];
  let spawnCall = null;
  spawnPiTurn(session, 'T1', (f) => frames.push(f), {
    spawn: (command, args, opts) => { spawnCall = { command, args, opts }; return proc; },
  });
  const out = (...events) => proc.stdout.emit('data', Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n'));
  const err = (text) => proc.stderr.emit('data', Buffer.from(text));
  const ofType = (type) => frames.filter(f => f.type === type);
  return { session, proc, frames, out, err, ofType, spawnCall: () => spawnCall };
}

function enableTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => t.mock.timers.reset());
}

const SESSION_EVENT = { type: 'session', version: 3, id: 'uuid-1' };

test('buildPiArgs: prefixed OpenRouter id is passed verbatim with --provider openrouter', () => {
  const args = buildPiArgs({ selectedModel: MODEL, piSessionId: null });
  assert.deepStrictEqual(args, ['--mode', 'json', '--provider', 'openrouter', '--model', MODEL, '--tools', 'read', '--no-extensions']);
  const resumed = buildPiArgs({ selectedModel: MODEL, piSessionId: 'uuid-9' });
  assert.deepStrictEqual(resumed.slice(-2), ['--session', 'uuid-9']);
});

test('assistantErrorOf: reads stopReason error from message or messages[]', () => {
  assert.strictEqual(assistantErrorOf({ message: { stopReason: 'stop' } }), null);
  assert.strictEqual(assistantErrorOf({ message: { stopReason: 'error', errorMessage: '401 nope' } }), '401 nope');
  assert.strictEqual(
    assistantErrorOf({ messages: [{ role: 'user' }, { role: 'assistant', stopReason: 'aborted' }] }),
    'request aborted',
  );
});

test('spawnPiTurn: stderr lines surface as pi-stderr progress frames, ANSI stripped', (t) => {
  enableTimers(t);
  const turn = startTurn(t);
  turn.err('\x1b[33mWarning: Model "x" not found for provider "openrouter". Using custom model id.\x1b[39m\n\nsecond line\n');
  const lines = turn.ofType('objective-progress').filter(f => f.stage === 'pi-stderr');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].detail, 'Warning: Model "x" not found for provider "openrouter". Using custom model id.');
  assert.strictEqual(lines[1].detail, 'second line');
  assert.strictEqual(lines[0].tabId, 'tab-1');
});

test('spawnPiTurn: a proc that never writes stdout still hits the idle watchdog, error names model + stderr tail', (t) => {
  enableTimers(t);
  const turn = startTurn(t);
  turn.err('No API key for openrouter\n');
  t.mock.timers.tick(config.OBJECTIVE_STREAM_IDLE_MS - 1);
  assert.strictEqual(turn.ofType('objective-error').length, 0);
  t.mock.timers.tick(1);
  const [error] = turn.ofType('objective-error');
  assert.ok(error, 'idle watchdog armed at spawn');
  assert.strictEqual(error.reason, 'stream-idle-timeout');
  assert.strictEqual(error.provider, 'pi');
  assert.strictEqual(error.model, MODEL);
  assert.match(error.detail, /No API key for openrouter/);
  // stderr must not have pushed the idle window out
  assert.ok(config.OBJECTIVE_STREAM_IDLE_MS < config.OBJECTIVE_TURN_MAX_MS);
});

test('spawnPiTurn: silence after the session event ends in an idle-timeout error within the window', (t) => {
  enableTimers(t);
  const turn = startTurn(t);
  t.mock.timers.tick(5000);
  turn.out(SESSION_EVENT);
  assert.strictEqual(turn.session.piSessionId, 'uuid-1');
  assert.ok(turn.ofType('objective-progress').some(f => f.stage === 'cli-init'));
  t.mock.timers.tick(config.OBJECTIVE_STREAM_IDLE_MS - 1);
  assert.strictEqual(turn.ofType('objective-error').length, 0);
  t.mock.timers.tick(1);
  const errors = turn.ofType('objective-error');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].reason, 'stream-idle-timeout');
  assert.strictEqual(errors[0].detail, undefined);
  // close after the abort must not finalize a result
  turn.proc.emit('close', null);
  assert.strictEqual(turn.ofType('objective-result').length, 0);
});

test('spawnPiTurn: auto-retry, compaction and thinking events become progress frames', (t) => {
  enableTimers(t);
  const turn = startTurn(t);
  turn.out(
    SESSION_EVENT,
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '429 rate limited' },
    { type: 'auto_retry_end', success: false, attempt: 3, finalError: '429 rate limited' },
    { type: 'compaction_start' },
    { type: 'compaction_end' },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } },
    { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } },
  );
  const stages = turn.ofType('objective-progress').map(f => f.stage);
  assert.deepStrictEqual(stages, ['spawned', 'cli-init', 'pi-retry', 'pi-retry-end', 'pi-compaction', 'pi-compaction-end', 'model-thinking']);
  const retry = turn.frames.find(f => f.stage === 'pi-retry');
  assert.strictEqual(retry.detail, 'attempt 1/3 in 2s: 429 rate limited');
  assert.match(turn.frames.find(f => f.stage === 'pi-retry-end').detail, /gave up: 429/);
});

test('spawnPiTurn: stopReason error with no text is a hard objective-error, not an empty result', (t) => {
  enableTimers(t);
  const turn = startTurn(t);
  const errorMessage = '401: {"message":"Missing Authentication header","code":401}';
  turn.out(
    SESSION_EVENT,
    { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage } },
    { type: 'turn_end', message: { role: 'assistant', stopReason: 'error', errorMessage } },
  );
  turn.proc.emit('close', 0);
  const errors = turn.ofType('objective-error');
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0].reason.startsWith('pi-error:401'));
  assert.strictEqual(errors[0].model, MODEL);
  assert.strictEqual(errors[0].detail, undefined, 'short provider error lives in reason only');
  assert.strictEqual(turn.ofType('objective-result').length, 0);
});

test('spawnPiTurn: non-zero exit with no text reports pi-exit with the stderr tail', (t) => {
  enableTimers(t);
  const turn = startTurn(t);
  turn.err('Error: something exploded\n');
  turn.proc.emit('close', 1);
  const [error] = turn.ofType('objective-error');
  assert.strictEqual(error.reason, 'pi-exit:1');
  assert.match(error.detail, /something exploded/);
  assert.strictEqual(turn.ofType('objective-result').length, 0);
});

test('spawnPiTurn: text deltas stream and the turn finalizes on close with usage', (t) => {
  enableTimers(t);
  const turn = startTurn(t);
  assert.deepStrictEqual(turn.spawnCall().args.slice(-9), ['--mode', 'json', '--provider', 'openrouter', '--model', MODEL, '--tools', 'read', '--no-extensions']);
  assert.strictEqual(turn.spawnCall().opts.env.OPENROUTER_API_KEY, 'sk-or-test');
  turn.out(
    SESSION_EVENT,
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'there' } },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } },
    { type: 'turn_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 956, output: 24, cost: { total: 0.00006 } } } },
    { type: 'agent_end', messages: [] },
  );
  turn.session.ws = { OPEN: 1, readyState: 1 }; // finalize emits only while the socket is open
  turn.proc.emit('close', 0);
  assert.deepStrictEqual(turn.ofType('data').map(f => f.data), ['Hello ', 'there']);
  const [result] = turn.ofType('objective-result');
  assert.strictEqual(result.content, 'Hello there');
  assert.deepStrictEqual(result.tokens, { input: 956, output: 24, costUsd: 0.00006 });
  assert.strictEqual(turn.ofType('objective-error').length, 0);
  // timers are cleared — nothing fires later
  t.mock.timers.tick(config.OBJECTIVE_TURN_MAX_MS);
  assert.strictEqual(turn.ofType('objective-error').length, 0);
});

// (TPT163) A PI_MODELS row naming a non-OpenRouter provider drives both --provider and the env
// var its key lands under; a second row of a different provider must not leak into either.
test('spawnPiTurn: a deepseek row spawns with --provider deepseek and DEEPSEEK_API_KEY', (t) => {
  enableTimers(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-pi-session-ds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify({
    PI_MODELS: [
      { model: MODEL, apiKey: 'sk-or-test' },
      { model: 'deepseek-flash', apiKey: 'sk-ds-test', provider: 'deepseek' },
    ],
  }), 'utf8');
  const session = { ...makeSession(dir), selectedModel: 'deepseek-flash' };
  assert.deepStrictEqual(buildPiArgs(session), ['--mode', 'json', '--provider', 'deepseek', '--model', 'deepseek-flash', '--tools', 'read', '--no-extensions']);
  let spawnCall = null;
  spawnPiTurn(session, 'T1', () => {}, {
    spawn: (command, args, opts) => { spawnCall = { command, args, opts }; return makeFakeProc(); },
  });
  assert.deepStrictEqual(spawnCall.args.slice(-9, -5), ['--mode', 'json', '--provider', 'deepseek']);
  assert.strictEqual(spawnCall.opts.env.DEEPSEEK_API_KEY, 'sk-ds-test');
  assert.notStrictEqual(spawnCall.opts.env.OPENROUTER_API_KEY, 'sk-ds-test');
});

// (TPT188) Any registry provider works the same way: a google row drives --provider google and
// puts its key under GEMINI_API_KEY (Pi's env var for that provider), never on argv.
test('spawnPiTurn: a google row spawns with --provider google and GEMINI_API_KEY', (t) => {
  enableTimers(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-pi-session-g-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify({
    PI_MODELS: [
      { model: MODEL, apiKey: 'sk-or-test' },
      { model: 'gemini-2.5-pro', apiKey: 'sk-g-test', provider: 'google' },
    ],
  }), 'utf8');
  const session = { ...makeSession(dir), selectedModel: 'gemini-2.5-pro' };
  assert.deepStrictEqual(buildPiArgs(session), ['--mode', 'json', '--provider', 'google', '--model', 'gemini-2.5-pro', '--tools', 'read', '--no-extensions']);
  let spawnCall = null;
  spawnPiTurn(session, 'T1', () => {}, {
    spawn: (command, args, opts) => { spawnCall = { command, args, opts }; return makeFakeProc(); },
  });
  assert.deepStrictEqual(spawnCall.args.slice(-9, -5), ['--mode', 'json', '--provider', 'google']);
  assert.strictEqual(spawnCall.opts.env.GEMINI_API_KEY, 'sk-g-test');
  assert.strictEqual(spawnCall.opts.env.OPENROUTER_API_KEY, 'sk-or-test', 'row 0 key stays under its own provider var');
  assert.ok(!spawnCall.args.includes('sk-g-test'), 'the key travels by env var, never argv');
});

test('spawnPiTurn: a keyless Bedrock row spawns with --provider amazon-bedrock and injects no key', (t) => {
  enableTimers(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-pi-session-br-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify({
    PI_MODELS: [{ model: 'us.anthropic.claude-sonnet-4', apiKey: '', provider: 'amazon-bedrock' }],
  }), 'utf8');
  const session = { ...makeSession(dir), selectedModel: 'us.anthropic.claude-sonnet-4' };
  assert.deepStrictEqual(buildPiArgs(session), ['--mode', 'json', '--provider', 'amazon-bedrock', '--model', 'us.anthropic.claude-sonnet-4', '--tools', 'read', '--no-extensions']);
  let spawnCall = null;
  spawnPiTurn(session, 'T1', () => {}, {
    spawn: (command, args, opts) => { spawnCall = { command, args, opts }; return makeFakeProc(); },
  });
  assert.deepStrictEqual(spawnCall.args.slice(-9, -5), ['--mode', 'json', '--provider', 'amazon-bedrock']);
  // The ambient value (if any) passes through untouched — an empty row key must not blank it.
  assert.strictEqual(spawnCall.opts.env.AWS_BEARER_TOKEN_BEDROCK, process.env.AWS_BEARER_TOKEN_BEDROCK);
});

// ── (TPT189) custom OpenAI-compatible endpoint rows ─────────────────────────
// A `custom` row runs on a provider declared in a generated <project>/.pi/agent/models.json:
// --provider is the block id, PI_CODING_AGENT_DIR points Pi at that dir, and the key never touches
// argv or the file (it travels as $TIPATASK_PI_CUSTOM_API_KEY).

function makeCustomProject(t, piModels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-pi-session-cu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify({ PI_MODELS: piModels }), 'utf8');
  return dir;
}

function spawnCapture(session, emit = () => {}) {
  let call = null;
  const proc = makeFakeProc();
  spawnPiTurn(session, 'T1', emit, {
    spawn: (command, args, opts) => { call = { command, args, opts }; return proc; },
  });
  return { call: () => call, proc };
}

const CUSTOM_KEYED = { model: 'gpt-4o-mini', apiKey: 'sk-custom-secret-9f3a', provider: 'custom', baseUrl: 'https://gw.example.com/v1' };
const CUSTOM_KEYLESS = { model: 'llama3.1:8b', apiKey: '', provider: 'custom', baseUrl: 'http://localhost:11434/v1' };

test('buildPiArgs: a custom row passes the generated block id as --provider and writes nothing', (t) => {
  const dir = makeCustomProject(t, [CUSTOM_KEYLESS]);
  const session = { ...makeSession(dir), selectedModel: 'llama3.1:8b' };
  assert.deepStrictEqual(
    buildPiArgs(session),
    ['--mode', 'json', '--provider', piCustomProviderId(CUSTOM_KEYLESS), '--model', 'llama3.1:8b', '--tools', 'read', '--no-extensions'],
  );
  assert.strictEqual(fs.existsSync(path.join(dir, '.pi')), false, 'buildPiArgs is a pure argv builder — it must not touch disk');
});

test('spawnPiTurn: a keyed custom row spawns on the generated provider, writes models.json, and keeps the key out of argv and the file', (t) => {
  enableTimers(t);
  const dir = makeCustomProject(t, [{ model: MODEL, apiKey: 'sk-or-test' }, CUSTOM_KEYED]);
  const session = { ...makeSession(dir), selectedModel: 'gpt-4o-mini' };
  const { call } = spawnCapture(session);
  const providerId = piCustomProviderId(CUSTOM_KEYED);

  assert.deepStrictEqual(call().args.slice(-9), ['--mode', 'json', '--provider', providerId, '--model', 'gpt-4o-mini', '--tools', 'read', '--no-extensions']);
  const env = call().opts.env;
  assert.strictEqual(env.PI_CODING_AGENT_DIR, path.join(dir, '.pi', 'agent'));
  assert.strictEqual(env.PI_CODING_AGENT_SESSION_DIR, piDefaultSessionDir(dir, process.env), 'sessions stay in Pi\'s normal per-cwd store');
  assert.strictEqual(env.TIPATASK_PI_CUSTOM_API_KEY, 'sk-custom-secret-9f3a');
  assert.strictEqual(env.OPENROUTER_API_KEY, 'sk-or-test', 'row 0 key stays under its own provider var');

  const modelsPath = path.join(dir, '.pi', 'agent', 'models.json');
  const block = JSON.parse(fs.readFileSync(modelsPath, 'utf8')).providers[providerId];
  assert.deepStrictEqual(block, {
    name: 'Custom endpoint (gw.example.com)',
    baseUrl: 'https://gw.example.com/v1',
    api: 'openai-completions',
    apiKey: '$TIPATASK_PI_CUSTOM_API_KEY',
    models: [{ id: 'gpt-4o-mini' }],
  });
  assert.ok(!call().args.join('\n').includes('sk-custom-secret-9f3a'), 'the key travels by env var — not a substring of any argv element');
  assert.ok(!fs.readFileSync(modelsPath, 'utf8').includes('sk-custom-secret-9f3a'), 'the literal key is never written to models.json');
});

test('spawnPiTurn: a keyless custom row gets the placeholder apiKey and exports no key var', (t) => {
  enableTimers(t);
  const dir = makeCustomProject(t, [CUSTOM_KEYLESS]);
  const session = { ...makeSession(dir), selectedModel: 'llama3.1:8b' };
  const { call } = spawnCapture(session);
  const providerId = piCustomProviderId(CUSTOM_KEYLESS);
  assert.deepStrictEqual(call().args.slice(-9, -5), ['--mode', 'json', '--provider', providerId]);
  assert.strictEqual(call().opts.env.PI_CODING_AGENT_DIR, path.join(dir, '.pi', 'agent'));
  assert.strictEqual(call().opts.env.TIPATASK_PI_CUSTOM_API_KEY, process.env.TIPATASK_PI_CUSTOM_API_KEY, 'ambient value passes through untouched');
  const block = JSON.parse(fs.readFileSync(path.join(dir, '.pi', 'agent', 'models.json'), 'utf8')).providers[providerId];
  assert.strictEqual(block.apiKey, 'tipatask-no-key');
});

test('spawnPiTurn: a full custom-row turn streams text and finalizes into objective-result', (t) => {
  enableTimers(t);
  const dir = makeCustomProject(t, [CUSTOM_KEYLESS]);
  const session = { ...makeSession(dir), selectedModel: 'llama3.1:8b' };
  const frames = [];
  const { call, proc } = spawnCapture(session, (f) => frames.push(f));
  assert.ok(call().args.includes(piCustomProviderId(CUSTOM_KEYLESS)));

  proc.stdout.emit('data', Buffer.from([
    SESSION_EVENT,
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'local model' } },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } },
    { type: 'turn_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 12, output: 3, cost: { total: 0 } } } },
    { type: 'agent_end', messages: [] },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n'));
  session.ws = { OPEN: 1, readyState: 1 };
  proc.emit('close', 0);

  assert.deepStrictEqual(frames.filter((f) => f.type === 'data').map((f) => f.data), ['Hello ', 'local model']);
  const [result] = frames.filter((f) => f.type === 'objective-result');
  assert.strictEqual(result.content, 'Hello local model');
  assert.deepStrictEqual(result.tokens, { input: 12, output: 3, costUsd: 0 });
  assert.strictEqual(frames.filter((f) => f.type === 'objective-error').length, 0);
  assert.strictEqual(session.piSessionId, 'uuid-1', 'the session id is captured for --session resume on the next turn');
});

test('spawnPiTurn: a follow-up custom-row turn resumes with --session and the same pinned sessions dir', (t) => {
  enableTimers(t);
  const dir = makeCustomProject(t, [CUSTOM_KEYLESS]);
  const session = { ...makeSession(dir), selectedModel: 'llama3.1:8b', piSessionId: 'uuid-1' };
  const { call } = spawnCapture(session);
  assert.deepStrictEqual(call().args.slice(-2), ['--session', 'uuid-1']);
  assert.strictEqual(call().opts.env.PI_CODING_AGENT_SESSION_DIR, piDefaultSessionDir(dir, process.env),
    'resume needs the sessions dir to be the one earlier (and non-custom) turns wrote to');
});

test('spawnPiTurn: a non-custom row leaves Pi\'s agent dir alone and creates no .pi/', (t) => {
  enableTimers(t);
  const turn = startTurn(t);
  const env = turn.spawnCall().opts.env;
  assert.strictEqual(env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR, 'ambient value passes through untouched');
  assert.strictEqual(env.PI_CODING_AGENT_SESSION_DIR, process.env.PI_CODING_AGENT_SESSION_DIR);
  assert.strictEqual(fs.existsSync(path.join(turn.session.projectPath, '.pi')), false);
});
