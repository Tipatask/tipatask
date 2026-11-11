'use strict';

// Which task claims the live terminal runs on this machine hold, shared by every Task App server
// of this OS user. They all read ~/.tipatask/device_id, so the API knows them as one device, and a
// legacy claim (device-session-lifecycle.js) names only that device: a server that finds this
// device's claim open on a task cannot tell from the API whether another server's live run holds
// it or a server that exited mid-run left it behind. Each server records here the claims its runs
// hold, and marks a claim it is about to release as abandoned, so:
// - a claim another live server's run holds is never released (beginRelease() answers 'held');
// - a run that starts while another server is releasing its task's abandoned claim sends its own
//   claim after that release (hold() answers releasing: true), instead of having the API attach it
//   to the old claim and the release end both.
//
// One JSON file under a mkdir lock, written by short synchronous transactions (the admission
// coordinator's pattern, admission-coordinator.js):
//   { version: 1, instances: { <server id>: { pid, claims: { <run id>: <claim key> },
//                                             releases: { <claim key>: <marked at, ms> } } } }
// A server writes only its own entry, rebuilt from memory on every transaction, so a failed write
// loses nothing it still holds. An entry whose pid is gone, or that names this server's pid under
// another server id (a recycled pid), is dropped. A release mark expires after RELEASE_MARK_MS.
// Claim keys are SHA-256 hashes of the API base, project, task key and device id: no URL or task
// key is written to disk. An unreadable or invalid file fails closed: nothing is released until
// it is readable again, while runs still claim their tasks as before.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { MACHINE_ID_PATH } = require('./device-identity');
const { pidAlive } = require('./admission-coordinator');

// Next to the machine id: servers that share the id share the device, and so this registry.
const DEVICE_DIRECTORY = path.dirname(MACHINE_ID_PATH);
const STATE_FILE = 'device-claims.json';
const LOCK_DIR = 'device-claims.lock';
// A release sends one DELETE with a 5s deadline; a mark this old belongs to a server that stopped
// (suspended, or its pid recycled) before clearing it.
const RELEASE_MARK_MS = 15_000;
const LOCK_RETRIES = 8;
const LOCK_RETRY_MS = 25;
// An empty lock directory is a lock whose owner died between creating it and naming itself.
const EMPTY_LOCK_STALE_MS = 10_000;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_INSTANCES = 64;
const MAX_ENTRIES = 1024;

const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LOCK_OWNER = /^(\d+)-[a-f0-9-]+$/;

// The registry identity of one task's claim by one device.
function claimKey(taskScope, deviceId) {
  return createHash('sha256').update(`${taskScope}\n${deviceId}`).digest('hex');
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validState(state) {
  if (state?.version !== 1 || !plain(state.instances)) return false;
  const instances = Object.entries(state.instances);
  if (instances.length > MAX_INSTANCES) return false;
  return instances.every(([id, entry]) => UUID.test(id) && plain(entry)
    && Number.isSafeInteger(entry.pid) && entry.pid > 1
    && plain(entry.claims) && Object.keys(entry.claims).length <= MAX_ENTRIES
    && Object.entries(entry.claims).every(([run, key]) => UUID.test(run) && typeof key === 'string' && HEX64.test(key))
    && plain(entry.releases) && Object.keys(entry.releases).length <= MAX_ENTRIES
    && Object.entries(entry.releases).every(([key, at]) => HEX64.test(key) && Number.isSafeInteger(at) && at >= 0));
}

const failure = code => Object.assign(new Error(code), { code });

function readState(file) {
  let text;
  try {
    if (fs.statSync(file).size > MAX_STATE_BYTES) throw failure('state-oversize');
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, instances: {} };
    throw err;
  }
  let state;
  try { state = JSON.parse(text); } catch { throw failure('state-invalid'); }
  if (!validState(state)) throw failure('state-invalid');
  return state;
}

function createDeviceClaimRegistry({
  directory = DEVICE_DIRECTORY,
  pid = process.pid,
  alive = pidAlive,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = console,
} = {}) {
  const instance = randomUUID();
  const file = path.join(directory, STATE_FILE);
  const lock = path.join(directory, LOCK_DIR);
  const owner = `${pid}-${instance}`;
  const held = new Map(); // run id -> claim key, for this server's runs
  const marks = new Map(); // claim key -> when this server marked it for release
  let written = false;
  let lastFailure = null;

  // A lock whose owner is gone is taken over; anything that changes under us while looking counts
  // as busy, and is retried.
  function reapOrBusy() {
    let owners;
    try { owners = fs.readdirSync(lock); } catch { throw failure('lock-busy'); }
    if (owners.length === 1 && LOCK_OWNER.test(owners[0])) {
      if (alive(Number(owners[0].match(LOCK_OWNER)[1]))) throw failure('lock-busy');
      // Only the dead owner's own file: a reaper that lost the race to it gets ENOENT here.
      try { fs.unlinkSync(path.join(lock, owners[0])); } catch { throw failure('lock-busy'); }
    } else {
      let age = 0;
      try { age = now() - fs.statSync(lock).mtimeMs; } catch { /* gone: busy */ }
      if (owners.length !== 0 || age < EMPTY_LOCK_STALE_MS) throw failure('lock-busy');
    }
    try { fs.rmdirSync(lock); fs.mkdirSync(lock, { mode: 0o700 }); } catch { throw failure('lock-busy'); }
  }

  function acquire() {
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      reapOrBusy();
    }
    try { fs.writeFileSync(path.join(lock, owner), '', { flag: 'wx', mode: 0o600 }); } catch (err) {
      try { fs.rmdirSync(lock); } catch { /* reaped after EMPTY_LOCK_STALE_MS */ }
      throw err;
    }
  }

  function release() {
    try { fs.unlinkSync(path.join(lock, owner)); fs.rmdirSync(lock); } catch { /* reaped as a dead owner's later */ }
  }

  // Whether another server's entry still belongs to a live server.
  const live = (id, entry) => id === instance || (entry.pid !== pid && alive(entry.pid));

  function ownEntry(state) {
    const at = now();
    for (const [key, markedAt] of marks) if (at - markedAt >= RELEASE_MARK_MS) marks.delete(key);
    if (held.size === 0 && marks.size === 0) delete state.instances[instance];
    else state.instances[instance] = { pid, claims: Object.fromEntries(held), releases: Object.fromEntries(marks) };
  }

  const heldOnMachine = (state, key) => Object.entries(state.instances)
    .some(([id, entry]) => live(id, entry) && Object.values(entry.claims).includes(key));
  const releasingElsewhere = (state, key) => Object.entries(state.instances)
    .some(([id, entry]) => id !== instance && live(id, entry)
      && Object.hasOwn(entry.releases, key) && now() - entry.releases[key] < RELEASE_MARK_MS);

  // One synchronous read-modify-write under the lock. `fn` sees the state with dead servers' entries
  // removed and this server's entry rebuilt from memory; it may change that memory, which is written.
  function transaction(fn) {
    let locked = false;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      acquire();
      locked = true;
      const state = readState(file);
      for (const [id, entry] of Object.entries(state.instances)) if (!live(id, entry)) delete state.instances[id];
      ownEntry(state);
      const result = fn(state);
      ownEntry(state);
      if (!validState(state)) throw failure('state-invalid');
      const tmp = `${file}.${instance}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
      written = true;
      lastFailure = null;
      return { ok: true, result };
    } catch (err) {
      return { ok: false, code: err.code || 'error' };
    } finally {
      if (locked) release();
    }
  }

  // A busy lock is held for a few milliseconds at most: retried, never waited on synchronously.
  async function attempt(fn) {
    for (let tries = 0; ; tries++) {
      const tx = transaction(fn);
      if (tx.ok || tx.code !== 'lock-busy' || tries >= LOCK_RETRIES) {
        if (!tx.ok && lastFailure !== tx.code) {
          lastFailure = tx.code;
          log.warn(`[device-session] this machine's claim registry is unavailable (${tx.code}); open claims of this machine's device are kept`);
        }
        return tx;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  return {
    instance,

    // Records that a run of this server holds the claim `key`, before it is sent. `releasing`: another
    // live server is releasing that task's abandoned claim right now, so wait (releasing()) before
    // claiming. Never rejects; a failed write still keeps the hold for this server's next write.
    async hold(key) {
      const id = randomUUID();
      held.set(id, key);
      const tx = await attempt(state => releasingElsewhere(state, key));
      return { id, releasing: tx.ok && tx.result === true };
    },

    // Forgets a hold once its run's release has been sent.
    async drop(id) {
      if (!held.delete(id)) return;
      await attempt(() => {});
    },

    // Whether another live server is releasing the claim `key`. Reads without the lock: every write
    // replaces the file whole. An unreadable file answers false, so a run is never held back by it.
    releasing(key) {
      try {
        const state = readState(file);
        return releasingElsewhere(state, key);
      } catch { return false; }
    },

    // 'marked': no run on this machine holds the claim `key` and this server may release it; call
    // endRelease() once its DELETE has answered. 'held': a live run of this or another server holds
    // it, or another server is releasing it. 'unavailable': the registry could not be read; keep the
    // claim.
    async beginRelease(key) {
      const tx = await attempt((state) => {
        if (heldOnMachine(state, key) || releasingElsewhere(state, key)) return 'held';
        marks.set(key, now());
        return 'marked';
      });
      if (!tx.ok) {
        marks.delete(key);
        return 'unavailable';
      }
      return tx.result;
    },

    async endRelease(key) {
      if (!marks.delete(key)) return;
      await attempt(() => {});
    },

    // Synchronous, for process exit: this server's runs end with it (their PTYs hang up), so its
    // holds go too. A server that never wrote anything touches nothing.
    close() {
      held.clear();
      marks.clear();
      if (!written) return;
      for (let tries = 0; tries < 3; tries++) if (transaction(() => {}).ok) return;
    },
  };
}

module.exports = { createDeviceClaimRegistry, claimKey, DEVICE_DIRECTORY, RELEASE_MARK_MS };
