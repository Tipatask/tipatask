'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The account store defaults to USER_DATA_ROOT; keep this file's tokens in a private dir.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-creds-userdata-'));
const { getApiCredentials, createTokenWatch } = require('./api-credentials');
const { readAccount, writeAccountToken, clearAccountToken } = require('./account-store');

function writeConfig(root, values) {
  fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.tipatask', 'config.json'),
    JSON.stringify(values),
    'utf8'
  );
}

test('credential resolver live-reads config.json (legacy inline token) and rejects a signed-out account', (t) => {
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

  // Signing out (the account store's token is cleared) is what makes the token go missing now.
  clearAccountToken('https://two.example.test');
  writeConfig(root, {
    API_BASE_URL: 'https://two.example.test',
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

test('token comes from the account store; config.json holds only the project target', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-creds-store-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); clearAccountToken('https://store.example.test'); });
  writeAccountToken('https://store.example.test', 'store-token');
  writeConfig(root, { API_BASE_URL: 'https://store.example.test/', API_PROJECT_ID: '4' });

  assert.deepStrictEqual(getApiCredentials(root), {
    baseUrl: 'https://store.example.test',
    token: 'store-token',
    projectId: '4',
  });

  // A second project on the same server reuses the same account token.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-creds-store2-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  writeConfig(other, { API_BASE_URL: 'https://store.example.test', API_PROJECT_ID: '9' });
  assert.strictEqual(getApiCredentials(other).token, 'store-token');

  // Signing out clears it for both.
  clearAccountToken('https://store.example.test');
  assert.throws(() => getApiCredentials(root), /missing API_TOKEN/);
  assert.throws(() => getApiCredentials(other), /missing API_TOKEN/);
});

test('legacy inline config.json token is migrated into the store once and stripped', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-creds-legacy-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); clearAccountToken('https://legacy.example.test'); });
  writeConfig(root, {
    API_BASE_URL: 'https://legacy.example.test',
    API_TOKEN: 'legacy-token',
    API_PROJECT_ID: '2',
    language: 'uk',
  });

  assert.strictEqual(getApiCredentials(root).token, 'legacy-token');
  assert.strictEqual(readAccount('https://legacy.example.test').token, 'legacy-token');
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.tipatask', 'config.json'), 'utf8'));
  assert.ok(!Object.hasOwn(onDisk, 'API_TOKEN'));
  assert.strictEqual(onDisk.language, 'uk', 'other keys survive the strip');
  assert.strictEqual(getApiCredentials(root).token, 'legacy-token', 'still resolves from the store after the strip');
});

test('an older inline token never replaces a store token that outlives it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-creds-older-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); clearAccountToken('https://older.example.test'); });
  const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ id: 1, email: 'a@b.c', exp })).toString('base64url')}.s`;
  const newer = jwt(2000000000);
  const older = jwt(1000000000);
  writeAccountToken('https://older.example.test', newer);
  writeConfig(root, { API_BASE_URL: 'https://older.example.test', API_TOKEN: older, API_PROJECT_ID: '2' });

  assert.strictEqual(getApiCredentials(root).token, newer);
  assert.strictEqual(readAccount('https://older.example.test').token, newer);
});

test('a legacy blank inline token is stripped without signing the account out', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-creds-blank-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); clearAccountToken('https://blank.example.test'); });
  writeAccountToken('https://blank.example.test', 'kept-token');
  writeConfig(root, { API_BASE_URL: 'https://blank.example.test', API_TOKEN: '', API_PROJECT_ID: '2' });

  assert.strictEqual(getApiCredentials(root).token, 'kept-token');
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.tipatask', 'config.json'), 'utf8'));
  assert.ok(!Object.hasOwn(onDisk, 'API_TOKEN'));
});

test('getAccountUserId returns the signed-in id, and null when nobody is signed in', () => {
  const { getAccountUserId } = require('./api-credentials');
  const jwt = (id) => `h.${Buffer.from(JSON.stringify({ id })).toString('base64url')}.s`;
  const base = 'https://uid.example.test';
  assert.strictEqual(getAccountUserId(base), null);
  assert.strictEqual(getAccountUserId(''), null);
  writeAccountToken(base, jwt(42));
  assert.strictEqual(getAccountUserId(base + '/'), 42);
  clearAccountToken(base);
  assert.strictEqual(getAccountUserId(base), null);
});
