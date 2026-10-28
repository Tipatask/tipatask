import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// (TPT9159) One isolated DOM process (bulk-apply-dom-runner.mjs) drives the real bulk action
// bar; each case below reads its pass marker.
let runnerResult;
function runDomRunner() {
  if (!runnerResult) {
    const runner = new URL('./bulk-apply-dom-runner.mjs', import.meta.url);
    runnerResult = spawnSync(process.execPath, [fileURLToPath(runner)], {
      encoding: 'utf8', timeout: 60_000,
    });
  }
  const result = runnerResult;
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

test('bulk bar stages edits until Apply, writes them in one pass, and drops them on Reset or close', () => {
  assert.match(runDomRunner().stdout, /TPT9159_BULK_APPLY_PASS/);
});

test('bulk bar Apply, Reset and Design mode render in English and Ukrainian without key fallbacks', () => {
  assert.match(runDomRunner().stdout, /TPT9159_BULK_LOCALES_PASS/);
});
