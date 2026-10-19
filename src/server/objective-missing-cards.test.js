'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { normalizeProposals, tryEmitTaskCards } = require('./claude-session');
const recordings = require('../../fixtures/objective-missing-cards.json');

// Assistant replies from the Windows Pi screenshot report: six deliberate empty
// Astra batches, a valid Astra batch, and the working Claude batch. No credentials
// or native-session envelopes are retained in the fixture.
for (const provider of ['claude', 'codex', 'gemini', 'pi']) {
  test(`objectiveMissingCards: recorded replies survive ${provider} extraction`, () => {
    for (const [index, recording] of recordings.entries()) {
      const frames = [];
      const session = { type: 'objective', messages: [{ role: 'assistant' }],
        turnBuffer: recording.content, _startStatusName: 'pending',
        _proposalContext: { tasks: new Map() },
        ws: { OPEN: 1, readyState: 1, send: raw => frames.push(JSON.parse(raw)) } };
      let extract;
      if (provider === 'claude') extract = () => tryEmitTaskCards(session);
      else {
        const source = fs.readFileSync(path.join(__dirname, 'providers', `${provider}-session.js`), 'utf8');
        const start = source.indexOf('function extractCards(');
        const env = { normalizeProposals, session, emit: frame => frames.push(frame) };
        vm.createContext(env);
        vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), env);
        extract = () => env.extractCards(session, env.emit);
      }
      const result = extract();
      assert.equal(result.proposalResult.status, index < 6 ? 'empty' : 'cards');
      assert.equal(result.cards.length, index < 6 ? 0 : index === 6 ? 1 : 3);
      if (index < 6) assert.match(result.proposalResult.reason, /TPT9036|Pi|Screenshot/);
      extract();
      assert.equal(frames.length, 1, 'identical extraction emits no duplicate card frame');
      assert.equal(frames[0].proposalResult.status, result.proposalResult.status);
      assert.equal(session.messages[0].proposalResult.status, result.proposalResult.status);
      const priorCards = session.messages[0].cards;
      session.messages.push({ role: 'user', content: 'Refine the plan' });
      session.turnBuffer = recordings[2].content;
      session._lastEmittedCardsJson = null;
      extract();
      assert.equal(session.messages[0].cards, priorCards, 'a new turn cannot overwrite a prior assistant batch');
    }
  });
}

test('objectiveMissingCards: rejected proposals differ from an intentional empty batch', () => {
  const parsed = normalizeProposals({ changes: [null, { type: 'new' },
    { type: 'modified', task: { id: 'TPT9036' } }], reason: 'Everything is fine' }, 'pending', { tasks: new Map() });
  assert.deepEqual(parsed.changes, []);
  assert.deepEqual(parsed.proposalResult, { status: 'rejected', reason: '' });
  assert.deepEqual(normalizeProposals({ changes: [] }).proposalResult, { status: 'empty', reason: '' });
  assert.equal(normalizeProposals({ reason: 'missing schema' }).proposalResult, undefined);
});

test('objectiveMissingCards: real Codex stream keeps empty results and performs no nudge', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const filename = path.join(__dirname, 'providers/codex-session.js');
  const realRequire = createRequire(filename);
  const spawned = [];
  const mocks = {
    '../codex-env': { ...realRequire('../codex-env'), buildCodexEnv: () => ({ env: {} }) },
    '../../codex-mcp-config': { buildScopedCodexMcpOverride: () => 'mcp_servers={}' },
    '../task-agent/attachments': { localizeAttachments: async ({ prompt }) => ({ prompt }) },
    '../context-manager': { shouldTrimContext: () => false },
    'node:child_process': { spawn(command, args) {
      const proc = new EventEmitter();
      proc.pid = 99000; proc.args = args;
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      proc.stdin = { write() {}, end() {} };
      spawned.push(proc);
      return proc;
    } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: id => mocks[id] || realRequire(id),
    process, Buffer, Date, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    console: { log() {}, warn() {}, error() {} },
  }, { filename });
  const frames = [];
  const session = { type: 'objective', providerType: 'codex', selectedModel: 'gpt-6-astra',
    projectPath: __dirname, tabId: 'recorded-astra', totalTokens: {}, timingMilestones: {},
    messages: [{ role: 'user', content: 'Windows Pi screenshot report' }],
    ws: { OPEN: 1, readyState: 1, send: raw => frames.push(JSON.parse(raw)) } };
  module.exports.spawnCodexTurn(session, 'recorded-astra');
  await new Promise(resolve => setImmediate(resolve));
  const proc = spawned[0];
  assert.equal(proc.args[proc.args.indexOf('-m') + 1], 'gpt-6-astra');
  assert.equal(proc.args[proc.args.indexOf('-s') + 1], 'read-only');
  proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: {
    type: 'agent_message', text: recordings[2].content,
  } }) + '\n'));
  proc.emit('close', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawned.length, 1);
  const result = frames.find(frame => frame.type === 'objective-result');
  assert.equal(result.proposalResult.status, 'empty');
  assert.match(result.proposalResult.reason, /TPT9036/);
  assert.equal(session.messages.at(-1).proposalResult.status, 'empty');
  assert.equal(frames.filter(frame => frame.type === 'exit').length, 1);
});
