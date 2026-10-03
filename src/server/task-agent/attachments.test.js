'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

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
