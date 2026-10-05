'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { STALE_AFTER_MS } = require('./host-memory');

const MAX_SESSIONS = 256;
const MAX_HISTORY = 256;
const MAX_HISTORY_BYTES = 512 * 1024;
const PROVIDERS = ['claude', 'codex', 'pi', 'gemini'];
const WORKLOADS = ['terminal', 'objective', 'specChat', 'taskChat'];

function rootsOf(session) {
  const roots = new Set();
  const add = pid => { if (Number.isSafeInteger(pid) && pid > 1) roots.add(pid); };
  if (session.type === 'terminal' && session.alive) add(session.ptyPid);
  for (const proc of [session.proc, session._heartbeatProc, ...(session._helperProcs || [])]) {
    if (proc && proc.exitCode == null && proc.signalCode == null) add(proc.pid);
  }
  return roots;
}

function sumRss(snapshot, pids) {
  if (!snapshot) return null;
  let sum = 0;
  for (const pid of pids) {
    const rss = snapshot.rssOf.get(pid);
    if (!Number.isSafeInteger(rss) || rss < 0) return null;
    sum += rss * 1024;
  }
  return Number.isSafeInteger(sum) ? sum : null;
}

// One child index for the whole poll. Each session tree and the cross-session union
// deduplicate PIDs; shared physical pages between different PIDs are still inflated.
function sessionDiagnostics(snapshot, sessions, isRunning = () => false) {
  const children = new Map();
  if (snapshot) for (const [pid, parent] of snapshot.parents) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  const union = new Set(), credited = new Set(), rows = [];
  let admissions = 0, truncated = false, unknown = !snapshot;
  for (const [, session] of sessions) {
    if (!session) continue;
    const admissionSlot = !!isRunning(session);
    if (admissionSlot) admissions++;
    const roots = rootsOf(session);
    if (!roots.size && !admissionSlot) continue;
    if (rows.length >= MAX_SESSIONS) { truncated = true; unknown = true; continue; }
    const pids = new Set();
    let missingRoot = false;
    if (snapshot) for (const root of roots) {
      // A missing root may have exited during sampling. Never attribute a recycled
      // process group after exit or report that race as a measured zero.
      if (!snapshot.parents.has(root)) { missingRoot = true; continue; }
      const pending = [root, ...(snapshot.byPgid.get(root) || [])];
      while (pending.length) {
        const pid = pending.pop();
        if (pids.has(pid)) continue;
        pids.add(pid);
        pending.push(...(children.get(pid) || []));
      }
    }
    for (const pid of pids) union.add(pid);
    const currentRssBytes = missingRoot || (!roots.size && admissionSlot) ? null : sumRss(snapshot, pids);
    const exclusive = new Set([...pids].filter(pid => !credited.has(pid)));
    for (const pid of pids) credited.add(pid);
    const observableRssBytes = currentRssBytes === null ? null : sumRss(snapshot, exclusive);
    if (currentRssBytes === null) unknown = true;
    rows.push({ session, admissionSlot, rootCount: roots.size, pidCount: snapshot ? pids.size : null,
      currentRssBytes, observableRssBytes, paused: !!session._pause, completed: !!session._completionEmitted });
  }
  return { rows, admissionSlots: admissions, memoryOwningSessions: rows.filter(r => r.rootCount > 0).length,
    pidCount: snapshot ? union.size : null, unionRssBytes: unknown ? null : sumRss(snapshot, union), truncated };
}

function identity(session) {
  const provider = session.type === 'terminal' ? session.taskAgent : session.providerType;
  return { provider: PROVIDERS.includes(provider) ? provider : 'unknown',
    admissionClass: session.admissionClass === 'ordinary' ? 'ordinary' : 'unknown',
    workload: WORKLOADS.includes(session.type) ? session.type : 'unknown' };
}

// Only allowlisted measurement fields survive disk reads; task text, paths, env,
// model endpoint names and process argv are never retained.
function cleanRecord(r) {
  if (!r || typeof r.id !== 'string' || !/^[a-f0-9-]{36}$/.test(r.id)) return null;
  const out = { id: r.id, provider: PROVIDERS.includes(r.provider) ? r.provider : 'unknown',
    admissionClass: r.admissionClass === 'ordinary' ? 'ordinary' : (r.admissionClass === 'unknown' ? 'unknown' : 'unclassified'),
    workload: WORKLOADS.includes(r.workload) ? r.workload : 'unknown' };
  for (const key of ['startedAt', 'endedAt', 'sampleCount', 'missingSamples', 'peakRssBytes']) {
    out[key] = Number.isSafeInteger(r[key]) && r[key] >= 0 ? r[key] : null;
  }
  out.completeLifetime = r.completeLifetime === true;
  out.reason = ['completed', 'exited', 'terminated', 'shutdown', 'lost', 'restarted'].includes(r.reason) ? r.reason : 'lost';
  return out;
}

function createSessionMemoryTracker({ now = Date.now, historyFile = null, onLifecycle = null } = {}) {
  const active = new Map();
  const records = new WeakMap();
  let history = [], storageStatus = historyFile ? 'ok' : 'memory-only';
  function readHistory() {
    if (!historyFile) return [];
    try {
      if (fs.statSync(historyFile).size > MAX_HISTORY_BYTES) throw Error('oversize');
      const data = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      if (!Array.isArray(data) || data.length > MAX_HISTORY) throw Error('invalid');
      return data.map(cleanRecord).filter(Boolean);
    } catch (err) { if (err.code !== 'ENOENT') storageStatus = 'unavailable'; return []; }
  }
  history = readHistory();
  function persist(record) {
    // Bounded, best-effort diagnostics. Atomic replacement prevents partial JSON;
    // independent server writers may supersede one another, never share admission state.
    const merged = new Map([...readHistory(), ...history, record].map(r => [r.id, r]));
    history = [...merged.values()].sort((a, b) => a.endedAt - b.endedAt).slice(-MAX_HISTORY);
    if (!historyFile) return;
    const tmp = `${historyFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(historyFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(history), { mode: 0o600 });
      fs.renameSync(tmp, historyFile);
      storageStatus = 'ok';
    } catch {
      storageStatus = 'unavailable';
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
  }
  function begin(session, observedStart = true) {
    const old = records.get(session);
    if (old && active.has(session)) end(session, 'restarted');
    if (active.size >= MAX_SESSIONS) return null;
    const r = { id: randomUUID(), ...identity(session), startedAt: now(), peakRssBytes: null,
      currentRssBytes: null, sampleCount: 0, missingSamples: 0, lastSampleAt: null,
      observedStart, gap: false, completed: false };
    records.set(session, r);
    session._memoryRunId = r.id;
    active.set(session, r);
    try { onLifecycle?.({ type: 'start', id: r.id, ...identity(session), startedAt: r.startedAt,
      observedStart, pid: session.ptyPid || null,
      queueMs: Number.isFinite(session._admittedAt) && Number.isFinite(session.queuedAt)
        ? Math.max(0, session._admittedAt - session.queuedAt) : null,
      startupMs: Number.isFinite(session._admittedAt) ? Math.max(0, r.startedAt - session._admittedAt) : null }); } catch { /* diagnostic only */ }
    return r;
  }
  function finalize(r, reason) {
    const endedAt = now();
    const tailGap = endedAt - (r.lastSampleAt ?? r.startedAt);
    const record = cleanRecord({ ...r, endedAt, reason,
      completeLifetime: reason === 'completed' && r.observedStart && r.sampleCount > 0 && !r.gap
        && !r.missingSamples && tailGap >= 0 && tailGap <= STALE_AFTER_MS });
    persist(record);
    try { onLifecycle?.({ type: 'end', ...record }); } catch { /* diagnostic only */ }
    return record;
  }
  function end(session, reason = 'exited') {
    const r = records.get(session);
    if (!r) return;
    if (r.ended && reason !== 'completed') return;
    if (!r.completed) {
      finalize(r, reason);
      if (reason === 'completed') r.completed = true;
    }
    if (reason !== 'completed') { r.ended = true; active.delete(session); }
  }
  function sample(diagnostics, sampledAt, liveSessions) {
    const live = new Set([...liveSessions.values()]);
    for (const session of active.keys()) if (!live.has(session)) end(session, 'lost');
    return diagnostics.rows.map(({ session, ...row }) => {
      let r = records.get(session);
      const known = identity(session);
      if (r && (r.provider !== known.provider || r.workload !== known.workload)) {
        end(session, 'restarted');
        r = begin(session, false);
      }
      if (!r) r = begin(session, false); // attached midway: never a complete lifetime
      if (!r) return { ...row, ...identity(session), peakRssBytes: null, peakMinusCurrentBytes: null };
      // Sampling metadata, not promises about a process's unobserved between-poll peak.
      const delta = sampledAt - (r.lastSampleAt ?? r.startedAt);
      if (delta < 0 || delta > STALE_AFTER_MS) r.gap = true;
      r.currentRssBytes = row.currentRssBytes;
      if (row.currentRssBytes === null) r.missingSamples++;
      else {
        r.sampleCount++;
        r.peakRssBytes = Math.max(r.peakRssBytes ?? 0, row.currentRssBytes);
      }
      r.lastSampleAt = sampledAt;
      return { ...row, id: r.id, ...identity(session), peakRssBytes: r.peakRssBytes,
        peakMinusCurrentBytes: row.currentRssBytes === null || r.peakRssBytes === null ? null : r.peakRssBytes - row.currentRssBytes,
        sampleCount: r.sampleCount, missingSamples: r.missingSamples, observedStart: r.observedStart };
    });
  }
  return { begin, end, sample, getHistory: () => history.map(r => ({ ...r })),
    storageStatus: () => storageStatus, activeCount: () => active.size,
    invalidate() { for (const r of active.values()) r.gap = true; },
    stop() { for (const session of active.keys()) end(session, 'shutdown'); } };
}

// Wiring is optional and no-op in standalone terminal probes/tests. index.js owns it.
let tracker = null;
function setSessionMemoryTracker(value) { tracker = value; }
function beginSessionMemory(session) { try { tracker?.begin(session); } catch { /* diagnostics never block spawn */ } }
function endSessionMemory(session, reason) { try { tracker?.end(session, reason); } catch { /* never block teardown */ } }

module.exports = { MAX_SESSIONS, MAX_HISTORY, MAX_HISTORY_BYTES, rootsOf, sumRss, sessionDiagnostics,
  createSessionMemoryTracker, setSessionMemoryTracker, beginSessionMemory, endSessionMemory };
