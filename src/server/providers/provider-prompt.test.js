'use strict';

const { test, mock, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-provider-prompt-data-'));
after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));
const { EventEmitter } = require('node:events');

// Intercept the actual spawn boundary before adapters capture child_process.spawn.
// Prompt selection, argument builders, and stdin writes remain production code.
let capture;
mock.method(require('node:child_process'), 'spawn', (command, args, options) => {
  assert.ok(capture, 'unexpected process launch outside a delivery fixture');
  capture.calls.push({ command, args, options });
  return capture.proc;
});
mock.method(require('../codex-env'), 'buildCodexEnv', () => ({ env: {} }));
mock.method(require('../../codex-mcp-config'), 'buildScopedCodexMcpOverride', () => 'mcp_servers={}');
mock.method(require('../task-agent/attachments'), 'localizeAttachments', async ({ prompt }) => ({ prompt }));

const config = require('../config');
const { createSession } = require('../session-state');
const { getStaticBundle } = require('../static-context');
const { buildLanguageDirective } = require('../project-config');
const { spawnObjectiveTurn, applyRehashIntent } = require('../claude-session');
const { spawnCodexTurn } = require('./codex-session');
const { spawnGeminiTurn } = require('./gemini-session');
const { spawnPiTurn } = require('./pi-session');
after(() => mock.restoreAll());

const providers = { claude: spawnObjectiveTurn, codex: spawnCodexTurn, gemini: spawnGeminiTurn, pi: spawnPiTurn };
const objective = 'OBJECTIVE_UNIQUE ship attachments';
const prefetch = '## Pre-fetched Workflow Data\n### list_task_id_meta\n```json\n{"active":[],"priorityBaseline":42,"marker":"TASK_META_UNIQUE"}\n```\n### get_project_tags\nTAGS_UNIQUE\n### Architecture\nARCH_UNIQUE';
const systemMarkers = ['Communicate with the user in Ukrainian.', 'GENERAL_UNIQUE', 'CONVENTIONS_UNIQUE', 'READ-ONLY PLANNER'];
const prefetchMarkers = ['TASK_META_UNIQUE', 'TAGS_UNIQUE', 'ARCH_UNIQUE'];

function occurrences(text, marker, expected = 1) {
  assert.equal(text.split(marker).length - 1, expected, `${marker}: expected ${expected} delivery occurrence(s)`);
}

function systemArgument(args) {
  const index = args.indexOf('--append-system-prompt');
  return index < 0 ? '' : args[index + 1];
}

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-provider-prompt-'));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.mkdirSync(path.join(root, 'ai/architecture'), { recursive: true });
  fs.writeFileSync(path.join(root, '.tipatask/config.json'), JSON.stringify({ language: 'uk', PI_MODELS: [{ model: 'openrouter/fixture', apiKey: 'fixture' }] }));
  fs.writeFileSync(path.join(root, 'ai/architecture/GENERAL.md'), 'GENERAL_UNIQUE');
  fs.writeFileSync(path.join(root, 'ai/CONVENTIONS.md'), 'CONVENTIONS_UNIQUE');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function deliver(t, id, state, { missingFirst = false, simple = false, origin = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const previous = { SIMPLE_MODE: config.SIMPLE_MODE, OBJECTIVE_PREWARM_ENABLED: config.OBJECTIVE_PREWARM_ENABLED };
  config.SIMPLE_MODE = simple;
  config.OBJECTIVE_PREWARM_ENABLED = false;
  t.after(() => { Object.assign(config, previous); capture = null; });
  const root = project(t);
  const { buildObjectivePrompt } = await import('../../client/utils.js');
  const planner = buildObjectivePrompt(objective, null, null, { originTaskKey: origin ? 'TPT999' : null, groupingEnabled: false });
  const session = createSession(null, null, 'fixture-tab', root);
  Object.assign(session, {
    type: 'objective', projectPath: root, providerType: id,
    selectedModel: id === 'pi' ? 'openrouter/fixture' : null,
    systemPrompt: simple ? '' : [buildLanguageDirective(root, { objective: true }), planner.systemPrompt, getStaticBundle(root)].join('\n\n'),
    firstPrompt: missingFirst ? null : simple ? objective : `${prefetch}\n\n${planner.userPrompt}`,
    messages: [{ role: 'user', content: objective }],
  });
  if (state !== 'fresh') {
    for (let n = 1; n <= 8; n++) {
      session.messages.push({ role: 'assistant', content: `REPLY_${n}_UNIQUE` }, { role: 'user', content: `ASK_${n}_UNIQUE` });
    }
    session.messages.at(-1).content = 'LATEST_ASK_UNIQUE';
    if (state === 'resume') session[`${id}SessionId`] = 'native-session';
    if (state === 'handoff') session._providerSwitchPending = true;
    if (state === 'compressed' || state === 'handoff') {
      session.compressedThrough = 1;
      session.compressedSummaries = [{ turn: 1, decision: 'SUMMARY_UNIQUE' }];
    }
  }
  if (!simple) {
    session.backend = { async getTask() { return { id: 'TPT999', title: 'REHASH_UNIQUE', description: 'Scope for decomposition' }; } };
    // Add real Rehash rules without invalidating the state the fixture is exercising.
    await applyRehashIntent(session, { rehashIntent: 'split', taskKey: 'TPT999' }, 'prompt-fixture');
    session._providerSwitchPending = state === 'handoff';
    if (state === 'resume') session[`${id}SessionId`] = 'native-session';
  }
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 0;
  proc.killed = true;
  let stdin = '';
  let ended = false;
  proc.stdin = { write(text) { stdin += text; }, end() { ended = true; } };
  capture = { proc, calls: [] };
  providers[id](session, 'prompt-fixture');
  // Attachment localization yields before writing stdin (and before spawning Codex).
  for (let i = 0; i < 10 && !ended; i++) await Promise.resolve();
  assert.ok(ended, `${id}: final stdin must be closed`);
  assert.equal(capture.calls.length, 1, `${id}: one spawn`);
  const { args, options } = capture.calls[0];
  assert.equal(options.cwd, root);
  const system = systemArgument(args);
  return { stdin, system, args, delivered: [system, stdin].join('\n'), session };
}

for (const id of Object.keys(providers)) {
  for (const state of ['fresh', 'resume', 'handoff', 'compressed']) {
    test(`${id} spawn: ${state} delivers applicable context once across stdin and system args`, async (t) => {
      const result = await deliver(t, id, state);
      const { stdin, system, args, delivered } = result;
      const resumed = state === 'resume';
      for (const marker of [...systemMarkers, 'REHASH_UNIQUE']) occurrences(delivered, marker, resumed && id !== 'claude' ? 0 : 1);
      for (const marker of [...prefetchMarkers, objective]) occurrences(delivered, marker, resumed ? 0 : 1);
      occurrences(delivered, 'SUMMARY_UNIQUE', ['handoff', 'compressed'].includes(state) ? 1 : 0);
      if (state !== 'fresh') {
        occurrences(stdin, 'LATEST_ASK_UNIQUE');
        assert.ok(stdin.endsWith('LATEST_ASK_UNIQUE'), 'latest ask stays last');
      }
      occurrences(stdin, 'Priority baseline (list_task_id_meta): 42.');
      if (resumed) assert.equal(stdin.split('\n\n').at(-1), 'LATEST_ASK_UNIQUE');
      if (state === 'handoff' || state === 'compressed') {
        occurrences(stdin, 'REPLY_1_UNIQUE', 0);
        occurrences(stdin, 'REPLY_8_UNIQUE');
        occurrences(stdin, 'ASK_7_UNIQUE');
        occurrences(stdin, 'REPLY_2_UNIQUE', state === 'handoff' ? 1 : 0);
      }
      if (id === 'claude') {
        assert.ok(system.includes('fenced ```json block ONLY'));
        assert.ok(system.includes('ORIGIN-LINKED PLANNING'));
        assert.doesNotMatch(stdin, /READ-ONLY PLANNER|GENERAL_UNIQUE/);
        assert.ok(args.includes('--allowedTools') && args.includes('--disallowedTools'));
      } else {
        assert.equal(system, '');
        if (!resumed) assert.ok(stdin.includes('fenced ```json block ONLY') && stdin.includes('ORIGIN-LINKED PLANNING'));
      }
      if (id === 'codex') {
        occurrences(stdin, 'Never call create_task, update_task, delete_task', resumed ? 0 : 1);
        if (!resumed) {
          assert.equal(args[args.indexOf('-s') + 1], 'read-only');
          assert.match(stdin, /reserve_task_keys is the one exception/);
        } else assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'native-session']);
      }
      if (id === 'pi') assert.equal(args[args.indexOf('--tools') + 1], 'read');
      if (id === 'gemini') { assert.ok(!args.includes('--yolo')); assert.ok(args.includes('--approval-mode')); }
    });
  }

  test(`${id} spawn: missing firstPrompt falls back to visible objective without inventing prefetch`, async (t) => {
    const { delivered } = await deliver(t, id, 'fresh', { missingFirst: true, origin: false });
    occurrences(delivered, objective);
    for (const marker of prefetchMarkers) occurrences(delivered, marker, 0);
    assert.match(delivered, /grouping turned OFF/);
  });

  test(`${id} spawn: SIMPLE_MODE excludes planner and static bundles`, async (t) => {
    const { delivered } = await deliver(t, id, 'fresh', { simple: true });
    occurrences(delivered, objective);
    for (const marker of [...systemMarkers, ...prefetchMarkers, 'REHASH_UNIQUE']) occurrences(delivered, marker, 0);
  });
}

test('delivery checks reject dropped prefetch and duplicated context across channels', async (t) => {
  const { delivered, stdin, system } = await deliver(t, 'claude', 'fresh');
  const verify = text => {
    for (const marker of [...prefetchMarkers, ...systemMarkers, objective]) occurrences(text, marker);
  };
  verify(delivered);
  assert.throws(() => verify(delivered.replace(prefetch, '')), /TASK_META_UNIQUE/);
  assert.throws(() => verify(`${system}\n${stdin}\n${system}`), /expected 1 delivery occurrence/);
  assert.throws(() => verify(`${delivered}\n${prefetch}`), /TASK_META_UNIQUE/);
});
