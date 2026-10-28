import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// (TPT9116) Live chat history in the window: the DOM half runs the real task-chat.js in its own
// process (task-chat-history-dom-runner.mjs); the socket wiring is scanned.
test('chat history updates and capacity recovery preserve history, reconcile reopen state and block live turns', () => {
  const runner = new URL('./task-chat-history-dom-runner.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(runner)], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TPT9116_CHAT_HISTORY_LIVE_PASS/);
  assert.match(result.stdout, /TPT9145_CHAT_RECOVERY_PASS/);
});

test('the browser __board__ socket hands chat-history-updated to task-chat.js', () => {
  const html = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  assert.match(html, /if \(msg\.type === 'chat-history-updated'\) \{\s*window\.TipTask\?\.taskChat\?\.historyUpdated\?\.\(msg\);\s*return;\s*\}/);
  const index = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(index, /import \* as taskChat from '\.\/task-chat\.js';/, 'window.TipTask.taskChat is the module itself');
});
