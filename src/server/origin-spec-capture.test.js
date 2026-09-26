'use strict';

// TPT29: origin-spec-capture.js — the C1559 single-task-adoption description/title
// capture hooked into api-backend.js's updateTask(). See
// ai/architecture/tt-objective-chat-prompt-builder.md § Original Objective Comment.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const {
  isObjectiveClearingPatch,
  readOriginSpecSnapshot,
  postOriginSpecComment,
} = require('./origin-spec-capture');

// ── isObjectiveClearingPatch ──

test('isObjectiveClearingPatch: camelCase isObjective:false + description -> true', () => {
  assert.strictEqual(isObjectiveClearingPatch({ isObjective: false, description: 'x' }), true);
});

test('isObjectiveClearingPatch: snake_case is_objective:false + description -> true (Electron IPC shape)', () => {
  assert.strictEqual(isObjectiveClearingPatch({ is_objective: false, description: 'x' }), true);
});

test('isObjectiveClearingPatch: isObjective:false with no description -> false', () => {
  assert.strictEqual(isObjectiveClearingPatch({ isObjective: false }), false);
});

test('isObjectiveClearingPatch: isObjective:true -> false', () => {
  assert.strictEqual(isObjectiveClearingPatch({ isObjective: true, description: 'x' }), false);
});

test('isObjectiveClearingPatch: bare description, no flag at all -> false (ordinary edit-modal write)', () => {
  assert.strictEqual(isObjectiveClearingPatch({ description: 'x' }), false);
});

test('isObjectiveClearingPatch: conflicting spellings -> camelCase wins', () => {
  assert.strictEqual(isObjectiveClearingPatch({ isObjective: false, is_objective: true, description: 'x' }), true);
  assert.strictEqual(isObjectiveClearingPatch({ isObjective: true, is_objective: false, description: 'x' }), false);
});

test('isObjectiveClearingPatch: non-string / null / missing description -> false', () => {
  assert.strictEqual(isObjectiveClearingPatch({ isObjective: false, description: null }), false);
  assert.strictEqual(isObjectiveClearingPatch(null), false);
  assert.strictEqual(isObjectiveClearingPatch({}), false);
});

// ── readOriginSpecSnapshot ──

function makeBackend(overrides) {
  const calls = [];
  const backend = {
    async getTask(id) { calls.push(['getTask', id]); return overrides.task; },
    async getTaskComments(id) {
      calls.push(['getTaskComments', id]);
      if (overrides.getTaskCommentsThrows) throw new Error('boom');
      return overrides.comments;
    },
    async listTaskImages(id) {
      calls.push(['listTaskImages', id]);
      if (overrides.listImagesThrows) throw new Error('boom');
      return overrides.images || [];
    },
    async listTaskFiles(id) {
      calls.push(['listTaskFiles', id]);
      if (overrides.listFilesThrows) throw new Error('boom');
      return overrides.files || [];
    },
  };
  return { backend, calls };
}

test('readOriginSpecSnapshot: happy path returns full snapshot', async () => {
  const { backend } = makeBackend({
    task: { isObjective: true, title: 'Original title', description: 'Original text' },
    comments: [],
    images: [{ id: 1, url: '/api/projects/1/images/1', filename: 'a.png' }],
    files: [],
  });
  const snap = await readOriginSpecSnapshot(backend, 'C1', { isObjective: false, title: 'Refined', description: 'Refined text' });
  assert.ok(snap);
  assert.strictEqual(snap.title, 'Original title');
  assert.strictEqual(snap.description, 'Original text');
  assert.strictEqual(snap.titleChanged, true);
  assert.strictEqual(snap.images.length, 1);
  assert.strictEqual(snap.files.length, 0);
});

test('readOriginSpecSnapshot: live row not an objective (overwriteRaw carried-over-task case) -> null, no further reads', async () => {
  const { backend, calls } = makeBackend({
    task: { isObjective: false, title: 'T', description: 'D' },
  });
  const snap = await readOriginSpecSnapshot(backend, 'C1', { isObjective: false, description: 'D' });
  assert.strictEqual(snap, null);
  assert.ok(!calls.some(c => c[0] === 'getTaskComments'), 'getTaskComments must not be called on the cheap-bail path');
});

test('readOriginSpecSnapshot: getTask returns null -> null', async () => {
  const { backend } = makeBackend({ task: null });
  const snap = await readOriginSpecSnapshot(backend, 'C1', { isObjective: false, description: 'D' });
  assert.strictEqual(snap, null);
});

test('readOriginSpecSnapshot: getTask throws -> null, never escapes', async () => {
  const backend = { async getTask() { throw new Error('network'); } };
  const snap = await readOriginSpecSnapshot(backend, 'C1', { isObjective: false, description: 'D' });
  assert.strictEqual(snap, null);
});

test('readOriginSpecSnapshot: live description blank -> null', async () => {
  const { backend } = makeBackend({ task: { isObjective: true, title: 'T', description: '   ' } });
  const snap = await readOriginSpecSnapshot(backend, 'C1', { isObjective: false, description: 'D' });
  assert.strictEqual(snap, null);
});

test('readOriginSpecSnapshot: title and description both unchanged -> null (nothing lost)', async () => {
  const { backend } = makeBackend({ task: { isObjective: true, title: 'T', description: 'D' } });
  const snap = await readOriginSpecSnapshot(backend, 'C1', { isObjective: false, title: 'T', description: 'D' });
  assert.strictEqual(snap, null);
});

test('readOriginSpecSnapshot: a spec comment already exists -> null (idempotent across revision turns)', async () => {
  const { backend } = makeBackend({
    task: { isObjective: true, title: 'T', description: 'D' },
    comments: [{ comment_type: 'spec', content: 'already here' }],
  });
  const snap = await readOriginSpecSnapshot(backend, 'C1', { isObjective: false, description: 'refined' });
  assert.strictEqual(snap, null);
});

test('readOriginSpecSnapshot: only a resolution comment exists -> snapshot still returned', async () => {
  const { backend } = makeBackend({
    task: { isObjective: true, title: 'T', description: 'D' },
    comments: [{ comment_type: 'resolution', content: 'log tail' }],
  });
  const snap = await readOriginSpecSnapshot(backend, 'C1', { isObjective: false, description: 'refined' });
  assert.ok(snap);
});

test('readOriginSpecSnapshot: getTaskComments throws -> fail-open, snapshot still returned', async () => {
  const { backend } = makeBackend({
    task: { isObjective: true, title: 'T', description: 'D' },
    getTaskCommentsThrows: true,
  });
  const snap = await readOriginSpecSnapshot(backend, 'C1', { isObjective: false, description: 'refined' });
  assert.ok(snap);
});

test('readOriginSpecSnapshot: getTaskComments returns null (_notFound shape) -> snapshot still returned', async () => {
  const { backend } = makeBackend({
    task: { isObjective: true, title: 'T', description: 'D' },
    comments: null,
  });
  const snap = await readOriginSpecSnapshot(backend, 'C1', { isObjective: false, description: 'refined' });
  assert.ok(snap);
});

test('readOriginSpecSnapshot: listTaskImages/listTaskFiles throw -> snapshot returned with empty arrays', async () => {
  const { backend } = makeBackend({
    task: { isObjective: true, title: 'T', description: 'D' },
    comments: [],
    listImagesThrows: true,
    listFilesThrows: true,
  });
  const snap = await readOriginSpecSnapshot(backend, 'C1', { isObjective: false, description: 'refined' });
  assert.ok(snap);
  assert.deepStrictEqual(snap.images, []);
  assert.deepStrictEqual(snap.files, []);
});

test('readOriginSpecSnapshot: backend missing listTaskImages/listTaskFiles entirely -> snapshot returned with empty arrays', async () => {
  const snap = await readOriginSpecSnapshot(
    { async getTask() { return { isObjective: true, title: 'T', description: 'D' }; }, async getTaskComments() { return []; } },
    'C1',
    { isObjective: false, description: 'refined' }
  );
  assert.ok(snap);
  assert.deepStrictEqual(snap.images, []);
  assert.deepStrictEqual(snap.files, []);
});

test('readOriginSpecSnapshot: non-adoption write shape (bare description) never reaches getTask', async () => {
  const { backend, calls } = makeBackend({ task: { isObjective: true, title: 'T', description: 'D' } });
  const snap = await readOriginSpecSnapshot(backend, 'C1', { description: 'x' });
  assert.strictEqual(snap, null);
  assert.strictEqual(calls.length, 0);
});

// ── postOriginSpecComment ──

function makeCommentBackend(overrides = {}) {
  const posted = [];
  return {
    posted,
    backend: {
      async createTaskComment(id, content, type) {
        if (overrides.createThrows) throw new Error('boom');
        posted.push({ id, content, type });
        return overrides.commentResult === undefined ? { id: 1, content, comment_type: type } : overrides.commentResult;
      },
    },
  };
}

test('postOriginSpecComment: posts type=spec with the en header and original description', async () => {
  const { backend, posted } = makeCommentBackend();
  await postOriginSpecComment(backend, 'C1', { title: 'T', description: 'Original text', titleChanged: false, images: [], files: [] }, 'en');
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].type, 'spec');
  assert.ok(posted[0].content.startsWith('## Original Objective (reference only)'));
  assert.ok(posted[0].content.includes('Original text'));
});

test('postOriginSpecComment: titleChanged produces the "### title\\n\\ndescription" shape', async () => {
  const { backend, posted } = makeCommentBackend();
  await postOriginSpecComment(backend, 'C1', { title: 'Original title', description: 'Original text', titleChanged: true, images: [], files: [] }, 'en');
  assert.ok(posted[0].content.includes('### Original title\n\nOriginal text'));
});

test('postOriginSpecComment: lang uk produces uk header and uk attachment heading', async () => {
  const { backend, posted } = makeCommentBackend();
  await postOriginSpecComment(backend, 'C1', {
    title: 'T', description: 'Опис', titleChanged: false,
    images: [{ id: 1, url: '/api/projects/1/images/1', filename: 'a.png' }], files: [],
  }, 'uk');
  assert.ok(posted[0].content.startsWith('## Початкова ціль (лише для довідки)'));
  assert.ok(posted[0].content.includes('### Вкладення'));
});

test('postOriginSpecComment: createTaskComment returns null (task not found) -> resolves without throwing', async () => {
  const { backend } = makeCommentBackend({ commentResult: null });
  await assert.doesNotReject(() => postOriginSpecComment(backend, 'C1', { title: 'T', description: 'D', titleChanged: false, images: [], files: [] }, 'en'));
});

test('postOriginSpecComment: createTaskComment throws -> resolves without throwing', async () => {
  const { backend } = makeCommentBackend({ createThrows: true });
  await assert.doesNotReject(() => postOriginSpecComment(backend, 'C1', { title: 'T', description: 'D', titleChanged: false, images: [], files: [] }, 'en'));
});

test('postOriginSpecComment: null snapshot is a no-op', async () => {
  const { backend, posted } = makeCommentBackend();
  await postOriginSpecComment(backend, 'C1', null, 'en');
  assert.strictEqual(posted.length, 0);
});

test('postOriginSpecComment: zero orphan attachments -> no Attachments heading in the body', async () => {
  const { backend, posted } = makeCommentBackend();
  await postOriginSpecComment(backend, 'C1', { title: 'T', description: 'D', titleChanged: false, images: [], files: [] }, 'en');
  assert.ok(!posted[0].content.includes('### Attachments'));
});

// ── Source-scan regression guards (house style: objective-origin-wiring.test.js) ──
// These can't be exercised through a plain stub — they guard the WIRING in
// api-backend.js itself, which silently rots without a direct source check.

const API_BACKEND_SRC = fs.readFileSync(require.resolve('./api-backend.js'), 'utf8');

// Match the CALL site specifically (`await _rawUpdateTask(id, fields)`), not the
// function definition (`async function _rawUpdateTask(id, fields) {`) which appears
// earlier in the file and would otherwise make both ordering checks vacuous.
const RAW_UPDATE_CALL = 'await _rawUpdateTask(id, fields)';

test('api-backend.js: readOriginSpecSnapshot() is called BEFORE _rawUpdateTask(id, fields) inside updateTask', () => {
  const snapshotIdx = API_BACKEND_SRC.indexOf('readOriginSpecSnapshot(');
  const rawUpdateIdx = API_BACKEND_SRC.indexOf(RAW_UPDATE_CALL);
  assert.ok(snapshotIdx > -1, 'readOriginSpecSnapshot( must be called from api-backend.js');
  assert.ok(rawUpdateIdx > -1, `${RAW_UPDATE_CALL} must exist in api-backend.js`);
  assert.ok(snapshotIdx < rawUpdateIdx, 'the snapshot must be read BEFORE the PATCH overwrites the live description');
});

test('api-backend.js: postOriginSpecComment() is called AFTER _rawUpdateTask(id, fields) inside updateTask', () => {
  const postIdx = API_BACKEND_SRC.indexOf('postOriginSpecComment(');
  const rawUpdateIdx = API_BACKEND_SRC.indexOf(RAW_UPDATE_CALL);
  assert.ok(postIdx > -1, 'postOriginSpecComment( must be called from api-backend.js');
  assert.ok(postIdx > rawUpdateIdx, 'the comment must post only AFTER the PATCH succeeds — orphan-comment guard');
});

test('api-backend.js: the snapshot call sits inside the online branch, before the offline queue fallback', () => {
  const onlineBranchIdx = API_BACKEND_SRC.indexOf('if (!_isOffline()) {');
  const snapshotIdx = API_BACKEND_SRC.indexOf('readOriginSpecSnapshot(');
  const enqueueIdx = API_BACKEND_SRC.indexOf("_enqueueMutation('update'");
  assert.ok(onlineBranchIdx > -1 && onlineBranchIdx < snapshotIdx, 'snapshot must run inside the !_isOffline() branch');
  assert.ok(snapshotIdx < enqueueIdx, 'snapshot must run before the offline-queue fallback');
});

test('api-backend.js: still contains the literal dual-spelling isObjective read that isObjectiveClearingPatch mirrors', () => {
  assert.ok(
    API_BACKEND_SRC.includes("fields.isObjective !== undefined ? fields.isObjective : fields.is_objective"),
    'a refactor of this line in _rawUpdateTask must be mirrored in origin-spec-capture.js\'s isObjectiveClearingPatch'
  );
});

test('origin-spec-capture.js reads both fields.isObjective and fields.is_objective', () => {
  const src = fs.readFileSync(require.resolve('./origin-spec-capture.js'), 'utf8');
  assert.ok(src.includes('fields.isObjective'));
  assert.ok(src.includes('fields.is_objective'));
});
