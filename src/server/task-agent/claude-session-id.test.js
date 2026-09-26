'use strict';

// (TPT354) ClaudeAgent pins the CLI's session uuid with `--session-id` when terminal-session.js
// hands it one (opts.agentSessionId), so the exit-comment builder can read that run's transcript
// by name. Absent → no flag, spawn unchanged. Codex/Pi cannot be pinned and ignore the key.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BaseTaskAgent = require('./base-agent');
const ClaudeAgent = require('./claude-agent');

const CLAUDE_CONFIG = {
  CLAUDE_MODEL: 'opusplan',
  SIMPLE_MODE: true,
  PROJECT_ROOT: '/fallback/global/project',
  USER_DATA_ROOT: os.tmpdir(),
  CLAUDE_BIN: 'claude',
};
const UUID = '0b7d3c1e-5f0a-4c2e-9a41-2f6d8e7b9c10';

function projectDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-sessid-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), '{}', 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Claude getSpawnSpec: agentSessionId becomes exactly one --session-id <uuid> pair', async (t) => {
  const spec = await new ClaudeAgent().getSpawnSpec(CLAUDE_CONFIG, 'Work on task C1.', 'C1', { projectPath: projectDir(t), agentSessionId: UUID });
  const i = spec.args.indexOf('--session-id');
  assert.ok(i >= 0, '--session-id expected');
  assert.equal(spec.args[i + 1], UUID);
  assert.equal(spec.args.filter(a => a === '--session-id').length, 1);
});

test('Claude getSpawnSpec: no agentSessionId → spawn args carry no --session-id', async (t) => {
  for (const opts of [{}, { agentSessionId: null }, { agentSessionId: '' }]) {
    const spec = await new ClaudeAgent().getSpawnSpec(CLAUDE_CONFIG, 'Work on task C1.', 'C1', { projectPath: projectDir(t), ...opts });
    assert.ok(!spec.args.includes('--session-id'));
  }
});

test('readFinalMessage: base default is null; Claude with no hint is null, never throws', () => {
  assert.equal(new BaseTaskAgent('x', 'X').readFinalMessage({ _transcriptHint: { agentSessionId: 'z' } }), null);
  assert.equal(new ClaudeAgent().readFinalMessage({ _transcriptHint: null }), null);
  assert.equal(new ClaudeAgent().readFinalMessage(null), null);
  assert.equal(new ClaudeAgent().readFinalMessage(undefined), null);
});
