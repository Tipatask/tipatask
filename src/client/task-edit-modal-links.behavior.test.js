import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// (TPT9411) The Task Edit description in read-only display: an image mid-sentence is a block of its
// own, a file link an inline chip that downloads without opening the editor, a web link and Enter
// on a chip are left to the link, and the image opens the lightbox. The DOM half runs the real
// modal in its own process (task-edit-modal-links-dom-runner.mjs).
test('the description shows its image on lines of its own and its file as a chip that downloads without opening the editor', () => {
  const runner = new URL('./task-edit-modal-links-dom-runner.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(runner)], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TPT9411_DESCRIPTION_LINKS_PASS/);
});
