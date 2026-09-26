'use strict';

process.env.TASK_BACKEND = 'api';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHttpHandler, normalizeProjectMember } = require('./ws-handlers');

function fakeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(chunk) { res.body = chunk || ''; },
  };
  return res;
}

async function runMembers(members) {
  const backend = { async getProjectMembers() { return members; } };
  const handler = createHttpHandler(new Map(), () => backend, null);
  const res = fakeRes();
  await handler({ method: 'GET', url: '/api/project/members', headers: {} }, res);
  return res;
}

test('normalizeProjectMember uses user ID, not membership-row ID, and exposes display aliases', () => {
  const member = normalizeProjectMember({
    id: 42,
    user_id: 7,
    name: ' Ada Lovelace ',
    avatar_url: 'https://example.test/ada.png',
    role: 'editor',
  });

  assert.equal(member.id, 7);
  assert.equal(member.user_id, 7);
  assert.equal(member.name, 'Ada Lovelace');
  assert.equal(member.display_name, 'Ada Lovelace');
  assert.equal(member.avatar_url, 'https://example.test/ada.png');
  assert.equal(member.avatarUrl, 'https://example.test/ada.png');
  assert.equal(member.role, 'editor');
});

test('GET /api/project/members normalizes alternate fields and never labels an invite by ID', async () => {
  const res = await runMembers([
    { id: 42, user_id: 7, name: 'Ada', avatar_url: null, status: 'accepted' },
    { id: 99, user_id: null, name: null, email: 'invite@example.test', status: 'pending' },
    { id: 8, userId: 8, displayName: 'Grace', avatarUrl: 'https://example.test/grace.png' },
  ]);

  assert.equal(res.statusCode, 200);
  const members = JSON.parse(res.body).members;
  assert.deepEqual(members.map(member => member.id), [7, null, 8]);
  assert.equal(members[1].name, 'invite@example.test');
  assert.notEqual(members[1].name, '#99');
  assert.equal(members[2].name, 'Grace');
  assert.equal(members[2].avatar_url, 'https://example.test/grace.png');
});
