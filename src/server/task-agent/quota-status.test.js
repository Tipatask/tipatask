'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { normalizeQuota, quotaError, coalesceQuota } = require('./quota-status');
const { readClaudeQuota, credentialLocation, readClaudeCredential, parseClaudeUsage } = require('./claude-quota');
const { readCodexQuota, openQuotaRpc } = require('./codex-quota');
const { getAgentQuotaStatus } = require('./index');

const cfg = { PROJECT_ROOT: '/project-a', CLAUDE_BIN: '/cli/claude', CODEX_BIN: '/cli/codex' };
const auth = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' };
const claudeDeps = (overrides = {}) => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret', OPENAI_API_KEY: 'wrong-provider-secret' },
  runFile: async () => JSON.stringify(auth),
  fetch: async () => Response.json({ five_hour: { utilization: 6, resets_at: '2026-09-24T18:00:00Z' }, seven_day: { utilization: 100, resets_at: null }, seven_day_opus: null }), ...overrides });
const normalizedClaude = async opts => normalizeQuota('claude', cfg.PROJECT_ROOT, await readClaudeQuota(cfg, claudeDeps(opts)));

test('Claude reads subscription metadata only, preserves windows, and does not leak credentials', async () => {
  const result = await normalizedClaude({ fetch: async (url, opts) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(opts.method, 'GET');
    assert.equal(opts.headers.Authorization, 'Bearer claude-secret');
    assert.equal(opts.redirect, 'error');
    assert.equal(opts.body, undefined);
    return Response.json({ five_hour: { utilization: 6, resets_at: '2026-09-24T18:00:00Z' }, seven_day: { utilization: 100, resets_at: null }, extra_usage: { utilization: 200 } });
  } });
  assert.equal(result.plan, 'max');
  assert.equal(result.connectionState, 'connected');
  assert.equal(result.status, 'exhausted');
  assert.deepEqual(result.windows.map(w => w.usagePercent), [6, 100]);
  assert.equal(result.windows[0].resetAt, '2026-09-24T18:00:00.000Z');
  assert.equal(result.windows[1].resetAt, null);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('Claude signed out and API-key modes never read subscription credentials or fetch quota', async () => {
  for (const [state, reason] of [[{ loggedIn: false }, 'signed_out'], [{ ...auth, authMethod: 'api_key' }, 'unsupported_auth']]) {
    const result = await normalizedClaude({ runFile: async () => JSON.stringify(state), fetch: () => assert.fail('must not fetch') });
    assert.equal(result.unavailableReason, reason);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.windows, []);
  }
});

test('Claude HTTP failures, malformed responses and timeouts have typed reasons, never fake zero usage', async () => {
  for (const [status, reason] of [[401, 'credentials_expired'], [403, 'access_denied'], [429, 'rate_limited'], [500, 'provider_error']]) {
    const result = await normalizedClaude({ fetch: async () => new Response('secret error body', { status }) });
    assert.equal(result.unavailableReason, reason);
    assert.deepEqual(result.windows, []);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
  for (const payload of [null, {}, { five_hour: { utilization: '6' } }, { five_hour: { utilization: -1 } }]) {
    assert.equal((await normalizedClaude({ fetch: async () => Response.json(payload) })).unavailableReason, 'invalid_response');
  }
  assert.equal((await normalizedClaude({ fetch: async () => { throw new DOMException('secret', 'TimeoutError'); } })).unavailableReason, 'timeout');
  assert.equal((await normalizedClaude({ runFile: async () => 'unexpected output' })).unavailableReason, 'invalid_response');
  assert.equal((await normalizedClaude({ runFile: async () => { throw Object.assign(new Error('secret'), { code: 'ENOENT' }); } })).unavailableReason, 'cli_missing');
});

test('Claude null windows and missing measurements stay unavailable', async () => {
  for (const payload of [{ five_hour: null, seven_day: null }, { five_hour: { utilization: null, resets_at: null } }]) {
    const result = await normalizedClaude({ fetch: async () => Response.json(payload) });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.unavailableReason, 'quota_unavailable');
    assert.ok(result.windows.every(w => w.usagePercent === null && w.exhausted === null));
  }
});

// Shape of the real usage endpoint on 2026-09-24: legacy per-model keys are null and codename
// experiment keys are mixed in; the Fable weekly limit exists only in the structured `limits[]`.
const livePayload = () => ({
  five_hour: { utilization: 0, resets_at: '2026-09-24T20:00:00.290738+00:00', limit_dollars: null },
  seven_day: { utilization: 0, resets_at: '2026-10-01T17:00:00.290758+00:00', limit_dollars: null },
  seven_day_oauth_apps: null, seven_day_opus: null, seven_day_sonnet: null, seven_day_cowork: null,
  nimbus_quill: { utilization: 0, resets_at: null }, extra_usage: { is_enabled: false, utilization: 0 },
  limits: [
    { kind: 'session', group: 'session', percent: 0, resets_at: '2026-09-24T20:00:00.290738+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 0, resets_at: '2026-10-01T17:00:00.290758+00:00', scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: '2026-10-01T17:00:00+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
  ],
});

test('Claude live-shaped payload yields the session, weekly and Fable windows, with true zero kept as zero', () => {
  const windows = parseClaudeUsage(livePayload());
  assert.deepEqual(windows.map(w => [w.id, w.usagePercent, w.windowMinutes]),
    [['five_hour', 0, 300], ['seven_day', 0, 10080], ['seven_day_fable', 0, 10080]]);
  const normalized = normalizeQuota('claude', cfg.PROJECT_ROOT, { connectionState: 'connected', windows });
  assert.equal(normalized.status, 'available', 'a measured 0% is available usage, not unavailable');
  assert.ok(normalized.windows.every(w => w.usagePercent === 0 && w.exhausted === false));
});

test('Claude legacy windows stay authoritative; limits[] only adds missing per-model weekly windows', () => {
  // Legacy per-model window present: limits[] must not add a duplicate (opus is shown as Fable).
  const withOpus = { ...livePayload(), seven_day_opus: { utilization: 41, resets_at: '2026-10-01T17:00:00Z' } };
  assert.deepEqual(parseClaudeUsage(withOpus).map(w => [w.id, w.usagePercent]),
    [['five_hour', 0], ['seven_day', 0], ['seven_day_opus', 41]]);
  // Legacy values win over a disagreeing limits[] entry.
  const disagree = livePayload();
  disagree.five_hour.utilization = 12;
  disagree.limits[0].percent = 99;
  assert.equal(parseClaudeUsage(disagree)[0].usagePercent, 12);
  // No limits[] at all: exactly the legacy behaviour.
  const { limits, ...legacyOnly } = livePayload();
  assert.deepEqual(parseClaudeUsage(legacyOnly).map(w => w.id), ['five_hour', 'seven_day']);
});

test('Claude limits[] alone supplies the windows when the legacy keys are gone; unknown or malformed entries are skipped', () => {
  const limitsOnly = { limits: [
    { kind: 'session', percent: 7.5, resets_at: '2026-09-24T20:00:00Z' },
    { kind: 'weekly_all', percent: 30, resets_at: '2026-10-01T17:00:00Z' },
    { kind: 'weekly_scoped', percent: 55, resets_at: null, scope: { model: { id: null, display_name: 'Claude Sonnet 4.5' } } },
    { kind: 'weekly_scoped', percent: 60, scope: { model: { display_name: 'claude sonnet 4.5' } } },
    { kind: 'weekly_scoped', percent: 10, scope: null },
    { kind: 'weekly_scoped', percent: null, scope: { model: { display_name: 'Nulled' } } },
    { kind: 'weekly_scoped', percent: 'x', scope: { model: { display_name: 'Bad' } } },
    { kind: 'daily', percent: 5 },
    null, 'oops',
  ] };
  assert.deepEqual(parseClaudeUsage(limitsOnly).map(w => [w.id, w.usagePercent]),
    [['five_hour', 7.5], ['seven_day', 30], ['seven_day_claude_sonnet_4_5', 55]]);
  // Nothing usable anywhere is still an invalid response, never a fake zero.
  for (const payload of [{ limits: [] }, { limits: [{ kind: 'session', percent: 'x' }] }, { limits: 'nope' }]) {
    assert.throws(() => parseClaudeUsage(payload), { quotaReason: 'invalid_response' });
  }
  // A scoped id always fits the 80-char window-id allowlist enforced by normalizeQuota.
  const long = parseClaudeUsage({ limits: [{ kind: 'weekly_scoped', percent: 1, scope: { model: { display_name: 'M'.repeat(200) } } }] });
  assert.ok(normalizeQuota('claude', '/p', { connectionState: 'connected', windows: long }).windows.length === 1);
});

test('Claude explicit OAuth token uses that token, while custom OAuth origins cannot read default account credentials', async () => {
  const token = await normalizedClaude({ runFile: async () => JSON.stringify({ ...auth, authMethod: 'oauth_token', subscriptionType: undefined }) });
  assert.equal(token.connectionState, 'connected');
  assert.equal(token.unavailableReason, null);
  assert.equal(token.plan, null);
  const custom = await normalizedClaude({ env: { CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://custom.example', CLAUDE_CODE_OAUTH_TOKEN: 'secret' }, fetch: () => assert.fail('custom credential must not reach default origin') });
  assert.equal(custom.unavailableReason, 'unsupported_auth');
  const expired = await normalizedClaude({ env: {}, platform: 'linux', readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'expired', expiresAt: 1 } }), fetch: () => assert.fail('expired token must not be sent') });
  assert.equal(expired.unavailableReason, 'credentials_expired');
});

test('Claude credential stores follow config scope and deny stale file fallback on Keychain errors', async () => {
  const a = credentialLocation({ CLAUDE_CONFIG_DIR: '/profile-a' }, '/profile-a', '/home/test');
  const b = credentialLocation({ CLAUDE_CONFIG_DIR: '/profile-b' }, '/profile-b', '/home/test');
  assert.notEqual(a.service, b.service);
  assert.equal(a.file, '/profile-a/.credentials.json');
  assert.equal(credentialLocation({}, null, '/home/test').service, 'Claude Code-credentials');
  assert.equal(credentialLocation({ CLAUDE_CONFIG_DIR: '/profile-a', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }, null, '/home/test').file, '/home/test/.claude/.credentials.json');
  await assert.rejects(readClaudeCredential({}, {}, { platform: 'darwin', runFile: async () => { throw Object.assign(new Error(), { code: 36 }); }, readFile: () => assert.fail('locked Keychain cannot use stale file') }), { quotaReason: 'credentials_unavailable' });
  const credential = await readClaudeCredential({ CLAUDE_CONFIG_DIR: '/profile-a' }, {}, { platform: 'linux', readFile: async file => {
    assert.equal(file, a.file); return JSON.stringify({ claudeAiOauth: { accessToken: 'only-claude' } });
  } });
  assert.equal(credential.accessToken, 'only-claude');
});

function codexDeps({ account = { type: 'chatgpt', planType: 'pro', email: 'a@example.test' }, data, error } = {}) {
  const calls = [], scopes = [];
  let closed = 0;
  return { calls, scopes, get closed() { return closed; }, env: { CODEX_HOME: '/wrong-project', ANTHROPIC_API_KEY: 'wrong-provider' },
    openRpc(bin, env, root) {
      scopes.push({ bin, home: env.CODEX_HOME, root });
      return { initialized() { calls.push('initialized'); }, close() { closed++; }, async request(method) {
        calls.push(method);
        if (method === 'initialize') return {};
        if (method === 'account/read') return { account };
        if (error) throw error;
        return data || { rateLimitsByLimitId: { codex: { primary: { usedPercent: 63, windowDurationMins: 10080, resetsAt: 1790256705 }, secondary: null } } };
      } };
    } };
}

test('Codex reads account then limits in project home, without starting inference; primary may be weekly', async () => {
  const deps = codexDeps();
  const result = normalizeQuota('codex', '/project-b', await readCodexQuota(cfg, { ...deps, projectRoot: '/project-b' }));
  assert.deepEqual(deps.calls, ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  assert.equal(deps.scopes[0].home, '/project-b/.codex');
  assert.equal(deps.scopes[0].root, '/project-b');
  assert.equal(result.windows[0].usagePercent, 63);
  assert.equal(result.windows[0].windowMinutes, 10080);
  assert.equal(result.windows[0].resetAt, '2026-09-24T13:31:45.000Z');
  assert.equal(result.status, 'available');
  assert.equal(deps.closed, 1);
  assert.equal(JSON.stringify(result).includes('example.test'), false);
});

test('Codex signed out, unsupported auth, provider errors and exhausted secondary limits normalize consistently', async () => {
  for (const [account, reason] of [[null, 'signed_out'], [{ type: 'apiKey' }, 'unsupported_auth']]) {
    const deps = codexDeps({ account });
    const result = await readCodexQuota(cfg, deps);
    assert.equal(result.unavailableReason, reason);
    assert.equal(deps.calls.includes('account/rateLimits/read'), false);
    assert.equal(deps.closed, 1);
  }
  for (const reason of ['timeout', 'provider_error', 'credentials_expired']) {
    const result = await readCodexQuota(cfg, codexDeps({ error: quotaError(reason) }));
    assert.equal(result.connectionState, 'connected');
    assert.equal(result.unavailableReason, reason);
  }
  const result = normalizeQuota('codex', cfg.PROJECT_ROOT, await readCodexQuota(cfg, codexDeps({ data: { rateLimits: {
    primary: { usedPercent: 10, windowDurationMins: 300 }, secondary: { usedPercent: 100, windowDurationMins: 10080 } } } })));
  assert.equal(result.status, 'exhausted');
  assert.deepEqual(result.windows.map(w => w.usagePercent), [10, 100]);
  assert.equal((await readCodexQuota(cfg, codexDeps({ data: {} }))).unavailableReason, 'invalid_response');
});

test('registry never falls back to Claude for unsupported provider IDs', async () => {
  for (const id of ['pi', 'gemini', '__proto__', 'constructor', '']) {
    const result = await getAgentQuotaStatus(id, cfg);
    assert.equal(result.provider, id);
    assert.equal(result.connectionState, 'unsupported');
    assert.equal(result.unavailableReason, 'unsupported_provider');
  }
});

test('coalescing shares simultaneous credential reads only; new credentials/projects and subsequent reads are fresh', async () => {
  let release, reads = 0;
  const gate = new Promise(r => { release = r; });
  const read = async () => { reads++; await gate; return reads; };
  const a = coalesceQuota('projectA:credentialA', read);
  const b = coalesceQuota('projectA:credentialA', read);
  const c = coalesceQuota('projectA:credentialB', read);
  const d = coalesceQuota('projectB:credentialA', read);
  await Promise.resolve();
  assert.equal(reads, 3);
  assert.equal(a, b);
  release(); await Promise.all([a,b,c,d]);
  await coalesceQuota('projectA:credentialA', read);
  assert.equal(reads, 4);
});

function fakeChild(reply) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
  child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('exit', 0)); };
  child.stdin = new Writable({ write(chunk, encoding, done) { reply(JSON.parse(chunk.toString()), child); done(); } });
  return child;
}

test('Codex RPC handles split frames, ignores notifications, and cleans up its child', async () => {
  const child = fakeChild((msg, c) => {
    const line = JSON.stringify({ id: msg.id, result: { account: null } }) + '\n';
    c.stdout.write('{"method":"account/updated","params":{}}\n');
    c.stdout.write(line.slice(0, 12)); c.stdout.write(line.slice(12));
  });
  const rpc = openQuotaRpc('/codex', {}, '/project', { spawnImpl: () => child });
  assert.deepEqual(await rpc.request('account/read'), { account: null });
  rpc.close();
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('Codex RPC bounds stalled and malformed providers and discards secret error text', async () => {
  for (const mode of ['timeout', 'bad-json', 'null-json', 'rpc-error', 'expired']) {
    const child = fakeChild((msg, c) => {
      if (mode === 'bad-json') c.stdout.write('bad\n');
      if (mode === 'null-json') c.stdout.write('null\n');
      if (mode === 'rpc-error') c.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'secret' } }) + '\n');
      if (mode === 'expired') c.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: '401 Unauthorized Bearer secret' } }) + '\n');
    });
    const rpc = openQuotaRpc('/codex', {}, '/project', { spawnImpl: () => child, timeoutMs: 20 });
    await assert.rejects(rpc.request('account/read'), error => {
      assert.equal(error.quotaReason, { timeout: 'timeout', 'bad-json': 'invalid_response', 'null-json': 'invalid_response', 'rpc-error': 'provider_error', expired: 'credentials_expired' }[mode]);
      assert.equal(error.message.includes('secret'), false); return true;
    });
    rpc.close();
    assert.ok(child.kills.includes('SIGTERM'));
  }
});

test('Codex RPC handles spawn failure, early exit and oversized output without an unhandled error', async () => {
  for (const mode of ['spawn-error', 'early-exit', 'oversized']) {
    const child = fakeChild((msg, c) => {
      if (mode === 'spawn-error') queueMicrotask(() => c.emit('error', Object.assign(new Error('secret path'), { code: 'ENOENT' })));
      if (mode === 'early-exit') queueMicrotask(() => c.emit('exit', 1));
      if (mode === 'oversized') c.stdout.write('x'.repeat(1024 * 1024 + 1));
    });
    const rpc = openQuotaRpc('/codex', {}, '/project', { spawnImpl: () => child });
    await assert.rejects(rpc.request('initialize'), error => {
      assert.equal(mode === 'spawn-error' ? error.code : error.quotaReason,
        { 'spawn-error': 'ENOENT', 'early-exit': 'provider_error', oversized: 'invalid_response' }[mode]);
      return true;
    });
    rpc.close();
  }
});

test('Codex simultaneous account changes cannot join another account quota read', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const deps = email => ({ env: {}, openRpc: () => ({
    initialized() {}, close() {}, async request(method) {
      if (method === 'account/read') return { account: { type: 'chatgpt', email, planType: 'pro' } };
      if (method === 'account/rateLimits/read') { await gate; return { rateLimits: { primary: { usedPercent: email === 'a' ? 20 : 80 } } }; }
      return {};
    },
  }) });
  const a = readCodexQuota(cfg, deps('a')), b = readCodexQuota(cfg, deps('b'));
  release();
  assert.deepEqual((await Promise.all([a,b])).map(r => r.windows[0].usagePercent), [20, 80]);
});
