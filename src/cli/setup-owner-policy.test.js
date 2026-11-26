'use strict';

// (TPT9409) saveProjectOwnerPolicy(): the setup wizard's write of a new project's owner rules,
// `PUT /api/projects/:id/policy` with the signed-in user's token, against a throwaway local
// server standing in for the Tipatask API.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// setup.js reads the account store location while it loads: give this file its own.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-setup-owner-policy-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));

const { saveProjectOwnerPolicy } = require('./setup');

function startServer(answer) {
  const seen = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        const { status, data } = answer();
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('PUTs the rules to the project policy endpoint with the user token', async (t) => {
  const policy = { owner_rules: { sprint_sort_order: 'desc' }, rules: { sprint_sort_order: { value: 'desc', source: 'owner' } } };
  const { server, seen, base } = await startServer(() => ({ status: 200, data: policy }));
  t.after(() => server.close());
  const result = await saveProjectOwnerPolicy({ apiBaseUrl: base, token: 'user-token', projectId: '52', rules: { sprint_sort_order: 'desc' } });
  assert.deepEqual(result, policy);
  assert.deepEqual(seen, [{ method: 'PUT', url: '/api/projects/52/policy', auth: 'Bearer user-token', body: { rules: { sprint_sort_order: 'desc' } } }]);
});

test('a refused save names the API error and the field', async (t) => {
  const { server, base } = await startServer(() => ({ status: 409, data: { error: 'policy_conflict', field: 'language' } }));
  t.after(() => server.close());
  await assert.rejects(
    saveProjectOwnerPolicy({ apiBaseUrl: base, token: 'user-token', projectId: 52, rules: { language: 'en' } }),
    { message: 'Policy rules were not saved: policy_conflict (language)' },
  );
});
