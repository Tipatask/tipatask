'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  STORE_FILE, accountStorePath, normalizeBaseUrl, decodeTokenPayload,
  readAccount, listAccounts, writeAccountToken, clearAccountToken,
  saveAccountForServer, defaultAccountServer,
} = require('./account-store');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-account-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { userDataRoot: dir };
}

function jwt(payload) {
  return `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
}

test('normalizeBaseUrl treats trailing slashes and host case as the same server', () => {
  assert.strictEqual(normalizeBaseUrl('https://Web.Tipatask.com/'), 'https://web.tipatask.com');
  assert.strictEqual(normalizeBaseUrl(' https://web.tipatask.com// '), 'https://web.tipatask.com');
  assert.strictEqual(normalizeBaseUrl('http://127.0.0.1:4454'), 'http://127.0.0.1:4454');
  assert.strictEqual(normalizeBaseUrl(''), '');
  assert.strictEqual(normalizeBaseUrl(undefined), '');
});

test('write/read round-trips and records the user id and email from the token payload', (t) => {
  const opts = scratch(t);
  assert.strictEqual(readAccount('https://a.test', opts), null);
  const token = jwt({ id: 42, email: 'me@example.test', purpose: 'desktop', exp: 2000000000 });
  const written = writeAccountToken('https://a.test/', token, opts);
  assert.strictEqual(written.userId, 42);
  assert.strictEqual(written.email, 'me@example.test');
  assert.strictEqual(written.apiBaseUrl, 'https://a.test');

  const read = readAccount('https://A.test', opts);
  assert.strictEqual(read.token, token);
  assert.strictEqual(read.userId, 42);
  assert.deepStrictEqual(listAccounts(opts).map((a) => a.email), ['me@example.test']);
});

test('an opaque (non-JWT) token is stored with null user id and blank email', (t) => {
  const opts = scratch(t);
  const entry = writeAccountToken('https://a.test', 'opaque', opts);
  assert.strictEqual(entry.userId, null);
  assert.strictEqual(entry.email, '');
  assert.strictEqual(decodeTokenPayload('opaque'), null);
});

test('accounts are kept per API server and cleared independently', (t) => {
  const opts = scratch(t);
  writeAccountToken('https://prod.test', 'prod-token', opts);
  writeAccountToken('https://self.test', 'self-token', opts);
  assert.strictEqual(readAccount('https://prod.test', opts).token, 'prod-token');
  assert.strictEqual(readAccount('https://self.test', opts).token, 'self-token');

  assert.strictEqual(clearAccountToken('https://prod.test', opts), true);
  assert.strictEqual(readAccount('https://prod.test', opts), null);
  assert.strictEqual(readAccount('https://self.test', opts).token, 'self-token');
  assert.strictEqual(clearAccountToken('https://prod.test', opts), false, 'clearing twice is a no-op');
});

test('the store file is owner-only and written atomically (no temp file left)', (t) => {
  const opts = scratch(t);
  writeAccountToken('https://a.test', 'tok', opts);
  const file = accountStorePath(opts);
  assert.strictEqual(path.basename(file), STORE_FILE);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(opts.userDataRoot), [STORE_FILE]);
});

test('write rejects a missing base URL or blank token; a corrupt file reads as empty', (t) => {
  const opts = scratch(t);
  assert.throws(() => writeAccountToken('', 'tok', opts), /base URL/);
  assert.throws(() => writeAccountToken('https://a.test', '  ', opts), /token/);
  fs.writeFileSync(accountStorePath(opts), '{not json', 'utf8');
  assert.strictEqual(readAccount('https://a.test', opts), null);
  // and a good write recovers it
  writeAccountToken('https://a.test', 'tok', opts);
  assert.strictEqual(readAccount('https://a.test', opts).token, 'tok');
});

test('TIPATASK_USER_DATA selects the store location when no explicit root is given', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-account-env-'));
  const prev = process.env.TIPATASK_USER_DATA;
  process.env.TIPATASK_USER_DATA = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.TIPATASK_USER_DATA; else process.env.TIPATASK_USER_DATA = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  writeAccountToken('https://env.test', 'env-token');
  assert.strictEqual(accountStorePath(), path.join(path.resolve(dir), STORE_FILE));
  assert.strictEqual(readAccount('https://env.test').token, 'env-token');
});

test('saveAccountForServer prefers the hydrated user id/email and falls back to the token payload', (t) => {
  const opts = scratch(t);
  const token = jwt({ id: 1, email: 'old@example.test', purpose: 'desktop' });
  const explicit = saveAccountForServer('https://a.test/', { token, userId: 7, email: 'new@example.test' }, opts);
  assert.strictEqual(explicit.userId, 7);
  assert.strictEqual(explicit.email, 'new@example.test');
  assert.strictEqual(explicit.apiBaseUrl, 'https://a.test');
  const onDisk = JSON.parse(fs.readFileSync(accountStorePath(opts), 'utf8')).accounts['https://a.test'];
  assert.strictEqual(onDisk.userId, 7);
  assert.strictEqual(onDisk.email, 'new@example.test');

  const fallback = saveAccountForServer('https://a.test', { token }, opts);
  assert.strictEqual(fallback.userId, 1);
  assert.strictEqual(fallback.email, 'old@example.test');
  assert.throws(() => saveAccountForServer('https://a.test', { token: ' ' }, opts), /token/);
  assert.throws(() => saveAccountForServer('', { token }, opts), /base URL/);
});

test('defaultAccountServer returns the most recently signed-in server, or blank when none', (t) => {
  const opts = scratch(t);
  assert.strictEqual(defaultAccountServer(opts), '');
  fs.writeFileSync(accountStorePath(opts), JSON.stringify({
    version: 1,
    accounts: {
      'https://old.test': { token: 'a', apiBaseUrl: 'https://old.test', updatedAt: '2026-01-01T00:00:00.000Z' },
      'https://new.test': { token: 'b', apiBaseUrl: 'https://new.test', updatedAt: '2026-06-01T00:00:00.000Z' },
      'https://gone.test': { token: '', apiBaseUrl: 'https://gone.test', updatedAt: '2026-09-01T00:00:00.000Z' },
    },
  }));
  assert.strictEqual(defaultAccountServer(opts), 'https://new.test');
});
