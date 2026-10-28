'use strict';

// A minimal terminal screen: what a cursor-addressed TUI shows right now, for reading Claude's
// prompt footer, dialogs and composer (task-agent/claude-live-mode.js). The raw stream cannot be
// read row by row for that: Ink rewrites only the cells that differ between frames, so
// "⏵⏵ auto mode on" → "⏸ manual mode on" can arrive as "⏸ manu", a cursor move over the
// unchanged "a", then "l mode on". Not a terminal emulator — printable text, cursor movement,
// line/screen erase, insert/delete and scrolling only; colours, modes and OSC strings are ignored.
// Every code point takes one cell except astral-plane ones (emoji), which take two.

const ESC = '\x1b';

function createGrid(rows = 40, cols = 120) {
  const grid = { rows: Math.max(1, rows | 0), cols: Math.max(1, cols | 0), lines: [], r: 0, c: 0,
    top: 0, bottom: 0, saved: null, carry: '' };
  grid.bottom = grid.rows - 1;
  grid.lines = Array.from({ length: grid.rows }, () => []);
  return grid;
}

// A size change re-creates the screen: the TUI repaints everything after a resize.
function resizeGrid(grid, rows, cols) {
  if (!grid || (rows === grid.rows && cols === grid.cols)) return grid;
  return Object.assign(grid, createGrid(rows, cols));
}

const blankLine = () => [];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function scrollUp(grid, n = 1) {
  for (let i = 0; i < n; i++) { grid.lines.splice(grid.top, 1); grid.lines.splice(grid.bottom, 0, blankLine()); }
}
function scrollDown(grid, n = 1) {
  for (let i = 0; i < n; i++) { grid.lines.splice(grid.bottom, 1); grid.lines.splice(grid.top, 0, blankLine()); }
}
function lineFeed(grid) {
  if (grid.r === grid.bottom) scrollUp(grid);
  else grid.r = clamp(grid.r + 1, 0, grid.rows - 1);
}

function put(grid, ch, width) {
  if (grid.c + width > grid.cols) { grid.c = 0; lineFeed(grid); }
  const line = grid.lines[grid.r];
  while (line.length < grid.c) line.push(' ');
  line[grid.c] = ch;
  if (width === 2) line[grid.c + 1] = '';
  grid.c += width;
}

function eraseInLine(grid, mode) {
  const line = grid.lines[grid.r];
  if (mode === 2) grid.lines[grid.r] = blankLine();
  else if (mode === 1) for (let i = 0; i <= grid.c && i < line.length; i++) line[i] = ' ';
  else line.length = Math.min(line.length, grid.c);
}

function eraseInDisplay(grid, mode) {
  if (mode === 2 || mode === 3) { grid.lines = Array.from({ length: grid.rows }, blankLine); return; }
  if (mode === 1) {
    for (let r = 0; r < grid.r; r++) grid.lines[r] = blankLine();
    eraseInLine(grid, 1);
    return;
  }
  eraseInLine(grid, 0);
  for (let r = grid.r + 1; r < grid.rows; r++) grid.lines[r] = blankLine();
}

function csi(grid, params, priv, final) {
  // With a private marker only the alternate screen matters: `ESC[?u` is a keyboard-protocol
  // query, `ESC[>0q` a version query — never cursor restore or movement.
  if (priv) {
    if ((final === 'h' || final === 'l') && /(^|;)(1049|1047|47)(;|$)/.test(params)) { eraseInDisplay(grid, 2); grid.r = 0; grid.c = 0; }
    return;
  }
  const nums = params ? params.split(';').map((p) => (p === '' ? NaN : parseInt(p, 10))) : [];
  const n = (i, def = 1) => (Number.isFinite(nums[i]) && nums[i] > 0 ? nums[i] : def);
  switch (final) {
    case 'H': case 'f': grid.r = clamp(n(0) - 1, 0, grid.rows - 1); grid.c = clamp(n(1) - 1, 0, grid.cols - 1); break;
    case 'A': grid.r = clamp(grid.r - n(0), 0, grid.rows - 1); break;
    case 'B': case 'e': grid.r = clamp(grid.r + n(0), 0, grid.rows - 1); break;
    case 'C': case 'a': grid.c = clamp(grid.c + n(0), 0, grid.cols - 1); break;
    case 'D': grid.c = clamp(grid.c - n(0), 0, grid.cols - 1); break;
    case 'E': grid.r = clamp(grid.r + n(0), 0, grid.rows - 1); grid.c = 0; break;
    case 'F': grid.r = clamp(grid.r - n(0), 0, grid.rows - 1); grid.c = 0; break;
    case 'G': case '`': grid.c = clamp(n(0) - 1, 0, grid.cols - 1); break;
    case 'd': grid.r = clamp(n(0) - 1, 0, grid.rows - 1); break;
    case 'J': eraseInDisplay(grid, Number.isFinite(nums[0]) ? nums[0] : 0); break;
    case 'K': eraseInLine(grid, Number.isFinite(nums[0]) ? nums[0] : 0); break;
    case 'X': { const line = grid.lines[grid.r]; for (let i = grid.c; i < grid.c + n(0) && i < line.length; i++) line[i] = ' '; break; }
    case 'P': grid.lines[grid.r].splice(grid.c, n(0)); break;
    case '@': { const line = grid.lines[grid.r]; while (line.length < grid.c) line.push(' '); line.splice(grid.c, 0, ...Array(n(0)).fill(' ')); line.length = Math.min(line.length, grid.cols); break; }
    case 'L': for (let i = 0; i < n(0); i++) { grid.lines.splice(grid.bottom, 1); grid.lines.splice(grid.r, 0, blankLine()); } break;
    case 'M': for (let i = 0; i < n(0); i++) { grid.lines.splice(grid.r, 1); grid.lines.splice(grid.bottom, 0, blankLine()); } break;
    case 'S': scrollUp(grid, n(0)); break;
    case 'T': scrollDown(grid, n(0)); break;
    case 'r': grid.top = clamp(n(0) - 1, 0, grid.rows - 1); grid.bottom = clamp(n(1, grid.rows) - 1, grid.top, grid.rows - 1); grid.r = 0; grid.c = 0; break;
    case 's': grid.saved = { r: grid.r, c: grid.c }; break;
    case 'u': if (grid.saved) { grid.r = grid.saved.r; grid.c = grid.saved.c; } break;
    default: break; // SGR and everything else draws nothing
  }
}

// Feeds one chunk; an escape sequence split across chunks is carried to the next one.
function feedGrid(grid, data) {
  if (!grid || typeof data !== 'string' || !data) return grid;
  const s = grid.carry + data;
  grid.carry = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ESC) {
      const next = s[i + 1];
      if (next === undefined) { grid.carry = s.slice(i); break; }
      if (next === '[') {
        const m = /^\x1b\[([?>=!]?)([0-9;:]*)([ -/]*)([@-~])/.exec(s.slice(i, i + 64));
        if (!m) {
          if (s.length - i < 64 && /^\x1b\[[?>=!]?[0-9;:]*[ -/]*$/.test(s.slice(i))) { grid.carry = s.slice(i); break; }
          i += 2; continue;
        }
        csi(grid, m[2], m[1], m[4]);
        i += m[0].length;
        continue;
      }
      if (next === ']' || next === 'P' || next === '_' || next === '^') { // OSC/DCS/APC/PM: skip to BEL or ST
        const bel = s.indexOf('\x07', i + 2);
        const st = s.indexOf('\x1b\\', i + 2);
        const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
        if (end === -1) { grid.carry = s.slice(i); break; }
        i = end + (end === st ? 2 : 1);
        continue;
      }
      if (next === '7') grid.saved = { r: grid.r, c: grid.c };
      else if (next === '8') { if (grid.saved) { grid.r = grid.saved.r; grid.c = grid.saved.c; } }
      else if (next === 'D') lineFeed(grid);
      else if (next === 'E') { grid.c = 0; lineFeed(grid); }
      else if (next === 'M') { if (grid.r === grid.top) scrollDown(grid); else grid.r = clamp(grid.r - 1, 0, grid.rows - 1); }
      else if (next === 'c') { Object.assign(grid, createGrid(grid.rows, grid.cols)); }
      else if (next === '(' || next === ')' || next === '*' || next === '+') { i += 3; continue; }
      i += 2;
      continue;
    }
    if (ch === '\r') { grid.c = 0; i++; continue; }
    if (ch === '\n' || ch === '\x0b' || ch === '\x0c') { lineFeed(grid); i++; continue; }
    if (ch === '\b') { grid.c = Math.max(0, grid.c - 1); i++; continue; }
    if (ch === '\t') { grid.c = Math.min(grid.cols - 1, (Math.floor(grid.c / 8) + 1) * 8); i++; continue; }
    const code = s.codePointAt(i);
    const len = code > 0xffff ? 2 : 1;
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0)) put(grid, String.fromCodePoint(code), code > 0xffff ? 2 : 1);
    i += len;
  }
  return grid;
}

// The screen's rows as text, right-trimmed.
function gridLines(grid) {
  return grid ? grid.lines.map((line) => line.join('').replace(/\s+$/, '')) : [];
}

module.exports = { createGrid, resizeGrid, feedGrid, gridLines };
