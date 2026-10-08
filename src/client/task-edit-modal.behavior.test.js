import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// One isolated DOM process serves every runner-backed case below.
let runnerResult;
function runDomRunner() {
  if (!runnerResult) {
    const runner = new URL('./task-edit-modal-dom-runner.mjs', import.meta.url);
    runnerResult = spawnSync(process.execPath, [fileURLToPath(runner)], {
      encoding: 'utf8', timeout: 30_000,
    });
  }
  const result = runnerResult;
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

test('Task Edit DOM flows preserve save, locks, tabs, cleanup, and task switching', () => {
  assert.match(runDomRunner().stdout, /TPT337_DOM_PASS/);
});

test('Saving an agent assignee adds or removes Start without reopening (TPT568)', () => {
  assert.match(runDomRunner().stdout, /TPT568_START_SYNC_PASS/);
});

test('Task Edit module imports without initializing board, cards, chat, or terminal', async () => {
  const editor = await import('./task-edit-modal.js');
  assert.equal(typeof editor.openTaskEditModal, 'function');
  assert.equal(typeof editor.configureTaskEditModal, 'function');
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./task-edit-modal.js', import.meta.url))],
    bundle: true,
    platform: 'browser',
    write: false,
    metafile: true,
    loader: { '.css': 'empty' },
  });
  const forbidden = Object.keys(result.metafile.inputs).filter(path =>
    /\/(task-board|task-card|chat-ui|console-modal)\.js$/.test(path));
  assert.deepEqual(forbidden, []);
});
