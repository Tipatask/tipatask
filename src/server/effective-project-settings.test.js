'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-effective-settings-'));
process.env.TIPATASK_USER_DATA = path.join(temp, 'data');
process.env.TIPATASK_PROJECT_ROOT = path.join(temp, 'startup');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const { createApiBackend } = require('./api-backend');
const { initializeProjectSettings } = require('../cli/setup');
const { writeProjectConfig, readProjectConfig, readProjectLanguage, rendererProjectConfig, buildLanguageDirective } = require('./project-config');
const { saveAccountForServer, clearAccountToken } = require('./account-store');
const { isSyncAsYouGoEnabled } = require('../cli/knowledge-sync');

const defaults = { language: 'uk', color_scheme: 'rose', task_group_label: 'Steps',
  sprints_enabled: 1, kb_sync_as_you_go: 1, use_objective_grouping: 1, sprint_sort_order: 'asc', agent_permission_mode: null,
  vcs_type: 'git', vcs_worktree_enabled: 0, vcs_commit_enabled: 1, vcs_pr_enabled: 0, vcs_merge_enabled: 0 };
const token = id => `header.${Buffer.from(JSON.stringify({ id })).toString('base64url')}.signature`;

async function fixture(t) {
  const state = { global: { '10': { ...defaults }, '11': { ...defaults, language: 'en', color_scheme: 'paper' } },
    personal: new Map(), calls: [], fail: null, hold: null };
  const server = http.createServer(async (req, res) => {
    const userId = JSON.parse(Buffer.from(req.headers.authorization.split('.')[1], 'base64url')).id;
    const projectId = req.url.split('/')[3];
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    state.calls.push({ method: req.method, path: req.url, userId });
    if (req.url === '/api/auth/me') return json(200, { user: { id: userId } });
    if (req.url.endsWith('/tasks')) return json(200, { tasks: [] });
    const key = `${projectId}:${userId}`;
    if (userId !== 1 && !state.personal.has(key)) state.personal.set(key, { ...state.global[projectId] });
    const settings = userId === 1 ? state.global[projectId] : state.personal.get(key);
    const data = { settings: { ...settings }, source: userId === 1 ? 'global' : 'personal', is_creator: userId === 1 };
    if (state.fail) return json(state.fail, { error: 'settings rejected' });
    if (req.url.endsWith('/settings')) {
      if (req.method === 'PATCH') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const patch = JSON.parse(body);
        Object.assign(settings, patch);
        data.settings = { ...settings };
      }
      const hold = state.hold;
      if (hold) { state.hold = null; hold.started(); await hold.wait; }
      return json(200, data);
    }
    json(200, { project: { id: Number(projectId), name: 'Project', task_prefix: 'TST', ...state.global[projectId] } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = fs.mkdtempSync(path.join(temp, 'project-'));
  const cfg = { API_BASE_URL: baseUrl, API_PROJECT_ID: '10', TASK_BACKEND: 'api', language: 'de', theme: 'ink',
    ASSEMBLYAI_API_KEY: 'local-secret', PI_MODELS: [{ model: 'local/model', apiKey: 'provider-secret' }] };
  writeProjectConfig(root, cfg);
  const signIn = id => saveAccountForServer(baseUrl, { token: token(id), userId: id });
  signIn(1);
  const backend = createApiBackend(null, root);
  t.after(() => backend.dispose());
  return { ...state, state, root, cfg, backend, baseUrl, signIn };
}

test('setup uses creator defaults once, member edits persist across restart and later default changes', async t => {
  const f = await fixture(t);
  assert.equal(readProjectLanguage(f.root), 'en', 'unattributed checkout language is not imported');
  assert.equal((await initializeProjectSettings({ projectRoot: f.root, backend: f.backend })).source, 'global');
  f.signIn(2);
  const first = await initializeProjectSettings({ projectRoot: f.root, backend: f.backend });
  assert.deepEqual(first.settings, defaults);
  assert.equal(first.source, 'personal');
  await f.backend.saveEffectiveProjectSettings({ language: 'fr', color_scheme: 'slate', kb_sync_as_you_go: false });
  f.signIn(1);
  await f.backend.updateProject({ language: 'en', color_scheme: 'meadow' });
  assert.equal(f.state.global['10'].language, 'en');
  f.signIn(2);
  f.backend.dispose();
  const restarted = createApiBackend(null, f.root);
  t.after(() => restarted.dispose());
  const repeat = await initializeProjectSettings({ projectRoot: f.root, backend: restarted });
  assert.equal(repeat.settings.language, 'fr');
  assert.equal(repeat.settings.color_scheme, 'slate');
  assert.equal(await isSyncAsYouGoEnabled(restarted), false);
  const row = await restarted.getProjectSettings();
  assert.equal(row.language, 'fr');
  assert.equal(row.task_prefix, 'TST', 'metadata remains available beside effective preferences');
  assert.match(buildLanguageDirective(f.root), /French|fr/);
  const childLanguage = execFileSync(process.execPath, ['-e',
    `process.stdout.write(require(${JSON.stringify(path.join(__dirname, 'project-config'))}).readProjectLanguage(process.argv[1]))`, f.root], { encoding: 'utf8' });
  assert.equal(childLanguage, 'fr', 'a separate process uses the persisted account mirror');
  f.signIn(3);
  assert.equal(readProjectLanguage(f.root), 'en', 'another account cannot see the cached language');
  assert.equal((await restarted.getEffectiveProjectSettings()).settings.color_scheme, 'meadow');
  assert.equal(f.state.personal.get('10:2').color_scheme, 'slate');
  assert.equal(readProjectConfig(f.root).ASSEMBLYAI_API_KEY, 'local-secret');
  for (const file of fs.readdirSync(path.join(process.env.TIPATASK_USER_DATA, 'project-settings'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(process.env.TIPATASK_USER_DATA, 'project-settings', file), 'utf8'), /local-secret|provider-secret|signature/);
  }
});

test('cache hits follow account, API project and sign-out before returning any old settings', async t => {
  const f = await fixture(t);
  await f.backend.getEffectiveProjectSettings();
  f.signIn(2);
  await f.backend.saveEffectiveProjectSettings({ language: 'fr' });
  f.signIn(1);
  assert.equal((await f.backend.getEffectiveProjectSettings()).settings.language, 'uk');
  writeProjectConfig(f.root, { ...f.cfg, API_PROJECT_ID: '11' });
  assert.equal(readProjectLanguage(f.root), 'en');
  assert.equal((await f.backend.getEffectiveProjectSettings()).settings.color_scheme, 'paper');
  clearAccountToken(f.baseUrl);
  assert.equal(await f.backend.getEffectiveProjectSettings(), null);
  assert.equal(readProjectLanguage(f.root), 'en');
  assert.equal(rendererProjectConfig(readProjectConfig(f.root)).theme, '');
});

test('permission defaults survive settings filtering, cache persistence and unrelated saves', async t => {
  const f = await fixture(t);
  for (const mode of ['plan', 'always_ask', 'accept_edits', 'auto', 'bypass', null]) {
    assert.equal((await f.backend.updateProject({ agent_permission_mode: mode })).agent_permission_mode, mode);
    await f.backend.saveEffectiveProjectSettings({ language: 'fr' });
    assert.equal((await f.backend.getProjectSettings({ refresh: true, strict: true })).agent_permission_mode, mode);
    assert.equal(require('./project-settings-cache').readSettingsCache(f.cfg).settings.agent_permission_mode, mode);
  }
  await f.backend.updateProject({ agent_permission_mode: 'auto' });
  f.signIn(2);
  assert.equal((await f.backend.getEffectiveProjectSettings()).settings.agent_permission_mode, 'auto');
  f.signIn(1);
  await f.backend.updateProject({ agent_permission_mode: 'bypass' });
  f.signIn(2);
  assert.equal((await f.backend.getProjectSettings()).agent_permission_mode, 'auto');
  await f.backend.updateProject({ agent_permission_mode: null });
  assert.equal(f.state.global['10'].agent_permission_mode, 'bypass');
});

test('an in-flight old-account response cannot return or persist after switching accounts', async t => {
  const f = await fixture(t);
  let release;
  let started;
  const began = new Promise(resolve => { started = resolve; });
  f.state.hold = { started, wait: new Promise(resolve => { release = resolve; }) };
  const request = f.backend.getEffectiveProjectSettings({ refresh: true });
  await began;
  f.signIn(2);
  await f.backend.saveEffectiveProjectSettings({ language: 'fr' });
  release();
  await assert.rejects(request, /context changed/);
  assert.equal((await f.backend.getEffectiveProjectSettings()).settings.language, 'fr');
  assert.equal(readProjectLanguage(f.root), 'fr');
});

test('failed saves preserve persisted preferences; strict reads reject outages and auth failures', async t => {
  const f = await fixture(t);
  await f.backend.getEffectiveProjectSettings();
  f.state.fail = 400;
  await assert.rejects(f.backend.saveEffectiveProjectSettings({ language: 'fr' }), /settings rejected/);
  assert.equal(readProjectLanguage(f.root), 'uk');
  assert.equal(f.state.global['10'].language, 'uk');
  f.state.fail = 503;
  assert.equal((await f.backend.getEffectiveProjectSettings({ refresh: true })).settings.language, 'uk');
  await assert.rejects(f.backend.getEffectiveProjectSettings({ strict: true }));
  f.state.fail = 403;
  assert.equal(await f.backend.getEffectiveProjectSettings({ refresh: true }), null);
  await assert.rejects(f.backend.getProjectSettings({ strict: true }));
  await assert.rejects(f.backend.saveEffectiveProjectSettings({ API_TOKEN: 'forbidden' }), /Unknown/);
});

test('concurrent partial saves preserve both edits and later reads cannot restore pre-save responses', async t => {
  const f = await fixture(t);
  await Promise.all([
    f.backend.saveEffectiveProjectSettings({ language: 'fr' }),
    f.backend.saveEffectiveProjectSettings({ color_scheme: 'slate' }),
  ]);
  const saved = await f.backend.getEffectiveProjectSettings();
  assert.equal(saved.settings.language, 'fr');
  assert.equal(saved.settings.color_scheme, 'slate');
});

test('credential-only KB sync gate uses /settings and does not share a project cache between accounts', async t => {
  const f = await fixture(t);
  await f.backend.saveEffectiveProjectSettings({ kb_sync_as_you_go: false });
  assert.equal(await isSyncAsYouGoEnabled({ baseUrl: f.baseUrl, projectId: 10, token: token(1) }), false);
  f.signIn(2);
  await f.backend.saveEffectiveProjectSettings({ kb_sync_as_you_go: true });
  assert.equal(await isSyncAsYouGoEnabled({ baseUrl: f.baseUrl, projectId: 10, token: token(2) }), true);
});

test('a response started for another API server cannot overwrite the new server mirror', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  second.state.global['10'].language = 'fr';
  let release;
  let started;
  const began = new Promise(resolve => { started = resolve; });
  first.state.hold = { started, wait: new Promise(resolve => { release = resolve; }) };
  const pending = first.backend.getEffectiveProjectSettings();
  await began;
  writeProjectConfig(first.root, { ...first.cfg, API_BASE_URL: second.baseUrl });
  assert.equal((await first.backend.getEffectiveProjectSettings()).settings.language, 'fr');
  release();
  await assert.rejects(pending, /context changed/);
  assert.equal(readProjectLanguage(first.root), 'fr');
});

test('browser and Electron editors use the same preferences and preserve window project isolation', async t => {
  const f = await fixture(t);
  f.signIn(2);
  const otherRoot = fs.mkdtempSync(path.join(temp, 'window-'));
  writeProjectConfig(otherRoot, { ...f.cfg, API_PROJECT_ID: '11' });
  const other = createApiBackend(null, otherRoot);
  t.after(() => other.dispose());
  const states = new Map([[1, { projectPath: f.root, backend: f.backend }], [2, { projectPath: otherRoot, backend: other }]]);
  const Module = require('node:module');
  const handlers = new Map();
  const routerPath = require.resolve('../../main/ipc/api-router');
  const previous = require.cache[routerPath];
  const load = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => temp }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
    if (request === '../window-state') return { getWindowState: id => states.get(id) };
    if (request === '../../src/server/config') return { TASK_AGENT: 'claude', PORT: 4455 };
    return load.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[routerPath];
    require(routerPath).registerApiHandlers();
  } finally {
    Module._load = load;
    if (previous) require.cache[routerPath] = previous;
    else delete require.cache[routerPath];
  }
  const { createHttpHandler } = require('./ws-handlers');
  const webBackend = Object.assign(Object.create(f.backend), { reconfigureAndProbe: async () => 'connected' });
  const handler = createHttpHandler(new Map(), () => webBackend, null);
  async function web(method, url, body) {
    const req = { method, url, headers: { 'x-tipatask-project': f.root } };
    req[Symbol.asyncIterator] = async function* () { if (body) yield Buffer.from(JSON.stringify(body)); };
    let result;
    const res = { writeHead(status) { this.status = status; }, end(data) { result = JSON.parse(data); } };
    await handler(req, res);
    assert.equal(res.status, 200, JSON.stringify(result));
    return result;
  }
  const event = id => ({ sender: { id } });
  await web('PATCH', '/api/project', { language: 'fr', task_group_label: 'Jars' });
  assert.deepEqual(await web('GET', '/api/project/settings'), await handlers.get('api:project.settings')(event(1)));
  await handlers.get('api:project.update')(event(2), { fields: { language: 'de', color_scheme: 'slate' } });
  assert.equal((await handlers.get('api:project.settings')(event(2))).language, 'de');
  assert.equal((await web('GET', '/api/project/settings')).language, 'fr');
  await handlers.get('api:project.mergeConfig')(event(1), { partial: { language: 'uk', theme: 'meadow' } });
  assert.equal((await f.backend.getEffectiveProjectSettings()).settings.color_scheme, 'meadow');
  await web('POST', '/api/project-config', { language: 'fr' });
  assert.equal(readProjectLanguage(f.root), 'fr');
  const raw = JSON.parse(fs.readFileSync(path.join(f.root, '.tipatask/config.json'), 'utf8'));
  assert.equal(Object.hasOwn(raw, 'language'), false);
  assert.equal(Object.hasOwn(raw, 'theme'), false);
  assert.equal(f.state.global['10'].language, 'uk', 'member saves never change creator defaults');
  assert.equal(f.state.personal.get('11:2').language, 'de');
});
