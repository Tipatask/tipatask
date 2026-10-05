'use strict';

// (C1383) Pure unit tests for auth-guard.js — no network, no filesystem beyond the
// scratch config.json validateCredentials() needs. See auth-fail-closed.test.js for the
// end-to-end fail-closed behavior against a fake API server.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-auth-guard-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));

const {
  AuthCorruptedError,
  SEALING_REASONS,
  REFRESH_MARGIN_MS,
  MIN_LAUNCH_MS,
  decodeJwtPayload,
  tokenExpiryMs,
  formatTokenExpiry,
  inspectToken,
  validateCredentials,
  assertCredentialsUsable,
} = require('./auth-guard');

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJwt(payload, header = { alg: 'HS256', typ: 'JWT' }) {
  return `${b64url(header)}.${b64url(payload)}.sig-not-checked-client-side`;
}

function writeConfig(root, cfg) { require('./project-config').writeProjectConfig(root, cfg); }

// ── AuthCorruptedError ──

test('AuthCorruptedError is a real Error subclass with code EAUTH and authError=true (back-compat)', () => {
  const e = new AuthCorruptedError('token expired', { reasonCode: 'expired', statusCode: 401 });
  assert.ok(e instanceof Error);
  assert.strictEqual(e.name, 'AuthCorruptedError');
  assert.strictEqual(e.code, 'EAUTH');
  assert.strictEqual(e.reasonCode, 'expired');
  assert.strictEqual(e.statusCode, 401);
  // init() (api-backend.js) and main/window-state.js's backend.init().catch both branch
  // on err.authError — this flag must survive the new error type.
  assert.strictEqual(e.authError, true);
  assert.strictEqual(e.message, 'token expired');
});

// ── decodeJwtPayload ──

test('decodeJwtPayload decodes a real 3-segment JWT payload', () => {
  const token = makeJwt({ id: 1, exp: 9999999999 });
  assert.deepStrictEqual(decodeJwtPayload(token), { id: 1, exp: 9999999999 });
});

test('decodeJwtPayload returns null for garbage input', () => {
  assert.strictEqual(decodeJwtPayload('not-a-jwt'), null);
  assert.strictEqual(decodeJwtPayload(''), null);
  assert.strictEqual(decodeJwtPayload(null), null);
  assert.strictEqual(decodeJwtPayload(undefined), null);
  assert.strictEqual(decodeJwtPayload('a.b'), null); // only 2 segments
  assert.strictEqual(decodeJwtPayload('a.b.c.d'), null); // 4 segments
});

test('decodeJwtPayload returns null when the payload segment is not valid JSON', () => {
  const notJson = Buffer.from('not-json', 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.strictEqual(decodeJwtPayload(`aaa.${notJson}.bbb`), null);
});

// ── inspectToken — every reason code ──

test('inspectToken: missing token → not ok, reasonCode missing', () => {
  assert.deepStrictEqual(inspectToken(''), { ok: false, reason: 'API_TOKEN missing', reasonCode: 'missing' });
  assert.deepStrictEqual(inspectToken(null), { ok: false, reason: 'API_TOKEN missing', reasonCode: 'missing' });
});

test('inspectToken: opaque (non-JWT) token → ok, reasonCode undecodable (permissive)', () => {
  const v = inspectToken('opaque-token-not-a-jwt');
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.reasonCode, 'undecodable');
});

test('inspectToken: 3-segment but undecodable payload → not ok, reasonCode malformed', () => {
  const v = inspectToken('aaa.not-valid-base64-json.bbb');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reasonCode, 'malformed');
});

test('inspectToken: valid JWT with no exp claim → ok, reasonCode no-exp (permissive)', () => {
  const token = makeJwt({ id: 1 });
  const v = inspectToken(token);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.reasonCode, 'no-exp');
});

test('inspectToken: exp in the future → ok, reasonCode ok', () => {
  const token = makeJwt({ id: 1, exp: Math.floor(Date.now() / 1000) + 3600 });
  const v = inspectToken(token);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.reasonCode, 'ok');
});

test('inspectToken: exp in the past → not ok, reasonCode expired', () => {
  const token = makeJwt({ id: 1, exp: Math.floor(Date.now() / 1000) - 3600 });
  const v = inspectToken(token);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reasonCode, 'expired');
  assert.match(v.reason, /expired/);
});

test('inspectToken: skewMs tolerates a token that just expired', () => {
  const now = Date.now();
  const token = makeJwt({ id: 1, exp: Math.floor((now - 1000) / 1000) }); // expired 1s ago
  const v = inspectToken(token, { now, skewMs: 5000 });
  assert.strictEqual(v.ok, true, 'within skew tolerance');
});

// ── SEALING_REASONS ──

test('SEALING_REASONS covers expired and malformed, excludes missing (unconfigured project must reach setup)', () => {
  assert.ok(SEALING_REASONS.has('expired'));
  assert.ok(SEALING_REASONS.has('malformed'));
  assert.ok(!SEALING_REASONS.has('missing'));
  assert.ok(!SEALING_REASONS.has('undecodable'));
  assert.ok(!SEALING_REASONS.has('no-exp'));
  assert.ok(!SEALING_REASONS.has('ok'));
});

// ── validateCredentials(projectRoot) — sync, never throws ──

test('validateCredentials: missing config.json → ok:false, reasonCode missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-auth-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const v = validateCredentials(root);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reasonCode, 'missing');
});

test('validateCredentials: blank API_TOKEN → ok:false, reasonCode missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-auth-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeConfig(root, { API_BASE_URL: 'https://a.test', API_TOKEN: '', API_PROJECT_ID: '1' });
  const v = validateCredentials(root);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reasonCode, 'missing');
});

test('validateCredentials: expired JWT in config.json → ok:false, reasonCode expired', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-auth-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const token = makeJwt({ id: 1, exp: Math.floor(Date.now() / 1000) - 3600 });
  writeConfig(root, { API_BASE_URL: 'https://a.test', API_TOKEN: token, API_PROJECT_ID: '1' });
  const v = validateCredentials(root);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reasonCode, 'expired');
});

test('validateCredentials: valid unexpired JWT → ok:true', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-auth-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const token = makeJwt({ id: 1, exp: Math.floor(Date.now() / 1000) + 3600 });
  writeConfig(root, { API_BASE_URL: 'https://a.test', API_TOKEN: token, API_PROJECT_ID: '1' });
  const v = validateCredentials(root);
  assert.strictEqual(v.ok, true);
});

// ── assertCredentialsUsable(backend) — the terminal-session.js pre-spawn gate ──
// Stub backends here, not a real api-backend instance — this proves the gate's own
// logic (latch check → getCredentials() → inspectToken()) in isolation, independent of
// HTTP. The real spawn-before-launch ordering is covered by terminal-session.js's own
// placement (before pty.spawn) and by auth-fail-closed.test.js's factory-seal coverage.

function stubBackend({ connectionState = null, token = 'valid-opaque-token', throwOnCredentials = null } = {}) {
  return {
    getConnectionState: () => connectionState,
    getCredentials: () => {
      if (throwOnCredentials) throw throwOnCredentials;
      return { baseUrl: 'https://a.test', token, projectId: '1' };
    },
  };
}

test('assertCredentialsUsable: latched unauthorized → throws AuthCorruptedError, code EAUTH', async () => {
  const backend = stubBackend({ connectionState: 'unauthorized' });
  await assert.rejects(() => assertCredentialsUsable(backend), (err) => {
    assert.ok(err instanceof AuthCorruptedError);
    assert.strictEqual(err.code, 'EAUTH');
    return true;
  });
});

test('assertCredentialsUsable: missing credentials → throws AuthCorruptedError', async () => {
  const missing = new Error('API not configured for this project (missing API_TOKEN in .tipatask/config.json)');
  missing.missingCredentials = true;
  const backend = stubBackend({ throwOnCredentials: missing });
  await assert.rejects(() => assertCredentialsUsable(backend), (err) => {
    assert.ok(err instanceof AuthCorruptedError);
    assert.strictEqual(err.code, 'EAUTH');
    assert.strictEqual(err.reasonCode, 'missing');
    return true;
  });
});

test('assertCredentialsUsable: locally-expired JWT → throws AuthCorruptedError', async () => {
  const token = makeJwt({ id: 1, exp: Math.floor(Date.now() / 1000) - 3600 });
  const backend = stubBackend({ token });
  await assert.rejects(() => assertCredentialsUsable(backend), (err) => {
    assert.ok(err instanceof AuthCorruptedError);
    assert.strictEqual(err.reasonCode, 'expired');
    return true;
  });
});

test('assertCredentialsUsable: valid unexpired token → resolves (no throw)', async () => {
  const token = makeJwt({ id: 1, exp: Math.floor(Date.now() / 1000) + 3600 });
  const backend = stubBackend({ token });
  await assert.doesNotReject(() => assertCredentialsUsable(backend));
});

test('assertCredentialsUsable: opaque non-JWT token → resolves (permissive — can\'t judge locally)', async () => {
  const backend = stubBackend({ token: 'opaque-server-issued-token' });
  await assert.doesNotReject(() => assertCredentialsUsable(backend));
});

// ── (TPT349) expiry margin: refresh a dying token before launch, name the expiry time ──

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const jwtExpiringIn = (ms) => makeJwt({ id: 1, project_id: 2, exp: Math.floor((NOW + ms) / 1000) });

test('tokenExpiryMs: epoch ms for a JWT with exp, null for opaque / no-exp / undecodable', () => {
  assert.strictEqual(tokenExpiryMs(makeJwt({ exp: 1_800_000_000 })), 1_800_000_000_000);
  assert.strictEqual(tokenExpiryMs(makeJwt({ id: 1 })), null);
  assert.strictEqual(tokenExpiryMs('opaque-token'), null);
  assert.strictEqual(tokenExpiryMs(''), null);
  assert.strictEqual(tokenExpiryMs(undefined), null);
});

test('formatTokenExpiry: HH:MM on the same local day, date-prefixed otherwise', () => {
  const at = new Date(2026, 8, 24, 9, 5).getTime();
  assert.strictEqual(formatTokenExpiry(at, new Date(2026, 8, 24, 8, 0).getTime()), '09:05');
  assert.strictEqual(formatTokenExpiry(at, new Date(2026, 8, 23, 8, 0).getTime()), '2026-09-24 09:05');
});

test('assertCredentialsUsable: expired token message names the expiry time', async () => {
  const exp = NOW - 30 * MIN;
  const backend = stubBackend({ token: jwtExpiringIn(-30 * MIN) });
  await assert.rejects(() => assertCredentialsUsable(backend, { now: NOW }), (err) => {
    assert.ok(err instanceof AuthCorruptedError);
    assert.strictEqual(err.reasonCode, 'expired');
    assert.ok(err.message.startsWith('API token expired at '), err.message);
    assert.ok(err.message.includes(formatTokenExpiry(exp, NOW)), err.message);
    return true;
  });
});

test('assertCredentialsUsable: 5 minutes left + successful refresh → refreshed, refresh called with live credentials', async () => {
  const token = jwtExpiringIn(5 * MIN);
  const fresh = jwtExpiringIn(7 * 24 * 60 * MIN);
  const calls = [];
  const res = await assertCredentialsUsable(stubBackend({ token }), {
    now: NOW,
    refresh: async (creds) => { calls.push(creds); return { token: fresh }; },
  });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], { baseUrl: 'https://a.test', token, projectId: '1' });
  assert.strictEqual(res.refreshed, true);
  assert.strictEqual(res.expiresAt, tokenExpiryMs(fresh));
  assert.strictEqual(res.previousExpiresAt, tokenExpiryMs(token));
});

test('assertCredentialsUsable: 5 minutes left + failed refresh → blocks with "expires at" (reasonCode expiring)', async () => {
  const token = jwtExpiringIn(5 * MIN);
  await assert.rejects(
    () => assertCredentialsUsable(stubBackend({ token }), { now: NOW, refresh: async () => { throw new Error('token refresh rejected (HTTP 503)'); } }),
    (err) => {
      assert.ok(err instanceof AuthCorruptedError);
      assert.strictEqual(err.code, 'EAUTH');
      assert.strictEqual(err.reasonCode, 'expiring');
      assert.ok(err.message.startsWith(`API token expires at ${formatTokenExpiry(NOW + 5 * MIN, NOW)}`), err.message);
      assert.ok(err.message.includes('HTTP 503'), err.message);
      return true;
    });
});

test('assertCredentialsUsable: refresh that returns no newer token counts as a failure', async () => {
  const token = jwtExpiringIn(5 * MIN);
  await assert.rejects(
    () => assertCredentialsUsable(stubBackend({ token }), { now: NOW, refresh: async () => ({ token }) }),
    (err) => err.reasonCode === 'expiring');
});

test('assertCredentialsUsable: 20h left + failed refresh → launches with a warning, not an error', async () => {
  const token = jwtExpiringIn(20 * 60 * MIN);
  const res = await assertCredentialsUsable(stubBackend({ token }), { now: NOW, refresh: async () => { throw new Error('offline'); } });
  assert.strictEqual(res.refreshed, false);
  assert.strictEqual(res.expiresAt, tokenExpiryMs(token));
  assert.match(res.warning, /API token expires at .* could not be refreshed \(offline\)/);
});

test('assertCredentialsUsable: no refresh hook — under MIN_LAUNCH blocks, above it resolves quietly', async () => {
  await assert.rejects(
    () => assertCredentialsUsable(stubBackend({ token: jwtExpiringIn(5 * MIN) }), { now: NOW }),
    (err) => err.reasonCode === 'expiring' && /^API token expires at /.test(err.message));
  const res = await assertCredentialsUsable(stubBackend({ token: jwtExpiringIn(2 * 60 * MIN) }), { now: NOW });
  assert.strictEqual(res.refreshed, false);
  assert.strictEqual(res.warning, null);
});

test('assertCredentialsUsable: more than the refresh margin left → refresh never called', async () => {
  let called = false;
  const token = jwtExpiringIn(REFRESH_MARGIN_MS + MIN);
  const res = await assertCredentialsUsable(stubBackend({ token }), { now: NOW, refresh: async () => { called = true; return { token }; } });
  assert.strictEqual(called, false);
  assert.strictEqual(res.refreshed, false);
  assert.ok(MIN_LAUNCH_MS < REFRESH_MARGIN_MS);
});

test('assertCredentialsUsable: opaque and no-exp tokens are never refreshed', async () => {
  let called = false;
  const refresh = async () => { called = true; return { token: 'x' }; };
  for (const token of ['opaque-server-issued-token', makeJwt({ id: 1 })]) {
    const res = await assertCredentialsUsable(stubBackend({ token }), { now: NOW, refresh });
    assert.strictEqual(res.refreshed, false);
    assert.strictEqual(res.expiresAt, null);
  }
  assert.strictEqual(called, false);
});

module.exports = { makeJwt, writeConfig };
