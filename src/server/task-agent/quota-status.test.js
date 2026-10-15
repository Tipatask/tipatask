'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { normalizeQuota, quotaError, coalesceQuota, staleQuota, clearQuotaSnapshots, loadQuotaSnapshots,
  SNAPSHOT_FILE, SNAPSHOT_MAX_AGE_MS } = require('./quota-status');
const { readClaudeQuota, credentialLocation, readClaudeCredential, parseClaudeUsage, runFile, quotaTimeoutMs,
  retryAfterMs, resetUsageGate, USER_AGENT, MIN_INTERVAL_MS, DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS } = require('./claude-quota');
const { readCodexQuota, openQuotaRpc } = require('./codex-quota');
const { getAgentQuotaStatus } = require('./index');

const cfg = { PROJECT_ROOT: '/project-a', CLAUDE_BIN: '/cli/claude', CODEX_BIN: '/cli/codex' };
const auth = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' };
// Each call gets its own token, so the per-credential usage gate never carries one test's reply
// into the next; the gate's own tests pin a token explicitly.
let tokenSeq = 0;
const claudeDeps = (overrides = {}) => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: `claude-secret-${++tokenSeq}`, OPENAI_API_KEY: 'wrong-provider-secret' },
  runFile: async () => JSON.stringify(auth), log: () => {},
  fetch: async () => Response.json({ five_hour: { utilization: 6, resets_at: '2026-09-24T18:00:00Z' }, seven_day: { utilization: 100, resets_at: null }, seven_day_opus: null }), ...overrides });
const normalizedClaude = async opts => normalizeQuota('claude', cfg.PROJECT_ROOT, await readClaudeQuota(cfg, claudeDeps(opts)));

// normalizeQuota() remembers the last good reading per account (TPT689); every test starts without one.
beforeEach(() => clearQuotaSnapshots());

test('Claude reads subscription metadata only, preserves windows, and does not leak credentials', async () => {
  const result = await normalizedClaude({ fetch: async (url, opts) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(opts.method, 'GET');
    assert.match(opts.headers.Authorization, /^Bearer claude-secret-\d+$/);
    assert.equal(opts.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(opts.headers['User-Agent'], USER_AGENT);
    assert.match(USER_AGENT, /^tipatask-task-app\/\d+\.\d+\.\d+/);
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
  const lockedCalls = [];
  await assert.rejects(readClaudeCredential({ USER: 'anton' }, {}, { platform: 'darwin', runFile: async (file, args) => { lockedCalls.push(args); throw Object.assign(new Error(), { code: 36 }); }, readFile: () => assert.fail('locked Keychain cannot use stale file') }), { quotaReason: 'credentials_unavailable' });
  assert.deepEqual(lockedCalls.map(args => args.includes('-a')), [true, false], 'one retry without -a, then refuse');
  const credential = await readClaudeCredential({ CLAUDE_CONFIG_DIR: '/profile-a' }, {}, { platform: 'linux', readFile: async file => {
    assert.equal(file, a.file); return JSON.stringify({ claudeAiOauth: { accessToken: 'only-claude' } });
  } });
  assert.equal(credential.accessToken, 'only-claude');
});

test('Claude Keychain lookup retries once without -a: a found item is used, a missing one falls back to the file', async () => {
  const service = credentialLocation({}, null).service;
  for (const firstCode of [36, 44]) {
    const calls = [];
    const credential = await readClaudeCredential({ USER: 'anton' }, {}, { platform: 'darwin', readFile: () => assert.fail('found item must not read the file'),
      runFile: async (file, args) => {
        calls.push(args);
        if (args.includes('-a')) throw Object.assign(new Error('secret'), { code: firstCode });
        return JSON.stringify({ claudeAiOauth: { accessToken: 'retry-token' } });
      } });
    assert.equal(credential.accessToken, 'retry-token');
    assert.deepEqual(calls, [['find-generic-password', '-a', 'anton', '-w', '-s', service], ['find-generic-password', '-w', '-s', service]]);
  }
  let fileReads = 0;
  const fallback = await readClaudeCredential({ USER: 'anton' }, {}, { platform: 'darwin',
    runFile: async () => { throw Object.assign(new Error(), { code: 44 }); },
    readFile: async () => { fileReads++; return JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } }); } });
  assert.equal(fallback.accessToken, 'file-token');
  assert.equal(fileReads, 1);
});

test('Claude auth status timeout defaults to 20s, survives a slow cold start, and TIPATASK_QUOTA_TIMEOUT_MS overrides it', async () => {
  const COLD_START_MS = 7000;
  // Simulated slow CLI: answers only when the timeout outlasts its cold start, else is killed.
  const execFileImpl = (command, args, options, done) => {
    if (options.timeout > COLD_START_MS) return done(null, JSON.stringify(auth));
    done(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '');
  };
  const slowRunFile = (file, args, options) => runFile(file, args, { ...options, execFileImpl, isWin: false });
  const saved = process.env.TIPATASK_QUOTA_TIMEOUT_MS;
  try {
    delete process.env.TIPATASK_QUOTA_TIMEOUT_MS;
    assert.equal(quotaTimeoutMs(), 20000);
    assert.equal(await slowRunFile('/cli/claude', ['auth', 'status'], {}), JSON.stringify(auth));
    const ok = await readClaudeQuota(cfg, { ...claudeDeps({ runFile: slowRunFile }), projectRoot: '/slow-ok' });
    assert.equal(ok.unavailableReason, undefined);
    process.env.TIPATASK_QUOTA_TIMEOUT_MS = 'not-a-number';
    assert.equal(quotaTimeoutMs(), 20000);
    process.env.TIPATASK_QUOTA_TIMEOUT_MS = '50';
    assert.equal(quotaTimeoutMs(), 50);
    await assert.rejects(slowRunFile('/cli/claude', ['auth', 'status'], {}), { killed: true });
    const short = await readClaudeQuota(cfg, { ...claudeDeps({ runFile: slowRunFile }), projectRoot: '/slow-short' });
    assert.equal(short.unavailableReason, 'timeout');
    // An explicit caller timeout still wins (the probe's longer re-run).
    assert.equal(await slowRunFile('/cli/claude', ['auth', 'status'], { timeout: 30000 }), JSON.stringify(auth));
  } finally {
    if (saved === undefined) delete process.env.TIPATASK_QUOTA_TIMEOUT_MS;
    else process.env.TIPATASK_QUOTA_TIMEOUT_MS = saved;
  }
});

const STAGE_LINE = /^\[agent-quota\] claude unavailable: ([a-z_]+) \(([a-z_]+), (\d+)ms\)$/;

test('Claude unavailable reads log one line naming the reason, the failing stage and how long it ran', async () => {
  const linux = readFile => ({ env: {}, platform: 'linux', readFile });
  const cases = [
    ['cli_missing', 'auth_status', { runFile: async () => { throw Object.assign(new Error('secret'), { code: 'ENOENT' }); } }],
    ['timeout', 'auth_status', { runFile: async () => { throw Object.assign(new Error('secret'), { killed: true, signal: 'SIGTERM' }); } }],
    ['signed_out', 'auth_status', { runFile: async () => JSON.stringify({ loggedIn: false }) }],
    ['unsupported_auth', 'auth_status', { runFile: async () => JSON.stringify({ ...auth, authMethod: 'api_key' }) }],
    ['credentials_expired', 'credential', linux(async () => JSON.stringify({ claudeAiOauth: { accessToken: 'secret', expiresAt: 1 } }))],
    ['credentials_unavailable', 'credential', linux(async () => { throw Object.assign(new Error('secret'), { code: 'ENOENT' }); })],
    ['rate_limited', 'usage_fetch', { fetch: async () => new Response('secret error body', { status: 429 }) }],
    ['invalid_response', 'usage_parse', { fetch: async () => Response.json({}) }],
  ];
  for (const [i, [reason, stage, overrides]] of cases.entries()) {
    const lines = [];
    const result = await readClaudeQuota(cfg, { ...claudeDeps(overrides), projectRoot: `/stage-${i}`, log: (...args) => lines.push(args) });
    assert.equal(result.unavailableReason, reason);
    assert.equal(lines.length, 1, reason);
    const [text, detail] = lines[0];
    const match = STAGE_LINE.exec(text);
    assert.ok(match, text);
    assert.deepEqual([match[1], match[2]], [reason, stage]);
    assert.deepEqual(detail, { reason, stage, ms: Number(match[3]) });
    assert.equal(text.includes('secret'), false);
  }
});

test('Claude unavailable log fires once per reason change per project; a successful read clears it', async () => {
  const lines = [];
  const read = (projectRoot, overrides) => readClaudeQuota(cfg, { ...claudeDeps(overrides), projectRoot, log: text => lines.push(text) });
  const limited = { fetch: async () => new Response('secret error body', { status: 429 }) };
  await read('/dedupe-a', limited);
  await read('/dedupe-a', limited);
  await read('/dedupe-b', limited);
  await read('/dedupe-a', { runFile: async () => JSON.stringify({ loggedIn: false }) });
  assert.equal((await read('/dedupe-a')).unavailableReason, undefined);
  await read('/dedupe-a', limited);
  await read('/dedupe-b', limited);
  assert.deepEqual(lines.map(text => text.replace(/\d+ms\)$/, 'Nms)')), [
    '[agent-quota] claude unavailable: rate_limited (usage_fetch, Nms)',
    '[agent-quota] claude unavailable: rate_limited (usage_fetch, Nms)',
    '[agent-quota] claude unavailable: signed_out (auth_status, Nms)',
    '[agent-quota] claude unavailable: rate_limited (usage_fetch, Nms)',
  ]);
});

test('Claude unavailable log defaults to a single-argument console.warn line', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  await readClaudeQuota(cfg, { ...claudeDeps({ fetch: async () => new Response('secret', { status: 403 }) }), projectRoot: '/default-log', log: undefined });
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(warn.mock.calls[0].arguments.length, 1);
  assert.match(warn.mock.calls[0].arguments[0], /^\[agent-quota\] claude unavailable: access_denied \(usage_fetch, \d+ms\)$/);
});

// Usage-endpoint gate: one shared token, a counting fetch and a controllable clock.
function gatedDeps(token, replies) {
  const clock = { now: 1_000_000 }, calls = [];
  const deps = projectRoot => ({ ...claudeDeps(), env: { CLAUDE_CODE_OAUTH_TOKEN: token }, projectRoot, now: () => clock.now,
    fetch: async (url, opts) => { calls.push(projectRoot); return (replies.shift() || (() => Response.json({ five_hour: { utilization: 3, resets_at: null } })))(opts); } });
  return { clock, calls, read: (projectRoot = '/gate-a') => readClaudeQuota(cfg, deps(projectRoot)) };
}
const tooMany = retryAfter => () => new Response('secret', { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } });

test('Claude usage 429 with retry-after 0 backs off the default interval without asking again', async () => {
  resetUsageGate();
  const g = gatedDeps('gate-default', [tooMany('0')]);
  assert.equal((await g.read()).unavailableReason, 'rate_limited');
  g.clock.now += DEFAULT_BACKOFF_MS - 1;
  assert.equal((await g.read('/gate-b')).unavailableReason, 'rate_limited', 'another project window shares the backoff');
  assert.equal(g.calls.length, 1, 'no request inside the backoff');
  g.clock.now += 1;
  assert.equal((await g.read()).unavailableReason, undefined);
  assert.equal(g.calls.length, 2);
});

test('Claude usage 429 honours a positive retry-after (seconds or HTTP date), floored at the minimum interval and capped', async () => {
  for (const [retryAfter, holdMs] of [['120', 120_000], ['5', MIN_INTERVAL_MS], [String(24 * 3600), MAX_BACKOFF_MS], [undefined, DEFAULT_BACKOFF_MS]]) {
    resetUsageGate();
    const g = gatedDeps(`gate-${retryAfter}`, [tooMany(retryAfter)]);
    await g.read();
    g.clock.now += holdMs - 1;
    assert.equal((await g.read()).unavailableReason, 'rate_limited', String(retryAfter));
    g.clock.now += 1;
    assert.equal((await g.read()).unavailableReason, undefined, String(retryAfter));
    assert.equal(g.calls.length, 2, String(retryAfter));
  }
  const now = Date.parse('2026-10-14T18:00:00Z');
  assert.equal(retryAfterMs('Wed, 14 Oct 2026 18:02:00 GMT', now), 120_000);
  assert.equal(retryAfterMs('Wed, 14 Oct 2026 17:00:00 GMT', now), 0, 'a past date is no hint');
  for (const value of [null, undefined, '', '0', 'soon', '-5', '1.5']) assert.equal(retryAfterMs(value, now), 0, String(value));
});

test('Claude usage reads are reused per credential for the minimum interval across projects; a new token reads fresh', async () => {
  resetUsageGate();
  const g = gatedDeps('gate-shared', []);
  const [a, b] = await Promise.all([g.read('/gate-a'), g.read('/gate-b')]);
  assert.equal(g.calls.length, 1, 'simultaneous windows share one request');
  assert.deepEqual(a.windows, b.windows);
  g.clock.now += MIN_INTERVAL_MS - 1;
  assert.equal((await g.read('/gate-c')).windows[0].usagePercent, 3);
  assert.equal(g.calls.length, 1, 'a completed read is reused inside the minimum interval');
  const other = gatedDeps('gate-other-account', []);
  other.clock.now = g.clock.now;
  await other.read('/gate-a');
  assert.equal(other.calls.length, 1, 'another credential is never served the held reply');
  g.clock.now += 1;
  await g.read('/gate-a');
  assert.equal(g.calls.length, 2);
});

test('Claude usage failures other than 429 are held only for the minimum interval', async () => {
  resetUsageGate();
  const g = gatedDeps('gate-500', [() => new Response('secret', { status: 500 })]);
  assert.equal((await g.read()).unavailableReason, 'provider_error');
  g.clock.now += MIN_INTERVAL_MS - 1;
  assert.equal((await g.read()).unavailableReason, 'provider_error');
  assert.equal(g.calls.length, 1);
  g.clock.now += 1;
  assert.equal((await g.read()).unavailableReason, undefined);
  assert.equal(g.calls.length, 2);
});

// Last good reading (TPT689). A stored claude.ai login read from the credentials file, so the
// email + orgId that `auth status` reports key the snapshot. The clock is mocked to a time before
// the fixture's five_hour reset; each read resets the usage gate so every reply is really fetched.
const READ_AT = Date.parse('2026-09-24T12:00:00Z');
const HOUR = 3_600_000;
const limited = () => new Response('secret', { status: 429 });
function accountRead({ email = 'a@example.test', orgId = 'org-a', token = 'token-a', expiresAt, reply, runFile } = {}, projectRoot = '/stale-a') {
  resetUsageGate();
  return readClaudeQuota(cfg, { projectRoot, log: () => {}, env: {}, platform: 'linux',
    runFile: runFile || (async () => JSON.stringify({ ...auth, email, orgId })),
    readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: token, ...(expiresAt ? { expiresAt } : {}) } }),
    fetch: async () => (reply ? reply() : Response.json({ five_hour: { utilization: 45, resets_at: '2026-09-24T18:00:00Z' }, seven_day: { utilization: 30, resets_at: '2026-09-30T00:00:00Z' } })),
  }).then(raw => normalizeQuota('claude', projectRoot, raw));
}

test('Claude transient failures serve the last good reading marked stale; the account key never reaches the result (TPT689)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: READ_AT });
  const fresh = await accountRead();
  assert.equal(fresh.stale, false);
  assert.equal(fresh.status, 'available');
  assert.deepEqual(fresh.windows.map(w => w.usagePercent), [45, 30]);
  t.mock.timers.tick(10 * 60_000);
  for (const [reason, reply] of [['rate_limited', limited], ['provider_error', () => new Response('secret', { status: 500 })],
    ['credentials_expired', () => new Response('secret', { status: 401 })], ['timeout', () => { throw new DOMException('secret', 'TimeoutError'); }]]) {
    const stale = await accountRead({ reply }, '/stale-b');
    assert.equal(stale.stale, true, reason);
    assert.equal(stale.unavailableReason, reason, 'the reason still says why the fresh read failed');
    assert.deepEqual([stale.status, stale.connectionState, stale.plan, stale.projectRoot], ['available', 'connected', 'max', '/stale-b']);
    assert.equal(stale.checkedAt, fresh.checkedAt, 'checkedAt is when the reading was taken');
    assert.deepEqual(stale.windows, fresh.windows);
    const json = JSON.stringify(stale);
    for (const secret of ['secret', 'token-a', 'example.test', 'org-a', 'credentialKey']) assert.equal(json.includes(secret), false, secret);
    assert.doesNotMatch(json, /[0-9a-f]{64}/);
  }
  // A stored token that has expired is refused before any request, and still finds the reading.
  const expired = await accountRead({ expiresAt: READ_AT, reply: () => assert.fail('an expired token must not be sent') });
  assert.deepEqual([expired.unavailableReason, expired.stale], ['credentials_expired', true]);
});

test('Claude stale readings stay with their account: a refreshed token keeps it; other or unknown accounts and definitive answers do not (TPT689)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: READ_AT });
  await accountRead();
  assert.equal((await accountRead({ token: 'token-a-refreshed', reply: limited })).stale, true, 'same email + org, new token');
  for (const other of [{ email: 'b@example.test' }, { orgId: 'org-b' }, { orgId: '' }, { email: null }]) {
    const result = await accountRead({ ...other, reply: limited });
    assert.deepEqual([result.unavailableReason, result.stale, result.windows], ['rate_limited', false, []], JSON.stringify(other));
  }
  // No account is known when `auth status` itself times out, so nothing can be matched.
  const authTimeout = await accountRead({ runFile: async () => { throw Object.assign(new Error('secret'), { killed: true }); } });
  assert.deepEqual([authTimeout.unavailableReason, authTimeout.stale], ['timeout', false]);
  // A definitive answer for the account drops its reading: a later 429 has nothing to show.
  const denied = await accountRead({ reply: () => new Response('secret', { status: 403 }) });
  assert.deepEqual([denied.unavailableReason, denied.stale], ['access_denied', false]);
  assert.equal((await accountRead({ reply: limited })).stale, false);

  // An env token is keyed by the token, even when `auth status` names an account.
  const envRead = async (token, fetch) => {
    resetUsageGate();
    const raw = await readClaudeQuota(cfg, { ...claudeDeps(fetch ? { fetch } : {}), env: { CLAUDE_CODE_OAUTH_TOKEN: token }, projectRoot: '/stale-env',
      runFile: async () => JSON.stringify({ ...auth, email: 'a@example.test', orgId: 'org-a' }) });
    return normalizeQuota('claude', '/stale-env', raw);
  };
  await accountRead();
  assert.equal((await envRead('env-token', limited)).stale, false, 'the account reading is not the env token\'s');
  assert.equal((await envRead('env-token')).status, 'exhausted');
  const sameToken = await envRead('env-token', limited);
  assert.deepEqual([sameToken.stale, sameToken.status], [true, 'exhausted']);
  assert.equal((await envRead('env-token-2', limited)).stale, false);
});

test('Claude stale readings drop windows that have reset since, recompute status, expire after 24h, and need a hashed key (TPT689)', t => {
  t.mock.timers.enable({ apis: ['Date'], now: READ_AT });
  const KEY = 'a'.repeat(64);
  const read = (raw, credentialKey = KEY) => normalizeQuota('claude', '/p', { connectionState: 'connected', plan: 'max', credentialKey, ...raw });
  const failed = { unavailableReason: 'rate_limited' };
  read({ windows: [
    { id: 'five_hour', usagePercent: 100, resetAt: new Date(READ_AT + HOUR).toISOString(), windowMinutes: 300 },
    { id: 'seven_day', usagePercent: 40, resetAt: new Date(READ_AT + 72 * HOUR).toISOString(), windowMinutes: 10080 },
    { id: 'seven_day_fable', usagePercent: 10, resetAt: null, windowMinutes: 10080 },
  ] });
  assert.equal(read(failed).status, 'exhausted', 'before the 5-hour reset');
  t.mock.timers.tick(2 * HOUR);
  const rolled = read(failed);
  assert.equal(rolled.stale, true);
  assert.equal(rolled.status, 'available', 'the reset 5-hour window no longer counts as at its limit');
  assert.deepEqual(rolled.windows.map(w => [w.id, w.usagePercent, w.resetAt, w.exhausted]),
    [['five_hour', null, null, null], ['seven_day', 40, new Date(READ_AT + 72 * HOUR).toISOString(), false], ['seven_day_fable', 10, null, false]]);
  t.mock.timers.tick(22 * HOUR - 1);
  assert.equal(read(failed).stale, true, '1 ms inside 24h');
  t.mock.timers.tick(2);
  const expired = read(failed);
  assert.deepEqual([expired.stale, expired.status, expired.windows], [false, 'unavailable', []]);
  assert.equal(staleQuota(`claude:${KEY}`), null, 'an expired reading is gone');

  // A null-reset window whose whole duration has passed since the reading has reset too; with
  // nothing known left the reading is dropped.
  const KEY2 = 'b'.repeat(64);
  read({ windows: [{ id: 'five_hour', usagePercent: 20, resetAt: null, windowMinutes: 300 }] }, KEY2);
  t.mock.timers.tick(5 * HOUR - 1);
  assert.equal(read(failed, KEY2).stale, true);
  t.mock.timers.tick(1);
  assert.equal(read(failed, KEY2).stale, false);
  assert.equal(staleQuota(`claude:${KEY2}`), null);

  // staleQuota() honours an explicit maxAgeMs; only a 64-hex key is ever remembered.
  const KEY3 = 'c'.repeat(64);
  read({ windows: [{ id: 'seven_day', usagePercent: 5, resetAt: null, windowMinutes: 10080 }] }, KEY3);
  t.mock.timers.tick(HOUR);
  assert.equal(staleQuota(`claude:${KEY3}`, 2 * HOUR).status, 'available');
  assert.equal(staleQuota(`claude:${KEY3}`, HOUR - 1), null);
  read({ windows: [{ id: 'seven_day', usagePercent: 5, resetAt: null, windowMinutes: 10080 }] }, 'claude-raw-token');
  assert.equal(read(failed, 'claude-raw-token').stale, false);
  assert.equal(normalizeQuota('codex', '/p', { connectionState: 'connected', unavailableReason: 'rate_limited' }).stale, false);
});

// Saved readings (TPT699). Persistence runs against throwaway temp roots only: the snapshot map is
// memory only until a test calls loadQuotaSnapshots(), and beforeEach's clearQuotaSnapshots()
// detaches the file again.
function snapshotRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-quota-snapshots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const snapshotFileIn = root => path.join(root, SNAPSHOT_FILE);
const readSaved = root => JSON.parse(fs.readFileSync(snapshotFileIn(root), 'utf8'));
const writeSaved = (root, snapshots) => fs.writeFileSync(snapshotFileIn(root), JSON.stringify({ version: 1, snapshots }));
const keyed = (key, raw) => normalizeQuota('claude', '/p', { connectionState: 'connected', plan: 'max', credentialKey: key, ...raw });

test('(TPT699) memory only until loadQuotaSnapshots(); then a good reading is saved and a restarted server serves it stale', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: READ_AT });
  const root = snapshotRoot(t);
  await accountRead();
  assert.equal(fs.existsSync(snapshotFileIn(root)), false);
  assert.deepEqual(loadQuotaSnapshots({ root }), { restored: 0, dropped: 0 });
  assert.equal(fs.existsSync(snapshotFileIn(root)), false, 'a missing file is not created until something changes');
  const fresh = await accountRead();
  if (process.platform !== 'win32') assert.equal(fs.statSync(snapshotFileIn(root)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(root), [SNAPSHOT_FILE], 'no temp file left behind');

  // Restart: an empty map, then the boot load. A 429 right after launch serves the saved reading.
  t.mock.timers.tick(10 * 60_000);
  clearQuotaSnapshots();
  assert.equal((await accountRead({ reply: limited })).stale, false, 'nothing in memory before the load');
  assert.deepEqual(loadQuotaSnapshots({ root }), { restored: 1, dropped: 0 });
  const stale = await accountRead({ reply: limited }, '/after-restart');
  assert.deepEqual([stale.stale, stale.status, stale.unavailableReason, stale.projectRoot], [true, 'available', 'rate_limited', '/after-restart']);
  assert.equal(stale.checkedAt, fresh.checkedAt, 'checkedAt is still when the reading was taken');
  assert.deepEqual(stale.windows, fresh.windows);
});

test('(TPT699) a reading one server process saves is served stale by the next process that loads the same root', t => {
  const root = snapshotRoot(t);
  const KEY = 'd'.repeat(64);
  // Exits right after the read: the synchronous save must already be on disk.
  const script = `const q = require(${JSON.stringify(require.resolve('./quota-status'))});
q.loadQuotaSnapshots({ root: ${JSON.stringify(root)} });
q.normalizeQuota('claude', '/p/a', { connectionState: 'connected', plan: 'max', credentialKey: '${KEY}',
  windows: [{ id: 'seven_day', usagePercent: 61, resetAt: null, windowMinutes: 10080 }] });
process.exit(0);`;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(loadQuotaSnapshots({ root }), { restored: 1, dropped: 0 });
  const stale = normalizeQuota('claude', '/p/b', { connectionState: 'connected', plan: 'max', credentialKey: KEY, unavailableReason: 'rate_limited' });
  assert.deepEqual([stale.stale, stale.status, stale.projectRoot, stale.windows.map(w => w.usagePercent)], [true, 'available', '/p/b', [61]]);
});

test('(TPT699) the saved file holds only the hashed key, plan, windows and checkedAt — never a token, email, org id or project root', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: READ_AT });
  const root = snapshotRoot(t);
  loadQuotaSnapshots({ root });
  await accountRead(); // a claude.ai login: keyed by email + org
  resetUsageGate();
  normalizeQuota('claude', '/stale-env', await readClaudeQuota(cfg, { ...claudeDeps(), env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-token-value' }, projectRoot: '/stale-env' }));
  const text = fs.readFileSync(snapshotFileIn(root), 'utf8');
  for (const secret of ['token-a', 'env-token-value', 'a@example.test', 'org-a', 'secret', 'Bearer', '/stale-a', '/stale-env',
    'credentialKey', 'connectionState', 'unavailableReason', 'projectRoot']) assert.equal(text.includes(secret), false, secret);
  const saved = JSON.parse(text);
  assert.equal(saved.version, 1);
  const keys = Object.keys(saved.snapshots);
  assert.equal(keys.length, 2, 'the account and the env token each keep one reading');
  for (const key of keys) {
    assert.match(key, /^claude:[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(saved.snapshots[key]), ['plan', 'windows', 'checkedAt']);
    for (const w of saved.snapshots[key].windows) assert.deepEqual(Object.keys(w), ['id', 'usagePercent', 'resetAt', 'windowMinutes', 'exhausted']);
  }
});

test('(TPT699) load drops readings older than 24h and rewrites the file; a restored reading keeps the stale rules', t => {
  t.mock.timers.enable({ apis: ['Date'], now: READ_AT });
  const root = snapshotRoot(t);
  const [KEPT, OLD] = ['e'.repeat(64), 'f'.repeat(64)];
  const windows = [
    { id: 'five_hour', usagePercent: 100, resetAt: new Date(READ_AT - HOUR).toISOString(), windowMinutes: 300, exhausted: true },
    { id: 'seven_day', usagePercent: 40, resetAt: new Date(READ_AT + 72 * HOUR).toISOString(), windowMinutes: 10080, exhausted: false },
  ];
  writeSaved(root, {
    [`claude:${KEPT}`]: { plan: 'max', windows, checkedAt: new Date(READ_AT - 23 * HOUR).toISOString() },
    [`claude:${OLD}`]: { plan: 'max', windows, checkedAt: new Date(READ_AT - SNAPSHOT_MAX_AGE_MS - 1).toISOString() },
  });
  assert.deepEqual(loadQuotaSnapshots({ root }), { restored: 1, dropped: 1 });
  assert.deepEqual(Object.keys(readSaved(root).snapshots), [`claude:${KEPT}`], 'the expired reading is gone from disk too');
  assert.equal(keyed(OLD, { unavailableReason: 'rate_limited' }).stale, false);
  const stale = keyed(KEPT, { unavailableReason: 'rate_limited' });
  assert.equal(stale.stale, true);
  assert.equal(stale.status, 'available', 'the five-hour window reset after the reading, so it no longer counts as at its limit');
  assert.deepEqual(stale.windows.map(w => [w.id, w.usagePercent, w.exhausted]), [['five_hour', null, null], ['seven_day', 40, false]]);
  // A definitive answer for the account drops the restored reading from disk as well.
  keyed(KEPT, { unavailableReason: 'access_denied' });
  assert.deepEqual(readSaved(root).snapshots, {});
  assert.equal(keyed(KEPT, { unavailableReason: 'rate_limited' }).stale, false);
});

test('(TPT699) a missing, corrupt, wrong-shape or oversize file loads no readings without throwing, and the next good reading replaces it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: READ_AT });
  const contents = [null, 'not json{', '[]', 'null', '{"version":1}', '{"version":1,"snapshots":[]}', 'x'.repeat(1024 * 1024 + 1)];
  for (const content of contents) {
    clearQuotaSnapshots();
    const root = snapshotRoot(t);
    if (content !== null) fs.writeFileSync(snapshotFileIn(root), content);
    const label = String(content).slice(0, 40);
    assert.deepEqual(loadQuotaSnapshots({ root }), { restored: 0, dropped: 0 }, label);
    assert.equal((await accountRead({ reply: limited })).stale, false, label);
    await accountRead();
    assert.equal(Object.keys(readSaved(root).snapshots).length, 1, label);
  }
});

test('(TPT699) load drops malformed readings one by one and passes a kept one through the fresh-read allowlist', t => {
  t.mock.timers.enable({ apis: ['Date'], now: READ_AT });
  const root = snapshotRoot(t);
  const checkedAt = new Date(READ_AT - HOUR).toISOString();
  const good = { plan: 'max', windows: [{ id: 'seven_day', usagePercent: 30, resetAt: null, windowMinutes: 10080 }], checkedAt };
  const [GOOD, COERCED] = ['1'.repeat(64), '8'.repeat(64)];
  writeSaved(root, {
    [`claude:${GOOD}`]: good,
    'claude:claude-raw-token': good, // not a hashed key
    [`claude:${'A'.repeat(64)}`]: good, // not lowercase hex
    [`claude:${'2'.repeat(64)}`]: { ...good, checkedAt: 'soon' },
    [`claude:${'3'.repeat(64)}`]: { ...good, checkedAt: new Date(READ_AT + HOUR).toISOString() }, // in the future
    [`claude:${'4'.repeat(64)}`]: { ...good, windows: [{ id: 'seven_day', usagePercent: null }] }, // nothing known
    [`claude:${'5'.repeat(64)}`]: { ...good, windows: 'many' },
    [`claude:${'6'.repeat(64)}`]: [1],
    [`claude:${'7'.repeat(64)}`]: null,
    [`claude:${COERCED}`]: { plan: 'bad plan!', checkedAt, email: 'a@example.test', windows: [
      { id: 'bad id!', usagePercent: 5 },
      { id: 'five_hour', usagePercent: 120, resetAt: 'later', windowMinutes: -1, exhausted: false, token: 'token-a' },
      { id: 'seven_day', usagePercent: -3 },
    ] },
  });
  assert.deepEqual(loadQuotaSnapshots({ root }), { restored: 2, dropped: 8 });
  const saved = readSaved(root).snapshots;
  assert.deepEqual(Object.keys(saved), [`claude:${GOOD}`, `claude:${COERCED}`], 'the file is rewritten without the dropped entries');
  assert.deepEqual(saved[`claude:${COERCED}`], { plan: null, checkedAt, windows: [
    { id: 'five_hour', usagePercent: 120, resetAt: null, windowMinutes: null, exhausted: true },
    { id: 'seven_day', usagePercent: null, resetAt: null, windowMinutes: null, exhausted: null },
  ] });
  const stale = normalizeQuota('claude', '/p', { connectionState: 'connected', credentialKey: COERCED, unavailableReason: 'timeout' });
  assert.deepEqual([stale.stale, stale.status, stale.plan], [true, 'exhausted', null]);
});

test('(TPT699) a failed save never throws, keeps the reading in memory and warns once per error', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: READ_AT });
  const dir = snapshotRoot(t);
  const notADir = path.join(dir, 'not-a-dir');
  fs.writeFileSync(notADir, '');
  const warn = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(loadQuotaSnapshots({ root: notADir }), { restored: 0, dropped: 0 }); // every write fails
  assert.equal((await accountRead()).stale, false);
  assert.equal((await accountRead({ reply: limited })).stale, true, 'served from memory');
  await accountRead();
  assert.equal(warn.mock.callCount(), 1, 'a lasting failure warns once');
  assert.match(warn.mock.calls[0].arguments[0], /^\[agent-quota\] could not save /);
  assert.deepEqual(fs.readdirSync(dir), ['not-a-dir'], 'no temp file left behind');
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

// npm's codex.cmd / claude.cmd: Node >= 22 refuses a shell-less spawn of a .cmd (EINVAL), so both
// quota readers build their argv through winExecSpec(). isWin forces the win32 branch on any host.
const WIN_SPACED_NPM = 'C:\\Users\\Anton M\\AppData\\Roaming\\npm';

function captureRpcSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return fakeChild((msg, c) => c.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\n'));
  };
}

test('Codex RPC (win32): a .cmd launcher in a path with a space spawns cmd.exe /d /s /c "<quoted line>"', async () => {
  const calls = [];
  const bin = `${WIN_SPACED_NPM}\\codex.cmd`;
  const env = { PATH: 'C:\\x' };
  const rpc = openQuotaRpc(bin, env, 'C:\\project', { spawnImpl: captureRpcSpawn(calls), isWin: true });
  assert.deepEqual(await rpc.request('initialize'), {});
  rpc.close();
  assert.equal(calls.length, 1);
  const { command, args, options } = calls[0];
  assert.equal(path.win32.basename(command).toLowerCase(), 'cmd.exe');
  assert.deepEqual(args, ['/d', '/s', '/c', `""${bin}" "app-server""`]);
  assert.equal(options.windowsVerbatimArguments, true);
  assert.equal(options.shell, undefined, 'never shell: true — cmd.exe would get the path unquoted');
  assert.equal(options.windowsHide, true);
  assert.equal(options.env, env);
  assert.equal(options.cwd, 'C:\\project');
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(Object.hasOwn(options, 'isWin'), false);
});

test('Codex RPC: a plain .exe and a POSIX path are spawned verbatim — no cmd.exe wrapper', async () => {
  for (const [bin, isWin] of [['C:\\Program Files\\OpenAI\\codex.exe', true], ['/usr/local/bin/codex', false]]) {
    const calls = [];
    const rpc = openQuotaRpc(bin, {}, '/project', { spawnImpl: captureRpcSpawn(calls), isWin });
    await rpc.request('initialize');
    rpc.close();
    assert.equal(calls[0].command, bin);
    assert.deepEqual(calls[0].args, ['app-server']);
    assert.equal(calls[0].options.windowsVerbatimArguments, undefined);
    assert.equal(calls[0].options.shell, undefined);
  }
});

test('Claude auth status (win32): a .cmd launcher in a path with a space runs through cmd.exe; signed-out exit 1 still resolves', async () => {
  const calls = [];
  const signedOut = '{"loggedIn":false}';
  const execFileImpl = (command, args, options, done) => {
    calls.push({ command, args, options });
    done(Object.assign(new Error('Command failed'), { code: 1 }), signedOut);
  };
  const bin = `${WIN_SPACED_NPM}\\claude.cmd`;
  const env = { PATH: 'C:\\x' };
  assert.equal(await runFile(bin, ['auth', 'status'], { execFileImpl, isWin: true, cwd: 'C:\\project', env }), signedOut);
  const { command, args, options } = calls[0];
  assert.equal(path.win32.basename(command).toLowerCase(), 'cmd.exe');
  assert.deepEqual(args, ['/d', '/s', '/c', `""${bin}" "auth" "status""`]);
  assert.equal(options.windowsVerbatimArguments, true);
  assert.equal(options.shell, undefined);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 20000);
  assert.equal(options.cwd, 'C:\\project');
  assert.equal(options.env, env);
  assert.equal(Object.hasOwn(options, 'execFileImpl'), false);
  assert.equal(Object.hasOwn(options, 'isWin'), false);
});

test('Claude auth status: a plain .exe is exec\'d verbatim, and an unquotable .cmd argv rejects instead of throwing', async () => {
  const calls = [];
  const execFileImpl = (command, args, options, done) => { calls.push({ command, args, options }); done(null, '{}'); };
  const bin = 'C:\\Program Files\\Claude\\claude.exe';
  assert.equal(await runFile(bin, ['auth', 'status'], { execFileImpl, isWin: true }), '{}');
  assert.equal(calls[0].command, bin);
  assert.deepEqual(calls[0].args, ['auth', 'status']);
  assert.equal(calls[0].options.windowsVerbatimArguments, undefined);
  await assert.rejects(runFile('C:\\x\\we"ird.cmd', ['auth', 'status'], { execFileImpl, isWin: true }), /unquotable/);
  assert.equal(calls.length, 1);
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
