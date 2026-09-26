'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { augmentPathEnv, projectEnvExtras, resolveNvmBinDir } = require('../spawn-utils');
const { quotaError, reasonFor, coalesceQuota } = require('./quota-status');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const MAX_BYTES = 1024 * 1024;
const WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps', 'seven_day_cowork'];

function runFile(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, maxBuffer: MAX_BYTES, windowsHide: true, ...options }, (err, stdout) => {
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
    try {
      text = await (deps.runFile || runFile)('/usr/bin/security', ['find-generic-password', '-a', /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user', '-w', '-s', loc.service], {});
    } catch (err) {
      // A missing item can use Claude's plaintext fallback. A locked/denied Keychain
      // must not fall through to a potentially different, stale account on disk.
      if (err.code !== 44) throw quotaError('credentials_unavailable');
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

async function fetchUsage(accessToken, fetchImpl = fetch) {
  const response = await fetchImpl(USAGE_URL, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw quotaError(({ 401: 'credentials_expired', 403: 'access_denied', 429: 'rate_limited' })[response.status] || 'provider_error');
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

async function readClaudeQuota(config, { projectRoot = config.PROJECT_ROOT, ...deps } = {}) {
  let connectionState = 'unknown', plan = null;
  try {
    const env = { ...(deps.env || augmentPathEnv({ ...projectEnvExtras(projectRoot) })) };
    const nvmDir = resolveNvmBinDir(config.CLAUDE_BIN);
    if (nvmDir) env.PATH = `${nvmDir}${path.delimiter}${env.PATH}`;
    const authText = await (deps.runFile || runFile)(config.CLAUDE_BIN, ['auth', 'status'], { cwd: projectRoot, env });
    let auth;
    try { auth = JSON.parse(authText); } catch { throw quotaError('invalid_response'); }
    if (typeof auth?.loggedIn !== 'boolean') throw quotaError('invalid_response');
    if (!auth.loggedIn) return { connectionState: 'signed_out', unavailableReason: 'signed_out' };
    connectionState = 'connected'; plan = auth.subscriptionType || null;
    const explicitOAuth = auth.authMethod === 'oauth_token' && !!env.CLAUDE_CODE_OAUTH_TOKEN;
    if ((!explicitOAuth && auth.authMethod !== 'claude.ai') || auth.apiProvider !== 'firstParty' || env.CLAUDE_CODE_CUSTOM_OAUTH_URL) {
      return { connectionState, plan: null, unavailableReason: 'unsupported_auth' };
    }
    const credential = await readClaudeCredential(env, auth, deps);
    plan = credential.subscriptionType || plan;
    // Do not refresh credentials or start an inference request to learn limits.
    if (Number.isFinite(credential.expiresAt) && credential.expiresAt <= Date.now()) throw quotaError('credentials_expired');
    const key = createHash('sha256').update(JSON.stringify([projectRoot, credential.accessToken])).digest('hex');
    const data = await coalesceQuota(`claude:${key}`, () => fetchUsage(credential.accessToken, deps.fetch));
    return { connectionState, plan, windows: parseClaudeUsage(data) };
  } catch (err) { return { connectionState, plan, unavailableReason: reasonFor(err) }; }
}

module.exports = { readClaudeQuota, readClaudeCredential, credentialLocation, parseClaudeUsage, fetchUsage };
