import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// (TPT9315) Opening a task chat again — the card's Discuss button, a pane switch, the standalone
// window — restores the unsent draft at the height it was typed at, and an empty draft at the
// default one-row height. The DOM half runs the real task-chat.js in its own process
// (task-chat-composer-height-dom-runner.mjs), with a textarea's scrollHeight emulated from the
// stylesheet rules pinned below.
test('a restored draft brings the task chat composer back at its typed height; an empty one keeps the default', () => {
  const runner = new URL('./task-chat-composer-height-dom-runner.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(runner)], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TPT9315_COMPOSER_HEIGHT_PASS/);
});

test('the runner\'s layout emulation matches styles.css, and the composer height follows its text only', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  // The runner reports a zero scrollHeight for the composer footer under these two classes.
  assert.match(css, /\.task-chat-panel--gated \.task-chat-footer,\s*\.task-chat-panel--connecting \.task-chat-footer \{ display: none; \}/);
  // No resize handle: the restored text alone decides the height, so none is stored with the draft.
  const start = css.indexOf('.task-chat-input {');
  assert.ok(start >= 0);
  assert.match(css.slice(start, css.indexOf('}', start)), /resize: none;/);
});
