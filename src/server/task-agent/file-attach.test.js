'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const config = require('../config');
const { localizeFileRefs } = require('./file-attach');

async function startFileServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function taskFileListingPath(taskKey) {
  return `/api/projects/1/files/task/${taskKey}`;
}

async function withConfig(overrides, run) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-file-project-'));
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

test('localizeFileRefs fetches and saves a relative internal file ref', async () => {
  const pdf = Buffer.from('%PDF-1.4 fake');
  const requests = [];
  const fileServer = await startFileServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === taskFileListingPath('C1247')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ files: [] }));
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="api-spec.pdf"; filename*=UTF-8\'\'api-spec.pdf',
    });
    res.end(pdf);
  });
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  try {
    await withConfig({
      API_BASE_URL: `${fileServer.baseUrl}/`,
      API_TOKEN: 'test-token',
    }, async (projectRoot) => {
      const result = await localizeFileRefs({
        taskId: 'C1247',
        prompt: 'See [api-spec.pdf](/api/projects/1/files/45).',
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.deepStrictEqual(requests, [
        { url: taskFileListingPath('C1247'), authorization: 'Bearer test-token' },
        { url: '/api/projects/1/files/45', authorization: 'Bearer test-token' },
      ]);
      assert.match(result.prompt, /^See api-spec\.pdf: @.+\.pdf\.\n\nTask file attachments \(read these before implementing\):\n@.+\.pdf$/);
      const localPath = result.prompt.match(/@(\S+\.pdf)/)[1];
      assert.strictEqual(path.dirname(localPath), path.join(projectRoot, '.tipatask', 'files', 'C1247'));
      assert.strictEqual(path.basename(localPath), '45-api-spec.pdf');
      assert.deepStrictEqual(fs.readFileSync(localPath), pdf);
      assert.ok(logs.some(line => line.includes(`[file-attach] task=C1247 saved /api/projects/1/files/45 → ${localPath}`)));
    });
  } finally {
    console.log = originalLog;
    await fileServer.close();
  }
});

test('localizeFileRefs fetches an absolute (apiBaseUrl-prefixed) file ref', async () => {
  const txt = Buffer.from('hello world');
  const fileServer = await startFileServer((req, res) => {
    if (req.url === taskFileListingPath('C1247')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ files: [] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="notes.txt"' });
    res.end(txt);
  });

  try {
    await withConfig({
      API_BASE_URL: fileServer.baseUrl,
      API_TOKEN: 'test-token',
    }, async (projectRoot) => {
      const fileUrl = `${fileServer.baseUrl}/api/projects/1/files/7`;
      const result = await localizeFileRefs({
        taskId: 'C1247',
        prompt: `Notes: [notes.txt](${fileUrl})`,
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.match(result.prompt, /^Notes: notes\.txt: @.+\.txt/);
    });
  } finally {
    await fileServer.close();
  }
});

test('localizeFileRefs warns and leaves refs unlocalized when credentials are missing', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    await withConfig({
      API_BASE_URL: 'https://tt.example.test',
      API_TOKEN: '',
    }, async (projectRoot) => {
      const prompt = '[spec.pdf](/api/projects/1/files/45)';
      const result = await localizeFileRefs({
        taskId: 'C1247',
        prompt,
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.strictEqual(result.prompt, prompt);
      assert.ok(
        warnings.some(line => line.includes('[file-attach]') && line.includes('API_TOKEN')),
        `expected a credentials-unavailable warning, got: ${JSON.stringify(warnings)}`
      );
    });
  } finally {
    console.warn = originalWarn;
  }
});

test('localizeFileRefs leaves external links untouched', async () => {
  const originalFetch = global.fetch;
  const fetchedUrls = [];
  global.fetch = async (url) => {
    fetchedUrls.push(String(url));
    return { ok: false, status: 404 };
  };

  try {
    await withConfig({
      API_BASE_URL: 'https://tt.example.test',
      API_TOKEN: 'test-token',
    }, async (projectRoot) => {
      const prompt = 'See [docs](https://example.com/spec.pdf) for details.';
      const result = await localizeFileRefs({
        taskId: 'C1247',
        prompt,
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.strictEqual(result.prompt, prompt);
      assert.deepStrictEqual(fetchedUrls, ['https://tt.example.test/api/projects/1/files/task/C1247']);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('localizeFileRefs C1247: attaches a file linked only via task_files.task_key (not inlined as a link)', async () => {
  const csv = Buffer.from('a,b,c');
  const fileServer = await startFileServer((req, res) => {
    if (req.url === taskFileListingPath('C1247')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ files: [{ id: 9, url: '/api/projects/1/files/9', filename: 'data.csv' }] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="data.csv"' });
    res.end(csv);
  });

  try {
    await withConfig({
      API_BASE_URL: fileServer.baseUrl,
      API_TOKEN: 'test-token',
    }, async (projectRoot) => {
      const result = await localizeFileRefs({
        taskId: 'C1247',
        prompt: 'Import the attached data.',
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.match(result.prompt, /^Import the attached data\.\n\nTask file attachments \(read these before implementing\):\n@.+9-data\.csv$/);
    });
  } finally {
    await fileServer.close();
  }
});

test('localizeFileRefs C1247: dedupes a file that is both link-inlined and task-linked', async () => {
  const pdf = Buffer.from('%PDF fake');
  let fetchCount = 0;
  const fileServer = await startFileServer((req, res) => {
    if (req.url === taskFileListingPath('C1247')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ files: [{ id: 45, url: '/api/projects/1/files/45', filename: 'spec.pdf' }] }));
    }
    fetchCount += 1;
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="spec.pdf"' });
    res.end(pdf);
  });

  try {
    await withConfig({
      API_BASE_URL: fileServer.baseUrl,
      API_TOKEN: 'test-token',
    }, async (projectRoot) => {
      const result = await localizeFileRefs({
        taskId: 'C1247',
        prompt: `[spec.pdf](${fileServer.baseUrl}/api/projects/1/files/45)`,
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.strictEqual(fetchCount, 1);
      // Rewrite-plus-block: the inline link is rewritten AND the block repeats it once — not twice.
      const blockMatches = result.prompt.match(/45-spec\.pdf/g) || [];
      assert.strictEqual(blockMatches.length, 2); // one in the rewritten inline ref, one in the block
    });
  } finally {
    await fileServer.close();
  }
});

test('localizeFileRefs C1247: listing failure does not block link-ref localization', async () => {
  const txt = Buffer.from('hi');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const fileServer = await startFileServer((req, res) => {
    if (req.url === taskFileListingPath('C1247')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'boom' }));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="notes.txt"' });
    res.end(txt);
  });

  try {
    await withConfig({
      API_BASE_URL: fileServer.baseUrl,
      API_TOKEN: 'test-token',
    }, async (projectRoot) => {
      const result = await localizeFileRefs({
        taskId: 'C1247',
        prompt: '[notes.txt](/api/projects/1/files/45)',
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.match(result.prompt, /notes\.txt: @.+\.txt/);
      assert.ok(warnings.some(w => w.includes('files listing returned 500')));
    });
  } finally {
    console.warn = originalWarn;
    await fileServer.close();
  }
});

test('localizeFileRefs C1247: does not fetch the by-task listing for non-task session ids', async () => {
  const requestedPaths = [];
  const fileServer = await startFileServer((req, res) => {
    requestedPaths.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ files: [] }));
  });

  try {
    await withConfig({
      API_BASE_URL: fileServer.baseUrl,
      API_TOKEN: 'test-token',
    }, async (projectRoot) => {
      const prompt = 'No files referenced here.';
      const result = await localizeFileRefs({
        taskId: 'obj-1721990400000',
        prompt,
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.strictEqual(result.prompt, prompt);
      assert.deepStrictEqual(requestedPaths, []);
    });
  } finally {
    await fileServer.close();
  }
});

test('localizeFileRefs never matches image markdown syntax (negative lookbehind)', async () => {
  const requestedPaths = [];
  const fileServer = await startFileServer((req, res) => {
    requestedPaths.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ files: [] }));
  });

  try {
    await withConfig({
      API_BASE_URL: fileServer.baseUrl,
      API_TOKEN: 'test-token',
    }, async (projectRoot) => {
      const prompt = '![screenshot](/api/projects/1/images/9)';
      const result = await localizeFileRefs({
        taskId: 'C1247',
        prompt,
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.strictEqual(result.prompt, prompt);
      // Only the by-task files listing should fire — the image ref must never be treated as a file ref.
      assert.deepStrictEqual(requestedPaths, [taskFileListingPath('C1247')]);
    });
  } finally {
    await fileServer.close();
  }
});

test('localizeFileRefs skips a response whose Content-Type is not in the doc allowlist (e.g. spoofed image extension)', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const fileServer = await startFileServer((req, res) => {
    if (req.url === taskFileListingPath('C1247')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ files: [] }));
    }
    // A row whose stored original_filename claims .png but whose real Content-Type is an
    // image MIME the doc allowlist does not carry — must be rejected, not written to disk
    // with an image extension (which would make codex-session.js's IMAGE_ATTACH_RE pick it
    // up as a native -i attachment).
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="chart.png"' });
    res.end(Buffer.from('not really a pdf'));
  });

  try {
    await withConfig({
      API_BASE_URL: fileServer.baseUrl,
      API_TOKEN: 'test-token',
    }, async (projectRoot) => {
      const prompt = '[chart.png](/api/projects/1/files/45)';
      const result = await localizeFileRefs({
        taskId: 'C1247',
        prompt,
        taskCommentsBlock: '',
        projectRoot,
      });

      assert.strictEqual(result.prompt, prompt); // untouched — nothing localized
      assert.ok(warnings.some(w => w.includes('Unsupported file MIME type')));
      // The directory is created up front (same as image-attach.js) once there's a candidate
      // URL, but nothing gets written into it — the rejected download must never land on disk.
      const dir = path.join(projectRoot, '.tipatask', 'files', 'C1247');
      const written = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f !== '.gitignore') : [];
      assert.deepStrictEqual(written, []);
    });
  } finally {
    console.warn = originalWarn;
    await fileServer.close();
  }
});

test('localizeFileRefs decodes an RFC 5987 filename*=UTF-8\'\' Content-Disposition', async () => {
  const pdf = Buffer.from('%PDF fake');
  const fileServer = await startFileServer((req, res) => {
    if (req.url === taskFileListingPath('C1247')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ files: [] }));
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': "attachment; filename=\"Test.pdf\"; filename*=UTF-8''%D0%A2%D0%B5%D1%81%D1%82.pdf",
    });
    res.end(pdf);
  });

  try {
    await withConfig({
      API_BASE_URL: fileServer.baseUrl,
      API_TOKEN: 'test-token',
    }, async (projectRoot) => {
      const result = await localizeFileRefs({
        taskId: 'C1247',
        prompt: '[doc](/api/projects/1/files/45)',
        taskCommentsBlock: '',
        projectRoot,
      });

      const localPath = result.prompt.match(/@(\S+\.pdf)/)[1];
      // Non-ASCII chars are sanitized out of the on-disk name, but decoding must not throw
      // and the fileId prefix + extension must still be correct.
      assert.match(path.basename(localPath), /^45-.*\.pdf$/);
    });
  } finally {
    await fileServer.close();
  }
});

test('localizeFileRefs seeds a self-ignoring .gitignore in the files directory', async () => {
  const txt = Buffer.from('hi');
  const fileServer = await startFileServer((req, res) => {
    if (req.url === taskFileListingPath('C1247')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ files: [] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="notes.txt"' });
    res.end(txt);
  });

  try {
    await withConfig({
      API_BASE_URL: fileServer.baseUrl,
      API_TOKEN: 'test-token',
    }, async (projectRoot) => {
      await localizeFileRefs({
        taskId: 'C1247',
        prompt: '[notes.txt](/api/projects/1/files/45)',
        taskCommentsBlock: '',
        projectRoot,
      });

      const gitignorePath = path.join(projectRoot, '.tipatask', 'files', '.gitignore');
      assert.strictEqual(fs.readFileSync(gitignorePath, 'utf8'), '*\n');
    });
  } finally {
    await fileServer.close();
  }
});
