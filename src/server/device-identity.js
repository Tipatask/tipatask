'use strict';

// Which registered device this machine is. The API names a device by its row id; this module
// finds that row for the machine it runs on. Its consumers share the one instance index.js
// creates, so they always name the same device and share one lookup per account:
// - the device relay (device-relay.js, deviceIdFor()), which also links the device to each
//   opted-in project, because the relay and GET /api/devices/online only serve a device in the
//   projects it is linked to;
// - run attribution (device-session-lifecycle.js, deviceIdForAccount()) and the board's own-device
//   check, which need no link: a task's device-sessions claim only checks that the device is the
//   account's own.
// - the agent model report (agent-model-report.js, deviceIdForAccount()), which names the device
//   whose model lists it reports for each project; no link either.
//
// The machine id every setup path keeps in ~/.tipatask/device_id selects the signed-in account's
// device row, registered on first use the way setup registers one (name: the host name). A
// project's config.json DEVICE_ID is deliberately not consulted: projects configured before that
// key existed have none, and a committed config.json would hand this machine's id to every
// clone, which would then connect as, and attribute its runs to, this machine. Results are kept
// per API server and account for the life of the process, and nothing is written to any project
// config.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MACHINE_ID_PATH = path.join(os.homedir(), '.tipatask', 'device_id');
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_MS = 60_000;
const STEP_TEXT = {
  lookup: "look up this machine's device",
  register: 'register this machine as a device',
  link: "link this machine's device",
};

function tokenUserId(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url'));
    return payload && payload.id != null ? payload.id : null;
  } catch { return null; }
}

// Same file main.js getOrCreateMachineId() and cli/setup.js use. Created exclusively, so a
// concurrent writer's id wins instead of being overwritten.
function readOrCreateMachineId(file) {
  const read = () => {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch (err) {
      if (err.code === 'ENOENT') return '';
      throw err;
    }
  };
  const existing = read();
  if (existing) return existing;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, randomUUID(), { encoding: 'utf8', flag: 'wx' }); } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const created = read();
  if (!created) throw Object.assign(new Error('Machine id unavailable'), { code: 'machine_id_unavailable' });
  return created;
}

function stepError(step, status) {
  return Object.assign(new Error(`Device ${step} failed`), { step, status });
}

function createDeviceIdentity({
  request = require('../cli/http').request,
  machineIdPath = MACHINE_ID_PATH,
  hostname = () => os.hostname(),
  now = Date.now,
  retryMs = RETRY_MS,
  log = console,
  onChange = () => {},
} = {}) {
  // JSON [origin, user id] -> { device, lookup, failure, links: Map(project id -> link) }
  const accounts = new Map();

  const authorization = credentials => ({ Authorization: `Bearer ${credentials.token}` });

  function accountFor(credentials) {
    if (!credentials) return null;
    let origin;
    try { origin = new URL(credentials.baseUrl).origin; } catch { return null; }
    const userId = tokenUserId(credentials.token);
    if (userId == null) return null;
    const key = JSON.stringify([origin, userId]);
    let account = accounts.get(key);
    if (!account) {
      account = { device: null, lookup: null, failure: null, links: new Map() };
      accounts.set(key, account);
    }
    return account;
  }

  // One lookup per account at a time; a failed one is forgotten so the next attempt reads again.
  function lookupDevice(account, credentials) {
    if (account.device) return Promise.resolve(account.device);
    if (!account.lookup) {
      account.lookup = (async () => {
        const machineId = readOrCreateMachineId(machineIdPath);
        const listed = await request(`${credentials.baseUrl}/api/devices`, {
          method: 'GET', headers: authorization(credentials), timeoutMs: REQUEST_TIMEOUT_MS,
        });
        if (listed.status < 200 || listed.status >= 300) throw stepError('lookup', listed.status);
        if (!Array.isArray(listed.data?.devices)) throw stepError('lookup', 'invalid_response');
        let device = (listed.data?.devices || []).find(candidate => candidate.machine_id === machineId);
        if (!device) {
          const registered = await request(`${credentials.baseUrl}/api/devices`, {
            method: 'POST', headers: authorization(credentials), timeoutMs: REQUEST_TIMEOUT_MS,
            body: { name: hostname(), machine_id: machineId },
          });
          if (registered.status < 200 || registered.status >= 300) throw stepError('register', registered.status);
          device = registered.data?.device;
        }
        if (!Number.isSafeInteger(device?.id) || device.id <= 0) throw stepError('lookup', 'invalid_response');
        account.device = {
          id: device.id,
          projectIds: new Set((Array.isArray(device.project_ids) ? device.project_ids : []).map(Number)),
        };
        return account.device;
      })().finally(() => { account.lookup = null; });
    }
    return account.lookup;
  }

  async function ensureLinked(account, projectId, credentials) {
    const device = await lookupDevice(account, credentials);
    if (device.projectIds.has(projectId)) return;
    const linked = await request(`${credentials.baseUrl}/api/devices/${device.id}/projects`, {
      method: 'POST', headers: authorization(credentials), timeoutMs: REQUEST_TIMEOUT_MS,
      body: { project_id: projectId },
    });
    if (linked.status < 200 || linked.status >= 300) throw stepError('link', linked.status);
    if (Number(linked.data?.device_id) !== device.id || Number(linked.data?.project_id) !== projectId) {
      throw stepError('link', 'invalid_response');
    }
    device.projectIds.add(projectId);
  }

  const failureReason = err => (err.status !== undefined ? `HTTP ${err.status}` : (err.code || 'network error'));

  // Once per failure streak: a down API fails every retry the same way.
  function report(link, projectId, err) {
    const text = `[device-relay] could not ${STEP_TEXT[err.step] || STEP_TEXT.lookup} for project ${projectId} (${failureReason(err)}); retrying in ${Math.round(retryMs / 1000)}s`;
    if (link.failure === text) return;
    link.failure = text;
    log.warn(text);
  }

  // This machine's device id for the account `credentials` sign in to, for attributing a run to
  // it and for recognizing this machine's own runs on the board. Nothing is linked: the API only
  // checks that a claimed device is the account's own. The lookup is the relay's: a call while
  // one is in flight waits for it, and once one has answered no request is made again. Resolves
  // null for unusable credentials or a failed lookup (logged once per failure streak, retried by
  // the next call); never rejects.
  function deviceIdForAccount(credentials) {
    let account;
    try { account = accountFor(credentials); } catch { account = null; }
    if (!account) return Promise.resolve(null);
    return lookupDevice(account, credentials).then((device) => {
      account.failure = null;
      return device.id;
    }, (err) => {
      const text = `[device-session] could not ${STEP_TEXT[err.step] || STEP_TEXT.lookup} (${failureReason(err)}); runs started now are not attributed to it`;
      if (account.failure !== text) {
        account.failure = text;
        log.warn(text);
      }
      return null;
    });
  }

  // The device id the relay may use for this project's account, or null until this machine's
  // device is known and linked to the project. A null starts that work (or waits out the retry
  // delay after a failure); onChange() reports its success. Never throws, never blocks.
  function deviceIdFor({ backend }) {
    let credentials;
    try { credentials = backend.getCredentials(); } catch { return null; }
    const projectId = Number(credentials?.projectId);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) return null;
    const account = accountFor(credentials);
    if (!account) return null;
    let link = account.links.get(projectId);
    if (!link) {
      link = { linked: false, pending: null, failedAt: -Infinity, failure: null };
      account.links.set(projectId, link);
    }
    if (link.linked && account.device) return account.device.id;
    if (!link.pending && now() - link.failedAt >= retryMs) {
      link.pending = ensureLinked(account, projectId, credentials)
        .then(() => {
          link.linked = true;
          link.failure = null;
          try { onChange(); } catch { /* the relay's own poll picks the id up within 30s */ }
        }, (err) => {
          link.failedAt = now();
          report(link, projectId, err);
        })
        .finally(() => { link.pending = null; });
    }
    return null;
  }

  return { deviceIdFor, deviceIdForAccount };
}

module.exports = { createDeviceIdentity, readOrCreateMachineId, MACHINE_ID_PATH };
