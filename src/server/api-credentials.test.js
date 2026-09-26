'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getApiCredentials, createTokenWatch } = require('./api-credentials');

function writeConfig(root, values) {
  fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.tipatask', 'config.json'),
    JSON.stringify(values),
    'utf8'
  );
}

test('credential resolver live-reads config.json and rejects blank token', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-api-creds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeConfig(root, {
    API_BASE_URL: 'https://one.example.test/',
    API_TOKEN: 'token-one',
    API_PROJECT_ID: '2',
  });

  assert.deepStrictEqual(getApiCredentials(root), {
    baseUrl: 'https://one.example.test',
    token: 'token-one',
    projectId: '2',
  });

  writeConfig(root, {
    API_BASE_URL: 'https://two.example.test',
    API_TOKEN: 'token-two',
    API_PROJECT_ID: '3',
  });
  assert.deepStrictEqual(getApiCredentials(root), {
    baseUrl: 'https://two.example.test',
    token: 'token-two',
    projectId: '3',
  });

  writeConfig(root, {
    API_BASE_URL: 'https://two.example.test',
    API_TOKEN: '',
    API_PROJECT_ID: '3',
  });
  assert.throws(() => getApiCredentials(root), /missing API_TOKEN/);
});

// (C1522) createTokenWatch() — the per-caller change signal resetUserContext() hangs off.
test('createTokenWatch fires onChange only on an actual token change, once per change', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-token-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const changes = [];
  const watch = createTokenWatch((token, prev) => changes.push({ token, prev }));

  writeConfig(root, { API_BASE_URL: 'https://a.test', API_TOKEN: 'token-a', API_PROJECT_ID: '1' });
  getApiCredentials(root, { watch });
  assert.deepStrictEqual(changes, [], 'first read is initial load, not a change');

  getApiCredentials(root, { watch });
  assert.deepStrictEqual(changes, [], 'unchanged token on repeat read does not fire');

  writeConfig(root, { API_BASE_URL: 'https://a.test', API_TOKEN: 'token-b', API_PROJECT_ID: '1' });
  getApiCredentials(root, { watch });
  assert.deepStrictEqual(changes, [{ token: 'token-b', prev: 'token-a' }], 'swap fires exactly once');

  getApiCredentials(root, { watch });
  assert.strictEqual(changes.length, 1, 'still the same token — no re-fire');

  writeConfig(root, { API_BASE_URL: 'https://a.test', API_TOKEN: 'token-a', API_PROJECT_ID: '1' });
  getApiCredentials(root, { watch });
  assert.deepStrictEqual(changes, [
    { token: 'token-b', prev: 'token-a' },
    { token: 'token-a', prev: 'token-b' },
  ], 'reverting to a prior token still counts as a change');
});

test('createTokenWatch: a throwing listener never breaks credential resolution', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-token-watch-throw-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const watch = createTokenWatch(() => { throw new Error('listener blew up'); });
  writeConfig(root, { API_BASE_URL: 'https://a.test', API_TOKEN: 'token-a', API_PROJECT_ID: '1' });
  getApiCredentials(root, { watch }); // initial load — no fire, nothing to throw yet

  writeConfig(root, { API_BASE_URL: 'https://a.test', API_TOKEN: 'token-b', API_PROJECT_ID: '1' });
  assert.deepStrictEqual(getApiCredentials(root, { watch }), {
    baseUrl: 'https://a.test',
    token: 'token-b',
    projectId: '1',
  }, 'credentials still resolve correctly despite the listener throwing');
});

test('separate watch instances track independently against the same config', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-token-watch-multi-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aFires = [];
  const bFires = [];
  const watchA = createTokenWatch((token) => aFires.push(token));
  const watchB = createTokenWatch((token) => bFires.push(token));

  writeConfig(root, { API_BASE_URL: 'https://a.test', API_TOKEN: 'token-a', API_PROJECT_ID: '1' });
  getApiCredentials(root, { watch: watchA }); // watchA has now "seen" token-a
  writeConfig(root, { API_BASE_URL: 'https://a.test', API_TOKEN: 'token-b', API_PROJECT_ID: '1' });
  getApiCredentials(root, { watch: watchB }); // watchB's FIRST read — no fire, even though the file already changed underneath it
  assert.deepStrictEqual(bFires, [], 'a watch that never saw the old token treats its first read as initial load');

  getApiCredentials(root, { watch: watchA }); // watchA's second read — sees the swap
  assert.deepStrictEqual(aFires, ['token-b']);
});
