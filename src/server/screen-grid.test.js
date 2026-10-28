'use strict';

// (TPT9136) screen-grid.js: the minimal screen task-agent/claude-live-mode.js reads Claude's
// prompt footer, dialogs and composer from.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGrid, resizeGrid, feedGrid, gridLines } = require('./screen-grid');

const screen = (rows, cols, ...chunks) => {
  const grid = createGrid(rows, cols);
  for (const c of chunks) feedGrid(grid, c);
  return gridLines(grid);
};

test('text lands at the cursor; absolute and relative moves, CR/LF and column jumps place it', () => {
  assert.deepEqual(screen(4, 20, 'abc\r\ndef'), ['abc', 'def', '', '']);
  assert.deepEqual(screen(4, 20, '\x1b[3;5Hx', '\x1b[1;1Hy', '\x1b[2B\x1b[2Cz'), ['y', '', '   zx', '']);
  assert.deepEqual(screen(3, 20, 'hello', '\x1b[3G', 'XY', '\x1b[1D', 'Z'), ['heXZo', '', '']);
  assert.deepEqual(screen(3, 20, '\x1b[2d', 'row two', '\x1b[H', '\x1b[1A', 'top'), ['top', 'row two', '']);
});

test('only the cells written change: an Ink diff that skips an unchanged cell still reads as the new text', () => {
  const lines = screen(2, 40, '  ⏵⏵ auto mode on (shift+tab to cycle)', '\x1b[1;3H⏸ m\x1b[1;7Hnual mode on\x1b[K');
  assert.equal(lines[0], '  ⏸ manual mode on');
});

test('erase in line and display, insert/delete characters and lines', () => {
  assert.deepEqual(screen(2, 20, 'abcdef', '\x1b[1;3H\x1b[K'), ['ab', '']);
  assert.deepEqual(screen(2, 20, 'abcdef', '\x1b[1;3H\x1b[1K'), ['   def', '']);
  assert.deepEqual(screen(2, 20, 'abcdef', '\x1b[1;3H\x1b[2K'), ['', '']);
  assert.deepEqual(screen(3, 20, 'one\r\ntwo\r\nthree', '\x1b[2;2H\x1b[J'), ['one', 't', '']);
  assert.deepEqual(screen(3, 20, 'one\r\ntwo\r\nthree', '\x1b[2J'), ['', '', '']);
  assert.deepEqual(screen(1, 20, 'abcdef', '\x1b[1;2H\x1b[2P'), ['adef']);
  assert.deepEqual(screen(1, 20, 'abcdef', '\x1b[1;2H\x1b[2@'), ['a  bcdef']);
  assert.deepEqual(screen(1, 20, 'abcdef', '\x1b[1;2H\x1b[2X'), ['a  def']);
  assert.deepEqual(screen(3, 20, 'one\r\ntwo\r\nthree', '\x1b[2;1H\x1b[L'), ['one', '', 'two']);
  assert.deepEqual(screen(3, 20, 'one\r\ntwo\r\nthree', '\x1b[1;1H\x1b[M'), ['two', 'three', '']);
});

test('a line feed on the last row scrolls; long lines wrap; reverse index scrolls down at the top', () => {
  assert.deepEqual(screen(2, 20, 'a\r\nb\r\nc'), ['b', 'c']);
  assert.deepEqual(screen(3, 5, 'abcdefg'), ['abcde', 'fg', '']);
  assert.deepEqual(screen(2, 20, 'a\r\nb', '\x1b[H\x1bM', 'z'), ['z', 'a']);
});

test('private-marker sequences never move the cursor: ESC[?u is a keyboard query, not a cursor restore', () => {
  assert.deepEqual(screen(3, 20, '\x1b7', '\x1b[3;1H', '\x1b[?u\x1b[>0q\x1b[?25l', 'here'), ['', '', 'here']);
  assert.deepEqual(screen(3, 20, '\x1b7', '\x1b[3;1H', '\x1b8', 'back'), ['back', '', '']);
  assert.deepEqual(screen(2, 20, 'old', '\x1b[?1049h', 'new'), ['new', '']);
});

test('OSC strings, SGR colours and escapes split across chunks draw nothing', () => {
  assert.deepEqual(screen(1, 30, '\x1b]0;title\x07\x1b[38;5;220mcol', 'ou', '\x1b[3', '9mr\x1b]8;;x\x1b\\'), ['colour']);
  assert.deepEqual(screen(1, 30, 'a\x1b', '[2Cb'), ['a  b']);
});

test('astral characters take two cells; a resize starts a fresh screen', () => {
  assert.deepEqual(screen(1, 10, '😀x'), ['😀x']);
  const grid = createGrid(2, 10);
  feedGrid(grid, 'keep');
  resizeGrid(grid, 2, 10);
  assert.deepEqual(gridLines(grid), ['keep', '']);
  resizeGrid(grid, 3, 12);
  assert.deepEqual(gridLines(grid), ['', '', '']);
  assert.equal(feedGrid(null, 'x'), null);
  assert.deepEqual(gridLines(null), []);
});
