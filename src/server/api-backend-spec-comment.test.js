'use strict';

// Exercise objective saves through the real backend and a local throwaway API.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-spec-comment-data-'));
process.env.TIPATASK_USER_DATA = userData;
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const { createApiBackend } = require('./api-backend');
const { writeProjectConfig } = require('./project-config');
const { buildSpecCommentBody, stripSpecCommentHeader } = require('./spec-comment');

const SPEC = 'Read https://example.com/design?node-id=12&view=full\n'
  + '![hero](/api/projects/1/images/1)\nCopy: Count every item\nJoin on project_id';

async function withSave({ lang, count, existingComment }, run) {
  const newTaskIds = Array.from({ length: count }, (_, i) => `TST${i + 1}`);
  const rows = newTaskIds.map((key, i) => ({
    id: i + 1, project_id: 1, task_key: key, title: '', description: 'Reserved key',
    category: 'CODING', status: 'pending', priority: 0, is_reservation: 1,
  }));
  const comments = [];
  const unexpected = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const pathname = req.url.split('?')[0];
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'GET' && pathname === '/api/projects/1/tags') return send(200, { tags: [] });
      if (req.method === 'GET' && pathname === '/api/projects/1/tasks') return send(200, { tasks: rows });
      const commentMatch = /^\/api\/projects\/1\/tasks\/(TST\d+)\/comments$/.exec(pathname);
      if (commentMatch && req.method === 'GET') {
        return send(200, { comments: existingComment == null ? [] : [{ comment_type: 'spec', content: existingComment }] });
      }
      if (commentMatch && req.method === 'POST') {
        const posted = JSON.parse(body);
        comments.push({ taskKey: commentMatch[1], ...posted });
        return send(201, { comment: { id: comments.length, ...posted } });
      }
      const taskMatch = /^\/api\/projects\/1\/tasks\/(TST\d+)$/.exec(pathname);
      if (taskMatch && req.method === 'PATCH') {
        const row = rows.find(row => row.task_key === taskMatch[1]);
        Object.assign(row, JSON.parse(body));
        return send(200, { task: row });
      }
      unexpected.push(`${req.method} ${req.url}`);
      return send(404, { error: 'not found' });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-spec-comment-'));
  writeProjectConfig(projectRoot, {
    TASK_BACKEND: 'api', API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    API_PROJECT_ID: '1', API_TOKEN: 'test-token', language: lang,
  });
  const backend = createApiBackend(null, projectRoot);
  const tasks = newTaskIds.map(id => ({
    id, title: 'Refine objective', description: 'Implement assigned scope', category: 'CODING',
    status: 'pending', priority: 1, order: 1, dependencies: [], tags: [], assignee: 7,
  }));
  const payload = '# Tasks\n\n```json\n' + JSON.stringify({ tasks, newTaskIds, originalSpec: SPEC }) + '\n```\n';
  try {
    await run({ backend, payload, comments, newTaskIds });
    assert.deepEqual(unexpected, []);
  } finally {
    backend.dispose();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

for (const lang of ['en', 'uk']) {
  for (const count of [1, 2]) {
    test(`overwriteRaw posts ${count === 1 ? 'full-spec' : 'reference-only'} comments for ${count} cards (${lang})`, async () => {
      await withSave({ lang, count }, async ({ backend, payload, comments, newTaskIds }) => {
        await backend.overwriteRaw(payload);
        assert.equal(comments.length, count);
        assert.deepEqual(comments.map(c => c.taskKey).sort(), newTaskIds);
        const heading = count === 1
          ? (lang === 'uk' ? '## Початкова ціль (повна специфікація)' : '## Original Objective (full specification)')
          : (lang === 'uk' ? '## Початкова ціль (лише для довідки)' : '## Original Objective (reference only)');
        for (const comment of comments) {
          assert.equal(comment.type, 'spec');
          assert.ok(comment.content.startsWith(heading));
          assert.equal(stripSpecCommentHeader(comment.content), SPEC);
        }
      });
    });
  }
}

for (const [variant, existingComment] of [
  ['raw', SPEC],
  ['reference-only', buildSpecCommentBody(SPEC, 'uk')],
  ['full-spec', buildSpecCommentBody(SPEC, 'uk', { soleTask: true })],
]) {
  test(`overwriteRaw deduplicates an existing ${variant} spec across revisions and language changes`, async () => {
    await withSave({ lang: 'en', count: 1, existingComment }, async ({ backend, payload, comments }) => {
      await backend.overwriteRaw(payload);
      assert.deepEqual(comments, []);
    });
  });
}
