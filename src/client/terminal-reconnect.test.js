import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the modal's actual metadata/URL helpers without loading xterm or a browser.
const source = readFileSync(new URL('./console-modal.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function adoptSessionStart('), source.indexOf('export function startTaskSession('));

test('resume forwards the server timestamp unchanged; fresh launches never reuse it', () => {
  const state = { activeSessions: new Set(['TPT415']), sessionMeta: new Map([['TPT415', { agent: 'codex' }]]) };
  const ctx = { state, buildTaskSessionPrompt: () => 'kickoff' };
  vm.createContext(ctx);
  vm.runInContext(helpers, ctx);
  const startedAt = 1790780000000;
  ctx.adoptSessionStart('TPT415', { startedAt });
  assert.equal(state.sessionMeta.get('TPT415').agent, 'codex');
  assert.equal(ctx.buildTaskSessionWsExtra('TPT415', '', '').startedAt, startedAt);
  ctx.adoptSessionStart('TPT415', { startedAt: undefined });
  assert.equal(ctx.buildTaskSessionWsExtra('TPT415', '', '').startedAt, startedAt);
  assert.equal(ctx.buildTaskSessionWsExtra('TPT415', '', '').prompt, undefined);
  state.activeSessions.clear();
  const fresh = ctx.buildTaskSessionWsExtra('TPT415', '', '');
  assert.equal(fresh.startedAt, undefined);
  assert.equal(fresh.prompt, 'kickoff');
  state.activeSessions.add('legacy');
  assert.equal(ctx.buildTaskSessionWsExtra('legacy', '', '').startedAt, undefined);
});
