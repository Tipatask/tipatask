'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { localizeImageRefs } = require('./image-attach');
const { localizeFileRefs } = require('./file-attach');

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function withProject(origin, run) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-attachment-origin-'));
  fs.mkdirSync(path.join(projectRoot, '.tipatask'));
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
    API_BASE_URL: `${origin}/`, API_TOKEN: 'origin-test-token', API_PROJECT_ID: '1',
  }));
  try {
    return await run(projectRoot);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

const kinds = [
  { name: 'image', route: 'images', localize: localizeImageRefs, mime: 'image/png', data: Buffer.from('png'), ref: url => `![pic](${url})` },
  { name: 'file', route: 'files', localize: localizeFileRefs, mime: 'text/plain', data: Buffer.from('text'), ref: url => `[doc](${url})` },
];

for (const kind of kinds) {
  test(`${kind.name} localization sends bearer token only to exact-origin, current-project attachment routes`, async () => {
    const origin = 'https://api.attachment.test:8443';
    const base = `/api/projects/1/${kind.route}`;
    const invalid = [
      `https://api.attachment.test.attacker.invalid:8443${base}/90`,
      `https://evil-api.attachment.test:8443${base}/91`,
      `${origin.replace('https:', 'http:')}${base}/92`,
      `${origin.replace(/:\d+$/, ':1')}${base}/93`,
      origin.replace('://', '://user@') + `${base}/94`,
      `${origin}/api/projects/2/${kind.route}/95`,
      `${origin}/api/projects/1/${kind.route}/%39%36`,
      `${origin}${base}/97/extra`,
      `//api.attachment.test:8443${base}/98`,
      `/api/projects/2/${kind.route}/99`,
      `/api/projects/1/${kind.route}/%31%30%30`,
    ];
    const listedUrls = [invalid[0], invalid[5], invalid[6], `${base}/45`];
    const prompt = [kind.ref(`${origin}${base}/45`), kind.ref(`${base}/46`),
      ...invalid.map(kind.ref)].join('\n');
    const originalFetch = global.fetch;
    const attempted = [];
    global.fetch = async (url, options) => {
      const href = String(url);
      attempted.push({ url: href, auth: options?.headers?.Authorization, redirect: options?.redirect });
      if (href === `${origin}${base}/task/C317`) {
        return new Response(JSON.stringify({ [kind.route]: listedUrls.map(url => ({ url, filename: 'doc.txt' })) }),
          { headers: { 'Content-Type': 'application/json' } });
      }
      if (href === `${origin}${base}/45` || href === `${origin}${base}/46`) {
        return new Response(kind.data, { headers: { 'Content-Type': kind.mime } });
      }
      throw new Error(`Unexpected attachment fetch: ${href}`);
    };

    try {
      await withProject(origin, async projectRoot => {
        const result = await kind.localize({ taskId: 'C317', prompt, taskCommentsBlock: '', projectRoot });
        for (const url of invalid) assert.ok(result.prompt.includes(kind.ref(url)), `rejected ref changed: ${url}`);
        for (const url of [`${origin}${base}/45`, `${base}/46`]) {
          assert.ok(!result.prompt.includes(kind.ref(url)), `valid ref not localized: ${url}`);
        }
        const localPaths = [...result.prompt.matchAll(/@(\/[^\s]+)/g)].map(match => match[1]);
        assert.ok(localPaths.length >= 2);
        for (const localPath of localPaths) assert.deepStrictEqual(fs.readFileSync(localPath), kind.data);
      });
      assert.deepStrictEqual(attempted, [
        `${origin}${base}/task/C317`, `${origin}${base}/45`, `${origin}${base}/46`,
      ].map(url => ({ url, auth: 'Bearer origin-test-token', redirect: 'error' })));
    } finally {
      global.fetch = originalFetch;
    }
  });

  test(`${kind.name} localization rejects listing and download redirects without forwarding bearer token`, async () => {
    const targetRequests = [];
    const target = await startServer((req, res) => {
      targetRequests.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': kind.mime });
      res.end(kind.data);
    });
    const apiRequests = [];
    const api = await startServer((req, res) => {
      apiRequests.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(302, { Location: `${target.origin}/stolen` });
      res.end();
    });
    const prompt = kind.ref(`/api/projects/1/${kind.route}/45`);
    try {
      await withProject(api.origin, async projectRoot => {
        const result = await kind.localize({ taskId: 'C317', prompt, taskCommentsBlock: '', projectRoot });
        assert.strictEqual(result.prompt, prompt);
      });
      assert.deepStrictEqual(apiRequests.map(row => row.url), [
        `/api/projects/1/${kind.route}/task/C317`, `/api/projects/1/${kind.route}/45`,
      ]);
      assert.ok(apiRequests.every(row => row.auth === 'Bearer origin-test-token'));
      assert.deepStrictEqual(targetRequests, []);
    } finally {
      await api.close();
      await target.close();
    }
  });
}
