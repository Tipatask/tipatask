import assert from 'node:assert/strict';
import { test } from 'node:test';
import { _isPinnedToBottom, createTerminalOutputWriter } from './terminal-output.js';

function setup(t) {
  const frames = new Map();
  let nextFrame = 0;
  t.mock.method(globalThis, 'requestAnimationFrame', fn => { frames.set(++nextFrame, fn); return nextFrame; });
  t.mock.method(globalThis, 'cancelAnimationFrame', id => frames.delete(id));
  const viewport = new EventTarget();
  const element = new EventTarget();
  element.querySelector = () => viewport;
  const writes = [];
  const buffer = { viewportY: 100, baseY: 100 };
  const term = {
    element, buffer: { active: buffer }, scrolls: 0,
    write(data, callback) { writes.push({ data, callback }); },
    scrollToBottom() { this.scrolls++; buffer.viewportY = buffer.baseY; },
  };
  const writer = createTerminalOutputWriter(term);
  t.after(() => writer.dispose());
  return {
    writer, term, buffer, viewport,
    parse(baseY, viewportY) {
      buffer.baseY = baseY;
      buffer.viewportY = viewportY;
      writes.shift().callback();
    },
    frame() {
      const batch = [...frames.values()];
      frames.clear();
      batch.forEach(fn => fn());
    },
    scroll(position) { buffer.viewportY = position; viewport.dispatchEvent(new Event('scroll')); },
  };
}

// Node has no animation-frame globals; the harness replaces these per test.
globalThis.requestAnimationFrame = () => {};
globalThis.cancelAnimationFrame = () => {};

test('pin helper uses the active buffer including empty/alternate buffers', () => {
  assert.equal(_isPinnedToBottom({ buffer: { active: { viewportY: 0, baseY: 0 } } }), true);
  assert.equal(_isPinnedToBottom({ buffer: { active: { viewportY: 8, baseY: 9 } } }), false);
});

test('restores a pre-write pin after a large chunk and after the burst layout', t => {
  const h = setup(t);
  h.writer.write('large repaint');
  h.parse(900, 400);
  assert.equal(h.buffer.viewportY, 900);
  h.buffer.viewportY = 700; // layout/repaint after the callback
  h.frame();
  assert.equal(h.buffer.viewportY, 900);
});

test('queued chunks and chunks arriving before the final frame end at the true tail', t => {
  const h = setup(t);
  for (let i = 0; i < 3; i++) h.writer.write('chunk');
  h.parse(200, 100);
  h.parse(300, 150);
  h.parse(400, 200);
  h.buffer.viewportY = 250;
  h.writer.write('next chunk');
  h.parse(500, 250);
  h.frame();
  assert.equal(h.buffer.viewportY, 500);
});

test('output preserves an unpinned viewport and follows again on returning to bottom', t => {
  const h = setup(t);
  h.scroll(40);
  h.writer.write('while reading');
  h.parse(200, 40);
  h.frame();
  assert.equal(h.buffer.viewportY, 40);
  assert.equal(h.term.scrolls, 0);
  h.scroll(200);
  h.writer.write('following again');
  h.parse(300, 200);
  h.frame();
  assert.equal(h.buffer.viewportY, 300);
});

test('scrollbar movement between queued chunks cancels the remaining burst follow', t => {
  const h = setup(t);
  h.writer.write('one');
  h.writer.write('two');
  h.parse(200, 100);
  h.scroll(40);
  h.parse(300, 40);
  h.frame();
  assert.equal(h.buffer.viewportY, 40);
});

test('wheel input cancels already queued callbacks before native scrolling settles', t => {
  const h = setup(t);
  h.writer.write('queued');
  h.term.element.dispatchEvent(new Event('wheel'));
  h.writer.write('arrives before native scroll');
  h.parse(200, 100);
  h.scroll(40);
  h.parse(300, 40);
  h.frame();
  h.frame();
  assert.equal(h.buffer.viewportY, 40);
  assert.equal(h.term.scrolls, 0);
});

test('manual scrolling cancels the final burst frame', t => {
  const h = setup(t);
  h.writer.write('chunk');
  h.parse(200, 100);
  h.scroll(50);
  h.frame();
  assert.equal(h.buffer.viewportY, 50);
});

test('disposal cancels pending writes, input frames and final follow frames', t => {
  const h = setup(t);
  let called = false;
  h.writer.write('one');
  h.parse(200, 100);
  h.writer.write('two', () => { called = true; });
  h.term.element.dispatchEvent(new Event('wheel'));
  h.writer.dispose();
  h.parse(300, 80);
  h.frame();
  h.frame();
  assert.equal(called, false);
  assert.equal(h.buffer.viewportY, 80);
});
