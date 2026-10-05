'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

// Task-chat widget frames through each provider's real turn loop (Claude, Codex, Pi): a fake CLI
// process writes that provider's own stream events and the test reads what reaches the client.
// No CLI is spawned and no request leaves the process.

const DIALOG_BLOCK = '```ask_user\n{"question": "Which sprint?", "options": ["Current", "Backlog"], "multi": false}\n```';

function fakeProc(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {}, end() {} };
  return proc;
}

function loadInVm(file, mocks, extraGlobals = {}) {
  const filename = path.join(__dirname, file);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id),
    console: { log() {}, warn() {}, error() {} },
    process: { env: {}, kill() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, Date, Buffer, AbortController,
    ...extraGlobals,
  }, { filename });
  return module.exports;
}

function chatSession(frames, extra = {}) {
  const mutations = [];
  const session = {
    type: 'taskChat', taskKey: 'TPT1', tabId: 'chat-tab', firstPrompt: 'seed',
    messages: [{ role: 'user', content: 'seed', seed: true, timestamp: 0 }],
    turnBuffer: '', turnRawSse: '', buffer: '',
    timingMilestones: {}, totalTokens: { input: 0, output: 0 },
    _cachedTagsSerialized: new Set(), tagArchCache: new Map(),
    ws: { OPEN: 1, readyState: 1, send: raw => frames.push(JSON.parse(raw)) },
    onTaskChatMutation: (info) => { mutations.push(info); return { action: info.action, toolId: info.toolId, task: { id: info.taskKey } }; },
    ...extra,
  };
  return { session, mutations };
}

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const toolFrames = frames => frames.filter(f => f.type === 'task-chat-tool').map(f => [f.tool.id, f.tool.status]);
const line = event => Buffer.from(`${JSON.stringify(event)}\n`);

test('claude: ask_user text and tool_use events become dialog and tool frames, deduped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const config = { ...require('./config'), SIMPLE_MODE: true, OBJECTIVE_TIMING_ENABLED: false,
    OBJECTIVE_PREWARM_ENABLED: false, OBJECTIVE_HEARTBEAT_ENABLED: false, OBJECTIVE_EARLY_FINALIZE: false };
  const procs = [];
  const throttle = loadInVm('objective-throttle.js', { './config': config });
  const claude = loadInVm('claude-session.js', {
    './config': config, './objective-throttle': throttle,
    './static-context': { getStaticBundleStats: () => ({ chars: 0, sha: '' }) },
    './spawn-utils': { augmentPathEnv: () => ({}), projectEnvExtras: () => ({}) },
    './task-agent/attachments': { localizeAttachments: async ({ prompt }) => ({ prompt }) },
    'node:fs/promises': { unlink: async () => {}, writeFile: async () => {} },
    'node:child_process': { spawn() { const proc = fakeProc(91000 + procs.length); procs.push(proc); return proc; } },
  });
  const frames = [];
  const { session, mutations } = chatSession(frames);
  claude.spawnObjectiveTurn(session, 'taskChat:TPT1');
  const out = event => session.proc.stdout.emit('data', line(event));
  const delta = text => out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });

  // The CLI announces a tool, then repeats it (now with its input) in the full assistant message.
  out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__tipatask__update_task', input: {} } } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__tipatask__update_task', input: { task_key: 'TPT1', title: 'New title' } }] } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__tipatask__update_task', input: { task_key: 'TPT1', title: 'New title' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '{"task":{"id":"TPT1"}}' }] }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'again' }] } });

  // The dialog block streams in pieces; nothing is sent until it is whole, and then only once.
  const cut = DIALOG_BLOCK.length - 10;
  delta(`Renamed. ${DIALOG_BLOCK.slice(0, cut)}`);
  assert.equal(frames.filter(f => f.type === 'task-chat-dialog').length, 0);
  delta(DIALOG_BLOCK.slice(cut));
  delta('\n');

  assert.deepEqual(toolFrames(frames), [['toolu_1', 'running'], ['toolu_1', 'running'], ['toolu_1', 'done']]);
  const withInput = frames.filter(f => f.type === 'task-chat-tool')[1].tool;
  assert.equal(withInput.input.title, 'New title');
  assert.equal(withInput.tool, 'update_task');
  const dialogs = frames.filter(f => f.type === 'task-chat-dialog');
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].tabId, 'chat-tab');
  assert.equal(dialogs[0].taskKey, 'TPT1');
  assert.deepEqual(dialogs[0].dialog.options.map(o => o.label), ['Current', 'Backlog']);
  assert.equal(frames.filter(f => f.type === 'task-cards').length, 0);

  session.proc.emit('close', 0);
  await settle();
  assert.equal(frames.filter(f => f.type === 'task-chat-dialog').length, 1, 'the closing scan sends nothing new');
  assert.deepEqual(mutations, [{ action: 'updated', taskKey: 'TPT1', toolId: 'toolu_1' }]);
  const reply = session.messages.at(-1);
  assert.equal(reply.role, 'assistant');
  assert.equal(reply.dialogs.length, 1);
  assert.deepEqual(reply.tools.map(tool => tool.status), ['done']);
  assert.deepEqual(reply.taskEvents.map(e => e.task.id), ['TPT1']);
  assert.equal(frames.filter(f => f.type === 'chat-ready').length, 1);
});

test('codex: mcp_tool_call items and the agent message become tool and dialog frames', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const spawned = [];
  const codex = loadInVm('providers/codex-session.js', {
    'node:child_process': { spawn() { const proc = fakeProc(97000 + spawned.length); spawned.push(proc); return proc; } },
    '../../codex-mcp-config': { buildScopedCodexMcpOverride: () => 'mcp_servers={}' },
    '../codex-env': { buildCodexEnv: () => ({ env: {} }), codexEffortArgs: () => [], toCodexEffort: level => level },
    '../claude-session': { normalizeProposals: x => x },
    './transcript': { buildTurnPrompt: () => ({ prompt: 'seed', mode: 'fresh' }), buildNudgeMessage: () => 'nudge' },
    '../task-agent/attachments': { localizeAttachments: async ({ prompt }) => ({ prompt }) },
    '../context-manager': { shouldTrimContext: () => false, trimContext: () => false },
  });
  const frames = [];
  const { session, mutations } = chatSession(frames, { providerType: 'codex' });
  codex.spawnCodexTurn(session, 'taskChat:TPT1');
  await settle();
  const proc = spawned[0];
  const out = event => proc.stdout.emit('data', line(event));

  out({ type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server: 'tipatask', tool: 'create_task', arguments: { title: 'Follow-up' }, status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server: 'tipatask', tool: 'create_task', arguments: { title: 'Follow-up' }, status: 'completed',
    result: { content: [{ type: 'text', text: '{"project_id":2,"task":{"id":"TPT60"}}' }] } } });
  out({ type: 'item.completed', item: { id: 'item_2', type: 'mcp_tool_call', server: 'tipatask', tool: 'update_task', arguments: { task_key: 'TPT1', status: 'nope' }, status: 'failed', error: { message: 'Invalid status' } } });
  out({ type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: 'ls' } });
  out({ type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: `Created TPT60.\n\n${DIALOG_BLOCK}` } });

  assert.deepEqual(toolFrames(frames), [['item_1', 'running'], ['item_1', 'done'], ['item_2', 'running'], ['item_2', 'error']]);
  const created = frames.find(f => f.type === 'task-chat-tool').tool;
  assert.deepEqual([created.name, created.server, created.tool], ['mcp__tipatask__create_task', 'tipatask', 'create_task']);
  assert.equal(frames.filter(f => f.type === 'task-chat-tool').at(-1).tool.error, 'Invalid status');
  assert.equal(frames.filter(f => f.type === 'task-chat-dialog').length, 1);
  assert.equal(frames.filter(f => f.type === 'objective-progress' && f.stage === 'tool').length, 3, 'the progress frames are unchanged');

  proc.emit('close', 0);
  await settle();
  assert.deepEqual(mutations, [{ action: 'created', taskKey: 'TPT60', toolId: 'item_1' }]);
  assert.equal(frames.filter(f => f.type === 'task-chat-dialog').length, 1);
  const reply = session.messages.at(-1);
  assert.equal(reply.dialogs.length, 1);
  assert.deepEqual(reply.tools.map(tool => tool.status), ['done', 'error']);
});

test('pi: tipatask_api tool executions and text deltas become tool and dialog frames', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => t.mock.timers.reset());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-chat-streams-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify({ PI_MODELS: [{ model: 'openrouter/x/y', apiKey: 'sk-or-test' }] }), 'utf8');

  const { spawnPiTurn } = require('./providers/pi-session');
  const frames = [];
  const { session, mutations } = chatSession([], { providerType: 'pi', projectPath: dir, selectedModel: 'openrouter/x/y', piSessionId: null, ws: null });
  const proc = fakeProc(0);
  proc.killed = true;
  spawnPiTurn(session, 'taskChat:TPT1', frame => frames.push(frame), { spawn: () => proc });
  const out = event => proc.stdout.emit('data', line(event));

  out({ type: 'session', version: 3, id: 'uuid-1' });
  out({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'tipatask_api', args: { method: 'PATCH', path: '/tasks/TPT1', body: { title: 'New title' } } });
  out({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'tipatask_api', isError: false, result: { content: [{ type: 'text', text: 'HTTP 200\n{"task":{"task_key":"TPT1"}}' }], details: {} } });
  out({ type: 'tool_execution_start', toolCallId: 'call_2', toolName: 'read', args: { path: 'README.md' } });
  out({ type: 'tool_execution_end', toolCallId: 'call_2', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: '# Readme' }] } });
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `Renamed.\n\n${DIALOG_BLOCK}` } });
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '\n' } });

  assert.deepEqual(toolFrames(frames), [['call_1', 'running'], ['call_1', 'done'], ['call_2', 'running'], ['call_2', 'done']]);
  assert.equal(frames.find(f => f.type === 'task-chat-tool').tool.input.path, '/tasks/TPT1');
  assert.deepEqual(frames.filter(f => f.type === 'objective-progress' && f.stage === 'tool').map(f => f.name), ['tipatask_api', 'read']);
  const dialogs = frames.filter(f => f.type === 'task-chat-dialog');
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].tabId, 'chat-tab');

  out({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] });
  proc.emit('close', 0);
  await settle();
  assert.deepEqual(mutations, [{ action: 'updated', taskKey: 'TPT1', toolId: 'call_1' }]);
  const reply = session.messages.at(-1);
  assert.equal(reply.role, 'assistant');
  assert.equal(reply.dialogs.length, 1);
  assert.equal(reply.tools.length, 2);
});
