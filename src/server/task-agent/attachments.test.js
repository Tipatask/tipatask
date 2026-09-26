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
