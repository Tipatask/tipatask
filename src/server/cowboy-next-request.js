'use strict';

// (TPT9163) The agent side of a cowboy chain. The start_next_tasks MCP tool (src/mcp/server.js) and
// `tt next <key>` (src/cli/task-tools.js) ask Task App to start the next tasks of this run's chain:
// POST /api/tasks/:key/cowboy-next, answered by terminal-session.js launchCowboyChain(). The run's
// PTY env carries the only credential that route takes (withCowboyEnv()): TIPATASK_COWBOY_TOKEN, sent
// as the x-tipatask-run-token header, and TIPATASK_COWBOY_URL, that route for the run's own task on
// the local Task App. requestNextTasks() never throws and never puts the token in its result.

const { RUN_TOKEN_HEADER, LOCAL_HOST } = require('./local-access');

const COWBOY_TOKEN_ENV = 'TIPATASK_COWBOY_TOKEN';
const COWBOY_URL_ENV = 'TIPATASK_COWBOY_URL';
// Both variables, for launchers that forward only named variables to an MCP server (Codex env_vars).
const COWBOY_ENV_VARS = Object.freeze([COWBOY_TOKEN_ENV, COWBOY_URL_ENV]);
const ROUTE_RE = /^\/api\/tasks\/([^/]+)\/cowboy-next$/;
// Below Codex's 60 s MCP tool timeout; a decision normally takes a few task reads.
const REQUEST_TIMEOUT_MS = 45000;

// The route's 409 refusals (ws-handlers.js): the run or its task does not qualify, nothing started.
const REFUSALS = Object.freeze({
  no_session: 'Task App has no live terminal for this task.',
  not_cowboy: 'This run is not part of a cowboy chain.',
  not_bypass: 'This run or its task is no longer in Bypass mode.',
  not_finished: 'Task App does not see this task as complete.',
});

function failure(reason, error, status = null) {
  return { ok: false, status, started: [], reason, error };
}

function decodeKey(encoded) {
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}

// taskKey: the task this run just completed. env: the run's environment (TIPATASK_COWBOY_*).
// Returns { ok: true, status: 200, started: [keys], reason, previous? } for a decision — a repeat
// answers reason 'already_launched' with the first decision as `previous` — else
// { ok: false, status, started: [], reason, error }.
async function requestNextTasks(taskKey, { env = process.env, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const key = typeof taskKey === 'string' ? taskKey.trim() : '';
  if (!key) return failure('no_task_key', 'Pass the key of the task this run just completed. Nothing was started.');
  const token = env[COWBOY_TOKEN_ENV];
  if (!token) {
    return failure('no_token', `${COWBOY_TOKEN_ENV} is not set: start_next_tasks works only inside a cowboy chain run (a Bypass task run with Cowboy-coding mode on, or one a chain started). Nothing was started.`);
  }
  let url = null;
  try { url = new URL(env[COWBOY_URL_ENV]); } catch { url = null; }
  // The token must never leave this machine: only the local Task App's route qualifies.
  const route = url && url.protocol === 'http:' && url.hostname === LOCAL_HOST ? ROUTE_RE.exec(url.pathname) : null;
  if (!route) {
    return failure('no_url', `${COWBOY_URL_ENV} is missing or is not this run's local Task App route. Nothing was started.`);
  }
  const ownKey = decodeKey(route[1]);
  if (ownKey !== key) {
    return failure('wrong_task', `${key} is not this run's task: pass ${ownKey}, the task this run just completed. Nothing was started.`);
  }
  const redact = text => String(text).split(token).join('[redacted]');
  let res;
  try {
    res = await fetchImpl(`${url.origin}${url.pathname}`, {
      method: 'POST',
      headers: { [RUN_TOKEN_HEADER]: token },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      return failure('timeout', `Task App did not answer within ${Math.round(timeoutMs / 1000)} s; it may still start the next tasks.`);
    }
    return failure('unreachable', redact(`Could not reach Task App at ${url.origin}: ${err && err.message}. Nothing was started.`));
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  const reason = body && typeof body.reason === 'string' ? body.reason : null;
  if (res.status === 200 && body && Array.isArray(body.started)) {
    return { ok: true, status: 200, started: body.started, reason, ...(body.previous ? { previous: body.previous } : {}) };
  }
  if (res.status === 403) {
    return failure('forbidden', 'Task App refused this run\'s token: it opens the route only for this run\'s own task while the run is live. Nothing was started.', 403);
  }
  if (res.status === 409 && reason) {
    return failure(reason, `${REFUSALS[reason] || `Task App refused (${reason}).`} Nothing was started.`, 409);
  }
  if (res.status === 503) {
    const detail = body && typeof body.error === 'string' && body.error ? `: ${redact(body.error)}` : '';
    return failure('unavailable', `Task App could not read the tasks${detail}. Nothing was started.`, 503);
  }
  return failure('unexpected', `Task App answered HTTP ${res.status}. Nothing was started.`, res.status);
}

module.exports = { COWBOY_TOKEN_ENV, COWBOY_URL_ENV, COWBOY_ENV_VARS, REQUEST_TIMEOUT_MS, requestNextTasks };
