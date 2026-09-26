import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

test('Task Edit DOM flows preserve save, locks, tabs, cleanup, and task switching', () => {
  const runner = new URL('./task-edit-modal-dom-runner.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(runner)], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TPT337_DOM_PASS/);
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
