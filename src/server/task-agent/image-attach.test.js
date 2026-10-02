'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// The account store defaults to USER_DATA_ROOT; keep this file's tokens in a private dir.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-attach-userdata-'));
const config = require('../config');
const { localizeImageRefs } = require('./image-attach');

async function startImageServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// C1012: localizeImageRefs now always issues a GET /images/task/:taskKey listing
// call (for real-looking task ids) before downloading anything, to pick up images
// linked to the task but never inlined as markdown. Test servers below branch on
// that path so the listing gets a proper JSON response instead of falling through
// to the image-bytes handler.
function taskImageListingPath(taskKey) {
  return `/api/projects/1/images/task/${taskKey}`;
}

async function withConfig(overrides, run) {
  // Each case starts from the account it declares: a blank API_TOKEN means signed out.
  require('../account-store').clearAccountToken(overrides.API_BASE_URL);
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-image-project-'));
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

test('localizeImageRefs fetches and saves a relative internal image ref', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const requests = [];
  const imageServer = await startImageServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === taskImageListingPath('C1011')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ images: [] }));
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);
  });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-image-attach-relative-'));
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  try {
    await withConfig({
      API_BASE_URL: `${imageServer.baseUrl}/`,
      API_TOKEN: 'test-token',
      USER_DATA_ROOT: dataRoot,
    }, async (projectRoot) => {
      const result = await localizeImageRefs({
        taskId: 'C1011',
        prompt: '![x](/api/projects/1/images/45)',
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.deepStrictEqual(requests, [
        { url: taskImageListingPath('C1011'), authorization: 'Bearer test-token' },
        { url: '/api/projects/1/images/45', authorization: 'Bearer test-token' },
      ]);
      assert.match(result.prompt, /^x: @.+\.png$/);
      const localPath = result.prompt.slice('x: @'.length);
      assert.strictEqual(path.dirname(localPath), path.join(projectRoot, '.tipatask', 'images', 'C1011'));
      // C1247: images now materialize in-tree — the legacy USER_DATA_ROOT location must stay untouched.
      assert.ok(!fs.existsSync(path.join(dataRoot, '.task-images')));
      assert.deepStrictEqual(fs.readFileSync(localPath), png);
      assert.ok(
        logs.some(line => line.includes(`[image-attach] task=C1011 saved /api/projects/1/images/45 → ${localPath}`)),
        'expected saved-image log entry'
      );
    });
  } finally {
    console.log = originalLog;
    await imageServer.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('localizeImageRefs saves an SVG ref with .svg extension', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const imageServer = await startImageServer((req, res) => {
    if (req.url === taskImageListingPath('C1011')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ images: [] }));
    }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
    res.end(svg);
  });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-image-attach-svg-'));
  const logs = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    await withConfig({
      API_BASE_URL: imageServer.baseUrl,
      API_TOKEN: 'test-token',
      USER_DATA_ROOT: dataRoot,
    }, async (projectRoot) => {
      const imageUrl = `${imageServer.baseUrl}/api/projects/1/images/46`;
      const result = await localizeImageRefs({
        taskId: 'C1011',
        prompt: `![diagram](${imageUrl})`,
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.match(result.prompt, /^diagram: @.+\.svg$/);
      const localPath = result.prompt.slice('diagram: @'.length);
      assert.strictEqual(path.dirname(localPath), path.join(projectRoot, '.tipatask', 'images', 'C1011'));
      assert.deepStrictEqual(fs.readFileSync(localPath), svg);
      assert.ok(logs.some(line => line.includes(`[image-attach] task=C1011 saved ${imageUrl} → ${localPath}`)));
      assert.doesNotMatch(warnings.join('\n'), /Unsupported image MIME type/);
    });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    await imageServer.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('localizeImageRefs uses the current config.json token, not a stale snapshot (C1013)', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const requests = [];
  const imageServer = await startImageServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === taskImageListingPath('C1013')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ images: [] }));
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);
  });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-image-attach-rotate-'));

  try {
    await withConfig({
      API_BASE_URL: imageServer.baseUrl,
      API_TOKEN: 'token-A',
      USER_DATA_ROOT: dataRoot,
    }, async (projectRoot) => {
      const configPath = path.join(projectRoot, '.tipatask', 'config.json');
      const prompt = '![x](/api/projects/1/images/45)';

      await localizeImageRefs({ taskId: 'C1013', prompt, taskCommentsBlock: '', projectRoot });

      // Rotate the token in config.json only — no config-object mutation, no restart —
      // mirroring a re-auth that happens while the server keeps running.
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.API_TOKEN = 'token-B';
      fs.writeFileSync(configPath, JSON.stringify(cfg));

      await localizeImageRefs({ taskId: 'C1013', prompt, taskCommentsBlock: '', projectRoot });

      // Each call issues a listing request followed by the image fetch, both
      // authenticated with whatever token config.json holds at that moment.
      assert.deepStrictEqual(requests.map(r => r.authorization), [
        'Bearer token-A', 'Bearer token-A',
        'Bearer token-B', 'Bearer token-B',
      ]);
    });
  } finally {
    await imageServer.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('localizeImageRefs warns and leaves refs unlocalized when credentials are missing', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    await withConfig({
      API_BASE_URL: 'https://tt.example.test',
      API_TOKEN: '',
    }, async (projectRoot) => {
      const prompt = '![x](/api/projects/1/images/45)';
      const result = await localizeImageRefs({
        taskId: 'C1013',
        prompt,
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.strictEqual(result.prompt, prompt);
      assert.ok(
        warnings.some(line => line.includes('[image-attach]') && line.includes('API_TOKEN')),
        `expected a credentials-unavailable warning, got: ${JSON.stringify(warnings)}`
      );
    });
  } finally {
    console.warn = originalWarn;
  }
});

test('localizeImageRefs materializes embedded data images without API access (C1253)', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const dataUri = `data:image/png;base64,${png.toString('base64')}`;

  await withConfig({
    API_BASE_URL: 'https://tt.example.test',
    API_TOKEN: '',
  }, async (projectRoot) => {
    const result = await localizeImageRefs({
      taskId: 'embedded-image-session',
      prompt: `Before\n\n![screenshot](${dataUri})\n\nAfter`,
      taskCommentsBlock: '',
      projectRoot,
    });

    assert.match(result.prompt, /^Before\n\nscreenshot: @.+\.png\n\nAfter$/);
    assert.doesNotMatch(result.prompt, /data:image\/png;base64/);
    const localPath = result.prompt.match(/screenshot: @(.+\.png)/)[1];
    assert.strictEqual(
      path.dirname(localPath),
      path.join(projectRoot, '.tipatask', 'images', 'embedded-image-session')
    );
    assert.deepStrictEqual(fs.readFileSync(localPath), png);
  });
});

test('localizeImageRefs leaves external image refs untouched', async () => {
  const originalFetch = global.fetch;
  const fetchedUrls = [];
  global.fetch = async (url) => {
    fetchedUrls.push(String(url));
    // Simulate an API server predating the by-task listing route (C1012) — the
    // only fetch that should reach here is the listing call, not the external ref.
    return { ok: false, status: 404 };
  };

  try {
    await withConfig({
      API_BASE_URL: 'https://tt.example.test',
      API_TOKEN: 'test-token',
    }, async (projectRoot) => {
      const prompt = '![external](https://images.example.test/example.png)';
      const result = await localizeImageRefs({
        taskId: 'C1011',
        prompt,
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.strictEqual(result.prompt, prompt);
      assert.deepStrictEqual(fetchedUrls, ['https://tt.example.test/api/projects/1/images/task/C1011']);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('localizeImageRefs C1012: attaches an image linked only via task_images.task_key (not inlined as markdown)', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const imageServer = await startImageServer((req, res) => {
    if (req.url === taskImageListingPath('C1012')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ images: [{ id: 45, url: '/api/projects/1/images/45' }] }));
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);
  });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-image-attach-linked-'));

  try {
    await withConfig({
      API_BASE_URL: imageServer.baseUrl,
      API_TOKEN: 'test-token',
      USER_DATA_ROOT: dataRoot,
    }, async (projectRoot) => {
      const result = await localizeImageRefs({
        taskId: 'C1012',
        prompt: 'Fix the header alignment.',
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.match(result.prompt, /^Fix the header alignment\.\n\nTask images \(inspect these before implementing\):\n@.+\.png$/);
      const localPath = result.prompt.slice(result.prompt.indexOf('@') + 1);
      assert.strictEqual(path.dirname(localPath), path.join(projectRoot, '.tipatask', 'images', 'C1012'));
      assert.deepStrictEqual(fs.readFileSync(localPath), png);
    });
  } finally {
    await imageServer.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('localizeImageRefs C1012: dedupes an image that is both markdown-inlined and task-linked', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  let imageFetchCount = 0;
  const imageServer = await startImageServer((req, res) => {
    if (req.url === taskImageListingPath('C1012')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ images: [{ id: 45, url: '/api/projects/1/images/45' }] }));
    }
    imageFetchCount += 1;
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);
  });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-image-attach-dedupe-'));

  try {
    await withConfig({
      API_BASE_URL: imageServer.baseUrl,
      API_TOKEN: 'test-token',
      USER_DATA_ROOT: dataRoot,
    }, async (projectRoot) => {
      const result = await localizeImageRefs({
        taskId: 'C1012',
        prompt: `![screenshot](${imageServer.baseUrl}/api/projects/1/images/45)`,
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.strictEqual(imageFetchCount, 1);
      assert.match(result.prompt, /^screenshot: @.+\.png$/);
      assert.doesNotMatch(result.prompt, /Task images \(inspect/);
    });
  } finally {
    await imageServer.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('localizeImageRefs C1012: listing failure does not block markdown-ref localization', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const imageServer = await startImageServer((req, res) => {
    if (req.url === taskImageListingPath('C1012')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'boom' }));
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);
  });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-image-attach-listfail-'));

  try {
    await withConfig({
      API_BASE_URL: imageServer.baseUrl,
      API_TOKEN: 'test-token',
      USER_DATA_ROOT: dataRoot,
    }, async (projectRoot) => {
      const result = await localizeImageRefs({
        taskId: 'C1012',
        prompt: '![x](/api/projects/1/images/45)',
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.match(result.prompt, /^x: @.+\.png$/);
      assert.ok(warnings.some(w => w.includes('images listing returned 500')));
    });
  } finally {
    console.warn = originalWarn;
    await imageServer.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('localizeImageRefs C1012: does not fetch the by-task listing for non-task session ids', async () => {
  const requestedPaths = [];
  const imageServer = await startImageServer((req, res) => {
    requestedPaths.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ images: [] }));
  });

  try {
    await withConfig({
      API_BASE_URL: imageServer.baseUrl,
      API_TOKEN: 'test-token',
    }, async (projectRoot) => {
      const prompt = 'No images referenced here.';
      const result = await localizeImageRefs({
        taskId: 'obj-1721990400000',
        prompt,
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.strictEqual(result.prompt, prompt);
      assert.deepStrictEqual(requestedPaths, []);
    });
  } finally {
    await imageServer.close();
  }
});
