'use strict';

// (TPT354) Reads an agent CLI's OWN session transcript to recover its final assistant message,
// so the auto-posted exit comment (exit-resolution.js) can carry what the agent actually said
// instead of a scrape of the terminal screen.
//
// Two layers, both fail-open (any error → null, never throws — the comment then falls back to
// the sanitized tail):
//   • parse*(text)  — pure: transcript text → { text, turnEnded } | null
//   • read*(hint)   — locate the transcript file for one terminal spawn, then parse its tail
//
// `hint` is the per-spawn snapshot terminal-session.js stores on session._transcriptHint:
//   { cwd, spawnedAt, taskId, agentSessionId, env: { CLAUDE_CONFIG_DIR, CODEX_HOME, … } }
//
// Transcript formats (verified against real captures):
//   Claude — ~/.claude/projects/<cwd, non-alnum → '-'>/<session-uuid>.jsonl. One JSON line per
//     content block: { type:'assistant', message:{ id, stop_reason, content:[{type:'text',text}] } }.
//     A finished turn's last assistant line has stop_reason 'end_turn'; non-assistant bookkeeping
//     lines (last-prompt, cost-state, mode, ai-title …) follow it.
//   Codex — $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl. { type:'event_msg', payload:{
//     type:'task_complete', last_agent_message } } closes a turn; { type:'response_item',
//     payload:{ type:'message', role:'assistant', content:[{type:'output_text',text}] } } are the
//     interim messages.
//   Pi — <agentDir>/sessions/--<cwd>--/<iso>_<uuid>.jsonl. { type:'message', message:{ role,
//     stopReason, content:[{type:'text',text}] } }; stopReason 'toolUse' means the turn continues.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Only the END of a transcript matters (the last assistant message, the turn-end marker), and a
// long session's file can be tens of MB.
const TAIL_BYTES = 2 * 1024 * 1024;
// The kickoff prompt (which carries the task marker) is preceded by ~100 KB of static context,
// so the head scan for the marker needs to reach well past it.
const HEAD_BYTES = 512 * 1024;

function parseJsonLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    try { out.push(JSON.parse(s)); } catch { /* partial first line of a tail read, or junk */ }
  }
  return out;
}

function joinText(blocks, textTypes) {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : '';
  return blocks
    .filter(b => b && textTypes.includes(b.type) && typeof b.text === 'string' && b.text.trim())
    .map(b => b.text)
    .join('\n\n');
}

// ── Parsers ──

function parseClaudeTranscript(text) {
  let lastStop = null;
  let sawAssistant = false;
  let userAfter = false;
  let textId = null;      // message.id of the newest assistant message that carried text
  let textParts = [];
  for (const o of parseJsonLines(text)) {
    if (o.isSidechain) continue;
    if (o.type === 'assistant' && o.message) {
      sawAssistant = true;
      userAfter = false;
      lastStop = o.message.stop_reason || null;
      const t = joinText(o.message.content, ['text']);
      if (t) {
        const id = o.message.id || null;
        // Consecutive lines of the same message.id are one message split per content block.
        if (id && id === textId) textParts.push(t);
        else { textId = id; textParts = [t]; }
      }
    } else if (o.type === 'user' && !o.isMeta) {
      const c = o.message && o.message.content;
      const onlyToolResults = Array.isArray(c) && c.length > 0 && c.every(b => b && b.type === 'tool_result');
      // A tool_result answers the assistant's tool call (turn still running, stop_reason already
      // 'tool_use'); anything else is a fresh user prompt, so the turn is not over.
      if (!onlyToolResults) userAfter = true;
    }
  }
  if (!sawAssistant) return null;
  return { text: textParts.join('\n\n'), turnEnded: lastStop === 'end_turn' && !userAfter };
}

function parseCodexRollout(text) {
  let msg = '';
  let turnEnded = false;
  let saw = false;
  for (const o of parseJsonLines(text)) {
    const p = o.payload || {};
    if (o.type === 'event_msg') {
      if (p.type === 'task_started') { turnEnded = false; saw = true; }
      else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        saw = true;
        turnEnded = true;
        if (typeof p.last_agent_message === 'string' && p.last_agent_message.trim()) msg = p.last_agent_message;
      }
    } else if (o.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const t = joinText(p.content, ['output_text', 'text']);
      if (t) { msg = t; saw = true; turnEnded = false; }
    }
  }
  return saw ? { text: msg, turnEnded } : null;
}

function parsePiSession(text) {
  let msg = '';
  let turnEnded = false;
  let saw = false;
  for (const o of parseJsonLines(text)) {
    if (o.type !== 'message' || !o.message) continue;
    const m = o.message;
    if (m.role === 'assistant') {
      saw = true;
      const t = joinText(m.content, ['text']);
      if (t) msg = t;
      turnEnded = m.stopReason !== 'toolUse';
    } else if (m.role === 'user' || m.role === 'toolResult') {
      turnEnded = false;
    }
  }
  return saw ? { text: msg, turnEnded } : null;
}

// ── File helpers ──

function readTail(file, maxBytes = TAIL_BYTES) {
  const size = fs.statSync(file).size;
  if (size <= maxBytes) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    const s = buf.toString('utf8');
    return s.slice(s.indexOf('\n') + 1); // drop the partial first line
  } finally {
    fs.closeSync(fd);
  }
}

function readHead(file, maxBytes = HEAD_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Newest transcript in `files` (absolute paths) that this spawn — and not a concurrent sibling
// task's session sharing the same directory — wrote: modified since the spawn, and whose head
// carries THIS task's kickoff line (`Work on task <KEY>:`). A bare task-key match is not enough —
// another session that merely listed tasks mentions every key.
function pickSessionFile(files, { spawnedAt, taskId }) {
  if (!taskId) return null;
  const marker = new RegExp(`Work on task ${escapeRegExp(taskId)}\\b`);
  let best = null;
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.mtimeMs < (spawnedAt || 0) - 2000) continue;
      if (!marker.test(readHead(file))) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
    } catch { /* unreadable candidate — skip */ }
  }
  return best ? best.file : null;
}

// ── Locators ──

// Claude names a project directory after the launch cwd with every non-alphanumeric → '-'.
function claudeProjectDirName(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function locateClaudeTranscript(hint) {
  if (!hint || !hint.agentSessionId) return null;
  const home = (hint.env && hint.env.CLAUDE_CONFIG_DIR) || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const projects = path.join(home, 'projects');
  const name = `${hint.agentSessionId}.jsonl`;
  const direct = path.join(projects, claudeProjectDirName(hint.cwd), name);
  if (fs.existsSync(direct)) return direct;
  // The launch cwd can be normalised differently from ours (symlinks, realpath) — the session
  // uuid is unique, so scanning every project dir for it is safe.
  for (const dir of fs.readdirSync(projects)) {
    const candidate = path.join(projects, dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Local-time YYYY/MM/DD directories from one day before the spawn to one day after now — Codex
// buckets by its own clock/timezone, so the window is padded rather than computed exactly.
function codexDayDirs(root, spawnedAt, now) {
  const dirs = [];
  const DAY = 24 * 60 * 60 * 1000;
  for (let t = (spawnedAt || now) - DAY; t <= now + DAY; t += DAY) {
    const d = new Date(t);
    dirs.push(path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  return [...new Set(dirs)];
}

function locateCodexRollout(hint, now = Date.now()) {
  if (!hint) return null;
  const codexHome = (hint.env && hint.env.CODEX_HOME) || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const root = path.join(codexHome, 'sessions');
  const files = [];
  for (const dir of codexDayDirs(root, hint.spawnedAt, now)) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (/^rollout-.*\.jsonl$/.test(n)) files.push(path.join(dir, n));
  }
  return pickSessionFile(files, hint);
}

function locatePiSession(hint) {
  if (!hint || !hint.cwd) return null;
  // Same resolution the spawn used (task-agent/pi-agent.js → pi-custom-endpoint.js): an explicit
  // PI_CODING_AGENT_SESSION_DIR wins, else Pi's per-cwd default.
  const { piDefaultSessionDir } = require('../pi-custom-endpoint');
  const env = hint.env || {};
  const dir = env.PI_CODING_AGENT_SESSION_DIR || piDefaultSessionDir(hint.cwd, env);
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  return pickSessionFile(names.filter(n => n.endsWith('.jsonl')).map(n => path.join(dir, n)), hint);
}

// ── Public readers: hint → { text, turnEnded } | null ──

function makeReader(locate, parse) {
  return function read(hint) {
    try {
      const file = locate(hint);
      if (!file) return null;
      return parse(readTail(file));
    } catch {
      return null;
    }
  };
}

const readClaudeFinalMessage = makeReader(locateClaudeTranscript, parseClaudeTranscript);
const readCodexFinalMessage = makeReader(locateCodexRollout, parseCodexRollout);
const readPiFinalMessage = makeReader(locatePiSession, parsePiSession);

module.exports = {
  parseClaudeTranscript,
  parseCodexRollout,
  parsePiSession,
  claudeProjectDirName,
  locateClaudeTranscript,
  locateCodexRollout,
  locatePiSession,
  pickSessionFile,
  readClaudeFinalMessage,
  readCodexFinalMessage,
  readPiFinalMessage,
};
