// ── Objective Debug Console: live progress log (C1255) ──
// Ring-buffered log of objective-turn progress events, per chatState (`cs.progressLog`).
// Feeds the xterm.js Debug Console (console-modal.js openObjectiveConsole()) so a long-running
// turn shows a scrolling timestamped log through stage transitions + thinking text, instead of
// a static "Waiting for Claude to respond..." line that never updates.
//
// Pure state + formatting only — no DOM, no WS. Producer: chat-ui.js WS handlers. Consumer:
// console-modal.js. Kept as its own module so console-modal.js (no chat-ui.js import today)
// doesn't have to start importing chat-ui.js back.

export const MAX_LOG_ENTRIES = 500;
const THINKING_FLUSH_IDLE_MS = 400;
const THINKING_FLUSH_CHARS = 200;

const STAGE_TEXT = {
  spawned: 'spawned',
  'cli-init': 'cli-init',
  'model-thinking': 'thinking',
  working: 'working',
  'pi-stderr': 'stderr',
  'pi-retry': 'provider retry',
  'pi-retry-end': 'provider retry ended',
  'pi-compaction': 'compacting context',
  'pi-compaction-end': 'compaction done',
};

// Glyph + ANSI color per entry kind — matches the approved console mockup.
const KIND_STYLE = {
  spawned:          { glyph: '▸', color: '36' }, // cyan
  'cli-init':       { glyph: '▸', color: '36' },
  'model-thinking': { glyph: '▸', color: '36' },
  working:          { glyph: '▸', color: '36' },
  tool:             { glyph: '▸', color: '36' },
  'pi-stderr':      { glyph: 'ℹ', color: '33' }, // yellow — CLI's own stderr line
  'pi-retry':       { glyph: '⟳', color: '33' },
  'pi-retry-end':   { glyph: '⟳', color: '33' },
  'tool-end':       { glyph: '◂', color: '90' }, // dim
  thinking:         { glyph: '·', color: '90' },
  retry:            { glyph: '⟳', color: '33' }, // yellow
  error:            { glyph: '✖', color: '31' }, // red
  result:           { glyph: '✔', color: '32' }, // green
  note:             { glyph: 'ℹ', color: '90' }, // dim — misc session notes (context-trimmed, …)
  turn:             { glyph: '', color: '90' },
};

function shortToolName(name) {
  if (!name) return 'tool';
  // C1382 — strip either server prefix: 'tipatask' (remote) or 'tipatask-local'
  // (the 4 tools needing a repo checkout, e.g. batch_grep_tags).
  return String(name).replace(/^mcp__tipatask(?:-local)?__/, '');
}

function fmtElapsed(ms) {
  if (ms == null || Number.isNaN(ms)) return '+?s';
  return `+${(ms / 1000).toFixed(1)}s`;
}

// Ensure the log + thinking coalescer state exist on this chatState — lazily created so
// existing chatState literals (chat-ui.js) need no field added.
function ensureLog(cs) {
  if (!cs.progressLog) cs.progressLog = [];
  if (cs._turnCount == null) cs._turnCount = 0;
  return cs.progressLog;
}

function pushEntry(cs, entry) {
  const log = ensureLog(cs);
  const full = { at: Date.now(), ...entry };
  log.push(full);
  if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
  if (cs.term) {
    cs.term.write(formatProgressLine(full));
    (cs.termScroll ?? cs.term.scrollToBottom.bind(cs.term))();
  }
  return full;
}

// One ANSI line for a log entry, CRLF-terminated (xterm convention used throughout
// console-modal.js — see e.g. its own '--- Process exited ---' writes).
export function formatProgressLine(entry) {
  if (entry.kind === 'turn') {
    return `\x1b[90m═══ turn ${entry.turnIndex} ═══\x1b[0m\r\n`;
  }
  const style = KIND_STYLE[entry.kind] || { glyph: '·', color: '90' };
  const prefix = `[${fmtElapsed(entry.elapsedMs)}]`;
  return `\x1b[90m${prefix}\x1b[0m \x1b[${style.color}m${style.glyph} ${entry.text}\x1b[0m\r\n`;
}

// Turn boundary — call on the 'spawned' stage of every turn (first reliable per-turn signal,
// per the objective-progress WS event comment in chat-ui.js C1031).
export function noteTurnBoundary(cs) {
  ensureLog(cs);
  flushThinking(cs);
  cs._turnCount = (cs._turnCount || 0) + 1;
  if (cs._turnCount > 1) {
    pushEntry(cs, { kind: 'turn', text: '', turnIndex: cs._turnCount });
  }
  cs._turnStartedAt = Date.now();
  cs._openTools = new Map();
}

function clientElapsed(cs) {
  if (cs._turnStartedAt == null) return null;
  return Date.now() - cs._turnStartedAt;
}

// Append a stage/tool/result/error/retry entry. `elapsedMs` from the server payload is
// preferred; falls back to client-side turn-start tracking when absent (older server, or a
// provider that hasn't been updated to send it yet).
export function appendProgressLog(cs, { kind, text, elapsedMs, toolName } = {}) {
  flushThinking(cs);
  const ms = elapsedMs != null ? elapsedMs : clientElapsed(cs);
  if (kind === 'tool' && toolName) {
    ensureLog(cs); // no-op besides lazy-init; open-tool tracking lives on cs._openTools
    if (!cs._openTools) cs._openTools = new Map();
    cs._openTools.set(toolName, ms);
  }
  if (kind === 'tool-end' && toolName && cs._openTools && cs._openTools.has(toolName)) {
    const startMs = cs._openTools.get(toolName);
    cs._openTools.delete(toolName);
    if (startMs != null && ms != null) {
      const durS = ((ms - startMs) / 1000).toFixed(1);
      return pushEntry(cs, { kind, text: `${text} (${durS}s)`, elapsedMs: ms });
    }
  }
  return pushEntry(cs, { kind, text, elapsedMs: ms });
}

// `detail` is free text a provider attaches to a stage (stderr line, retry reason).
export function stageLogText(stage, name, detail) {
  if (stage === 'tool') return shortToolName(name);
  if (stage === 'tool-end') return shortToolName(name) || 'tool';
  const base = STAGE_TEXT[stage] || stage;
  return detail ? `${base}: ${String(detail).replace(/[\r\n]+/g, ' ')}` : base;
}

// ── Thinking coalescer ──
// objective-thinking arrives as hundreds of tiny thinking_delta chunks per turn (see
// tt-objective-chat.md). Buffering avoids one log line per token; flush on newline, ~400ms
// idle, or ~200 chars, whichever first. Any non-thinking append flushes first so ordering
// in the log matches wall-clock order.
export function pushThinking(cs, chunk) {
  if (!chunk) return;
  cs._thinkingPending = (cs._thinkingPending || '') + chunk;
  if (cs._thinkingFlushTimer) clearTimeout(cs._thinkingFlushTimer);
  if (cs._thinkingPending.includes('\n') || cs._thinkingPending.length >= THINKING_FLUSH_CHARS) {
    flushThinking(cs);
    return;
  }
  cs._thinkingFlushTimer = setTimeout(() => flushThinking(cs), THINKING_FLUSH_IDLE_MS);
}

export function flushThinking(cs) {
  ensureLog(cs);
  if (cs._thinkingFlushTimer) {
    clearTimeout(cs._thinkingFlushTimer);
    cs._thinkingFlushTimer = null;
  }
  const pending = (cs._thinkingPending || '').trim();
  cs._thinkingPending = '';
  if (!pending) return;
  const oneLine = pending.replace(/\s+/g, ' ').trim();
  pushEntry(cs, { kind: 'thinking', text: oneLine, elapsedMs: clientElapsed(cs) });
}

// Replay the full buffered log into a freshly-opened terminal (console reopened mid/after turn).
export function replayProgressLog(term, cs) {
  const log = cs.progressLog || [];
  for (const entry of log) term.write(formatProgressLine(entry));
}

// { stage, elapsedMs, sinceLastSignalMs } for the console status bar. `stage` prefers the live
// progress-chip label (already stage-aware) so the status bar and in-bubble chip never disagree.
export function progressStatusLine(cs) {
  if (!cs) return null;
  const stage = cs.progressStage || null;
  const elapsedMs = clientElapsed(cs);
  const lastAt = (cs.progressLog && cs.progressLog.length)
    ? cs.progressLog[cs.progressLog.length - 1].at
    : cs._turnStartedAt;
  const sinceLastSignalMs = lastAt != null ? Date.now() - lastAt : null;
  return { stage, elapsedMs, sinceLastSignalMs };
}
