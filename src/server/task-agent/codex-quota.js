'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { augmentPathEnv, projectEnvExtras, resolveNvmBinDir, winExecSpec } = require('../spawn-utils');
const { killWindowsChildTree } = require('../process-group');
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
// argv via winExecSpec(): a Windows codex.cmd launcher runs through cmd.exe (Node >= 22
// refuses a shell-less spawn of a .cmd with EINVAL); .exe and POSIX paths pass through.
// spawnImpl/isWin are test-only seams; isWin forces the win32 branch on any host.
function openQuotaRpc(bin, env, projectRoot, { spawnImpl = spawn, timeoutMs = 15000, isWin = process.platform === 'win32', killTree } = {}) {
  const spec = winExecSpec(bin, ['app-server'], { isWin, env });
  const child = spawnImpl(spec.command, spec.args, { ...spec.options, cwd: projectRoot, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '', bytes = 0, nextId = 1, closed = false, exited = false;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Direct RPC callers may request immediately instead of awaiting the spawn event.
  ready.catch(() => {});
  const pending = new Map();
  const fail = error => {
    rejectReady(error);
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
    if (isWin) { killWindowsChildTree(child, { killTree }); return; }
    if (exited) return;
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
    killTimer.unref();
    child.once('exit', () => clearTimeout(killTimer));
  }
  child.once('spawn', () => resolveReady());
  child.on('error', err => { fail(err); close(); });
  child.on('exit', () => { exited = true; fail(quotaError('provider_error')); close(); });
  child.stdin.on('error', err => { fail(err); close(); });
  child.stderr.on('data', () => {}); // Never log auth/config-bearing CLI diagnostics.
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { fail(quotaError('invalid_response')); close(); return; }
    buffer += chunk.toString('utf8');
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue; // Both LF and CRLF JSON lines, including empty separators.
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
    ready,
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

// Log only fixed reason/stage names, once per changed failure per project. Success
// clears the remembered failure. No provider text or account data reaches the log.
const lastFailure = new Map();
function noteOutcome(projectRoot, reason, stage, ms, log = line => console.warn(line)) {
  if (!reason) { lastFailure.delete(projectRoot); return; }
  const key = `${stage}:${reason}`;
  if (lastFailure.get(projectRoot) === key) return;
  lastFailure.set(projectRoot, key);
  log(`[agent-quota] codex unavailable: ${reason} (${stage}, ${ms}ms)`, { reason, stage, ms });
}

async function readCodexQuota(config, { projectRoot = config.PROJECT_ROOT, ...deps } = {}) {
  let rpc, connectionState = 'unknown', plan = null, stage = 'setup', stageAt = Date.now();
  // The observer receives timings only; it cannot see RPC parameters or replies.
  const finishStage = () => deps.onStage?.({ stage, ms: Date.now() - stageAt });
  const enter = name => { finishStage(); stage = name; stageAt = Date.now(); };
  const unavailable = result => {
    noteOutcome(projectRoot, result.unavailableReason, stage, Date.now() - stageAt, deps.log);
    return result;
  };
  try {
    const env = { ...(deps.env || augmentPathEnv({ ...projectEnvExtras(projectRoot) })) };
    // Match getSpawnSpec's project home, without ensureProjectCodexHome's writes.
    env.CODEX_HOME = path.join(projectRoot, '.codex');
    const bin = config.CODEX_BIN;
    const nvmDir = resolveNvmBinDir(bin);
    if (nvmDir) env.PATH = `${nvmDir}${path.delimiter}${env.PATH}`;
    enter('spawn');
    rpc = (deps.openRpc || openQuotaRpc)(bin, env, projectRoot, deps);
    await rpc.ready;
    enter('initialize');
    await rpc.request('initialize', { clientInfo: { name: 'tipatask_quota', version: '1.0' } });
    rpc.initialized();
    enter('account_read');
    const accountReply = await rpc.request('account/read', { refreshToken: false });
    if (!accountReply || !Object.hasOwn(accountReply, 'account')) throw quotaError('invalid_response');
    const account = accountReply.account;
    if (account === null) return unavailable({ connectionState: 'signed_out', unavailableReason: 'signed_out' });
    if (typeof account !== 'object' || typeof account.type !== 'string') throw quotaError('invalid_response');
    connectionState = 'connected'; plan = account.planType || null;
    if (account.type !== 'chatgpt') return unavailable({ connectionState, plan: null, unavailableReason: 'unsupported_auth' });
    // Resolve the account BEFORE coalescing: native keychain/file auth changes must
    // not join another account's outstanding request. The key never leaves memory.
    const key = JSON.stringify([projectRoot, account]);
    enter('rate_limits');
    const data = await coalesceQuota(`codex:${key}`, () => rpc.request('account/rateLimits/read'));
    enter('parse');
    const windows = parseCodexLimits(data);
    if (!windows.some(w => w.usagePercent !== null)) return unavailable({ connectionState, plan, windows, unavailableReason: 'quota_unavailable' });
    noteOutcome(projectRoot, null);
    return { connectionState, plan, windows };
  } catch (err) { return unavailable({ connectionState, plan, unavailableReason: reasonFor(err) }); }
  finally { finishStage(); rpc?.close(); }
}

module.exports = { readCodexQuota, parseCodexLimits, openQuotaRpc };
