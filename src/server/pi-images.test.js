'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { sanitizePiModels, rendererPiModels, resolvePiModelWrites } = require('./project-config');
const { generatePiImages, loadPiImages, IMAGE_API } = require('./pi-image-provider');
const { decodeImage, safeFolder } = require('./image-task-store');
const { startImageTask, storeFor, resolveImageEntry } = require('./image-task');
const { IMAGE_DEFAULTS } = require('../pi-image-settings');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ZkAAAAASUVORK5CYII=';
const IMAGE = { model: 'openrouter/recraft/recraft-v3', purpose: 'image', apiKey: 'test-key', imageDefaults: IMAGE_DEFAULTS };
const imageResult = () => ({ output: [{ type: 'image', mimeType: 'image/png', data: PNG }] });

test('image config round trips through renderer edits without exposing or losing credentials', async () => {
  const stored = { PI_MODELS: sanitizePiModels([IMAGE]) };
  const dto = rendererPiModels(stored);
  assert.equal(dto[0].apiKey, undefined);
  assert.equal(dto[0].purpose, 'image');
  dto[0].imageDefaults = { aspectRatio: '16:9', count: 2, outputFolder: 'assets/images/' };
  const { normalizePiModels, computePiSaveRows } = await import(pathToFileURL(path.join(__dirname, '../client/agent-select.js')));
  const rows = computePiSaveRows(normalizePiModels({ piModels: dto }));
  const saved = resolvePiModelWrites(stored, rows);
  assert.equal(saved[0].apiKey, 'test-key');
  assert.equal(saved[0].model, IMAGE.model);
  assert.deepEqual(saved[0].imageDefaults, dto[0].imageDefaults);
  assert.throws(() => resolvePiModelWrites(stored, [{ ...dto[0], provider: 'deepseek' }]));
  assert.deepEqual(sanitizePiModels([{ model: 'plain', apiKey: 'key' }]), [{ model: 'plain', apiKey: 'key' }]);
  assert.equal(sanitizePiModels([{ model: 'old-image', provider: 'custom', baseUrl: 'https://example.test/v1', tools: false }])[0].purpose, undefined);
});

test('image defaults reject traversal, absolute paths, unsupported providers/counts/ratios', () => {
  for (const outputFolder of ['../out', '/tmp/out', 'C:\\out', '\\\\server\\out', 'a/../out', '.git/objects', '.tipatask/out']) {
    assert.throws(() => sanitizePiModels([{ ...IMAGE, imageDefaults: { outputFolder } }]), outputFolder);
  }
  assert.throws(() => sanitizePiModels([{ ...IMAGE, imageDefaults: { count: 1.5 } }]));
  assert.throws(() => sanitizePiModels([{ ...IMAGE, imageDefaults: { count: 11 } }]));
  assert.throws(() => sanitizePiModels([{ ...IMAGE, imageDefaults: { aspectRatio: 'invalid' } }]));
  assert.deepEqual(sanitizePiModels([{ ...IMAGE, provider: 'deepseek' }]), []);
});

test('real bundled Pi image collection uses the dedicated request contract with one request', async () => {
  let calls = 0;
  const result = await generatePiImages({ ...IMAGE, imageDefaults: { aspectRatio: '16:9', count: 1 } }, 'Draw a teal circle', {
    fetchFn: async (url, opts) => {
      calls++;
      assert.equal(url, IMAGE_API);
      assert.equal(opts.headers.Authorization, 'Bearer test-key');
      assert.deepEqual(JSON.parse(opts.body), { model: 'recraft/recraft-v3', prompt: 'Draw a teal circle', aspect_ratio: '16:9', n: 1 });
      assert.equal(opts.redirect, 'error');
      return Response.json({ data: [{ b64_json: PNG, media_type: 'image/png' }], usage: { cost: 0.04 } });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.output, imageResult().output);
  assert.ok((await loadPiImages()).createImagesModels);
});

test('provider failures, empty responses and cancellation never retry a paid request', async () => {
  for (const [status, code] of [[401, 'auth'], [402, 'payment'], [429, 'rate'], [503, 'provider']]) {
    let calls = 0;
    await assert.rejects(generatePiImages(IMAGE, 'prompt', { fetchFn: async () => { calls++; return new Response('', { status }); } }), { code });
    assert.equal(calls, 1);
  }
  await assert.rejects(generatePiImages(IMAGE, 'prompt', { fetchFn: async () => Response.json({ data: [] }) }), { code: 'invalid' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generatePiImages(IMAGE, 'prompt', { signal: controller.signal, fetchFn: async (_url, opts) => { opts.signal.throwIfAborted(); } }), { code: 'canceled' });
});

test('image validation sniffs MIME, rejects non-images, mismatch and active SVG', () => {
  assert.equal(decodeImage({ type: 'image', data: PNG }).mime, 'image/png');
  assert.throws(() => decodeImage({ type: 'image', data: Buffer.from('not an image').toString('base64') }));
  assert.throws(() => decodeImage({ type: 'image', data: PNG, mimeType: 'image/jpeg' }));
  assert.throws(() => decodeImage({ type: 'image', data: Buffer.from('<svg><script>bad()</script></svg>').toString('base64') }));
});

async function fixture(t) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-image-task-'));
  const userDataRoot = path.join(projectRoot, 'private-state');
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, '.tipatask'));
  await fs.writeFile(path.join(projectRoot, '.tipatask/config.json'), JSON.stringify({ PI_MODELS: [IMAGE] }));
  const task = { id: 'IMG1', title: 'Image', description: 'Draw a teal circle', status: 'pending', assignee: 1 };
  const comments = [];
  const statuses = [{ name: 'working', is_in_progress: true }, { name: 'done', is_workflow_complete: true }, { name: 'on_fire' }];
  const backend = {
    getCredentials: () => ({ baseUrl: 'https://example.test', projectId: 99, token: 'opaque-test-fixture' }),
    getConnectionState: () => 'connected',
    getProjectSettings: async () => ({ id: 99, vcs_type: null, vcs_worktree_enabled: false, vcs_commit_enabled: false, vcs_merge_enabled: false, vcs_pr_enabled: false }),
    getStatuses: async () => statuses,
    getTask: async () => ({ ...task }), getCurrentUserId: async () => 1,
    updateTask: async (_id, fields) => Object.assign(task, fields),
    getTaskComments: async () => comments,
    createTaskComment: async (_id, content, type) => comments.push({ content, type }),
    uploadImage: async () => ({ url: '/api/projects/99/images/1' }),
  };
  const frames = [];
  const session = { buffer: '', tabId: task.id, ws: { readyState: 1, OPEN: 1, send: s => frames.push(JSON.parse(s)) } };
  const args = { task, entry: IMAGE, backend, projectRoot, userDataRoot, generate: async () => imageResult() };
  return { ...args, args, session, comments, frames, store: storeFor(userDataRoot, projectRoot, task.id, backend) };
}

test('task saves unique originals, attaches previews, and completes through the real guard', async t => {
  const f = await fixture(t);
  assert.equal(resolveImageEntry(f.projectRoot, IMAGE.model, f.task).purpose, 'image');
  await startImageTask(f.session, f.args);
  await f.session._imagePromise;
  const state = await f.store.read();
  assert.equal(state.stage, 'done');
  assert.equal(f.task.status, 'done');
  assert.equal(await fs.readFile(state.files[0].path, 'base64'), PNG);
  assert.ok(state.files[0].path.startsWith(path.join(await fs.realpath(f.projectRoot), 'generated-images')));
  assert.equal(f.comments.filter(c => c.type === 'resolution').length, 1);
  assert.match(f.comments.find(c => c.type === 'resolution').content, /!\[Generated image\]/);
  assert.ok(f.frames.some(frame => frame.imageTask?.completed));
  const reconnect = { buffer: '', tabId: f.task.id };
  await startImageTask(reconnect, { ...f.args, generate: () => { throw new Error('must not generate on reconnect'); } });
  assert.equal(reconnect._imageState.completed, true);
  assert.equal(typeof reconnect._imageRetry, 'function');
});

test('failed attachment preserves originals and retries only attachment/completion', async t => {
  const f = await fixture(t);
  let generations = 0;
  f.args.generate = async () => { generations++; return imageResult(); };
  f.backend.uploadImage = async () => { throw new Error('offline'); };
  await startImageTask(f.session, f.args); await f.session._imagePromise;
  let state = await f.store.read();
  assert.equal(state.error, 'upload');
  assert.equal(f.task.status, 'on_fire');
  assert.equal(await fs.readFile(state.files[0].path, 'base64'), PNG);
  f.backend.uploadImage = async () => ({ url: '/api/projects/99/images/2' });
  await f.session._imageRetry('resume', state.runId); await f.session._imagePromise;
  state = await f.store.read();
  assert.equal(state.stage, 'done'); assert.equal(generations, 1);
});

test('cancellation, invalid output and completion blockers leave task incomplete', async t => {
  const f = await fixture(t);
  let requested;
  const ready = new Promise(resolve => { requested = resolve; });
  f.args.generate = async (_entry, _prompt, { signal }) => new Promise((_resolve, reject) => {
    requested(); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await startImageTask(f.session, f.args); await ready;
  f.session._imageAbort(); await f.session._imagePromise;
  assert.equal((await f.store.read()).stage, 'canceled');
  assert.notEqual(f.task.status, 'done');
  const state = await f.store.read();
  await startImageTask(f.session, { ...f.args, mode: 'generate', runId: state.runId, generate: async () => ({ output: [] }) });
  await f.session._imagePromise;
  assert.equal((await f.store.read()).error, 'invalid');
  const failed = await f.store.read();
  await startImageTask(f.session, { ...f.args, mode: 'generate', runId: failed.runId, generate: async () => imageResult(), complete: async () => ({ completed: false, verification: { blockers: [{ code: 'TASK_COMMIT_MISSING' }] } }) });
  await f.session._imagePromise;
  assert.equal((await f.store.read()).error, 'completion');
  assert.notEqual(f.task.status, 'done');
});

test('request interruption and concurrent starts cannot automatically generate again', async t => {
  const f = await fixture(t);
  const unlock = await f.store.lock();
  await assert.rejects(startImageTask(f.session, f.args), { code: 'busy' });
  await unlock();
  await f.store.write({ taskId: f.task.id, model: IMAGE.model, runId: crypto.randomUUID(), stage: 'requesting', files: [] });
  await startImageTask(f.session, { ...f.args, generate: () => { throw new Error('unexpected paid request'); } });
  assert.equal(f.session._imageState.error, 'interrupted');
  assert.notEqual(f.task.status, 'done');
});

test('output symlinks and existing files cannot redirect or overwrite image writes', async t => {
  const f = await fixture(t);
  const outside = path.join(f.projectRoot, 'other'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.projectRoot, 'linked'));
  await assert.rejects(safeFolder(f.projectRoot, 'linked/out'), { code: 'save' });
  await assert.rejects(safeFolder(f.projectRoot, '../escape'), { code: 'save' });
  await startImageTask(f.session, f.args); await f.session._imagePromise;
  const state = await f.store.read();
  await fs.writeFile(state.files[0].path, 'user content');
  await assert.rejects(f.store.save(state, state.files[0], f.projectRoot, 'generated-images'), { code: 'save' });
  assert.equal(await fs.readFile(state.files[0].path, 'utf8'), 'user content');
});

test('real task dispatch reaches the image runner before any coding CLI detection or PTY spawn', async t => {
  const f = await fixture(t);
  const pty = require('node-pty');
  const images = require('./image-task');
  const { getTaskAgent } = require('./task-agent');
  const { spawnTerminal } = require('./terminal-session');
  t.mock.method(getTaskAgent('pi'), 'cachedDetect', () => { throw new Error('Image tasks must not detect a text CLI'); });
  t.mock.method(pty, 'spawn', () => { throw new Error('Image tasks must not spawn a coding PTY'); });
  let dispatched;
  t.mock.method(images, 'startImageTask', async (_session, args) => { dispatched = args; });
  f.session.taskAgent = 'pi'; f.session.projectPath = f.projectRoot;
  f.backend.getEffectiveProjectSettings = async () => ({ settings: { agent_permission_mode: null } });
  await spawnTerminal(f.session, 'Coding kickoff must be ignored', f.task.id, [], { backend: f.backend, task: f.task, model: IMAGE.model });
  assert.equal(dispatched.task.description, 'Draw a teal circle');
  assert.equal(dispatched.entry.model, IMAGE.model);
  assert.equal(dispatched.prompt, undefined);
});

test('a selected image row with a missing key is refused without text fallback', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.projectRoot, '.tipatask/config.json'), JSON.stringify({ PI_MODELS: [{ ...IMAGE, apiKey: '' }, { model: 'text', apiKey: 'key' }] }));
  assert.throws(() => resolveImageEntry(f.projectRoot, IMAGE.model, f.task), { code: 'auth' });
  assert.equal(require('./pi-custom-endpoint').piTaskEntryForModel({ PI_MODELS: [{ ...IMAGE, apiKey: '' }] }, IMAGE.model).entry.purpose, 'image');
});

test('an unsafe output folder fails before a paid request', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.projectRoot, 'other'));
  await fs.symlink(path.join(f.projectRoot, 'other'), path.join(f.projectRoot, 'linked'));
  let requests = 0;
  await startImageTask(f.session, { ...f.args, entry: { ...IMAGE, imageDefaults: { outputFolder: 'linked/output' } }, generate: async () => { requests++; return imageResult(); } });
  await f.session._imagePromise;
  assert.equal(requests, 0);
  assert.equal((await f.store.read()).error, 'save');
  assert.notEqual(f.task.status, 'done');
});

test('a changed project binding cannot upload or complete results in the new project', async t => {
  const f = await fixture(t);
  let projectId = 99; let writes = 0; let uploads = 0;
  f.backend.getCredentials = () => ({ baseUrl: 'https://example.test', projectId });
  const update = f.backend.updateTask;
  f.backend.updateTask = async (...args) => { writes++; return update(...args); };
  f.backend.uploadImage = async () => { uploads++; return { url: '/api/projects/100/images/1' }; };
  await startImageTask(f.session, { ...f.args, generate: async () => { projectId = 100; return imageResult(); } });
  await f.session._imagePromise;
  assert.equal(writes, 1); assert.equal(uploads, 0);
  assert.equal((await f.store.read()).error, 'completion');
  assert.notEqual(f.task.status, 'done');
});
