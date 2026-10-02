'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifySaveError } = require('./todo-save-error');

function err(message, props = {}) {
  return Object.assign(new Error(message), props);
}

test('an unclassified error stays a 500 and reports the handler step', () => {
  assert.deepEqual(classifySaveError(err('boom'), 'normalize-priorities'), {
    status: 500,
    body: { error: 'boom', step: 'normalize-priorities', code: null },
  });
});

test('the step the backend tagged wins over the handler step', () => {
  const out = classifySaveError(err('boom', { saveStep: 'write-task:C12' }), 'persist');
  assert.equal(out.body.step, 'write-task:C12');
});

test('an API 4xx or auth rejection keeps its own status and message', () => {
  for (const statusCode of [400, 401, 403, 409, 422]) {
    const out = classifySaveError(err(`API ${statusCode}: nope`, { statusCode }), 'persist');
    assert.equal(out.status, statusCode);
    assert.equal(out.body.error, `API ${statusCode}: nope`);
  }
});

test('an API 5xx becomes 502 so it is not mistaken for a failure of this server', () => {
  const out = classifySaveError(err('API 500: {"error":"Internal server error"}', { statusCode: 500 }), 'persist');
  assert.equal(out.status, 502);
  assert.equal(out.body.code, 'API_ERROR');
  assert.match(out.body.error, /^Tipatask API error: API 500/);
});

test('an unreachable API becomes 503 whatever transport code it carried', () => {
  const out = classifySaveError(err('API unreachable at https://x: socket hang up', { networkError: true, code: 'ECONNRESET' }), 'persist');
  assert.equal(out.status, 503);
  assert.equal(out.body.code, 'API_UNREACHABLE');
});

test('missing credentials are an auth problem, not a server error', () => {
  const out = classifySaveError(err('API not configured for this project (missing API_TOKEN in .tipatask/config.json)', { missingCredentials: true }), 'persist');
  assert.equal(out.status, 401);
  assert.equal(out.body.code, 'MISSING_CREDENTIALS');
});

test('coded save rejections map to their status', () => {
  const expected = {
    TODO_PAYLOAD_INVALID: 400,
    TAGS_UNREGISTERED: 422,
    NEW_TAG_DESCRIPTION_MISSING: 422,
    TAG_REGISTRY_UNREADABLE: 502,
    RESERVE_FAILED: 502,
  };
  for (const [code, status] of Object.entries(expected)) {
    const out = classifySaveError(err('rejected', { code }), 'persist');
    assert.equal(out.status, status, code);
    assert.equal(out.body.code, code);
  }
});

test('an unknown code is passed through without changing the 500', () => {
  const out = classifySaveError(err('too big', { code: 'ERR_RESPONSE_TOO_LARGE' }), 'persist');
  assert.equal(out.status, 500);
  assert.equal(out.body.code, 'ERR_RESPONSE_TOO_LARGE');
});

test('a non-Error throw still produces a readable body', () => {
  assert.deepEqual(classifySaveError('plain string', 'persist'), {
    status: 500,
    body: { error: 'plain string', step: 'persist', code: null },
  });
  assert.equal(classifySaveError(null).status, 500);
});
