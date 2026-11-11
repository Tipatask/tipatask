'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// writeProjectConfig() routes API_TOKEN into the account store under TIPATASK_USER_DATA.
// Own user-data root: the test runner's shared one is rewritten concurrently by other files.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-safe-ipc-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));
const Module = require('node:module');
const { writeProjectConfig, readProjectConfig } = require('./project-config');
const machineIdPath = path.join(process.env.TIPATASK_USER_DATA, 'machine-id');
fs.writeFileSync(machineIdPath, 'isolated-ipc-device');
const consent = require('./remote-control-consent').createRemoteControlConsent({ machineIdPath });
const token = id => 'synthetic.' + Buffer.from(JSON.stringify({ id, exp: 4000000000 })).toString('base64url') + '.signature';

test('project settings IPC reads and save replies exclude credentials across windows', async (t) => {
  const roots = [1, 2].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'tt-safe-ipc-')));
  t.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
  for (const [i, root] of roots.entries()) {
    writeProjectConfig(root, {
      API_BASE_URL: `https://server-${i}.test`, API_TOKEN: token(i + 1), ASSEMBLYAI_API_KEY: `sentinel-voice-${i}`,
      PI_MODELS: [{ model: 'm1', apiKey: `sentinel-pi-${i}` }],
      TASK_AGENT: 'pi', AVAILABLE_AGENTS: 'pi', API_PROJECT_ID: String(i + 1),
    });
  }
  const states = new Map(roots.map((root, i) => [i + 1, { projectPath: root, config: readProjectConfig(root), backend: null }]));
  const handlers = new Map();
  const fakeElectron = { app: { getPath: () => roots[0] }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
  const configChanges = [];
  const fakeWindowState = { getWindowState: (id) => states.get(id), reconfigureWindowBackend: async () => 'connected', notifyProjectConfigChanged: root => configChanges.push(root) };
  const routerPath = require.resolve('../../main/ipc/api-router');
  const prior = require.cache[routerPath];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === '../../src/server/remote-control-consent') return consent;
    if (request === 'electron') return fakeElectron;
    if (request === '../window-state') return fakeWindowState;
    if (request === '../../src/server/config') return { TASK_AGENT: 'pi', PORT: 4455 };
    if (request === '../../src/server/reopen-closed-task') return { applyReopenToPatch() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[routerPath];
    require(routerPath).registerApiHandlers();
  } finally {
    Module._load = originalLoad;
    if (prior) require.cache[routerPath] = prior;
    else delete require.cache[routerPath];
  }
  const consentModule = require('./remote-control-consent');
  t.mock.method(consentModule, 'read', consent.read);
  t.mock.method(consentModule, 'write', consent.write);
  const event = (id) => ({ sender: { id } });
  const first = await handlers.get('api:project.config')(event(1));
  const second = await handlers.get('api:project.config')(event(2));
  assert.equal(first.config.API_PROJECT_ID, '1');
  assert.equal(second.config.API_PROJECT_ID, '2');
  for (const reply of [first, second]) {
    for (const secret of ['sentinel-token-0', 'sentinel-token-1', 'sentinel-voice-0', 'sentinel-voice-1', 'sentinel-pi-0', 'sentinel-pi-1']) {
      assert.equal(JSON.stringify(reply).includes(secret), false, `${secret} leaked from IPC read`);
    }
  }
  const selection = { taskAgent: 'pi', availableAgents: ['pi'], piModels: first.config.PI_MODELS };
  const saved = await handlers.get('api:project.saveAgents')(event(1), { selection });
  assert.equal(saved.ok, true);
  assert.equal(JSON.stringify(saved).includes('sentinel-pi-0'), false);
  assert.equal(readProjectConfig(roots[0]).PI_MODELS[0].apiKey, 'sentinel-pi-0');
  assert.equal(readProjectConfig(roots[1]).PI_MODELS[0].apiKey, 'sentinel-pi-1');
  await handlers.get('api:project.mergeConfig')(event(1), { partial: { assemblyaiKey: { action: 'clear' } } });
  assert.equal(readProjectConfig(roots[0]).ASSEMBLYAI_API_KEY, '');
  assert.equal(readProjectConfig(roots[1]).ASSEMBLYAI_API_KEY, 'sentinel-voice-1');
  let context = first.remoteControl.context;
  for (const enabled of [true, false]) {
    const result = await handlers.get('api:project.setRemoteControl')(event(1), { enabled, context, expectedProjectPath: roots[0] });
    context = result.remoteControl.context;
    assert.equal(readProjectConfig(roots[0]).REMOTE_CONTROL_ENABLED, undefined);
    assert.equal((await handlers.get('api:project.config')(event(1))).remoteControl.enabled, enabled);
    assert.equal((await handlers.get('api:project.config')(event(2))).remoteControl.enabled, false);
  }
  assert.deepEqual(configChanges, [roots[0], roots[0]]);
  assert.throws(() => handlers.get('api:project.setRemoteControl')(event(2), { enabled: true, context, expectedProjectPath: roots[0] }), /Project changed/);
  assert.throws(() => handlers.get('api:project.setRemoteControl')(event(1), { enabled: 'true', context, expectedProjectPath: roots[0] }), /must be a boolean/);
  await assert.rejects(handlers.get('api:project.mergeConfig')(event(1), { partial: { REMOTE_CONTROL_ENABLED: true } }), /local desktop consent/);
  require('./account-store').saveAccountForServer('https://server-0.test', { token: token(9) });
  assert.throws(() => handlers.get('api:project.setRemoteControl')(event(1), { enabled: true, context, expectedProjectPath: roots[0] }), /context changed/);
  assert.equal(consent.read(roots[0]).enabled, false);
});
