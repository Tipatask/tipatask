import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('board filter controls reveal cached matching tiers and preserve search focus', () => {
  const runner = new URL('./board-filter-dom-runner.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(runner)], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /BOARD_FILTER_DOM_PASS/);
});
