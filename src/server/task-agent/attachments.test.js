'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// The account store defaults to USER_DATA_ROOT; keep this file's tokens in a private dir.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-attachments-userdata-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));
const config = require('../config');
const { localizeAttachments } = require('./attachments');

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withConfig(overrides, run) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-attachments-project-'));
  fs.mkdirSync(path.join(projectRoot, '.tipatask'));
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api',
    API_BASE_URL: overrides.API_BASE_URL,
    API_TOKEN: overrides.API_TOKEN,
    API_PROJECT_ID: '1',
  }));
  const original = {};
  for (const [key, value] of Object.entries(overrides)) {
    original[key] = config[key];
    config[key] = value;
  }
  try {
    return await run(projectRoot);
  } finally {
    Object.assign(config, original);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

test('localizeAttachments localizes both an image ref and a file ref in one pass, images first', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const pdf = Buffer.from('%PDF fake');
  const server = await startServer((req, res) => {
    if (req.url === '/api/projects/1/images/task/C1247') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ images: [] }));
    }
    if (req.url === '/api/projects/1/files/task/C1247') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ files: [] }));
    }
    if (req.url === '/api/projects/1/images/9') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png);
    }
    if (req.url === '/api/projects/1/files/45') {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="spec.pdf"' });
      return res.end(pdf);
    }
    res.writeHead(404);
    res.end();
  });

  try {
    await withConfig({ API_BASE_URL: server.baseUrl, API_TOKEN: 'test-token' }, async (projectRoot) => {
      const prompt = '![screenshot](/api/projects/1/images/9)\n\nSee [spec.pdf](/api/projects/1/files/45).';
      const result = await localizeAttachments({ taskId: 'C1247', prompt, taskCommentsBlock: '', projectRoot });

      // Image rewrite happened.
      assert.match(result.prompt, /screenshot: @.+\.png/);
      // File rewrite happened, and the image rewrite's @<path> did NOT get swept up by the
      // file pass (it has no [name](url) shape any more).
      assert.match(result.prompt, /spec\.pdf: @.+\.pdf/);
      assert.match(result.prompt, /Task file attachments \(read these before implementing\):/);

      const imagePath = result.prompt.match(/screenshot: @(\S+\.png)/)[1];
      const filePath = result.prompt.match(/spec\.pdf: @(\S+\.pdf)/)[1];
      assert.strictEqual(path.dirname(imagePath), path.join(projectRoot, '.tipatask', 'images', 'C1247'));
      assert.strictEqual(path.dirname(filePath), path.join(projectRoot, '.tipatask', 'files', 'C1247'));
      assert.deepStrictEqual(fs.readFileSync(imagePath), png);
      assert.deepStrictEqual(fs.readFileSync(filePath), pdf);
    });
  } finally {
    await server.close();
  }
});

// (TPT9346) The Task Edit description's Embed control saves each reference as the upload returned
// it — an image's absolute API URL (board socket), a file's absolute (browser proxy) or relative
// (Electron IPC) API URL — on a line of its own, or mid-sentence when the editor was open; every
// upload is also linked to the task. Start hands that description to the agent through here.
test('localizeAttachments gives the agent what the Task Edit Embed control saved in a description', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const requested = [];
  const server = await startServer((req, res) => {
    requested.push(req.url);
    if (req.url === '/api/projects/1/images/task/TPT9346') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ images: [{ id: 9, url: '/api/projects/1/images/9', filename: 'x.png' }] }));
    }
    if (req.url === '/api/projects/1/files/task/TPT9346') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ files: [
        { id: 45, url: '/api/projects/1/files/45', filename: 'notes.txt' },
        { id: 47, url: '/api/projects/1/files/47', filename: 'late.txt' },
      ] }));
    }
    if (/^\/api\/projects\/1\/images\/(9|10)$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png);
    }
    const file = /^\/api\/projects\/1\/files\/(45|46|47)$/.exec(req.url);
    if (file) {
      const name = { 45: 'notes.txt', 46: 'export.csv', 47: 'late.txt' }[file[1]];
      res.writeHead(200, { 'Content-Type': name.endsWith('.csv') ? 'text/csv' : 'text/plain', 'Content-Disposition': `attachment; filename="${name}"` });
      return res.end(`contents of ${name}`);
    }
    res.writeHead(404);
    res.end();
  });

  try {
    await withConfig({ API_BASE_URL: server.baseUrl, API_TOKEN: 'test-token' }, async (projectRoot) => {
      const api = `${server.baseUrl}/api/projects/1`;
      const description = [
        `Fix the dip shown here![img](${api}/images/10) on Mondays.`,
        `![img](${api}/images/9)`,
        `[notes.txt](${api}/files/45)`,
        '[export.csv](/api/projects/1/files/46)',
      ].join('\n');
      const result = await localizeAttachments({ taskId: 'TPT9346', prompt: description, taskCommentsBlock: '', projectRoot });

      const images = [...result.prompt.matchAll(/img: @(\S+\.png)/g)].map(m => m[1]);
      assert.strictEqual(images.length, 2, result.prompt);
      for (const image of images) assert.deepStrictEqual(fs.readFileSync(image), png);
      for (const name of ['notes', 'export']) {
        const local = result.prompt.match(new RegExp(`${name}\\.(?:txt|csv): @(\\S+)`))[1];
        assert.strictEqual(path.dirname(local), path.join(projectRoot, '.tipatask', 'files', 'TPT9346'));
        assert.match(fs.readFileSync(local, 'utf8'), new RegExp(`contents of ${name}`));
      }
      assert.match(result.prompt, /^Fix the dip shown here/);
      assert.doesNotMatch(result.prompt, /\]\((?:https?:\/\/[^)]*)?\/api\/projects\/1\/(?:images|files)\/\d+\)/, 'no reference left unlocalized');
      // A file linked to the task whose link never reached the text (the modal closed mid-upload)
      // still reaches the agent through the task's attachment listing.
      const block = result.prompt.slice(result.prompt.indexOf('Task file attachments (read these before implementing):'));
      assert.match(block, /47-late\.txt/);
      assert.ok(requested.includes('/api/projects/1/files/task/TPT9346'));
    });
  } finally {
    await server.close();
  }
});

// (TPT9361) Several attachments picked at once go in back to back, and one inserted at the caret
// can sit right before more text. An agent CLI reads an `@path` up to the next whitespace, so every
// rewritten path must stay its own token.
test('localizeAttachments keeps references written back to back as separate @paths', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const server = await startServer((req, res) => {
    if (/\/(images|files)\/task\//.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(req.url.includes('/images/') ? '{"images":[]}' : '{"files":[]}');
    }
    if (/^\/api\/projects\/1\/images\/[12]$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png);
    }
    if (req.url === '/api/projects/1/files/3') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="a.txt"' });
      return res.end('notes');
    }
    res.writeHead(404);
    res.end();
  });

  try {
    await withConfig({ API_BASE_URL: server.baseUrl, API_TOKEN: 'test-token' }, async (projectRoot) => {
      const api = `${server.baseUrl}/api/projects/1`;
      const prompt = `Look![img](${api}/images/1)![img](${api}/images/2)[a.txt](${api}/files/3)tail, see![](${api}/images/2)now`;
      const result = await localizeAttachments({ taskId: 'TPT9361', prompt, taskCommentsBlock: '', projectRoot });

      const inline = result.prompt.split('\n\n')[0];
      const paths = [...inline.matchAll(/@(\S+)/g)].map(m => m[1]);
      assert.strictEqual(paths.length, 4, inline);
      for (const local of paths) assert.ok(fs.existsSync(local), `a whole path, not glued to its neighbour: ${local}`);
      assert.match(inline, /^Lookimg: @\S+\.png img: @\S+\.png a\.txt: @\S+\.txt tail, see @\S+\.png now$/);
    });
  } finally {
    await server.close();
  }
});

test('localizeAttachments is idempotent on a re-run (no duplicated file block)', async () => {
  const pdf = Buffer.from('%PDF fake');
  const server = await startServer((req, res) => {
    if (req.url === '/api/projects/1/images/task/C1247') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ images: [] }));
    }
    if (req.url === '/api/projects/1/files/task/C1247') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ files: [] }));
    }
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="spec.pdf"' });
    res.end(pdf);
  });

  try {
    await withConfig({ API_BASE_URL: server.baseUrl, API_TOKEN: 'test-token' }, async (projectRoot) => {
      const prompt = 'See [spec.pdf](/api/projects/1/files/45).';
      const once = await localizeAttachments({ taskId: 'C1247', prompt, taskCommentsBlock: '', projectRoot });
      const twice = await localizeAttachments({ taskId: 'C1247', prompt: once.prompt, taskCommentsBlock: '', projectRoot });

      const headerCount = (twice.prompt.match(/Task file attachments/g) || []).length;
      assert.strictEqual(headerCount, 1);
      assert.strictEqual(twice.prompt, once.prompt);
    });
  } finally {
    await server.close();
  }
});

// Task and project chat turns reach localizeAttachments() from each provider's spawn with the
// chat id as taskId (`projectChat:<pid>:<chatId>`, `taskChat:<key>`) — never a task key.
test('localizeAttachments localizes a project chat turn with no task key into a chat-scoped dir', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const pdf = Buffer.from('%PDF fake');
  const requested = [];
  const server = await startServer((req, res) => {
    requested.push(req.url);
    if (req.url === '/api/projects/1/images/9') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png);
    }
    if (req.url === '/api/projects/1/files/45') {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="spec.pdf"' });
      return res.end(pdf);
    }
    res.writeHead(404);
    res.end();
  });

  try {
    await withConfig({ API_BASE_URL: server.baseUrl, API_TOKEN: 'test-token' }, async (projectRoot) => {
      const chatId = 'projectChat:1:abc123';
      const prompt = `What is wrong here? ![shot](${server.baseUrl}/api/projects/1/images/9)\n\nSee [spec.pdf](${server.baseUrl}/api/projects/1/files/45).`;
      const result = await localizeAttachments({ taskId: chatId, prompt, projectRoot });

      const imagePath = result.prompt.match(/shot: @(\S+\.png)/)[1];
      const filePath = result.prompt.match(/spec\.pdf: @(\S+\.pdf)/)[1];
      assert.strictEqual(path.dirname(imagePath), path.join(projectRoot, '.tipatask', 'images', 'projectChat_1_abc123'));
      assert.strictEqual(path.dirname(filePath), path.join(projectRoot, '.tipatask', 'files', 'projectChat_1_abc123'));
      assert.deepStrictEqual(fs.readFileSync(imagePath), png);
      assert.deepStrictEqual(fs.readFileSync(filePath), pdf);
      assert.doesNotMatch(result.prompt, /\/api\/projects\/1\/(images|files)\/\d+/);
      // A chat id is not a task key: no by-task attachment listing is fetched.
      assert.ok(!requested.some(u => /\/(images|files)\/task\//.test(u)), `unexpected listing request: ${requested.join(', ')}`);
    });
  } finally {
    await server.close();
  }
});

test('localizeAttachments materializes an inline data-URI image in a task chat turn without touching the input', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const server = await startServer((req, res) => { res.writeHead(404); res.end(); });

  try {
    await withConfig({ API_BASE_URL: server.baseUrl, API_TOKEN: 'test-token' }, async (projectRoot) => {
      const content = `Describe this: ![screenshot](data:image/png;base64,${png.toString('base64')})`;
      const original = content;
      const result = await localizeAttachments({ taskId: 'taskChat:TPT1', prompt: content, projectRoot });

      const imagePath = result.prompt.match(/screenshot: @(\S+\.png)/)[1];
      assert.strictEqual(path.dirname(imagePath), path.join(projectRoot, '.tipatask', 'images', 'taskChat_TPT1'));
      assert.deepStrictEqual(fs.readFileSync(imagePath), png);
      assert.doesNotMatch(result.prompt, /data:image/);
      assert.strictEqual(content, original);
    });
  } finally {
    await server.close();
  }
});
