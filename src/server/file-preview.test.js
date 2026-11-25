'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { resolvePreviewPath, readFilePreview } = require('./file-preview');

const MiB = 1024 * 1024;
const doc = 'ai/architecture/notes.md';
const markdown = '# Notes\n\nУкраїнський текст.\n';
let scratch, project, other;

async function write(root, relPath, data) {
  const target = path.join(root, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-file-preview-'));
  project = path.join(scratch, 'project');
  other = path.join(scratch, 'project-two');
  await write(project, doc, markdown);
  await write(other, doc, '# Other project');
});

after(async () => { if (scratch) await fs.rm(scratch, { recursive: true, force: true }); });

test('resolves a project-relative link and previews the regular file it names', async () => {
  await fs.symlink(path.join(project, doc), path.join(project, 'notes-link'), 'file');
  assert.equal(await resolvePreviewPath(project, 'notes-link'), await fs.realpath(path.join(project, doc)));
  assert.deepEqual(await readFilePreview(project, 'notes-link'), {
    path: 'notes-link', size: Buffer.byteLength(markdown), truncated: false,
    kind: 'markdown', mime: 'text/markdown', content: markdown,
  });
});

test('rejects traversal, absolute paths, protected names, and symlinks to forbidden files', async () => {
  await write(project, 'config/.env.local', 'fixture');
  await fs.symlink(path.join(project, 'config/.env.local'), path.join(project, 'env-link'), 'file');
  await fs.symlink(other, path.join(project, 'other'), 'dir');
  for (const forbidden of [
    '../project-two/' + doc, path.join(project, doc), 'C:\\dir\\file', '..\\file',
    'other/' + doc, '.env', 'config/.env.local', 'env-link', 'nested/.Git/config',
    '.tipatask/config.json', '.tipatask-account.json', '.codex/auth.json',
  ]) {
    await assert.rejects(readFilePreview(project, forbidden), { statusCode: 403, code: 'PREVIEW_FORBIDDEN' }, forbidden);
  }
  for (const invalid of [null, '', 'bad\0name']) {
    await assert.rejects(readFilePreview(project, invalid), { statusCode: 400, code: 'PREVIEW_INVALID_PATH' });
  }
  for (const absent of ['missing', '.', 'ai/architecture']) {
    await assert.rejects(readFilePreview(project, absent), { statusCode: 404, code: 'PREVIEW_NOT_FOUND' });
  }
});

test('caps text in bytes without breaking UTF-8 and returns metadata for binary data', async () => {
  const atLimit = 'a'.repeat(MiB);
  await write(project, 'Makefile', atLimit);
  assert.deepEqual(await readFilePreview(project, 'Makefile'), {
    path: 'Makefile', kind: 'text', mime: 'text/plain', size: MiB, truncated: false, content: atLimit,
  });
  const prefix = atLimit.slice(1);
  await write(project, 'larger.md', prefix + '界');
  assert.deepEqual(await readFilePreview(project, 'larger.md'), {
    path: 'larger.md', kind: 'markdown', mime: 'text/markdown', size: MiB + 2, truncated: true, content: prefix,
  });
  for (const bytes of [Buffer.from([10, 0, 65]), Buffer.from([65, 255])]) {
    await write(project, 'data.bin', bytes);
    assert.deepEqual(await readFilePreview(project, 'data.bin'), {
      path: 'data.bin', kind: 'binary', mime: 'application/octet-stream', size: bytes.length, truncated: false, content: null,
    });
  }
});

test('returns base64 image and PDF content and enforces the inclusive media limit', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZUAAAAASUVORK5CYII=', 'base64');
  for (const [name, kind, mime, data] of [
    ['pixel.PNG', 'image', 'image/png', png],
    ['sample.pdf', 'pdf', 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n')],
  ]) {
    await write(project, name, data);
    assert.deepEqual(await readFilePreview(project, name), {
      path: name, kind, mime, size: data.length, truncated: false, content: data.toString('base64'),
    });
    const file = path.join(project, name);
    await fs.truncate(file, 10 * MiB);
    const atLimit = await readFilePreview(project, name);
    assert.equal(atLimit.content.length, Math.ceil(10 * MiB / 3) * 4);
    assert.equal(atLimit.truncated, false);
    await fs.truncate(file, 10 * MiB + 1);
    await assert.rejects(readFilePreview(project, name), { statusCode: 413, code: 'PREVIEW_TOO_LARGE' });
  }
});

test('GET file-preview uses the authenticated window checkout and returns uncached JSON with coded errors', async t => {
  process.env.TIPATASK_PROJECT_ROOT = project;
  process.env.TIPATASK_USER_DATA = scratch;
  const { createHttpHandler } = require('./ws-handlers');
  const { createLocalAccess, stampElectronRequest } = require('./local-access');
  const handler = createHttpHandler(new Map(), () => ({}));
  const secret = 'test-window-secret';
  let access;
  const server = http.createServer((req, res) => access.guardHttp(req, res, handler));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  access = createLocalAccess({ port, electron: true, secret });
  const route = 'http://127.0.0.1:' + port + '/api/project/file-preview';
  function get(relative, projectPath = project, options = {}) {
    const url = new URL(route);
    if (relative !== undefined) url.searchParams.set('path', relative);
    const headers = stampElectronRequest({}, { projectPath, requestUrl: url.href, port, secret, knownWindow: true });
    return fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  }

  for (const [root, content] of [[project, markdown], [other, '# Other project']]) {
    const res = await get(doc, root);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.match(res.headers.get('Content-Type'), /application\/json/);
    assert.deepEqual(await res.json(), {
      path: doc, size: Buffer.byteLength(content), truncated: false, kind: 'markdown', mime: 'text/markdown', content,
    });
  }
  await write(project, 'over.pdf', 'fixture');
  await fs.truncate(path.join(project, 'over.pdf'), 10 * MiB + 1);
  for (const [relative, status, code] of [
    [undefined, 400, 'PREVIEW_INVALID_PATH'], ['../project-two/' + doc, 403, 'PREVIEW_FORBIDDEN'],
    ['absent', 404, 'PREVIEW_NOT_FOUND'], ['over.pdf', 413, 'PREVIEW_TOO_LARGE'],
  ]) {
    const res = await get(relative);
    assert.equal(res.status, status);
    const body = await res.json();
    assert.equal(body.code, code);
    assert.ok(!JSON.stringify(body).includes(scratch));
  }
  assert.equal((await fetch(route)).status, 401);
  assert.equal((await get(doc, '')).status, 403);
  assert.equal((await get(doc, project, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await get(doc, project, { method: 'POST' })).status, 404);
});
