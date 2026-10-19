'use strict';
// (TPT9048) Env-gated PTY I/O trace for a task terminal session.
//
// The packaged app forks the server with its stdout inherited from a GUI launch, so on Windows
// the injector's console.log diagnostics (paste / typed line / Enter / submit verification) are
// invisible. With TIPATASK_PTY_TRACE set, every byte written to the PTY and every raw output
// chunk is appended, timestamped, to one JSONL file per spawn, together with the injector's log
// lines, so a failed kickoff can be reconstructed offline (feed the `out` records back through
// stripAnsi()/reflowChunk()).
//
//   TIPATASK_PTY_TRACE=1        -> <USER_DATA_ROOT>/pty-trace/<task>-<agent>-<spawnedAt>.jsonl
//   TIPATASK_PTY_TRACE=<dir>    -> <dir>/<task>-<agent>-<spawnedAt>.jsonl
//
// Records: {"t":<ms since spawn>,"k":"meta"|"in"|"out"|"log","s":<string>,...extra}. `in` holds
// the exact PTY input (including keystrokes a user types into the terminal while tracing — this
// is a debug aid, off by default); `meta` carries the spawn shape but never the prompt text
// (the Windows handoff file path is already a plain file under USER_DATA_ROOT/spawn-args).
// Nothing here ever throws into the terminal pipeline: a failed open returns null, a failed
// write is dropped.
const fs = require('fs');
const path = require('path');

function traceDir(env, userDataRoot) {
  const raw = env && env.TIPATASK_PTY_TRACE;
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || /^(0|false|off|no)$/i.test(value)) return null;
  if (/^(1|true|on|yes)$/i.test(value)) return userDataRoot ? path.join(userDataRoot, 'pty-trace') : null;
  return path.resolve(value);
}

function safeName(value) {
  return String(value || 'session').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64);
}

function openPtyTrace({ agentId, taskId, spawnedAt = Date.now(), spec = {}, cols, rows, userDataRoot, env = process.env } = {}) {
  const dir = traceDir(env, userDataRoot);
  if (!dir) return null;
  const file = path.join(dir, `${safeName(taskId)}-${safeName(agentId)}-${spawnedAt}.jsonl`);
  // Synchronous appends: the file must be readable while the session is still running (that is
  // what it is for), and a terminal's chunks are small. A failed write disables the trace.
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(file, 'a');
  } catch {
    return null;
  }
  const write = (kind, text, extra) => {
    if (fd === null) return;
    try {
      const record = { t: Date.now() - spawnedAt, k: kind, s: typeof text === 'string' ? text : String(text ?? '') };
      if (extra && typeof extra === 'object') Object.assign(record, extra);
      fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    } catch {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      fd = null;
    }
  };
  write('meta', '', {
    platform: process.platform,
    command: spec.command || null,
    args: Array.isArray(spec.args) ? spec.args : null,
    cols: cols ?? null,
    rows: rows ?? null,
    kickoffFile: spec.kickoffFile || null,
    initialPromptLength: typeof spec.initialPrompt === 'string' ? spec.initialPrompt.length : 0,
    kickoffTypedLine: spec.kickoffTypedLine || '',
    preludePromptLength: typeof spec.preludePrompt === 'string' ? spec.preludePrompt.length : 0,
  });
  return {
    file,
    write,
    close() {
      const current = fd;
      fd = null;
      try { if (current !== null) fs.closeSync(current); } catch { /* ignore */ }
    },
  };
}

module.exports = { openPtyTrace, traceDir };
