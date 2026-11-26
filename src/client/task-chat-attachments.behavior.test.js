import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// (TPT9279) Paste, Embed ▸ Image and drop insert an image at the composer's caret, the upload's
// blob-to-URL swap keeps that caret, and the sent turn shows each image inline where it was
// inserted, live and restored. The DOM half runs the real task-chat.js with the real shared upload
// helpers in its own process (task-chat-attachments-dom-runner.mjs).
test('task chat images go in at the caret and show inline in the sent and restored turn', () => {
  const runner = new URL('./task-chat-attachments-dom-runner.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(runner)], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TPT9279_INLINE_IMAGES_PASS/);
  // (TPT9410) The composer's attachment strip follows the draft: a tile while an image uploads, the
  // same tile once it lands, none after the send.
  assert.match(result.stdout, /TPT9410_TASK_CHAT_STRIP_PASS/);
});
