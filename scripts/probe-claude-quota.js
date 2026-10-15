#!/usr/bin/env node
'use strict';

// Read-only diagnostic for the Claude row of the sidebar plan-usage block. Runs
// readClaudeQuota() once, in-process, for the configured project root with its real
// dependencies (the project's launch env, `claude auth status`, the Keychain / .credentials.json
// read and the usage endpoint), each wrapped only to observe it, and prints what every stage saw:
//
//   auth_status   `claude auth status` wall time, outcome, loggedIn/authMethod/apiProvider
//   credential    source (env CLAUDE_CODE_OAUTH_TOKEN / Keychain / .credentials.json), every
//                 Keychain lookup the reader made (`-a <user>`, then its retry without `-a`)
//                 and whether expiresAt is past
//   usage_fetch   request header names and User-Agent, HTTP status and retry-after of
//                 GET /api/oauth/usage
//   result        connectionState, plan, windows, unavailableReason, the failing stage and the
//                 exact `[agent-quota]` line the server logs for it
//
// Two read-only follow-ups run only after a failure: a `claude auth status` killed by the reader's
// timeout is re-run once with max(30s, reader timeout + 10s) to measure its real duration, and
// when every Keychain lookup failed the service is queried once more without `-w` (attributes
// only, the secret is never requested) to show which account, if any, holds the item.
//
// Never prints a token, credential JSON, response body, error message or env value (only
// CLAUDE*/ANTHROPIC* variable names and config-directory paths); never refreshes a credential,
// starts a model turn, starts a server or touches port 4455. Exits 0 whatever the quota outcome:
// the failing stage is the finding, not a probe failure.
//
// Usage:
//   npm run probe:claude-quota
//   TIPATASK_PROJECT_ROOT=/path/to/project npm run probe:claude-quota

require('./check-node-version');
const fs = require('node:fs/promises');
const os = require('node:os');
const util = require('node:util');

const config = require('../src/server/config');
const { readClaudeQuota, runFile, credentialLocation, quotaTimeoutMs } = require('../src/server/task-agent/claude-quota');
const { normalizeQuota } = require('../src/server/task-agent/quota-status');

// Same order as the stages readClaudeQuota() enters.
const STAGES = ['setup', 'auth_status', 'credential', 'usage_fetch', 'usage_parse'];
const NOT_REACHED = 'not reached';

const fmt = (v) => (v === null || v === undefined || v === '' ? '(none)' : typeof v === 'string' ? v : util.inspect(v, { depth: 4, breakLength: 120 }));
const line = (label, value) => console.log(`  ${label.padEnd(26)} ${fmt(value)}`);
const header = (title) => console.log(`\n=== ${title} ===`);

const seen = { auth: null, keychain: [], file: null, fetch: null, log: null };

// Exit code, signal and error class only: execFile/fetch messages can echo argv or output.
function outcome(err) {
  if (!err) return 'ok';
  const parts = [];
  if (err.killed) parts.push('killed (timeout)');
  if (err.code !== undefined && err.code !== null) parts.push(`code ${err.code}`);
  if (err.signal) parts.push(`signal ${err.signal}`);
  if (err.name && err.name !== 'Error') parts.push(err.name);
  if (err.cause?.code) parts.push(`cause ${err.cause.code}`);
  return `error: ${parts.join(', ') || 'unknown'}`;
}

function parseAuth(stdout) {
  try {
    const a = JSON.parse(stdout);
    return { loggedIn: a?.loggedIn, authMethod: a?.authMethod, apiProvider: a?.apiProvider, subscriptionType: a?.subscriptionType, configDirectory: a?.configDirectory };
  } catch { return { unparsable: true }; }
}

// Only these fields of the credential JSON are read; the token itself is never kept or printed.
function credentialMeta(text) {
  try {
    const c = JSON.parse(text)?.claudeAiOauth;
    return { token: typeof c?.accessToken === 'string' && c.accessToken.length > 0, expiresAt: c?.expiresAt, subscriptionType: c?.subscriptionType };
  } catch { return { unparsable: true }; }
}

function span(ms) {
  const minutes = Math.round(Math.abs(ms) / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

// Same rule as the reader: a finite expiresAt at or before now is expired.
function expiry(expiresAt) {
  if (!Number.isFinite(expiresAt)) return '(none stored)';
  const left = expiresAt - Date.now();
  return `${new Date(expiresAt).toISOString()}: ${left <= 0 ? `PAST, expired ${span(left)} ago` : `valid for ${span(left)}`}`;
}

async function observedRunFile(file, args, options) {
  const isAuth = args[0] === 'auth';
  const record = isAuth ? (seen.auth = { file, cwd: options.cwd, env: options.env }) : { args };
  if (!isAuth) seen.keychain.push(record);
  const t0 = Date.now();
  try {
    const stdout = await runFile(file, args, options);
    record.ms = Date.now() - t0;
    if (isAuth) record.status = parseAuth(stdout);
    else record.meta = stdout ? credentialMeta(stdout) : null; // empty → the reader falls back to the file
    return stdout;
  } catch (err) {
    record.ms = Date.now() - t0;
    record.error = err;
    throw err;
  }
}

async function observedReadFile(file, encoding) {
  const record = (seen.file = { file });
  try {
    const text = await fs.readFile(file, encoding);
    record.meta = credentialMeta(text);
    return text;
  } catch (err) {
    record.error = err;
    throw err;
  }
}

async function observedFetch(url, options) {
  // Header names and the User-Agent value only; the Authorization value is never kept.
  const record = (seen.fetch = { headerNames: Object.keys(options.headers || {}), userAgent: options.headers?.['User-Agent'] });
  const t0 = Date.now();
  try {
    const response = await fetch(url, options);
    Object.assign(record, { ms: Date.now() - t0, status: response.status, retryAfter: response.headers.get('retry-after') });
    return response;
  } catch (err) {
    Object.assign(record, { ms: Date.now() - t0, error: err });
    throw err;
  }
}

// On success every stage ran; on a failure the reader's log names the stage it stopped in.
const reached = (stage) => !seen.log || STAGES.indexOf(stage) <= STAGES.indexOf(seen.log.stage);

async function printAuth() {
  header('auth_status: `claude auth status`');
  const a = seen.auth;
  if (!a) return line('result', NOT_REACHED);
  line('wall time', `${a.ms}ms`);
  line('outcome', outcome(a.error));
  const names = Object.keys(a.env || {}).filter(k => /^(CLAUDE|ANTHROPIC)/.test(k)).sort();
  line('CLAUDE*/ANTHROPIC* env', names.length ? names.join(', ') : '(none)');
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) {
    if (a.env?.[k] !== undefined) line(k, a.env[k] || '(empty)');
  }
  if (a.status?.unparsable) line('output', 'not JSON → invalid_response');
  else if (a.status) for (const k of ['loggedIn', 'authMethod', 'apiProvider', 'subscriptionType', 'configDirectory']) line(k, a.status[k]);
  if (a.error?.killed) {
    const t0 = Date.now();
    let err = null;
    // Always longer than the reader's own timeout (TIPATASK_QUOTA_TIMEOUT_MS can raise it).
    const timeout = Math.max(30000, quotaTimeoutMs() + 10000);
    try { await runFile(a.file, ['auth', 'status'], { cwd: a.cwd, env: a.env, timeout }); } catch (e) { err = e; }
    line(`re-run, ${Math.round(timeout / 1000)}s timeout`, `${outcome(err)} after ${Date.now() - t0}ms`);
  }
}

// After every Keychain lookup failed: attributes only (no -w), to see which account, if any,
// holds the item.
async function printKeychainItem(service) {
  try {
    const out = await runFile('/usr/bin/security', ['find-generic-password', '-s', service], {});
    const acct = /"acct"<blob>=(?:"([^"]*)"|(0x[0-9A-Fa-f]+))/.exec(out);
    line('item, no -a filter', `exists, acct=${acct ? (acct[1] ?? acct[2]) : '(unreadable)'}`);
  } catch (err) {
    line('item, no -a filter', err.code === 44 ? 'none: no item for this service under any account' : outcome(err));
  }
}

async function printCredential() {
  header('credential');
  if (!reached('credential')) return line('result', NOT_REACHED);
  const env = seen.auth?.env || {};
  const loc = credentialLocation(env, seen.auth?.status?.configDirectory);
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    line('source', 'env CLAUDE_CODE_OAUTH_TOKEN');
    line('expiresAt', 'n/a: an explicit token carries no stored expiry');
    return;
  }
  const f = seen.file;
  for (const [i, k] of seen.keychain.entries()) {
    const a = k.args.indexOf('-a');
    const label = i === 0 ? 'Keychain' : 'Keychain retry';
    line(`${label} query`, `${a === -1 ? 'no -a filter' : `-a ${k.args[a + 1]}`} -s ${loc.service}`);
    line(`${label} lookup`, !k.error ? `found (${k.ms}ms)`
      : i === 0 ? `${outcome(k.error)} → retry without -a`
      : `${outcome(k.error)} (${k.error.code === 44 ? 'item not found → file fallback' : 'locked/denied → no file fallback'})`);
  }
  const k = seen.keychain.find(r => !r.error);
  line('credentials file', loc.file);
  line('file read', !f ? 'not attempted' : f.error ? outcome(f.error) : 'found');
  const meta = k?.meta || f?.meta;
  line('source', k?.meta ? `Keychain "${loc.service}"` : f?.meta ? `file ${loc.file}` : 'none found');
  if (meta?.unparsable) line('credential JSON', 'unparsable → credentials_unavailable');
  else if (meta) {
    line('access token', meta.token ? 'present (not shown)' : 'MISSING → credentials_unavailable');
    line('expiresAt', expiry(meta.expiresAt));
    line('subscriptionType', meta.subscriptionType);
  }
  if (seen.keychain.length && !k) await printKeychainItem(loc.service);
}

function printUsage() {
  header('usage_fetch: GET https://api.anthropic.com/api/oauth/usage');
  const f = seen.fetch;
  if (!f) return line('result', NOT_REACHED);
  line('request headers', f.headerNames.join(', '));
  line('User-Agent', f.userAgent);
  line('wall time', `${f.ms}ms`);
  line('HTTP status', f.error ? outcome(f.error) : f.status);
  if (f.retryAfter) line('retry-after', f.retryAfter);
}

function printResult(normalized) {
  header('result');
  line('connectionState', normalized.connectionState);
  line('plan', normalized.plan);
  line('status', normalized.status);
  for (const w of normalized.windows) line(`window ${w.id}`, `${w.usagePercent ?? '?'}%, resets ${w.resetAt ?? '?'}`);
  line('unavailableReason', normalized.unavailableReason);
  if (seen.log) {
    line('failing stage', `${seen.log.stage} (${seen.log.ms}ms)`);
    line('server log line', seen.log.text);
  } else if (normalized.unavailableReason) {
    line('failing stage', 'none in readClaudeQuota(); normalizeQuota() found no window with a measured usage');
  } else {
    line('failing stage', 'none: every stage passed');
  }
}

async function main() {
  const t0 = Date.now();
  const projectRoot = config.PROJECT_ROOT;
  header('environment');
  line('platform', `${process.platform} ${os.release()} (${process.arch})`);
  line('node', `${process.version} @ ${process.execPath}`);
  line('project root', projectRoot);
  line('CLAUDE_BIN', config.CLAUDE_BIN);

  const raw = await readClaudeQuota(config, {
    projectRoot, runFile: observedRunFile, readFile: observedReadFile, fetch: observedFetch,
    log: (text, detail) => { seen.log = { text, ...detail }; },
  });
  await printAuth();
  await printCredential();
  printUsage();
  printResult(normalizeQuota('claude', projectRoot, raw));
  console.log(`\nelapsed=${Date.now() - t0}ms`);
}

main().catch((err) => {
  console.error('[probe-claude-quota] failed:', err);
  process.exitCode = 1;
});
