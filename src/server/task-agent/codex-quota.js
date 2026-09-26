'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { augmentPathEnv, projectEnvExtras, resolveNvmBinDir } = require('../spawn-utils');
const { quotaError, reasonFor, coalesceQuota } = require('./quota-status');

function parseCodexLimits(data) {
  if (!data || typeof data !== 'object') throw quotaError('invalid_response');
  const buckets = data.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length
    ? data.rateLimitsByLimitId : (data.rateLimits ? { codex: data.rateLimits } : data.rateLimitsByLimitId);
  if (!buckets || typeof buckets !== 'object' || Array.isArray(buckets)) throw quotaError('invalid_response');
  const windows = [];
  for (const [id, bucket] of Object.entries(buckets)) {
    if (!bucket || !/^[a-zA-Z0-9_-]{1,60}$/.test(id)) continue;
    for (const name of ['primary', 'secondary']) {
      const w = bucket[name];
      if (w === null || w === undefined) continue;
      if (typeof w !== 'object' || !Object.hasOwn(w, 'usedPercent') || (w.usedPercent !== null && (typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent) || w.usedPercent < 0))) throw quotaError('invalid_response');
      windows.push({ id: `${id}_${name}`, usagePercent: w.usedPercent, resetAt: w.resetsAt, windowMinutes: w.windowDurationMins });
    }
  }
  return windows;
}

function rpcErrorReason(error) {
  if (error?.code === -32601) return 'unsupported_provider';
  // Codex versions wrap upstream HTTP errors in a generic JSON-RPC code. Classify
  // recognizable auth/HTTP failures locally; never forward the raw message or data.
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/\b401\b|unauthorized|token.{0,20}(expired|revoked)|refresh.{0,20}token/i.test(message)) return 'credentials_expired';
  if (/\b403\b|forbidden/i.test(message)) return 'access_denied';
  if (/\b429\b|too many requests/i.test(message)) return 'rate_limited';
  return 'provider_error';
}

// A short-lived stdio RPC client. No thread/start or turn/start, no config writer,
// login flow, MCP startup, or model request. Codex owns its native credential store.
function openQuotaRpc(bin, env, projectRoot, { spawnImpl = spawn, timeoutMs = 15000 } = {}) {
  const child = spawnImpl(bin, ['app-server'], { cwd: projectRoot, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '', bytes = 0, nextId = 1, closed = false, exited = false;
  const pending = new Map();
  const fail = error => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  const timer = setTimeout(() => { fail(quotaError('timeout')); close(); }, timeoutMs);
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    fail(quotaError('provider_error'));
    child.stdin.destroy();
    if (exited) return;
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
    killTimer.unref();
    child.once('exit', () => clearTimeout(killTimer));
  }
  child.on('error', err => { fail(err); close(); });
  child.on('exit', () => { exited = true; fail(quotaError('provider_error')); close(); });
  child.stdin.on('error', err => { fail(err); close(); });
  child.stderr.on('data', () => {}); // Never log auth/config-bearing CLI diagnostics.
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { fail(quotaError('invalid_response')); close(); return; }
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { fail(quotaError('invalid_response')); close(); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { fail(quotaError('invalid_response')); close(); return; }
      const item = pending.get(msg.id);
      if (!item) continue;
      pending.delete(msg.id);
      if (msg.error) item.reject(quotaError(rpcErrorReason(msg.error)));
      else item.resolve(msg.result);
    }
  });
  return {
    request(method, params) {
      if (closed) return Promise.reject(quotaError('provider_error'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n');
      });
    },
    initialized() { child.stdin.write('{"method":"initialized"}\n'); }, close,
  };
}

async function readCodexQuota(config, { projectRoot = config.PROJECT_ROOT, ...deps } = {}) {
  let rpc, connectionState = 'unknown', plan = null;
  try {
    const env = { ...(deps.env || augmentPathEnv({ ...projectEnvExtras(projectRoot) })) };
    // Match getSpawnSpec's project home, without ensureProjectCodexHome's writes.
    env.CODEX_HOME = path.join(projectRoot, '.codex');
    const nvmDir = resolveNvmBinDir(config.CODEX_BIN);
    if (nvmDir) env.PATH = `${nvmDir}${path.delimiter}${env.PATH}`;
    rpc = (deps.openRpc || openQuotaRpc)(config.CODEX_BIN, env, projectRoot, deps);
    await rpc.request('initialize', { clientInfo: { name: 'tipatask_quota', version: '1.0' } });
    rpc.initialized();
    const accountReply = await rpc.request('account/read', { refreshToken: false });
    if (!accountReply || !Object.hasOwn(accountReply, 'account')) throw quotaError('invalid_response');
    const account = accountReply.account;
    if (account === null) return { connectionState: 'signed_out', unavailableReason: 'signed_out' };
    if (typeof account !== 'object' || typeof account.type !== 'string') throw quotaError('invalid_response');
    connectionState = 'connected'; plan = account.planType || null;
    if (account.type !== 'chatgpt') return { connectionState, plan: null, unavailableReason: 'unsupported_auth' };
    // Resolve the account BEFORE coalescing: native keychain/file auth changes must
    // not join another account's outstanding request. The key never leaves memory.
    const key = JSON.stringify([projectRoot, account]);
    const data = await coalesceQuota(`codex:${key}`, () => rpc.request('account/rateLimits/read'));
    return { connectionState, plan, windows: parseCodexLimits(data) };
  } catch (err) { return { connectionState, plan, unavailableReason: reasonFor(err) }; }
  finally { rpc?.close(); }
}

module.exports = { readCodexQuota, parseCodexLimits, openQuotaRpc };
