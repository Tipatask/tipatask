'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isAgentChatType, isAgentChatId } = require('./session-state');
const { normalizeProposals, tryEmitTaskCards } = require('./claude-session');
const { LEGACY_STATUSES, rolesFromStatuses, fetchStatusContext, isLockedTargetStatus } = require('./status-roles');
const { prepareObjectiveProposalContext, assertEditableModifiedTargets, forcePendingProposalStatuses } = require('./objective-proposal-status');

const renamed = LEGACY_STATUSES.map(row => ({ ...row, name: `custom_${row.name}` }));
const proposal = id => ({ type: 'modified', task: { id, title: 'Changed', status: 'pending' } });

for (const rows of [LEGACY_STATUSES, renamed]) {
  const roles = rolesFromStatuses(rows);
  const tasks = new Map(rows.map((row, i) => [`TPT${i}`, { id: `TPT${i}`, status: row.name }]));
  test(`normalization filters all locked workflow roles (${roles.start})`, () => {
    const changes = [...tasks.keys()].map(proposal);
    changes.push({ type: 'new', task: { id: 'TPT10', title: 'New' } });
    const result = normalizeProposals({ changes }, roles.start, { tasks, roles });
    assert.deepEqual(result.changes.map(c => c.task.id), ['TPT0', 'TPT2', 'TPT10']);
    for (const row of rows) assert.equal(isLockedTargetStatus(row.name, roles), !!(row.is_in_progress || row.is_workflow_complete || row.is_workflow_canceled));
  });

  for (const provider of ['claude', 'codex', 'gemini', 'pi']) {
    test(`${provider} emits no locked cards (${roles.start})`, () => {
      const frames = [];
      const session = {
        type: 'objective', messages: [{ role: 'assistant' }],
        turnBuffer: '```json\n' + JSON.stringify({ changes: [...tasks.keys()].map(proposal) }) + '\n```',
        _startStatusName: roles.start, _proposalContext: { tasks, roles },
        ws: { OPEN: 1, readyState: 1, send: raw => frames.push(JSON.parse(raw)) },
      };
      if (provider === 'claude') tryEmitTaskCards(session);
      else {
        const source = fs.readFileSync(path.join(__dirname, 'providers', `${provider}-session.js`), 'utf8');
        const start = source.indexOf('function extractCards(');
        const env = { normalizeProposals, session, emit: frame => frames.push(frame) };
        vm.runInNewContext(source.slice(start, source.indexOf('\n}', start) + 2) + '\nextractCards(session, emit);', env);
      }
      assert.equal(frames.length, 1);
      assert.deepEqual(Array.from(frames[0].cards, c => c.task.id), ['TPT0', 'TPT2']);
    });
  }

  for (const status of [roles.in_progress, roles.complete, roles.canceled]) {
    test(`crafted finalize rejects entire batch for ${status}`, async () => {
      const source = fs.readFileSync(path.join(__dirname, 'ws-handlers.js'), 'utf8');
      const start = source.indexOf('function wireClient(');
      const handlers = {}, frames = [];
      let writes = 0;
      const backend = {
        getStatuses: async () => rows,
        getTask: async id => ({ id, status }),
        finalizeChanges: async () => { writes++; },
      };
      const ws = { OPEN: 1, readyState: 1, on: (key, fn) => { handlers[key] = fn; }, send: raw => frames.push(JSON.parse(raw)) };
      const session = { type: 'objective', ws, messages: [] };
      const env = { console, config: {}, isAgentChatType, isAgentChatId, wireSessionLifecycle() {}, getTaskAgentInfo: () => ({}), configForProject: () => ({}),
        listVisibleObjectiveProviders: () => [], _agentLabels: () => ({}), getAvailableAgentsPeek: () => [], listTaskAgentStatusesPeek: () => [], fetchStatusContext, assertEditableModifiedTargets,
        forcePendingProposalStatuses, clearTimeout, dropObjectiveSession() {} };
      vm.createContext(env);
      vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), env);
      env.wireClient(ws, session, 'objective', 'objective', new Map(), backend);
      await handlers.message(JSON.stringify({ type: 'finalize', changes: [{ type: 'new', task: { id: 'TPT9' } }, proposal('TPT1')] }));
      assert.equal(writes, 0);
      assert.match(frames.at(-1).message, /status .* is locked/);
    });
  }
}

test('snapshot refresh is unfiltered and failed refresh suppresses modifications', async () => {
  const session = { backend: { getStatuses: async () => renamed, getTasksUnfiltered: async () => [{ id: 'TPT1', status: 'custom_in_progress' }] } };
  await prepareObjectiveProposalContext(session);
  assert.equal(session._proposalContext.tasks.get('TPT1').status, 'custom_in_progress');
  session.backend.getTasksUnfiltered = async () => { throw new Error('offline'); };
  await prepareObjectiveProposalContext(session);
  assert.equal(session._proposalContext.tasks, null);
  assert.deepEqual(normalizeProposals({ changes: [proposal('TPT1')] }, 'pending', session._proposalContext).changes, []);
});

test('finalize target check allows eligible tasks and refuses unverifiable targets', async () => {
  const roles = rolesFromStatuses(renamed);
  await assertEditableModifiedTargets([proposal('TPT1')], { getTask: async () => ({ status: roles.start }) }, roles);
  await assert.rejects(assertEditableModifiedTargets([proposal('TPT1')], { getTask: async () => null }, roles), /Cannot verify/);
  await assert.rejects(assertEditableModifiedTargets([proposal('TPT1')], { getTask: async () => { throw new Error('offline'); } }, roles), /offline/);
});
