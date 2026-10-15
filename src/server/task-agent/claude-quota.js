'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { augmentPathEnv, projectEnvExtras, resolveNvmBinDir, winExecSpec } = require('../spawn-utils');
const { quotaError, reasonFor, coalesceQuota } = require('./quota-status');
const { version: APP_VERSION } = require('../../../package.json');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Identifies the Task App honestly; the endpoint rate-limits per OAuth token, not per client.
const USER_AGENT = `tipatask-task-app/${APP_VERSION}`;
// Per-credential gate on the usage endpoint, shared by every project window this server reads
// for: a completed read is reused for MIN_INTERVAL_MS; a 429 holds off for its retry-after, or
// DEFAULT_BACKOFF_MS when that is 0 or absent, never longer than MAX_BACKOFF_MS. Claude Code's
// own reader applies the same 429 rule to the same token.
const MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;
const WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps', 'seven_day_cowork'];

// A cold Claude CLI start can take several seconds, so `claude auth status` gets 20s.
// TIPATASK_QUOTA_TIMEOUT_MS (the server's own env, read per call) overrides it.
const DEFAULT_QUOTA_TIMEOUT_MS = 20000;
function quotaTimeoutMs(env = process.env) {
  const ms = Number(env.TIPATASK_QUOTA_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : DEFAULT_QUOTA_TIMEOUT_MS;
}

// argv via winExecSpec(): a Windows claude.cmd launcher runs through cmd.exe (Node >= 22
// refuses a shell-less execFile of a .cmd with EINVAL); .exe and POSIX paths, including
// /usr/bin/security, pass through. execFileImpl/isWin are test-only seams.
function runFile(file, args, { execFileImpl = execFile, isWin, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const spec = winExecSpec(file, args, isWin === undefined ? {} : { isWin });
    execFileImpl(spec.command, spec.args, { timeout: quotaTimeoutMs(), maxBuffer: MAX_BYTES, windowsHide: true, ...spec.options, ...options }, (err, stdout) => {
      // `claude auth status` returns exit 1 with valid JSON when signed out.
      if (err && !(err.code === 1 && args[0] === 'auth' && stdout?.trim().startsWith('{'))) return reject(err);
      resolve(stdout);
    });
  });
}

function credentialLocation(env, configDirectory, home = os.homedir()) {
  const secureDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const dir = (secureDir !== undefined ? secureDir || path.join(home, '.claude') : configDirectory || env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')).normalize('NFC');
  const scoped = secureDir !== undefined ? !!secureDir : !!env.CLAUDE_CONFIG_DIR || dir !== path.join(home, '.claude').normalize('NFC');
  const suffix = scoped ? '-' + createHash('sha256').update(dir).digest('hex').slice(0, 8) : '';
  return { file: path.join(dir, '.credentials.json'), service: `Claude Code-credentials${suffix}` };
}

async function readClaudeCredential(env, auth, deps = {}) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { accessToken: env.CLAUDE_CODE_OAUTH_TOKEN };
  const loc = credentialLocation(env, auth.configDirectory, deps.home);
  const readFile = deps.readFile || fs.readFile;
  let text;
  if ((deps.platform || process.platform) === 'darwin') {
    const user = env.USER || os.userInfo().username;
    const lookup = account => (deps.runFile || runFile)('/usr/bin/security',
      ['find-generic-password', ...(account ? ['-a', account] : []), '-w', '-s', loc.service], {});
    try {
      text = await lookup(/^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user');
    } catch {
      // The item may be stored under another account name than this process's user:
      // retry once without the -a filter before deciding.
      try { text = await lookup(null); } catch (err) {
        // A missing item can use Claude's plaintext fallback. A locked/denied Keychain
        // must not fall through to a potentially different, stale account on disk.
        if (err.code !== 44) throw quotaError('credentials_unavailable');
      }
    }
  }
  if (!text) {
    try { text = await readFile(loc.file, 'utf8'); }
    catch { throw quotaError('credentials_unavailable'); }
  }
  try {
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error();
    const credential = JSON.parse(text).claudeAiOauth;
    if (typeof credential?.accessToken !== 'string' || !credential.accessToken) throw new Error();
    return credential;
  } catch { throw quotaError('credentials_unavailable'); }
}

// `retry-after` as delta-seconds or an HTTP date; 0 when absent, zero, past or unparsable.
function retryAfterMs(value, now = Date.now()) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

async function fetchUsage(accessToken, fetchImpl = fetch) {
  const response = await fetchImpl(USAGE_URL, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json', 'User-Agent': USER_AGENT },
  });
  if (!response.ok) {
    await response.body?.cancel();
    const err = quotaError(({ 401: 'credentials_expired', 403: 'access_denied', 429: 'rate_limited' })[response.status] || 'provider_error');
    if (response.status === 429) err.retryAfterMs = retryAfterMs(response.headers?.get('retry-after'));
    throw err;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw quotaError('invalid_response');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw quotaError('invalid_response'); }
}

function holdMs(err) {
  if (err?.quotaReason !== 'rate_limited') return MIN_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(err.retryAfterMs > 0 ? err.retryAfterMs : DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS));
}

// Keyed by the access token's hash alone, so every project reading the same account shares one
// gate, and a new login (a new token) never sees another account's held reply.
const usageGate = new Map();
function readUsageGated(accessToken, { fetch: fetchImpl, now = Date.now } = {}) {
  const key = createHash('sha256').update(accessToken).digest('hex');
  const at = now();
  for (const [k, entry] of usageGate) if (entry.until <= at) usageGate.delete(k);
  const held = usageGate.get(key);
  if (held) return held.error ? Promise.reject(held.error) : Promise.resolve(held.data);
  return coalesceQuota(`claude:${key}`, async () => {
    try {
      const data = await fetchUsage(accessToken, fetchImpl);
      usageGate.set(key, { until: now() + MIN_INTERVAL_MS, data });
      return data;
    } catch (err) {
      usageGate.set(key, { until: now() + holdMs(err), error: err });
      throw err;
    }
  });
}

// Test-only: forget every held read.
function resetUsageGate() { usageGate.clear(); }

// The usage endpoint also returns a structured `limits[]` (kind session | weekly_all | weekly_scoped,
// with the model in `scope.model`). Per-model weekly limits now appear ONLY there — the legacy
// `seven_day_<model>` keys are null. Read leniently: an entry this reader does not understand is
// skipped, never fatal, so an unrecognised extra never costs the bars the legacy keys still supply.
const LIMIT_SLUG_MAX = 60; // `seven_day_${slug}` must fit normalizeQuota's 80-char id allowlist
function scopedSlug(scope) {
  for (const raw of [scope?.model?.display_name, scope?.model?.id, scope?.surface]) {
    if (typeof raw !== 'string') continue;
    const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, LIMIT_SLUG_MAX);
    if (slug) return slug;
  }
  return null;
}

function parseClaudeLimits(limits) {
  if (!Array.isArray(limits)) return [];
  const seen = new Set();
  return limits.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.percent !== 'number'
      || !Number.isFinite(entry.percent) || entry.percent < 0) return [];
    let id;
    if (entry.kind === 'session') id = 'five_hour';
    else if (entry.kind === 'weekly_all') id = 'seven_day';
    else if (entry.kind === 'weekly_scoped') { const slug = scopedSlug(entry.scope); id = slug && `seven_day_${slug}`; }
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, usagePercent: entry.percent, resetAt: entry.resets_at, windowMinutes: id === 'five_hour' ? 300 : 10080 }];
  });
}

function parseClaudeUsage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw quotaError('invalid_response');
  const limits = parseClaudeLimits(data.limits);
  const hasLegacy = WINDOWS.some(id => Object.hasOwn(data, id));
  if (!hasLegacy && !limits.length) throw quotaError('invalid_response');
  const legacy = WINDOWS.flatMap(id => {
    const w = data[id];
    if (w === null || w === undefined) return [];
    if (typeof w !== 'object' || Array.isArray(w) || !Object.hasOwn(w, 'utilization')) throw quotaError('invalid_response');
    if (w.utilization !== null && (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization) || w.utilization < 0)) throw quotaError('invalid_response');
    return [{ id, usagePercent: w.utilization, resetAt: w.resets_at, windowMinutes: id === 'five_hour' ? 300 : 10080 }];
  });
  // Legacy windows stay authoritative. `limits[]` fills in what they lack: the whole set when the
  // legacy keys are gone, or the per-model weekly windows when no legacy model window is present.
  if (!legacy.length) return limits;
  if (legacy.some(w => w.id !== 'five_hour' && w.id !== 'seven_day')) return legacy;
  return [...legacy, ...limits.filter(w => w.id !== 'five_hour' && w.id !== 'seven_day')];
}

// The unavailable reason otherwise reaches only the sidebar row's tooltip, so it is logged with
// the stage that failed and how long that stage ran: once per reason change per project (one
// server reads for several project windows), cleared by a successful read. Reason and stage come
// from fixed lists, never provider replies, error text or credentials. deps.log(line, detail)
// replaces console.warn for tests and scripts/probe-claude-quota.js.
const lastReason = new Map();
function noteOutcome(projectRoot, reason, stage, ms, log = line => console.warn(line)) {
  if (lastReason.get(projectRoot) === reason) return;
  lastReason.set(projectRoot, reason);
  if (reason) log(`[agent-quota] claude unavailable: ${reason} (${stage}, ${ms}ms)`, { reason, stage, ms });
}

// One-way SHA-256 of JSON parts; used as an in-memory key only, never logged or returned to clients.
const fingerprint = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

async function readClaudeQuota(config, { projectRoot = config.PROJECT_ROOT, ...deps } = {}) {
  // credentialKey names the account read, for quota-status.js's last-good-reading snapshot
  // (TPT689). Once known it rides on every result, including usage-gate holds and failures.
  let connectionState = 'unknown', plan = null, credentialKey = null, stage = 'setup', stageAt = Date.now();
  const enter = name => { stage = name; stageAt = Date.now(); };
  const unavailable = result => {
    noteOutcome(projectRoot, result.unavailableReason, stage, Date.now() - stageAt, deps.log);
    return credentialKey ? { ...result, credentialKey } : result;
  };
  try {
    const env = { ...(deps.env || augmentPathEnv({ ...projectEnvExtras(projectRoot) })) };
    const nvmDir = resolveNvmBinDir(config.CLAUDE_BIN);
    if (nvmDir) env.PATH = `${nvmDir}${path.delimiter}${env.PATH}`;
    enter('auth_status');
    const authText = await (deps.runFile || runFile)(config.CLAUDE_BIN, ['auth', 'status'], { cwd: projectRoot, env });
    let auth;
    try { auth = JSON.parse(authText); } catch { throw quotaError('invalid_response'); }
    if (typeof auth?.loggedIn !== 'boolean') throw quotaError('invalid_response');
    if (!auth.loggedIn) return unavailable({ connectionState: 'signed_out', unavailableReason: 'signed_out' });
    connectionState = 'connected'; plan = auth.subscriptionType || null;
    const explicitOAuth = auth.authMethod === 'oauth_token' && !!env.CLAUDE_CODE_OAUTH_TOKEN;
    if ((!explicitOAuth && auth.authMethod !== 'claude.ai') || auth.apiProvider !== 'firstParty' || env.CLAUDE_CODE_CUSTOM_OAUTH_URL) {
      return unavailable({ connectionState, plan: null, unavailableReason: 'unsupported_auth' });
    }
    // A stored claude.ai login is keyed by the account `auth status` names, email and org together
    // (one org holds many seats), so the key survives token refreshes. An env token, or a login
    // reported without both, is keyed by the token itself (taken before the expiry check below).
    if (!env.CLAUDE_CODE_OAUTH_TOKEN && typeof auth.email === 'string' && auth.email
      && typeof auth.orgId === 'string' && auth.orgId) credentialKey = fingerprint(['account', auth.email, auth.orgId]);
    enter('credential');
    const credential = await readClaudeCredential(env, auth, deps);
    plan = credential.subscriptionType || plan;
    credentialKey ||= fingerprint(['token', credential.accessToken]);
    // Do not refresh credentials or start an inference request to learn limits.
    if (Number.isFinite(credential.expiresAt) && credential.expiresAt <= Date.now()) throw quotaError('credentials_expired');
    enter('usage_fetch');
    const data = await readUsageGated(credential.accessToken, { fetch: deps.fetch, now: deps.now });
    enter('usage_parse');
    const windows = parseClaudeUsage(data);
    noteOutcome(projectRoot, null);
    return { connectionState, plan, windows, credentialKey };
  } catch (err) { return unavailable({ connectionState, plan, unavailableReason: reasonFor(err) }); }
}

module.exports = { readClaudeQuota, readClaudeCredential, credentialLocation, parseClaudeUsage, fetchUsage, runFile, quotaTimeoutMs,
  retryAfterMs, resetUsageGate, USER_AGENT, MIN_INTERVAL_MS, DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS };
