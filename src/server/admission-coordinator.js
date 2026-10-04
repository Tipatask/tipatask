'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DEVICE_DIRECTORY, initialPressureState } = require('./admission-policy');

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code !== 'ESRCH'; }
}

function validState(state) {
  const natural = value => Number.isSafeInteger(value) && value >= 0;
  const time = value => value === null || natural(value);
  const p = state?.pressure;
  if (state?.version !== 1 || !state.instances || Array.isArray(state.instances)
    || Object.keys(state.instances).length > 128 || !p || !['pressure', 'swap', 'headroom', null].includes(p.alarm)
    || !time(p.normalSince) || !time(p.lastStartAt) || !Array.isArray(p.samples) || p.samples.length > 128
    || (state.nextTicket !== undefined && !natural(state.nextTicket))) return false;
  if (!p.samples.every(s => natural(s.at) && natural(s.swap) && natural(s.page) && s.page > 0
    && ['normal', 'warning', 'critical'].includes(s.pressure))) return false;
  return Object.values(state.instances).every(o => natural(o.pid) && o.pid > 1 && natural(o.at)
    && typeof o.fingerprint === 'string' && ['static', 'pressure'].includes(o.mode)
    && natural(o.staticCap) && o.staticCap > 0 && natural(o.fallbackCap) && o.fallbackCap > 0
    && Array.isArray(o.slots) && o.slots.length <= 256
    && o.slots.every(s => typeof s.id === 'string' && typeof s.project === 'string' && typeof s.running === 'boolean'
      && (s.pid === null || (natural(s.pid) && s.pid > 1)) && natural(s.reservedBytes) && natural(s.gapBytes))
    && Array.isArray(o.queued) && o.queued.length <= 4096 && o.queued.every(q => typeof q.id === 'string'
      && typeof q.project === 'string' && natural(q.ticket) && q.ticket > 0 && natural(q.estimateBytes)
      && (q.projectCap === null || (natural(q.projectCap) && q.projectCap > 0)))
    && natural(o.extraGapBytes));
}

// A short synchronous transaction owns the lock through check AND reservation.
// No asynchronous spawn preparation or process inspection runs under this lock.
function createAdmissionCoordinator({ directory = DEVICE_DIRECTORY, pid = process.pid,
  alive = pidAlive, now = Date.now } = {}) {
  const instance = randomUUID();
  const lock = path.join(directory, 'admission.lock');
  const file = path.join(directory, 'admission-state.json');
  function transaction(fn) {
    let held = false;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { fs.mkdirSync(lock, { mode: 0o700 }); held = true; }
      catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // Remove only the dead owner's uniquely named file, then rmdir. A racing
        // replacement lock has its own file and cannot be removed by this reaper.
        const owners = fs.readdirSync(lock);
        if (owners.length !== 1 || !/^\d+-[a-f0-9-]+$/.test(owners[0])) throw Error('lock-busy');
        const ownerPid = Number(owners[0].split('-')[0]);
        if (alive(ownerPid)) throw Error('lock-busy');
        fs.unlinkSync(path.join(lock, owners[0]));
        fs.rmdirSync(lock);
        fs.mkdirSync(lock, { mode: 0o700 }); held = true;
      }
      fs.writeFileSync(path.join(lock, `${pid}-${instance}`), '', { flag: 'wx', mode: 0o600 });
      let state;
      try {
        if (fs.statSync(file).size > 1024 * 1024) throw Error('state-oversize');
        state = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!validState(state)) throw Error('state-invalid');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        state = { version: 1, instances: {}, pressure: initialPressureState() };
      }
      // Never expire a live server's reservations by heartbeat alone. A suspended
      // server may resume at any time, and its children still own memory.
      for (const [id, owner] of Object.entries(state.instances)) {
        if (alive(owner.pid)) continue;
        const holders = (owner.slots || []).filter(slot => slot.pid ? alive(slot.pid) : slot.running);
        if (holders.length) { owner.slots = holders; owner.orphaned = true; }
        else delete state.instances[id];
      }
      const result = fn(state, instance);
      if (!validState(state)) throw Error('state-invalid');
      const tmp = `${file}.${instance}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
      return { ok: true, result };
    } catch (err) { return { ok: false, reason: 'coordination', detail: err.code || err.message }; }
    finally {
      if (held) {
        try { fs.unlinkSync(path.join(lock, `${pid}-${instance}`)); fs.rmdirSync(lock); } catch { /* fail closed next time */ }
      }
    }
  }
  return { instance, pid, transaction, stop() {
    return transaction(state => {
      // Keep memory holders on shutdown until their actual processes disappear.
      const owner = state.instances[instance];
      if (owner) { owner.at = now(); owner.stopped = true; }
    });
  } };
}

const OWN_SCRIPTS = [path.join(__dirname, '..', '..', 'todo-server.js'), path.join(__dirname, 'index.js')];
const SERVER_BINARY = /^(?:node|nodejs|electron|.+ Helper(?: \(\w+\))?)$/i;

function parseLines(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const rows = new Map();
  for (const line of text.trim().split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return null;
    rows.set(Number(match[1]), match[2]);
  }
  return rows;
}

// Bounded census input is used only in memory; never log/persist command lines.
// Unknown entry points cannot prove coordination, so callers require a successful
// census containing themselves before enabling dynamic expansion. A pid counts only
// when its executable (`ps comm`) is node/electron/an Electron helper/this server's
// own binary AND the first non-flag argument is the server script, so editors,
// grep/tail and agent processes whose argv merely mentions the file never count.
// `comm` is optional; without it argv0 is taken as the first whitespace token.
function parseServerCensus(argsText, commText, { scripts = OWN_SCRIPTS, execPath = process.execPath } = {}) {
  const args = parseLines(argsText);
  if (!args) return null;
  const comms = commText === undefined ? null : parseLines(commText);
  if (commText !== undefined && !comms) return null;
  const ownBinary = path.basename(execPath || '');
  const pids = [];
  for (const [pid, line] of args) {
    const comm = comms ? comms.get(pid) : line.split(/\s+/)[0];
    if (!comm) continue;
    const binary = path.basename(comm);
    if (!SERVER_BINARY.test(binary) && binary !== ownBinary) continue;
    let rest = line.startsWith(comm) ? line.slice(comm.length) : line.replace(/^\S+/, '');
    rest = rest.replace(/^(?:\s+-\S*)*\s+/, '');
    if (/^(?:\S*\/)?todo-server\.js(?:\s|$)/.test(rest)
      || scripts.some(script => rest === script || rest.startsWith(`${script} `))) pids.push(pid);
  }
  return pids;
}

module.exports = { createAdmissionCoordinator, parseServerCensus, pidAlive };
