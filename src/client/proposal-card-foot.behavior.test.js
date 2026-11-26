import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// (TPT9403) A proposal card's foot never opens the hover overlay; Accept and Reject work from a
// collapsed card and from an expanded one.
test('proposal card foot: no hover expansion, Accept and Reject from collapsed and expanded cards', () => {
  const runner = new URL('./proposal-card-foot-dom-runner.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(runner)], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TPT9403_PROPOSAL_FOOT_DOM_PASS/);
});
