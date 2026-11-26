import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// (TPT9417) One isolated DOM process (task-edit-rule-dom-runner.mjs) drives the real board card,
// bulk action bar and Task Edit modal against the API's can_edit; each case reads its marker.
let runnerResult;
function runDomRunner() {
  if (!runnerResult) {
    const runner = new URL('./task-edit-rule-dom-runner.mjs', import.meta.url);
    runnerResult = spawnSync(process.execPath, [fileURLToPath(runner)], {
      encoding: 'utf8', timeout: 60_000,
    });
  }
  const result = runnerResult;
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

test('a card\'s status select is locked with the localized reason when can_edit is false, and only then', () => {
  assert.match(runDomRunner().stdout, /TPT9417_CARD_STATUS_LOCK_PASS/);
});

test('the bulk bar names the view-only count, writes only the other tasks and reports the skipped ones', () => {
  assert.match(runDomRunner().stdout, /TPT9417_BULK_VIEW_ONLY_PASS/);
});

test('the Task Edit modal locks exactly what can_edit locks: creator, owner and higher role can edit', () => {
  assert.match(runDomRunner().stdout, /TPT9417_MODAL_CAN_EDIT_PASS/);
});

test('the lock reasons, bulk chip and banner render in en, uk, zh and es without raw keys', () => {
  assert.match(runDomRunner().stdout, /TPT9417_LOCALES_PASS/);
});
