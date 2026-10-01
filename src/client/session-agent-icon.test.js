import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// (TPT413) The left-nav active-session row icon must follow the agent actually running the
// session. Root cause of the wrong-icon bug: openTerminal()'s ws.onopen stamped EVERY session —
// resumed ones included — with `opts.agent || state.taskAgent`, and state.taskAgent is a global
// that every session's config frame overwrites (applyTaskAgentConfig), i.e. "whichever terminal
// was opened last". The live session's agent arrives in the per-session `config` and
// `terminal-state` frames as msg.taskAgent; adoptSessionAgent() mirrors it into
// state.sessionMeta, the one source syncActiveSessionsNav() paints from. There is no DOM
// harness for console-modal.js, so — like terminal-nav-overlay.test.js — these are
// source-scanned invariants.
const modal = readFileSync(new URL('./console-modal.js', import.meta.url), 'utf8');
const board = readFileSync(new URL('./task-board.js', import.meta.url), 'utf8');

function fnBody(source, header, indent = '  ') {
  const start = source.indexOf(header);
  assert.ok(start > -1, `${header} not found`);
  const end = source.indexOf(`\n${indent}}\n`, start);
  assert.ok(end > start, `end of ${header} not found`);
  return source.slice(start, end);
}

test('adoptSessionAgent() writes msg.taskAgent into state.sessionMeta and never seeds from state.taskAgent', () => {
  const body = fnBody(modal, 'function adoptSessionAgent(taskId, msg) {', '');
  assert.match(body, /typeof msg\.taskAgent !== 'string'/);
  assert.match(body, /state\.sessionMeta\.set\(taskId, \{[\s\S]*agent: msg\.taskAgent,/);
  assert.doesNotMatch(body, /state\.taskAgent\b/);
  assert.match(body, /if \(changed\) updateClaudeButtons\(\);/);
});

test('openTerminal(): both per-session frames adopt the live agent, right after applyTaskAgentConfig()', () => {
  const open = modal.slice(modal.indexOf('export function openTerminal('), modal.indexOf('export function openAgentSelectorModal('));
  assert.match(open, /if \(msg\.type === 'config'\) \{[\s\S]*?applyTaskAgentConfig\(msg\);\s*adoptSessionAgent\(taskId, msg\);/);
  assert.match(open, /else if \(msg\.type === 'terminal-state'\) \{\s*applyTaskAgentConfig\(msg\);\s*adoptSessionAgent\(taskId, msg\);/);
});

test('openTerminal(): ws.onopen only guesses the agent for a fresh launch — a resume keeps the row it has', () => {
  const open = modal.slice(modal.indexOf('export function openTerminal('), modal.indexOf('export function openAgentSelectorModal('));
  const onopen = open.slice(open.indexOf('ws.onopen = () => {'), open.indexOf('ws.onmessage = (event) => {'));
  assert.match(onopen, /if \(!isResume\) \{\s*state\.sessionMeta\.set\(taskId, \{ agent: opts\.agent \|\| state\.taskAgent,/);
  assert.match(onopen, /\} else \{\s*const prevMeta = state\.sessionMeta\.get\(taskId\) \|\| \{ type: 'terminal' \};\s*state\.sessionMeta\.set\(taskId, \{ \.\.\.prevMeta, alive: true \}\);/);
  assert.equal((onopen.match(/state\.sessionMeta\.set\(/g) || []).length, 2);
});

test('startTaskSession(): prefers the agent the server replied with over the launch guess', () => {
  const body = fnBody(modal, 'export function startTaskSession(', '');
  assert.match(body, /result\.message\.taskAgent[\s\S]*?: \(opts\.agent \|\| state\.taskAgent\)/);
  assert.match(body, /state\.sessionMeta\.set\(taskId, \{ agent: launchedAgent,/);
});

test('syncActiveSessionsNav(): the row icon reads state.sessionMeta first', () => {
  const body = fnBody(board, 'export function syncActiveSessionsNav() {', '');
  assert.match(body, /agent: state\.sessionMeta\.get\(id\)\?\.agent \|\| state\.taskAgent,/);
});
