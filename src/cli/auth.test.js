'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { authenticate, authenticateAndStore, resolveCallbackPort, startCallbackServer } = require('./auth');

test('startCallbackServer resolves only after loopback listener has a valid port', async (t) => {
  const callback = await startCallbackServer();
  t.after(() => callback.server.close());

  assert.equal(callback.server.listening, true);
  assert.equal(Number.isInteger(callback.port), true);
  assert.equal(callback.port > 0, true);
  assert.equal(callback.port, callback.server.address().port);

  const response = await fetch(
    `http://127.0.0.1:${callback.port}/callback?token=test-token&nonce=${callback.nonce}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await callback.waitForToken, { token: 'test-token' });
});

test('resolveCallbackPort rejects missing and invalid listener addresses', () => {
  assert.throws(
    () => resolveCallbackPort({ address: () => null }),
    /Could not determine the desktop sign-in callback port/,
  );
  assert.throws(
    () => resolveCallbackPort({ address: () => 'local-socket' }),
    /Could not determine the desktop sign-in callback port/,
  );
  assert.throws(
    () => resolveCallbackPort({ address: () => ({ port: 0 }) }),
    /Could not determine the desktop sign-in callback port/,
  );
});

test('authenticate opens the browser only after callback startup resolves with a valid port', async () => {
  let callbackReady = false;
  let openedUrl = null;
  let closed = false;

  const result = await authenticate('https://tt.example.test', {
    startServer: async () => {
      await Promise.resolve();
      callbackReady = true;
      return {
        server: { close: () => { closed = true; } },
        port: 43114,
        nonce: 'nonce-1314',
        waitForToken: Promise.resolve({ token: 'user-token' }),
      };
    },
    browser: async (url) => {
      assert.equal(callbackReady, true);
      openedUrl = url;
      return true;
    },
    requestImpl: async () => ({ status: 200, data: { user: { email: 'user@example.com' } } }),
  });

  const desktopParam = openedUrl.split('?d=')[1];
  assert.deepEqual(
    JSON.parse(Buffer.from(desktopParam, 'base64url').toString('utf8')),
    { port: 43114, nonce: 'nonce-1314' },
  );
  assert.equal(closed, true);
  assert.deepEqual(result, { token: 'user-token', user: { email: 'user@example.com' } });
});

test('authenticate derives the sign-in page and profile lookup host from the given apiBaseUrl', async () => {
  const apiBaseUrl = 'https://web.example.test';
  let openedUrl = null;
  let profileUrl = null;

  await authenticate(apiBaseUrl, {
    startServer: async () => ({
      server: { close: () => {} },
      port: 43115,
      nonce: 'nonce-host',
      waitForToken: Promise.resolve({ token: 'user-token' }),
    }),
    browser: async (url) => {
      openedUrl = url;
      return true;
    },
    requestImpl: async (url) => {
      profileUrl = url;
      return { status: 200, data: { user: {} } };
    },
  });

  const signin = new URL(openedUrl);
  assert.equal(signin.origin, apiBaseUrl);
  assert.equal(signin.pathname, '/');
  assert.equal(signin.hash.startsWith('#/login?d='), true);
  assert.equal(new URL(profileUrl).origin, apiBaseUrl);
  assert.equal(new URL(profileUrl).pathname, '/api/auth/me');
});

test('authenticate adds choose_account=1 to the sign-in URL only when chooseAccount is set', async () => {
  const run = async (deps) => {
    let openedUrl = null;
    await authenticate('https://web.example.test', {
      startServer: async () => ({
        server: { close: () => {} },
        port: 43116,
        nonce: 'nonce-choose',
        waitForToken: Promise.resolve({ token: 'user-token' }),
      }),
      browser: async (url) => { openedUrl = url; return true; },
      requestImpl: async () => ({ status: 200, data: { user: {} } }),
      ...deps,
    });
    return new URL(openedUrl);
  };

  const plain = await run({});
  assert.equal(new URLSearchParams(plain.hash.slice(plain.hash.indexOf('?') + 1)).has('choose_account'), false);

  const choose = await run({ chooseAccount: true });
  const params = new URLSearchParams(choose.hash.slice(choose.hash.indexOf('?') + 1));
  assert.equal(params.get('choose_account'), '1');
  // The handoff blob must survive intact next to the extra flag.
  assert.deepEqual(
    JSON.parse(Buffer.from(params.get('d'), 'base64url').toString('utf8')),
    { port: 43116, nonce: 'nonce-choose' },
  );
});

test('project-open re-auth stores the account-wide handoff token without a project-token exchange', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readAccount, writeAccountToken } = require('../server/account-store');
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-open-auth-'));
  t.after(() => fs.rmSync(userDataRoot, { recursive: true, force: true }));
  const token = `header.${Buffer.from(JSON.stringify({ id: 7, purpose: 'desktop' })).toString('base64url')}.signature`;
  const requests = [];
  await authenticateAndStore('https://api.test', {
    startServer: async () => ({
      server: { close() {} }, port: 43210, nonce: 'auth-test',
      waitForToken: Promise.resolve({ token }),
    }),
    browser: async (url) => { assert.match(url, /&choose_account=1$/); return true; },
    requestImpl: async (url) => { requests.push(url); return { status: 200, data: { user: { id: 7 } } }; },
    writeAccountToken: (baseUrl, value) => writeAccountToken(baseUrl, value, { userDataRoot }),
  });
  assert.deepEqual(requests, ['https://api.test/api/auth/me']);
  assert.equal(readAccount('https://api.test', { userDataRoot }).token, token);
  assert.equal(readAccount('https://api.test', { userDataRoot }).userId, 7);
  assert.deepEqual(fs.readdirSync(userDataRoot), ['.tipatask-account.json']);
});

test('failed handoff never replaces the stored account', async () => {
  let saved = false;
  await assert.rejects(authenticateAndStore('https://api.test', {
    startServer: async () => { throw new Error('callback failed'); },
    writeAccountToken: () => { saved = true; },
  }), /callback failed/);
  assert.equal(saved, false);
});
