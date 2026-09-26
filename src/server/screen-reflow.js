'use strict';

// Recover line boundaries from cursor-addressed PTY output for attention matching.
// stripAnsi() alone glues rows without literal newlines and defeats anchored prompt
// patterns. This is a lightweight row transform, not a terminal emulator; raw tail
// detection still uses stripAnsi(). Keep cursor row/column on session across chunks,
// including split escapes. Omit session for one-shot buffer conversion
// (e.g. the exit-comment tail sanitizer in exit-resolution.js).

const CSI_RE = /\x1b\[([0-?]*)([ -/]*)([@-~])/g;
const TWO_CHAR_ESC_RE = /\x1b[@-Z\\-_]/g;

function parseParams(paramStr) {
  if (!paramStr) return [];
  return paramStr.split(';').map((p) => (p === '' ? undefined : parseInt(p, 10)));
}

// Resets the row/col cursor-tracking state kept on a session. Called at spawn and on
// clear-screen/alt-screen toggle, alongside `_attentionLineCarry`/`_attentionOscOpen`
// (terminal-session.js) — a cleared screen means the next frame's cursor moves are relative to a
// fresh blank canvas, not wherever the previous frame left the tracked position.
function resetReflow(session) {
  if (!session) return;
  session._attentionRow = 1;
  session._attentionCol = 1;
}

// Splits a reflowed chunk into complete rows, carrying the trailing partial row across calls in
// `session._attentionRowCarry` — the same cross-chunk-carry discipline as
// terminal-session.js#carveAttentionLines(), kept as an independent carry field since the two
// streams (legacy stripAnsi vs. reflowed) segment differently and must not corrupt each other.
function carveReflowLines(session, reflowedChunk) {
  const combined = ((session && session._attentionRowCarry) || '') + reflowedChunk;
  const parts = combined.split(/\r\n|\n|\r/);
  let carry = parts.pop() || '';
  if (carry.length > 4096) carry = carry.slice(-4096);
  if (session) session._attentionRowCarry = carry;
  const lines = parts;
  if (carry) lines.push(carry);
  return lines;
}

// Walks one chunk, turning cursor-positioning CSI sequences into row breaks / column padding.
// `session` may be null/undefined for a stateless one-shot pass (fresh row/col each call, no
// carry write-back) — used by the whole-buffer exit-comment tail sanitizer (exit-resolution.js),
// which is not a streaming chunk and has no session to carry state on.
function reflowChunk(session, s) {
  if (typeof s !== 'string' || !s) return '';
  let row = (session && session._attentionRow) || 1;
  let col = (session && session._attentionCol) || 1;
  let out = '';

  const newRow = () => { out += '\n'; col = 1; };
  const padTo = (c) => { if (c > col) { out += ' '.repeat(c - col); col = c; } };

  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\x1b' && s[i + 1] === '[') {
      CSI_RE.lastIndex = i;
      const m = CSI_RE.exec(s);
      if (m && m.index === i) {
        const params = parseParams(m[1]);
        const final = m[3];
        const n = params[0] === undefined ? 1 : params[0];
        switch (final) {
          case 'H':
          case 'f': { // cursor position: row;col (both default 1)
            const r = params[0] === undefined ? 1 : params[0];
            const c = params[1] === undefined ? 1 : params[1];
            if (r !== row) { newRow(); row = r; col = 1; }
            padTo(c);
            break;
          }
          case 'd': { // vertical position absolute: row only, column unchanged
            const r = params[0] === undefined ? 1 : params[0];
            if (r !== row) { newRow(); row = r; }
            break;
          }
          case 'A': case 'B': // cursor up/down N rows
            if (n > 0) { newRow(); row += (final === 'A' ? -n : n); }
            break;
          case 'E': // cursor next line: down N, column 1
            newRow(); row += n;
            break;
          case 'F': // cursor previous line: up N, column 1
            newRow(); row -= n;
            break;
          case 'G': { // cursor horizontal absolute — same row, never a line break
            const c = params[0] === undefined ? 1 : params[0];
            padTo(c);
            break;
          }
          case 'C': // cursor forward N columns — same row
            if (n > 0) { out += ' '.repeat(n); col += n; }
            break;
          // Everything else (SGR 'm', erase-in-line/-display 'J'/'K', scroll, cursor
          // save/restore, etc.) carries no row-position information — drop it, same as
          // stripAnsi() does today.
          default:
            break;
        }
        i = CSI_RE.lastIndex;
        continue;
      }
    }
    if (ch === '\x1b') {
      TWO_CHAR_ESC_RE.lastIndex = i;
      const m2 = TWO_CHAR_ESC_RE.exec(s);
      if (m2 && m2.index === i) { i = TWO_CHAR_ESC_RE.lastIndex; continue; }
      i += 1; // lone/unrecognized ESC — drop just the ESC byte, same failure mode as stripAnsi()
      continue;
    }
    if (ch === '\n') { out += '\n'; row += 1; col = 1; i += 1; continue; }
    if (ch === '\r') { out += '\r'; col = 1; i += 1; continue; }
    out += ch;
    col += 1;
    i += 1;
  }

  if (session) {
    session._attentionRow = row;
    session._attentionCol = col;
  }
  return out;
}

module.exports = {
  reflowChunk,
  carveReflowLines,
  resetReflow,
};
