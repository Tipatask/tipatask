'use strict';

// TPT701 — headless-claude.js: the one-shot `claude -p` argv (tool-less mode), the error
// envelope, and the env/spawn seams. No real CLI spawns.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runHeadlessClaude, buildHeadlessClaudeArgs, EMPTY_MCP_CONFIG } = require('./headless-claude');

function fakeSpawn(stdout, capture) {
  return (command, args, options) => {
    if (capture) Object.assign(capture, { command, args, options });
    const proc = new EventEmitter();
    proc.pid = 4321;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = Object.assign(new EventEmitter(), { write() {}, end() {
      setImmediate(() => { proc.stdout.emit('data', Buffer.from(stdout)); proc.emit('close', 0); });
    } });
    return proc;
  };
}

const baseOpts = () => ({ cwd: process.cwd(), env: { PATH: process.env.PATH, TERM: 'dumb' } });

test('buildHeadlessClaudeArgs: default argv, tool-less flags appended after --output-format', () => {
  assert.deepEqual(buildHeadlessClaudeArgs(), ['-p', '--model', 'claude-opus-5', '--output-format', 'json']);
  assert.deepEqual(buildHeadlessClaudeArgs({ model: 'm1' }), ['-p', '--model', 'm1', '--output-format', 'json']);
  const toolless = buildHeadlessClaudeArgs({ model: 'm1', toolless: true });
  assert.deepEqual(toolless.slice(0, 5), ['-p', '--model', 'm1', '--output-format', 'json']);
  assert.deepEqual(toolless.slice(5, 8), ['--tools', '', '--mcp-config']);
  if (process.platform !== 'win32') assert.equal(toolless[8], EMPTY_MCP_CONFIG);
  assert.equal(toolless[9], '--strict-mcp-config');
  assert.equal(toolless.length, 10);
});

test('runHeadlessClaude: result envelope text; is_error envelope → null; raw text passthrough', async () => {
  const ok = await runHeadlessClaude('hi', { ...baseOpts(), spawn: fakeSpawn(JSON.stringify({ type: 'result', is_error: false, result: 'answer' })) });
  assert.equal(ok, 'answer');
  const bad = await runHeadlessClaude('hi', { ...baseOpts(), spawn: fakeSpawn(JSON.stringify({ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'Not logged in' })) });
  assert.equal(bad, null);
  const raw = await runHeadlessClaude('hi', { ...baseOpts(), spawn: fakeSpawn('plain text\n') });
  assert.equal(raw, 'plain text');
  const parsed = await runHeadlessClaude('hi', { ...baseOpts(), parseJson: true, spawn: fakeSpawn(JSON.stringify({ result: '```json\n{"a":1}\n```' })) });
  assert.deepEqual(parsed, { a: 1 });
});

test('runHeadlessClaude: opts.env is passed verbatim, cwd honored, tool-less argv reaches the spawn', async () => {
  const capture = {};
  const env = { PATH: process.env.PATH, TERM: 'dumb', MARKER: '1' };
  await runHeadlessClaude('hi', { spawn: fakeSpawn('{"result":"x"}', capture), cwd: process.cwd(), env, toolless: true, model: 'm2' });
  assert.equal(capture.options.env, env);
  assert.equal(capture.options.cwd, process.cwd());
  assert.ok(capture.args.includes('--strict-mcp-config'), capture.args.join(' '));
  assert.ok(capture.args.includes('--tools'));
  assert.ok(capture.args.includes('m2'));
  const plain = {};
  await runHeadlessClaude('hi', { spawn: fakeSpawn('{"result":"x"}', plain), cwd: process.cwd(), env });
  assert.ok(!plain.args.includes('--strict-mcp-config'));
  assert.ok(!plain.args.includes('--tools'));
});
