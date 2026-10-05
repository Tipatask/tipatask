// Unit tests for setup-modal.js's pure, DOM-free exports (TPT161): the mode-specific step
// lists, the forward-navigation helper, the C1122 pi-row save filter, and the re-auth
// savedConfig builder. Back navigation is a plain history-stack pop with no domain logic,
// so it isn't tested here — see _goto()/_back() in setup-modal.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { stepsFor, nextStep, computePiSaveRows, buildReauthConfig } = await import('./setup-modal.js');

test('stepsFor: setup mode includes the device step, reauth never does', () => {
  assert.deepEqual(stepsFor('setup'), ['signin', 'project', 'device', 'agent', 'confirm']);
  assert.deepEqual(stepsFor('reauth'), ['signin', 'project', 'agent', 'confirm']);
  assert.ok(!stepsFor('reauth').includes('device'));
  // No step list anywhere carries an API-URL step (TPT161's whole point).
  assert.ok(!stepsFor('setup').some(s => /api/i.test(s)));
  assert.ok(!stepsFor('reauth').some(s => /api/i.test(s)));
});

test('nextStep: setup walks signin -> project -> device -> agent -> confirm', () => {
  assert.equal(nextStep('setup', 'signin'), 'project');
  assert.equal(nextStep('setup', 'project'), 'device');
  assert.equal(nextStep('setup', 'device'), 'agent');
  assert.equal(nextStep('setup', 'agent'), 'confirm');
});

test('nextStep: reauth skips the project picker only when a project is already known', () => {
  assert.equal(nextStep('reauth', 'signin', { skipProject: true }), 'agent');
  assert.equal(nextStep('reauth', 'signin', { skipProject: false }), 'project');
  assert.equal(nextStep('reauth', 'signin'), 'project'); // default: not skipped
  assert.equal(nextStep('reauth', 'project'), 'agent'); // never 'device'
  assert.equal(nextStep('reauth', 'agent'), 'confirm');
});

test('computePiSaveRows: a key-required row needs both model AND apiKey; trims, drops incomplete rows', () => {
  assert.deepEqual(
    computePiSaveRows([
      { model: '  a  ', apiKey: ' k ' },
      { model: '', apiKey: 'x' },
      { model: 'b', apiKey: '' },
      { model: 'c', apiKey: 'k2' },
    ]),
    // (TPT172) an OpenRouter row is SAVED with its openrouter/ prefix even when typed without it.
    [{ model: 'openrouter/a', apiKey: 'k' }, { model: 'openrouter/c', apiKey: 'k2' }],
  );
  assert.deepEqual(computePiSaveRows([]), []);
  assert.deepEqual(computePiSaveRows(undefined), []);
});

test('computePiSaveRows: a DeepSeek row keeps provider; an OpenRouter row stays {model, apiKey}', () => {
  assert.deepEqual(
    computePiSaveRows([
      { model: 'deepseek-v4-flash', apiKey: 'sk-ds', provider: 'deepseek' },
      { model: 'openrouter/x', apiKey: 'sk-or', provider: 'openrouter' },
    ]),
    [
      { model: 'deepseek-v4-flash', apiKey: 'sk-ds', provider: 'deepseek' },
      { model: 'openrouter/x', apiKey: 'sk-or' },
    ],
  );
});

test('buildReauthConfig: a DeepSeek row passes through PI_MODELS with its provider', () => {
  const piSaveRows = computePiSaveRows([{ model: 'deepseek-v4-flash', apiKey: 'sk-ds', provider: 'deepseek' }]);
  const cfg = buildReauthConfig({
    baseCfg: {},
    apiBaseUrl: 'https://web.tipatask.com',
    scopedToken: 'tok',
    selectedProject: { id: 5, name: 'Tipatask' },
    taskAgent: 'pi',
    availableAgents: ['pi'],
    piSaveRows,
  });
  assert.deepEqual(cfg.PI_MODELS, [{ model: 'deepseek-v4-flash', apiKey: 'sk-ds', provider: 'deepseek' }]);
});

test('buildReauthConfig: writes PI_MODELS and deletes the legacy flat pair when rows are present', () => {
  const cfg = buildReauthConfig({
    baseCfg: { PI_MODEL: 'old', OPENROUTER_API_KEY: 'oldkey', DEVICE_ID: '9', DEVICE_NAME: 'Mac' },
    apiBaseUrl: 'https://web.tipatask.com',
    scopedToken: 'scoped-tok',
    selectedProject: { id: 5, name: 'Tipatask' },
    taskAgent: 'claude',
    availableAgents: ['claude', 'pi'],
    piSaveRows: [{ model: 'openrouter/x', apiKey: 'sk-1' }],
  });
  assert.equal(cfg.PI_MODEL, undefined);
  assert.equal(cfg.OPENROUTER_API_KEY, undefined);
  assert.deepEqual(cfg.PI_MODELS, [{ model: 'openrouter/x', apiKey: 'sk-1' }]);
  assert.equal(cfg.API_PROJECT_ID, '5');
  assert.equal(cfg.API_TOKEN, 'scoped-tok');
  assert.equal(cfg.DEVICE_ID, '9'); // carried forward from baseCfg untouched
  assert.equal(cfg.projectName, 'Tipatask');
});

test('buildReauthConfig: never writes an empty PI_MODELS array and leaves an existing legacy pair alone', () => {
  const cfg = buildReauthConfig({
    baseCfg: { PI_MODEL: 'old', OPENROUTER_API_KEY: 'oldkey' },
    apiBaseUrl: 'https://web.tipatask.com',
    scopedToken: 'tok',
    selectedProject: { id: 5, name: 'Tipatask' },
    taskAgent: 'claude',
    availableAgents: ['claude'],
    piSaveRows: [],
  });
  assert.ok(!('PI_MODELS' in cfg));
  assert.equal(cfg.PI_MODEL, 'old');
  assert.equal(cfg.OPENROUTER_API_KEY, 'oldkey');
});

test('buildReauthConfig: falls back to baseCfg TASK_AGENT/AVAILABLE_AGENTS, then claude', () => {
  const cfg = buildReauthConfig({
    baseCfg: { TASK_AGENT: 'codex', AVAILABLE_AGENTS: 'codex' },
    apiBaseUrl: 'https://web.tipatask.com',
    scopedToken: 'tok',
    selectedProject: { id: 1, name: 'P' },
    taskAgent: '',
    availableAgents: [],
    piSaveRows: [],
  });
  assert.equal(cfg.TASK_AGENT, 'codex');
  assert.equal(cfg.AVAILABLE_AGENTS, 'codex');

  const cfgNoFallback = buildReauthConfig({
    baseCfg: {},
    apiBaseUrl: 'https://web.tipatask.com',
    scopedToken: 'tok',
    selectedProject: { id: 1, name: 'P' },
    taskAgent: '',
    availableAgents: [],
    piSaveRows: [],
  });
  assert.equal(cfgNoFallback.TASK_AGENT, 'claude');
  assert.equal(cfgNoFallback.AVAILABLE_AGENTS, 'claude');
});

test('stepsFor/nextStep: account-only mode is Sign-in then Confirm, nothing else', () => {
  assert.deepEqual(stepsFor('account'), ['signin', 'confirm']);
  assert.equal(nextStep('account', 'signin'), 'confirm');
  assert.equal(nextStep('account', 'signin', { skipProject: true }), 'confirm');
});
