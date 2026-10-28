import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

import permissionGate, { MODE_SWITCH_MARKER, switchDirectiveMode, toolCallResult } from './permission-gate.mjs';

const require = createRequire(import.meta.url);
const TOKEN = 'a'.repeat(64);

// Stands in for the Task App gate: answers each tool call from `state.mode` with the same rule
// shape as permission-gate.js (Plan: reads only; Auto: edits and reads run, anything else waits
// for the user; Bypass: everything runs) and records every event the extension sends.
async function stubGate(t, mode) {
  const state = { mode, events: [], waiting: [], reply: null };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const send = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(403); res.end('{}'); return; }
    const event = JSON.parse(body);
    state.events.push(event);
    if (state.reply) return send(state.reply);
    if (event.hook_event_name !== 'PreToolUse') return send({ decision: 'allow', mode: state.mode });
    const tool = event.tool_name;
    const verdict = state.mode === 'bypass' ? 'allow'
      : ['read', 'grep', 'find', 'ls'].includes(tool) ? 'allow'
        : state.mode === 'plan' ? 'deny'
          : ['edit', 'write'].includes(tool) ? 'allow' : 'prompt';
    if (verdict !== 'prompt') return send({ decision: verdict, mode: state.mode, reason: `${verdict} under ${state.mode}` });
    // An approval: the request stays open until the test answers for the user.
    state.waiting.push(allow => send({ decision: allow ? 'allow' : 'deny', mode: state.mode, reason: 'answered' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { state, url: `http://127.0.0.1:${server.address().port}/check` };
}

function loadExtension(t, url) {
  const saved = { url: process.env.TIPATASK_PERMISSION_URL, token: process.env.TIPATASK_PERMISSION_TOKEN };
  process.env.TIPATASK_PERMISSION_URL = url;
  process.env.TIPATASK_PERMISSION_TOKEN = TOKEN;
  t.after(() => {
    for (const [key, value] of [['TIPATASK_PERMISSION_URL', saved.url], ['TIPATASK_PERMISSION_TOKEN', saved.token]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const handlers = {};
  let active = ['read', 'bash', 'edit', 'write'];
  const pi = {
    on(event, fn) { handlers[event] = fn; },
    getActiveTools: () => active,
    setActiveTools(names) { active = names; },
  };
  permissionGate(pi);
  return { handlers, tools: () => active,
    call: (toolName, input = {}, ctx = {}) => handlers.tool_call({ toolName, input }, ctx) };
}

async function until(pred, ms = 2000) {
  for (const stop = Date.now() + ms; !pred(); ) {
    if (Date.now() > stop) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('session start confirms the gate and enables the native search tools', async t => {
  const gate = await stubGate(t, 'plan');
  const pi = loadExtension(t, gate.url);
  await pi.handlers.session_start({}, {});
  assert.deepEqual(gate.state.events, [{ hook_event_name: 'SessionStart' }]);
  assert.deepEqual(pi.tools(), ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
});

test('each tool call follows the live decision: Plan blocks writes, Auto prompts for non-edit tools, Bypass allows', async t => {
  const gate = await stubGate(t, 'plan');
  const pi = loadExtension(t, gate.url);
  assert.equal(await pi.call('read', { path: 'a' }), undefined);
  assert.deepEqual(await pi.call('write', { path: 'a', content: 'x' }), { block: true, reason: 'deny under plan' });
  assert.deepEqual(await pi.call('bash', { command: 'ls' }), { block: true, reason: 'deny under plan' });
  assert.deepEqual(gate.state.events.at(-1), { hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'ls' } });

  gate.state.mode = 'auto';
  assert.equal(await pi.call('edit', { path: 'a' }), undefined);
  const prompted = pi.call('bash', { command: 'npm test' });
  await until(() => gate.state.waiting.length === 1);
  let settled = false;
  prompted.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(settled, false, 'the tool waits while the user is asked');
  gate.state.waiting.shift()(true);
  assert.equal(await prompted, undefined);
  const refused = pi.call('bash', { command: 'npm test' });
  await until(() => gate.state.waiting.length === 1);
  gate.state.waiting.shift()(false);
  assert.deepEqual(await refused, { block: true, reason: 'answered' });

  gate.state.mode = 'bypass';
  assert.equal(await pi.call('bash', { command: 'npm test' }), undefined);
});

test('a mid-run switch applies at the next tool call, and Bypass to Auto restores prompting', async t => {
  const gate = await stubGate(t, 'auto');
  const pi = loadExtension(t, gate.url);
  const asked = pi.call('bash', { command: 'git status --porcelain' });
  await until(() => gate.state.waiting.length === 1);
  gate.state.mode = 'bypass'; // the user switches while the first call is still running
  gate.state.waiting.shift()(false); // the gate revokes the outstanding request on a switch
  assert.equal((await asked).block, true);
  assert.equal(await pi.call('bash', { command: 'git status --porcelain' }), undefined, 'the retry runs under Bypass');
  gate.state.mode = 'auto';
  const again = pi.call('bash', { command: 'git status --porcelain' });
  await until(() => gate.state.waiting.length === 1);
  gate.state.waiting.shift()(true);
  assert.equal(await again, undefined);
});

test('only an explicit allow runs a tool; unknown answers, errors, an unavailable gate and aborts block', async t => {
  const gate = await stubGate(t, 'bypass');
  const pi = loadExtension(t, gate.url);
  gate.state.reply = { decision: 'prompt', mode: 'auto' };
  assert.equal((await pi.call('bash', { command: 'x' })).block, true, 'an unanswered prompt never runs the tool');
  gate.state.reply = { mode: 'auto' };
  assert.equal((await pi.call('bash')).block, true);
  gate.state.reply = { hookSpecificOutput: { permissionDecision: 'allow' } };
  assert.equal(await pi.call('bash'), undefined, 'older gate answer shape still allows');
  gate.state.reply = { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'old deny' } };
  assert.deepEqual(await pi.call('bash'), { block: true, reason: 'old deny' });
  gate.state.reply = null;

  gate.state.mode = 'auto';
  const controller = new AbortController();
  const aborted = pi.call('bash', { command: 'sleep 1' }, { signal: controller.signal });
  await until(() => gate.state.waiting.length === 1);
  controller.abort();
  assert.deepEqual(await aborted, { block: true, reason: 'Action canceled.' });

  process.env.TIPATASK_PERMISSION_URL = 'http://127.0.0.1:9/check';
  assert.deepEqual(await pi.call('read'), { block: true, reason: 'Permission gate unavailable. Action blocked.' });
  process.env.TIPATASK_PERMISSION_URL = 'http://example.com/check';
  assert.deepEqual(await pi.call('read'), { block: true, reason: 'Permission gate unavailable. Action blocked.' });
});

test('input reports only a submitted mode-switch directive, and never blocks input', async t => {
  const gate = await stubGate(t, 'plan');
  const pi = loadExtension(t, gate.url);
  assert.equal(await pi.handlers.input({ text: 'Please continue with step 2.', source: 'interactive' }, {}), undefined);
  assert.deepEqual(gate.state.events, []);
  const PiAgent = require('../../task-agent/pi-agent');
  for (const mode of ['auto', 'bypass']) {
    const directive = new PiAgent().buildModeSwitchDirective(mode);
    assert.equal(switchDirectiveMode(directive), mode, 'the marker tracks the directive wording');
    assert.equal(await pi.handlers.input({ text: `draft text ${directive}`, source: 'interactive', streamingBehavior: 'steer' }, {}), undefined);
    assert.deepEqual(gate.state.events.at(-1), { hook_event_name: 'UserPromptSubmit', permission_mode: mode });
  }
  assert.equal(switchDirectiveMode('The user selected plan for this session.'), null);
  assert.ok(MODE_SWITCH_MARKER.test('The user selected auto for this session.'));
  process.env.TIPATASK_PERMISSION_URL = 'http://127.0.0.1:9/check';
  assert.equal(await pi.handlers.input({ text: new PiAgent().buildModeSwitchDirective('auto') }, {}), undefined);
});

test('toolCallResult fails closed on anything but an explicit allow', () => {
  assert.equal(toolCallResult({ decision: 'allow' }), undefined);
  for (const result of [null, {}, { decision: 'deny' }, { decision: 'prompt' }, { decision: 'ask' }]) {
    assert.equal(toolCallResult(result).block, true);
  }
});
