'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

// Run production modules with isolated throttle state, fake CLI processes and
// mocked time. No real process signals, file writes, or provider requests.
function harness(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const config = { ...require('./config'), SIMPLE_MODE: true,
    OBJECTIVE_TIMING_ENABLED: false, OBJECTIVE_PREWARM_ENABLED: false,
    OBJECTIVE_HEARTBEAT_ENABLED: false, OBJECTIVE_MAX_CONCURRENT: 1,
    OBJECTIVE_STREAM_IDLE_MS: 60000, OBJECTIVE_MAX_RETRIES: 2,
    OBJECTIVE_RETRY_BACKOFF_MS: 250, ...overrides };
  const processes = [], signals = [], frames = [], writes = [], logs = [];
  function load(file, mocks) {
    const filename = path.join(__dirname, file);
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports,
      require: id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id),
      console: { log: (...a) => logs.push(a.join(' ')), warn() {}, error: (...a) => logs.push(a.join(' ')) },
      process: { env: {}, kill: (pid, signal) => signals.push({ pid, signal }) },
      setTimeout, clearTimeout, setImmediate, Date, Buffer, AbortController,
    }, { filename });
    return module.exports;
  }
  const throttle = load('objective-throttle.js', { './config': config });
  const claude = load('claude-session.js', {
    './config': config, './objective-throttle': throttle,
    './static-context': { getStaticBundleStats: () => ({ chars: 0, sha: '' }) },
    './spawn-utils': { augmentPathEnv: () => ({}), projectEnvExtras: () => ({}), cliSpawnSpec: require('./spawn-utils').cliSpawnSpec },
    './task-agent/attachments': { localizeAttachments: async ({ prompt }) => ({ prompt }) },
    'node:fs/promises': { unlink: async () => {}, writeFile: async (file, data) => { writes.push({ file, data }); } },
    'node:child_process': { spawn() {
      const proc = new EventEmitter();
      proc.pid = 90000 + processes.length;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdinText = '';
      proc.stdin = { write(s) { proc.stdinText += s; }, end() {} };
      processes.push(proc);
      return proc;
    } },
  });
  const session = { type: 'objective', tabId: 'test-tab', firstPrompt: 'Plan this',
    messages: [{ role: 'user', content: 'Plan this', timestamp: 0 }],
    timingMilestones: {}, totalTokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, costUsd: 0 },
    _cachedTagsSerialized: new Set(), tagArchCache: new Map(),
    _cacheTrail: [], _profileTrail: [], _priorCacheRead: 0,
    ws: { OPEN: 1, readyState: 1, send: text => frames.push(JSON.parse(text)) },
  };
  const start = () => throttle.requestTurn('A', () => claude.spawnObjectiveTurn(session, 'A'));
  const errors = () => frames.filter(f => f.type === 'objective-error');
  const out = event => session.proc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  // The stdin write (and the prompt dump beside it) happens after the attachment localizer's
  // await resolves — one macrotask after start().
  const settled = () => new Promise(resolve => setImmediate(resolve));
  return { throttle, claude, config, session, processes, signals, frames, writes, logs, start, errors, out, settled };
}

const { SEPARATOR } = require('./objective-prompt-dump');

test('every turn logs [objective:prompt-size] and dumps objective-prompt.md holding the exact stdin text', async t => {
  const h = harness(t);
  h.session.firstPrompt = '### get_project_tags\n[]\n\n<objective>\nPlan this with @ai/x.md\n</objective>';
  h.start();
  await h.settled();
  const proc = h.processes[0];
  assert.ok(proc.stdinText.endsWith(h.session.firstPrompt), 'stdin carries the prompt');
  const sizeLine = h.logs.find(l => l.startsWith('[objective:prompt-size]'));
  assert.ok(sizeLine, 'size line logged');
  assert.match(sizeLine, new RegExp(` stdin\\.chars=${proc.stdinText.length} stdin\\.bytes=${Buffer.byteLength(proc.stdinText)} mentions=1 attachmentRefs=0 sections=`));
  assert.match(sizeLine, /mode=fresh/);
  const dump = h.writes.find(w => w.file.endsWith('objective-prompt.md'));
  assert.ok(dump, 'objective-prompt.md written');
  const sepAt = dump.data.indexOf(SEPARATOR);
  assert.ok(sepAt > 0);
  const header = dump.data.slice(0, sepAt + SEPARATOR.length);
  assert.equal(dump.data.slice(header.length), proc.stdinText, 'body after the separator is the exact stdin');
  const bodyStart = Number(header.match(/body starts at byte (\d+)/)[1]);
  assert.equal(bodyStart, Buffer.byteLength(header));
  assert.equal(Buffer.byteLength(dump.data) - bodyStart, Buffer.byteLength(proc.stdinText));
  assert.ok(h.logs.indexOf(sizeLine) >= 0);
  assert.equal(h.session._lastTurnProfile.stdinChars, proc.stdinText.length);
  assert.equal(h.session._lastTurnProfile.mentions, 1);
});

test('a CLI result with an error subtype ends the turn as objective-error, never as a chat bubble', async t => {
  const h = harness(t);
  h.start();
  await h.settled();
  h.out({ type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 400 prompt is too long' }] } });
  h.out({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 10, num_turns: 1,
    result: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 5012345 tokens > 200000 maximum"}}' });
  await h.settled();
  assert.equal(h.errors().length, 1);
  const err = h.errors()[0];
  assert.equal(err.reason, 'cli-error:error_during_execution');
  assert.equal(err.provider, 'claude');
  assert.equal(err.attempts, 0);
  assert.match(err.message, /prompt is too long: 5012345 tokens/);
  assert.ok(!h.frames.some(f => f.type === 'objective-result' || f.type === 'chat-ready'), 'no reply frames');
  assert.equal(h.session.turnBuffer, '');
  assert.ok(!h.session.messages.some(m => m.role === 'assistant'), 'no assistant message recorded');
  assert.equal(h.session.proc, null);
  assert.equal(h.throttle.getStatus().active, 0, 'slot released');
  assert.equal(h.throttle.getStatus().consecutiveTimeouts, 0, 'a CLI input error is not a circuit-breaker timeout');
  const errLine = h.logs.find(l => l.startsWith('[objective:cli-error]'));
  assert.ok(errLine);
  assert.match(errLine, /subtype=error_during_execution is_error=true/);
  assert.match(errLine, /prompt is too long/);
  assert.match(errLine, /profile=\{.*"stdinChars":\d+/);
  h.processes[0].emit('close', 1);
  t.mock.timers.tick(5000);
  assert.equal(h.errors().length, 1, 'close after the error emits nothing more');
  assert.equal(h.processes.length, 1, 'no retry spawn');
});

test('a result with is_error but no text still yields a cli-error carrying a placeholder message', async t => {
  const h = harness(t);
  h.start();
  await h.settled();
  h.out({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['max turns reached'] });
  assert.equal(h.errors().length, 1);
  assert.equal(h.errors()[0].reason, 'cli-error:error_max_turns');
  assert.equal(h.errors()[0].message, 'max turns reached');
});

test('token usage is read from the result event\'s usage block and total_cost_usd, and [objective:profile] logs', async t => {
  const h = harness(t, { OBJECTIVE_MAX_NUDGES: 0 });
  h.start();
  await h.settled();
  h.out({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 1.25, num_turns: 3,
    usage: { input_tokens: 162, cache_creation_input_tokens: 201449, cache_read_input_tokens: 822359, output_tokens: 6424 } });
  assert.deepEqual({ ...h.session.turnTokens }, { input: 162, output: 6424, cacheCreation: 201449, cacheRead: 822359, costUsd: 1.25 });
  assert.equal(h.session.totalTokens.cacheRead, 822359);
  const profile = h.logs.find(l => l.startsWith('[objective:profile]'));
  assert.ok(profile, 'profile logged once a result carries usage');
  assert.match(profile, /reported\.input=162 cache_read=822359 cache_write=201449/);
  assert.equal(h.session._profileTrail.length, 1, 'C495 metrics trail records the turn');
});

test('a successful result still finalizes the turn as before', async t => {
  const h = harness(t, { OBJECTIVE_MAX_NUDGES: 0 });
  h.start();
  await h.settled();
  h.out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } } });
  h.out({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', input_tokens: 10, output_tokens: 2 });
  await h.settled();
  await h.settled();
  assert.equal(h.errors().length, 0);
  assert.ok(h.frames.some(f => f.type === 'objective-result'), 'reply delivered');
  assert.equal(h.session.messages.at(-1).role, 'assistant');
});

test('a throwing SSE handler logs one [objective:sse-handler] line per event type and the stream keeps going', async t => {
  const h = harness(t, { OBJECTIVE_MAX_NUDGES: 0 });
  h.start();
  await h.settled();
  h.session._cacheTrail = {}; // not an array — the result handler's cache-trail push throws
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.',
    usage: { input_tokens: 1, output_tokens: 1 } });
  const delta = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'after-throw' } } });
  h.session.proc.stdout.emit('data', Buffer.from(`${result}\n${result}\n${delta}\n`));
  const handlerLogs = h.logs.filter(l => l.startsWith('[objective:sse-handler]'));
  assert.equal(handlerLogs.length, 1, 'repeat throws of the same event type log once');
  assert.match(handlerLogs[0], /^\[objective:sse-handler\] task=A event=result TypeError: session\._cacheTrail\.push is not a function\n {4}at /);
  assert.ok(h.session.turnBuffer.includes('after-throw'), 'the line after the throw was still processed');
  assert.ok(h.frames.some(f => f.type === 'data' && f.data === 'after-throw'));
});

test('a malformed stream-json line is skipped without logging and the next line is processed', async t => {
  const h = harness(t, { OBJECTIVE_MAX_NUDGES: 0 });
  h.start();
  await h.settled();
  const before = h.logs.length;
  const delta = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } });
  h.session.proc.stdout.emit('data', Buffer.from(`{not json\n${delta}\n`));
  assert.deepEqual(h.logs.slice(before), [], 'nothing logged for the unparseable line');
  assert.equal(h.session.turnBuffer, 'ok');
});

test('silent Claude turn expires across automatic retries, emits one error and drains queue', t => {
  const h = harness(t);
  h.start();
  let nextRan = 0;
  h.throttle.requestTurn('B', () => nextRan++);
  t.mock.timers.tick(60000);
  t.mock.timers.tick(250);
  assert.equal(h.processes.length, 2, 'idle retry spawned without refreshing slot watchdog');
  t.mock.timers.tick(59749);
  assert.equal(h.errors().length, 0);
  t.mock.timers.tick(1);
  assert.equal(h.errors().length, 1);
  assert.equal(h.errors()[0].reason, 'stream-stalled');
  assert.equal(h.errors()[0].tabId, 'test-tab');
  assert.equal(h.errors()[0].provider, 'claude');
  assert.equal(nextRan, 1);
  assert.equal(h.throttle.getStatus().pending, 0);
  assert.equal(h.throttle.getStatus().active, 1, 'only queued B retains a slot');
  assert.equal(h.session.proc, null);
  assert.equal(h.session.messages[0].content, 'Plan this', 'Retry retains original prompt');
  const stalledProc = h.processes[1];
  assert.ok(h.signals.some(s => s.pid === -stalledProc.pid && s.signal === 'SIGTERM'));
  t.mock.timers.tick(2000);
  assert.ok(h.signals.some(s => s.pid === -stalledProc.pid && s.signal === 'SIGKILL'));
  for (const proc of h.processes) proc.emit('close', 1);
  t.mock.timers.tick(120000);
  assert.equal(h.errors().length, 1, 'late close cannot emit another error or retry');
  assert.equal(h.processes.length, 2);
});

test('tool-only stream chunks keep a long turn alive; silence then expires it', t => {
  const h = harness(t);
  h.start();
  for (let i = 0; i < 8; i++) {
    t.mock.timers.tick(45000);
    h.out({ type: 'stream_event', event: { type: 'content_block_start',
      content_block: { type: 'tool_use', name: 'Read', id: `tool-${i}` } } });
  }
  assert.equal(h.errors().length, 0);
  assert.equal(h.processes.length, 1);
  assert.ok(h.frames.some(f => f.type === 'objective-progress' && f.stage === 'tool'));
  t.mock.timers.tick(60000);
  t.mock.timers.tick(250);
  t.mock.timers.tick(60000);
  assert.equal(h.errors().length, 1);
});

test('late output, close, and kill escalation from stalled proc cannot damage Retry', t => {
  const h = harness(t, { OBJECTIVE_STREAM_IDLE_MS: 300000 });
  h.start();
  const old = h.session.proc;
  t.mock.timers.tick(120000);
  h.start();
  const replacement = h.session.proc;
  t.mock.timers.tick(2000);
  assert.ok(h.signals.some(s => s.pid === -old.pid && s.signal === 'SIGKILL'));
  assert.ok(!h.signals.some(s => s.pid === -replacement.pid));
  old.emit('close', 1);
  old.stdout.emit('data', Buffer.from('{}\n'));
  assert.equal(h.session.proc, replacement);
  assert.equal(h.session._aborted, false);
  t.mock.timers.tick(118000);
  assert.equal(h.errors().length, 2, 'fresh turn has its own watchdog');
});

for (const finish of ['recordSuccess', 'recordAbort', 'recordTimeout']) {
  test(`${finish} clears timer; stale activity cannot refresh a replacement slot`, t => {
    const { throttle } = harness(t);
    let expired = 0;
    throttle.requestTurn('A', () => {});
    const staleTouch = throttle.watchTurn('A', () => expired++);
    throttle[finish]('A', 'test');
    t.mock.timers.tick(120000);
    assert.equal(expired, 0);
    throttle.requestTurn('A', () => {});
    throttle.watchTurn('A', () => expired++);
    t.mock.timers.tick(119999);
    staleTouch();
    t.mock.timers.tick(1);
    assert.equal(expired, 1);
    assert.equal(throttle.getStatus().active, 0);
  });
}

test('throwing stall cleanup still frees slot without crashing timer callback', t => {
  const { throttle } = harness(t);
  throttle.requestTurn('A', () => {});
  throttle.watchTurn('A', () => { throw new Error('socket failed'); });
  t.mock.timers.tick(120000);
  assert.equal(throttle.getStatus().active, 0);
});

// Streamed text and the closing full `assistant` message carry the same words. The full message
// is a fallback for a turn that streamed nothing — it must never be appended on top of deltas,
// whether or not turn timing is enabled.
for (const timing of [false, true]) {
  test(`Claude reply text is recorded once when deltas and the full message both arrive (timing=${timing})`, t => {
    const h = harness(t, { OBJECTIVE_TIMING_ENABLED: timing });
    h.start();
    const delta = text => h.out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    delta('Hello ');
    delta('world.');
    h.out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world.' }] } });
    assert.equal(h.session.turnBuffer, 'Hello world.');
    assert.deepEqual(h.frames.filter(f => f.type === 'data').map(f => f.data), ['Hello ', 'world.']);
  });

  test(`Claude full-message fallback still delivers a turn that streamed no deltas (timing=${timing})`, t => {
    const h = harness(t, { OBJECTIVE_TIMING_ENABLED: timing });
    h.start();
    h.out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Only message.' }] } });
    assert.equal(h.session.turnBuffer, 'Only message.');
    assert.deepEqual(h.frames.filter(f => f.type === 'data').map(f => f.data), ['Only message.']);
  });
}
