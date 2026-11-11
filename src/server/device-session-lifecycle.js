'use strict';

const { request } = require('../cli/http');
const { claimKey, RELEASE_MARK_MS } = require('./device-claim-registry');

// Device attribution for a task's terminal run: the PTY's spawn claims the task for this machine's
// device (POST .../device-sessions, the legacy `{ device_id }` contract) and the PTY's exit releases
// that claim. resolveDeviceId(credentials) names the device: ws-handlers.js backs it with the one
// device identity (device-identity.js) index.js also gives the device relay, so a run is
// attributed to the device the relay connects as, found by this machine's id for the run's
// account. A config.json DEVICE_ID is never read: a committed config would attribute every clone's
// runs to the machine that wrote it.
//
// Updates are serialized per API/project/task: a fast exit must not send DELETE before its POST
// finishes, nor erase a replacement run's claim.
//
// A legacy claim holds no lease, so a run still going when its server exits (app quit, crash,
// relaunch for an update) leaves its claim open: no exit callback is left to release it, and the
// API answers every other device's claim for that task 409 task_claimed. releaseStaleClaims()
// ends such claims, once per project and account per process: it lists the project's tasks and
// releases each open claim of this machine's device that no live run on this machine holds. Every
// run records its claim before sending it in the claim registry getClaimRegistry() returns
// (device-claim-registry.js), which the other Task App servers of this OS user share: they share
// this machine's device id too. Without that registry nothing is released.

const TASK_LIST_TIMEOUT_MS = 30_000;
// A run that starts while another server releases its task's abandoned claim polls for the end of
// that release, for at most as long as a release mark lasts.
const RELEASE_POLL_MS = 100;
// A claim the relay reports a live session for is a running run of this device, wherever it runs.
const LIVE_STATES = new Set(['starting', 'running']);

const positiveId = value => Number.isSafeInteger(value) && value > 0;

function tokenUserId(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url')).id ?? null; } catch { return null; }
}

// One task's claims are one queue and one registry entry however the API base is spelled.
function apiBase(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return String(baseUrl); }
}
const taskScope = (credentials, taskId) => JSON.stringify([apiBase(credentials.baseUrl), String(credentials.projectId), String(taskId).toUpperCase()]);
const passKey = credentials => JSON.stringify([apiBase(credentials.baseUrl), String(credentials.projectId), tokenUserId(credentials.token)]);
const tasksUrl = credentials => `${credentials.baseUrl}/api/projects/${encodeURIComponent(credentials.projectId)}/tasks`;

function createDeviceSessionLifecycle({
  httpRequest = request,
  resolveDeviceId = () => null,
  getClaimRegistry = () => null,
  log = console,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const pending = new Map(); // task scope -> its last queued update
  const passes = new Map(); // pass key -> stale-claim pass, kept once one succeeds

  function enqueue(key, operation) {
    const previous = pending.get(key) || Promise.resolve();
    const next = previous.then(operation).catch(() => {
      log.warn('[device-session] API attribution update failed');
    }).finally(() => { if (pending.get(key) === next) pending.delete(key); });
    pending.set(key, next);
    return next;
  }

  function refused(res, what, taskId) {
    if (res && res.status >= 400) log.warn(`[device-session] the API refused the ${what} for ${taskId} (HTTP ${res.status})`);
  }

  // Recorded in the claim registry before the POST, so another server never releases it. When that
  // server is releasing an abandoned claim on this task right now, the API would attach this run to
  // the old claim and the release would end it: claim once the release is done.
  async function holdOnMachine(claim) {
    const registry = getClaimRegistry();
    if (!registry) return;
    const key = claimKey(claim.scope, claim.deviceId);
    const { id, releasing } = await registry.hold(key);
    claim.registry = registry;
    claim.holdId = id;
    if (!releasing) return;
    const deadline = now() + RELEASE_MARK_MS;
    while (registry.releasing(key) && now() < deadline) await sleep(RELEASE_POLL_MS);
  }

  function postDeviceSession(session, taskId, backend) {
    if (session._deviceClaim || session.type !== 'terminal' || !session.alive || !session.pty) return;
    let credentials;
    // A project with no API target has no account to look a device up for: no lookup, no claim.
    try { credentials = backend.getCredentials(); } catch { return; }
    const url = `${tasksUrl(credentials)}/${encodeURIComponent(taskId)}/device-sessions`;
    const scope = taskScope(credentials, taskId);
    const claim = { deviceId: null, url, scope, credentials, backend, taskId, released: false, registry: null, holdId: null };
    session._deviceClaim = claim;
    // Asked before queueing, so the lookup overlaps an earlier run's pending release. A run that
    // starts while it is still in flight is claimed once it answers; one it cannot answer for is
    // not claimed at all, and its release then sends nothing.
    const resolved = Promise.resolve().then(() => resolveDeviceId(credentials)).catch(() => null);
    const update = enqueue(scope, async () => {
      const deviceId = await resolved;
      if (!positiveId(deviceId)) return;
      claim.deviceId = deviceId;
      await holdOnMachine(claim);
      refused(await httpRequest(url, {
        method: 'POST', headers: { Authorization: `Bearer ${credentials.token}` },
        body: { device_id: deviceId }, timeoutMs: 5000,
      }), 'claim', taskId);
    });
    // A project this server runs a task in gets its abandoned claims released too.
    releaseStaleClaims(backend);
    return update;
  }

  function deleteDeviceSession(session) {
    const claim = session?._deviceClaim;
    if (!claim || claim.released) return;
    claim.released = true;
    session._deviceClaim = null;
    // Queued behind the claim, so claim.deviceId is settled by now: the device the claim named,
    // released even when its POST failed (the API may still have stored it), or null when no
    // claim was sent.
    return enqueue(claim.scope, async () => {
      if (claim.deviceId == null) return;
      let credentials = claim.credentials;
      try {
        const live = claim.backend.getCredentials();
        // Renewed tokens may release this run; an account/project switch may not redirect it.
        if (live.baseUrl === credentials.baseUrl && String(live.projectId) === String(credentials.projectId)
          && tokenUserId(live.token) != null && tokenUserId(live.token) === tokenUserId(credentials.token)) credentials = live;
      } catch { /* Original run credentials retain their original scope. */ }
      let landed = false;
      try {
        const res = await httpRequest(`${claim.url}/${claim.deviceId}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${credentials.token}` }, timeoutMs: 5000,
        });
        refused(res, 'release', claim.taskId);
        landed = !(res && res.status >= 400);
      } finally {
        // A release that did not land leaves the claim open: the project's next pass retries it.
        if (!landed) forgetPass(passKey(claim.credentials));
        if (claim.registry) await claim.registry.drop(claim.holdId);
      }
    });
  }

  function forgetPass(key, pass) {
    if (pass === undefined || passes.get(key) === pass) passes.delete(key);
  }

  // Ends the abandoned claim of this machine's device on one task, unless a live run on this
  // machine holds it: one of this server's (each holds its claim in the registry before sending it,
  // and this queue runs a release judged here after any claim queued before it) or another server's.
  // true: nothing is left to do for it; false: try again on the next pass.
  async function releaseIfAbandoned(credentials, taskKey, deviceId) {
    const registry = getClaimRegistry();
    if (!registry) return false;
    const key = claimKey(taskScope(credentials, taskKey), deviceId);
    const verdict = await registry.beginRelease(key);
    if (verdict === 'held') return true;
    if (verdict !== 'marked') return false;
    try {
      const res = await httpRequest(`${tasksUrl(credentials)}/${encodeURIComponent(taskKey)}/device-sessions/${deviceId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${credentials.token}` }, timeoutMs: 5000,
      });
      if (res && res.status >= 400) {
        refused(res, 'stale claim release', taskKey);
        return false;
      }
      if (typeof log.log === 'function') log.log(`[device-session] released the claim a run on this machine left open on ${taskKey}`);
      return true;
    } finally {
      await registry.endRelease(key);
    }
  }

  async function runPass(credentials) {
    const deviceId = await Promise.resolve().then(() => resolveDeviceId(credentials)).catch(() => null);
    if (!positiveId(deviceId)) return false;
    // Summary rows carry each task's active_device; reservation placeholders are never run.
    const listed = await httpRequest(`${tasksUrl(credentials)}?fields=summary&include_children_count=false`, {
      method: 'GET', headers: { Authorization: `Bearer ${credentials.token}` }, timeoutMs: TASK_LIST_TIMEOUT_MS,
    });
    if (!listed || listed.status >= 400 || !Array.isArray(listed.data?.tasks)) {
      refused(listed, 'task list', `project ${credentials.projectId}`);
      return false;
    }
    // Another device's claim is never touched, nor one the relay sees running on this device.
    const abandoned = listed.data.tasks.filter(task => typeof task?.task_key === 'string' && task.task_key
      && task.active_device?.id === deviceId && !LIVE_STATES.has(task.active_device.state));
    const results = await Promise.all(abandoned.map(task => enqueue(taskScope(credentials, task.task_key),
      () => releaseIfAbandoned(credentials, task.task_key, deviceId))));
    return results.every(result => result === true);
  }

  // Releases the claims runs on this machine left open in `backend`'s project, once per project and
  // account per process; a pass that could not finish (no device id, no task list, a claim it could
  // not judge or release) is run again by the next call. Calls during a pass share it. Resolves
  // true once the project is clean; never rejects. No registry or no API target: no request.
  function releaseStaleClaims(backend) {
    if (!getClaimRegistry()) return Promise.resolve(false);
    let credentials;
    try { credentials = backend.getCredentials(); } catch { return Promise.resolve(false); }
    const key = passKey(credentials);
    if (passes.has(key)) return passes.get(key);
    const pass = runPass(credentials).catch(() => false);
    passes.set(key, pass);
    pass.then((clean) => { if (!clean) forgetPass(key, pass); });
    return pass;
  }

  return { postDeviceSession, deleteDeviceSession, releaseStaleClaims };
}

module.exports = { createDeviceSessionLifecycle };
