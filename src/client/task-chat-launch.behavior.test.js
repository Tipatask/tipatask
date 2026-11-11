import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// (TPT9268/TPT9271) A task chat opens on its start gate, a passed model only preselected there:
// the DOM half runs the real task-chat.js in its own process (task-chat-launch-dom-runner.mjs);
// the workspace hand-off that template.html adds is scanned (the page script is not importable).
test('open() fills the start gate with the saved or passed model, spawns nothing until Start chat, and steers an existing chat', () => {
  const runner = new URL('./task-chat-launch-dom-runner.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(runner)], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /TPT9271_CHAT_LAUNCH_PASS/);
});

test('the board workspace opener forwards a preselected model to the task workspace', () => {
  const html = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
  assert.match(html, /registerTaskWorkspaceOpener\(\(taskId, \{ initialPane, terminalLaunch, chatLaunch, trigger \} = \{\}\) =>\s*openBoardTaskEditModal\(taskId, trigger, \{ initialPane, terminalLaunch, chatLaunch \}\)\);/);
  const opener = html.slice(html.indexOf('function openBoardTaskEditModal('), html.indexOf('registerTaskEditNavigation('));
  assert.match(opener, /chatLaunch: workspace\.chatLaunch,/);
});
