import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// (TPT9296) Copy in the task and project chat windows: the DOM half runs the real task-chat.js in
// its own process (task-chat-copy-dom-runner.mjs); the clipboard wiring is scanned.
test('Copy puts the exact text on the clipboard when the clipboard API rejects, and only a real failure toasts, in every locale', () => {
  const runner = new URL('./task-chat-copy-dom-runner.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(runner)], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TPT9296_CHAT_COPY_PASS/);
});

test('the chat window writes through writeClipboardText(), never navigator.clipboard directly', () => {
  const chat = readFileSync(new URL('./task-chat.js', import.meta.url), 'utf8');
  assert.match(chat, /import \{ writeClipboardText \} from '\.\/clipboard-write\.js';/);
  assert.match(chat, /const result = await writeClipboardText\(text, \{ anchor: btn \}\);/);
  const code = chat.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /navigator\.clipboard/);
});
