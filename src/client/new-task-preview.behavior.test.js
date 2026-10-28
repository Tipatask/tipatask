import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// (TPT9147) The New Task Preview card is the board's renderCard() card.
test('New Task Preview renders the board card with the NEW chip, one sprint label and inert badges', () => {
  const runner = new URL('./new-task-preview-dom-runner.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(runner)], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TPT9147_PREVIEW_DOM_PASS/);
});
