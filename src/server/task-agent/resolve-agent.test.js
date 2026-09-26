'use strict';

// C1131: resolveTaskAgentId() precedence — explicit pick > project config.json LAST_AGENT
// > project config.json TASK_AGENT > global config.TASK_AGENT snapshot > 'claude'. Exists
// because session-state.js's createSession() used to seed session.taskAgent from the
// global config.TASK_AGENT unconditionally (config.js:184, a process.env-only startup
// snapshot) — wrong for any Electron project window that isn't the server's startup
// project, and blind to a project's own "last agent+model actually launched"
// (project-config.js recordLastUsedAgent()).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveTaskAgentId, getTaskAgentLabels } = require('./index');

function makeRoot(cfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-resolve-agent-'));
  fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
  if (cfg) fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  return root;
}

test('explicit id wins over everything, when it is a known agent', (t) => {
  const root = makeRoot({ LAST_AGENT: 'pi', TASK_AGENT: 'codex' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(resolveTaskAgentId(root, 'claude', { TASK_AGENT: 'codex' }), 'claude');
});

test('unknown explicit id falls through to LAST_AGENT', (t) => {
  const root = makeRoot({ LAST_AGENT: 'pi', TASK_AGENT: 'codex' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(resolveTaskAgentId(root, 'not-a-real-agent', { TASK_AGENT: 'codex' }), 'pi');
});

test('LAST_AGENT wins over TASK_AGENT when both are set', (t) => {
  const root = makeRoot({ LAST_AGENT: 'codex', TASK_AGENT: 'pi' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(resolveTaskAgentId(root, null, { TASK_AGENT: 'claude' }), 'codex');
});

test('falls through to TASK_AGENT when LAST_AGENT is absent or unknown', (t) => {
  const rootAbsent = makeRoot({ TASK_AGENT: 'pi' });
  const rootUnknown = makeRoot({ LAST_AGENT: 'not-a-real-agent', TASK_AGENT: 'pi' });
  t.after(() => { fs.rmSync(rootAbsent, { recursive: true, force: true }); fs.rmSync(rootUnknown, { recursive: true, force: true }); });
  assert.strictEqual(resolveTaskAgentId(rootAbsent, null, { TASK_AGENT: 'claude' }), 'pi');
  assert.strictEqual(resolveTaskAgentId(rootUnknown, null, { TASK_AGENT: 'claude' }), 'pi');
});

test('falls through to the global config.TASK_AGENT when the project has neither field', (t) => {
  const root = makeRoot({});
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(resolveTaskAgentId(root, null, { TASK_AGENT: 'codex' }), 'codex');
});

test('an unknown global config.TASK_AGENT falls through to "claude"', (t) => {
  const root = makeRoot({});
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(resolveTaskAgentId(root, null, { TASK_AGENT: 'not-a-real-agent' }), 'claude');
});

test('no projectRoot (browser/single-project mode) resolves straight to the global default', () => {
  assert.strictEqual(resolveTaskAgentId('', null, { TASK_AGENT: 'codex' }), 'codex');
  assert.strictEqual(resolveTaskAgentId(null, null, { TASK_AGENT: 'pi' }), 'pi');
});

test('a project with no config.json at all falls through to the global default', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-resolve-agent-unconfigured-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.strictEqual(resolveTaskAgentId(root, null, { TASK_AGENT: 'codex' }), 'codex');
});

test('registry exposes stable canonical display labels for every task agent', () => {
  const labels = getTaskAgentLabels();
  assert.deepStrictEqual(labels, {
    claude: 'Claude Code',
    codex: 'Codex',
    pi: 'Other Model',
  });
  assert.strictEqual(getTaskAgentLabels(), labels, 'label metadata should remain stable across reads');
  assert.equal(Object.isFrozen(labels), true, 'callers must not mutate registry labels');
});
