'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Synchronous by design: neither fatal exceptions nor shutdown wait for queued IO.
// Diagnostics must never throw back into a fatal-error handler or prevent shutdown.
function writeLastExit({ reason, stack = null, sessions, root = require('./config').USER_DATA_ROOT }) {
  try {
    const liveSessionCount = Array.from(sessions?.values() || [])
      .filter(s => s && (s.alive || s._starting)).length;
    const terminalSessions = Array.from(sessions?.values() || [])
      .filter(s => s && (s.alive || s._starting) && s.type === 'terminal' && s.tabId && s.projectPath)
      .map(s => ({ taskId: s.tabId, projectPath: s.projectPath, agent: s.taskAgent || null,
        label: s.taskAgentLabel || '', startedAt: s.startedAt || null }));
    const record = { at: new Date().toISOString(), reason, stack, liveSessionCount, terminalSessions };
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'last-exit.json'), JSON.stringify(record), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function readLastExit(root) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(root, 'last-exit.json'), 'utf8'));
    if (typeof record?.at !== 'string') return null;
    const at = Date.parse(record.at);
    if (!Number.isFinite(at) || at > Date.now()) return null;
    if (!['uncaught-exception', 'signal:SIGTERM', 'signal:SIGINT', 'ipc-disconnect'].includes(record.reason)) return null;
    return record;
  } catch {
    return null;
  }
}

function readLastExitSince(startedAt, root = require('./config').USER_DATA_ROOT) {
  const start = Number(startedAt);
  if (!Number.isFinite(start) || start <= 0) return null;
  const record = readLastExit(root);
  // Stack traces remain local; only the reason and timestamp belong on the wire.
  return record && Date.parse(record.at) > start ? { reason: record.reason, at: record.at } : null;
}

function readLostSessions(projectPath, root = require('./config').USER_DATA_ROOT) {
  const record = readLastExit(root);
  if (!record || !Array.isArray(record.terminalSessions)) return [];
  return record.terminalSessions
    .filter(s => s && typeof s.taskId === 'string' && s.taskId && s.projectPath === projectPath)
    .map(s => ({ taskId: s.taskId, reason: record.reason, at: record.at,
      agent: s.agent || null, label: s.label || '', startedAt: s.startedAt || null }));
}

// Retire a recovered entry so a later renderer reload cannot resurrect the old loss.
function forgetLostSession(taskId, projectPath, root = require('./config').USER_DATA_ROOT) {
  const record = readLastExit(root);
  if (!Array.isArray(record?.terminalSessions)) return;
  const remaining = record.terminalSessions.filter(s => s?.taskId !== taskId || s?.projectPath !== projectPath);
  if (remaining.length === record.terminalSessions.length) return;
  try {
    fs.writeFileSync(path.join(root, 'last-exit.json'), JSON.stringify({ ...record, terminalSessions: remaining }), { mode: 0o600 });
  } catch { /* recovery must not depend on diagnostic storage */ }
}

module.exports = { writeLastExit, readLastExitSince, readLostSessions, forgetLostSession };
