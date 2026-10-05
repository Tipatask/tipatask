'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveTipataskRequest } = require('./tipatask-request.cjs');
const { materializePiTaskTools, FILES, ENTRY } = require('../pi-task-tools');

const ENV = { API_BASE_URL: 'https://api.example.test/', API_PROJECT_ID: '7', API_TOKEN: 'secret-token' };
const ROOT = 'https://api.example.test/api/projects/7';

test('reads and task writes resolve under the project root with the bearer token', () => {
  const read = resolveTipataskRequest({ path: '/tasks/TPT1' }, ENV);
  assert.deepEqual({ ok: read.ok, method: read.method, url: read.url, body: read.body },
    { ok: true, method: 'GET', url: `${ROOT}/tasks/TPT1`, body: undefined });
  assert.equal(read.headers.Authorization, 'Bearer secret-token');

  const patch = resolveTipataskRequest({ method: 'patch', path: '/tasks/TPT1', body: { title: 'New' } }, ENV);
  assert.equal(patch.ok, true);
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.body, '{"title":"New"}');
  assert.equal(patch.headers['Content-Type'], 'application/json');

  assert.equal(resolveTipataskRequest({ path: '/tasks?status=pending&fields=summary&limit=20' }, ENV).url,
    `${ROOT}/tasks?status=pending&fields=summary&limit=20`);
});

test('every allowed method + path shape passes', () => {
  const allowed = [
    ['GET', '/tasks'], ['GET', '/tasks/TPT1/comments'], ['GET', '/tasks/TPT1/events'],
    ['GET', '/tags'], ['GET', '/members'], ['GET', '/sprints'], ['GET', '/statuses'],
    ['GET', '/knowledge'], ['GET', '/knowledge/ai/architecture/tt-task-chat.md'],
    ['POST', '/tasks'], ['POST', '/tasks/TPT1/comments'], ['POST', '/tags'],
    ['PATCH', '/tasks/TPT1'], ['DELETE', '/tasks/TPT1'],
  ];
  for (const [method, p] of allowed) {
    const body = method === 'POST' || method === 'PATCH' ? { x: 1 } : undefined;
    assert.equal(resolveTipataskRequest({ method, path: p, body }, ENV).ok, true, `${method} ${p}`);
  }
});

test('anything outside the task/tag/read surface is rejected', () => {
  const rejected = [
    ['PUT', '/tasks', { tasks: [] }],                 // bulk replace
    ['PUT', '/knowledge/ai/architecture/x.md', {}],   // KB write
    ['POST', '/knowledge', { files: [] }],            // KB write
    ['POST', '/tasks/purge-reservations', {}],
    ['POST', '/tasks/TPT1/token-usage', {}],
    ['DELETE', '/tags/x'],
    ['DELETE', '/tasks'],
    ['PATCH', '/tasks', {}],
    ['GET', '/'],
    ['GET', '/devices'],
    ['POST', '/sprints', { name: 'x' }],
  ];
  for (const [method, p, body] of rejected) {
    const res = resolveTipataskRequest({ method, path: p, body }, ENV);
    assert.equal(res.ok, false, `${method} ${p}`);
    assert.doesNotMatch(res.error, /secret-token/);
  }
});

test('the URL can never leave the project root', () => {
  for (const p of ['https://evil.test/tasks', '//evil.test/tasks', 'tasks/TPT1', '/tasks/../../users',
    '/tasks/%2e%2e/%2e%2e/users', '/tasks/TPT1#frag', '/tasks/a\\b', '/tasks/a b', '/knowledge/../tasks']) {
    assert.equal(resolveTipataskRequest({ path: p }, ENV).ok, false, p);
  }
});

test('writes need a JSON object body; missing credentials fail closed', () => {
  assert.equal(resolveTipataskRequest({ method: 'PATCH', path: '/tasks/TPT1' }, ENV).ok, false);
  assert.equal(resolveTipataskRequest({ method: 'POST', path: '/tasks', body: [1] }, ENV).ok, false);
  assert.equal(resolveTipataskRequest({ method: 'POST', path: '/tasks', body: 'str' }, ENV).ok, false);
  assert.equal(resolveTipataskRequest({ method: 'POST', path: '/tasks', body: '[1]' }, ENV).ok, false);
  assert.equal(resolveTipataskRequest({ method: 'POST', path: '/tasks', body: '"text"' }, ENV).ok, false);
  // A body sent as a JSON string of an object is the same request.
  const stringified = resolveTipataskRequest({ method: 'PATCH', path: '/tasks/TPT1', body: '{"description": "x"}' }, ENV);
  assert.equal(stringified.ok, true);
  assert.equal(stringified.body, '{"description":"x"}');
  assert.equal(resolveTipataskRequest({ method: 'POST', path: '/tasks', body: { description: 'x'.repeat(300 * 1024) } }, ENV).ok, false);
  for (const env of [{}, { ...ENV, API_TOKEN: '' }, { ...ENV, API_PROJECT_ID: '' }, undefined]) {
    assert.equal(resolveTipataskRequest({ path: '/tasks' }, env).ok, false);
  }
});

test('the extension is staged outside the app bundle, byte-identical and idempotent', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-pi-ext-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = materializePiTaskTools(dir);
  assert.equal(entry, path.join(dir, 'pi-ext', ENTRY));
  for (const name of FILES) {
    assert.equal(fs.readFileSync(path.join(dir, 'pi-ext', name), 'utf8'), fs.readFileSync(path.join(__dirname, name), 'utf8'));
  }
  const before = fs.statSync(entry).mtimeMs;
  assert.equal(materializePiTaskTools(dir), entry);
  assert.equal(fs.statSync(entry).mtimeMs, before, 'an unchanged copy is not rewritten');
  assert.equal(materializePiTaskTools(''), null);
});

test('restToolEnabled: the REST tool is the fallback for a turn without an MCP bridge config', () => {
  const { restToolEnabled } = require('./tipatask-request.cjs');
  assert.equal(restToolEnabled({}), true);
  assert.equal(restToolEnabled({ TIPATASK_PI_MCP_CONFIG: '' }), true, 'pi-session.js sets it empty without a bridge');
  assert.equal(restToolEnabled({ TIPATASK_PI_MCP_CONFIG: '/data/mcp-spawn/abc.pi.json' }), false);
  assert.equal(restToolEnabled(undefined), true);
});

test('the extension source registers only the gated tool and reads no credentials itself', () => {
  const src = fs.readFileSync(path.join(__dirname, 'task-tools.mjs'), 'utf8');
  assert.match(src, /if \(!restToolEnabled\(process\.env\)\) return;\n  pi\.registerTool\(/, 'registration is skipped when the MCP bridge is configured');
  assert.equal((src.match(/registerTool\(/g) || []).length, 1);
  assert.match(src, /name: "tipatask_api"/);
  assert.match(src, /credentials\.liveCredentials\(process\.env\)/);
  assert.match(src, /split\(env\.API_TOKEN\)/, 'server responses redact any credential echo');
  assert.doesNotMatch(src, /child_process|node:fs|writeFile/);
});
