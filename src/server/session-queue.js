'use strict';

// (TPT444) FIFO start queue for task terminal sessions.
//
// A start request that finds no free slot is not refused — its session is parked here and
// started, oldest first, as soon as a running session frees its slot (task completed, pty
// exited, session terminated). A slot is the device-wide cap from process-group.js's
// resolveAgentLimits() (hardware-derived), plus an optional lower per-project cap when the
// project's config.json / env sets AGENT_LIMITS_MAX_CONCURRENT_SESSIONS.
//
// "Running" means a live terminal task session — chat sessions (objective/spec/task chat, which
// have their own throttle) never count, and neither does a session whose task already completed
// while its pty idles on (it holds memory but is done working; the user rule is that completion
// releases the slot). Slot accounting is synchronous: the moment a session is admitted it is
// stamped `_launching`, so N concurrent start requests (Play All) can never all see the same
// free slot while their async spawn preparation is still in flight.
//
// Pure of IO apart from injected deps — `getSessions`, `resolveLimits`, `onChange`, `log`.

const { isAgentChatId } = require('./session-state');

function projectOf(session, defaultProject) {
  return (session && session.projectPath) || defaultProject || '';
}

function createSessionQueue({ getSessions, resolveLimits, defaultProject = '', onChange = () => {}, log = console.warn } = {}) {
  const entries = []; // FIFO: { key, session, projectPath, taskId, start }
  let draining = false;
  let drainAgain = false;
  let admission = null;

  function sessionsMap() {
    try { return getSessions() || new Map(); } catch { return new Map(); }
  }

  function isRunning(s) {
    if (!s || s.type !== 'terminal' || s.pending || s._queued || s._completionEmitted || s._terminated) return false;
    if (isAgentChatId(s.taskId || s.tabId)) return false;
    return !!(s.alive || s._starting || s._launching);
  }

  function countRunning(projectPath) {
    let n = 0;
    for (const [, s] of sessionsMap()) {
      if (!isRunning(s)) continue;
      if (projectPath !== undefined && projectOf(s, defaultProject) !== projectPath) continue;
      n++;
    }
    return n;
  }

  function limitsFor(projectPath) {
    try { return resolveLimits(projectPath || defaultProject) || {}; } catch { return {}; }
  }

  // Never throws; a broken resolver degrades to "one slot" rather than "unlimited".
  function hasSlot(projectPath) {
    const project = projectPath || defaultProject;
    const limits = limitsFor(project);
    const deviceCap = Number.isInteger(limits.deviceSessionCap) && limits.deviceSessionCap > 0 ? limits.deviceSessionCap : 1;
    if (countRunning() >= deviceCap) return false;
    if (limits.sessionCapSource && limits.sessionCapSource !== 'device'
        && Number.isInteger(limits.maxConcurrentSessions)
        && countRunning(project) >= limits.maxConcurrentSessions) return false;
    return true;
  }

  function isStale(entry) {
    const live = sessionsMap().get(entry.key);
    return live !== entry.session || entry.session._terminated === true;
  }

  function decisionFor(entry) {
    if (!admission) return { allowed: hasSlot(entry.projectPath) };
    const limits = limitsFor(entry.projectPath);
    const projectCap = limits.sessionCapSource !== 'device'
      ? (limits.projectSessionCap || limits.maxConcurrentSessions) : null;
    return admission.tryReserve(entry.session, projectCap);
  }

  function position(key) {
    const i = entries.findIndex(e => e.key === key);
    return i === -1 ? null : i + 1;
  }

  function snapshot(projectPath) {
    const queued = [];
    entries.forEach((e, i) => {
      if (projectPath === undefined || e.projectPath === projectPath) queued.push({ taskId: e.taskId, position: i + 1,
        ...e.diagnostic });
    });
    const limits = limitsFor(projectPath);
    const diagnostic = admission?.snapshot();
    return { queued, running: diagnostic?.running ?? countRunning(), cap: diagnostic?.cap ?? limits.deviceSessionCap ?? null,
      ...(diagnostic ? { admission: diagnostic } : {}) };
  }

  function notify(projects) {
    for (const projectPath of projects) {
      try { onChange(projectPath, snapshot(projectPath)); } catch (err) { log(`[session-queue] onChange failed: ${err.message}`); }
    }
  }

  // Starts every queued entry that has a slot, oldest first. An entry blocked only by its own
  // project's cap is skipped, not allowed to hold up other projects behind it.
  function drain() {
    if (draining) { drainAgain = true; return; }
    draining = true;
    const touched = new Set();
    try {
      do {
        drainAgain = false;
        for (let i = 0; i < entries.length;) {
          const entry = entries[i];
          if (isStale(entry)) { entries.splice(i, 1); touched.add(entry.projectPath); continue; }
          const decision = decisionFor(entry);
          if (!decision.allowed) {
            const diagnostic = {};
            for (const field of ['reason', 'coordinationReason', 'detail', 'instances', 'censusPidCount', 'unregisteredCount', 'unregisteredPids']) {
              if (decision[field] !== undefined) diagnostic[field] = decision[field];
            }
            if (JSON.stringify(entry.diagnostic) !== JSON.stringify(diagnostic)) touched.add(entry.projectPath);
            entry.diagnostic = diagnostic;
            i++; continue;
          }
          entries.splice(i, 1);
          touched.add(entry.projectPath);
          entry.session._queued = false;
          entry.session._launching = true; // counted as running from this tick on
          for (const e of entries) touched.add(e.projectPath); // positions behind it shifted
          entry.promise = Promise.resolve().then(() => entry.start());
          entry.promise.catch(err => {
            entry.session._launching = false;
            log(`[session-queue] start of ${entry.taskId} failed: ${err && err.message}`);
            drain();
          });
        }
      } while (drainAgain);
    } finally {
      draining = false;
    }
    if (touched.size) notify(touched);
  }

  // Admit a new session. The queue itself always runs `start()` — at once when a slot is free
  // and nobody is waiting ahead, later (oldest first) otherwise. Returns
  // { queued: false, done } with `done` settling when the start finished, or
  // { queued: true, position } when the session is parked.
  function submit({ key, session, taskId, start }) {
    const projectPath = projectOf(session, defaultProject);
    session.projectPath = projectPath;
    const entry = { key, session, projectPath, taskId, start, promise: null };
    session._queued = true;
    session.queuedAt = Date.now();
    entries.push(entry);
    drain(); // starts it now when a slot is free (and other entries are blocked or absent)
    const pos = position(key);
    if (pos === null) return { queued: false, done: entry.promise };
    notify([projectPath]);
    return { queued: true, position: pos };
  }

  function remove(key) {
    const i = entries.findIndex(e => e.key === key);
    if (i === -1) return false;
    const [entry] = entries.splice(i, 1);
    entry.session._queued = false;
    notify(new Set([entry.projectPath, ...entries.map(e => e.projectPath)]));
    return true;
  }

  return { submit, remove, drain, position, snapshot, hasSlot, countRunning, isRunning, size: () => entries.length,
    setAdmission(value) { admission = value; } };
}

module.exports = { createSessionQueue };
