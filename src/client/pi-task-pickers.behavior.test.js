import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The task-start pickers (launch modal, New Task / Task Edit agent picker, card assign modal, bulk
// start modal) never offer a Pi row whose PI_MODELS entry sets `tools: false`. The real client
// modules run in their own DOM process — see pi-task-pickers-dom-runner.mjs.
test('task-start pickers filter Pi rows and explain unusable saved pins on pickers and badges', () => {
  const runner = new URL('./pi-task-pickers-dom-runner.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(runner)], {
    encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PI_TASK_PICKERS_DOM_PASS/);
});
