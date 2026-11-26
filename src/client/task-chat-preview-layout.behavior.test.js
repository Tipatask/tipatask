import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// (TPT9408) A file preview turns the chat window into a full-window layout with a slim chat column,
// and closing it turns it back. The transcript keeps its place across both switches and the
// composer keeps working. The DOM half runs the real task-chat.js and preview-drawer.js in its own
// process (task-chat-preview-layout-dom-runner.mjs), with the transcript's geometry emulated from
// the layout the stylesheet rules pinned below produce.
test('the transcript keeps its place when the preview switches the layout, and the composer still sends', () => {
  const runner = new URL('./task-chat-preview-layout-dom-runner.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(runner)], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TPT9408_PREVIEW_LAYOUT_PASS/);
});

test('the runner\'s layout emulation matches styles.css and task-chat.js', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const chat = readFileSync(new URL('./task-chat.js', import.meta.url), 'utf8');
  // The runner's slim column is the panel under the drawer's host class, filling the window.
  const at = css.indexOf('.task-chat-modal > .task-chat-panel--with-drawer {');
  assert.ok(at >= 0, 'the full-window rule');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /width: 100%;/);
  assert.match(rule, /height: 100%;/);
  // The chat hands the drawer its layout hook, under the class the runner emulates.
  assert.match(chat, /createPreviewDrawer\(root\.querySelector\('\.task-chat-panel'\), \{\s*hostClass: 'task-chat-panel--with-drawer', onSelect: scrollToFileLine, onLayoutChange: keepTranscriptPosition,\s*\}\)/);
});
