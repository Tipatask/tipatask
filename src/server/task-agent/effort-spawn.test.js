'use strict';

// TPT286 — a task's persisted effort (task.effort, threaded into getSpawnSpec() as opts.task)
// must reach every agent CLI that supports one: Claude via CLAUDE_CODE_EFFORT_LEVEL (+ --effort
// when the installed CLI's --help lists it), Codex via config or -c (max -> xhigh),
// Pi not at all (spawn unchanged).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BaseTaskAgent = require('./base-agent');
const ClaudeAgent = require('./claude-agent');
const CodexAgent = require('./codex-agent');
const PiAgent = require('./pi-agent');
const { codexEffortArgs, toCodexEffort } = require('../codex-env');

function makeProjectDir(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-effort-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  return dir;
}

function effortArgPairs(args) {
  const out = [];
  args.forEach((a, i) => {
    if (a === '-c' && /^model_reasoning_effort=/.test(args[i + 1] || '')) out.push(args[i + 1]);
  });
  return out;
}

function withEffortProbe(t, value) {
  const original = ClaudeAgent._cliSupportsEffortFlag;
  ClaudeAgent._cliSupportsEffortFlag = async () => value;
  t.after(() => { ClaudeAgent._cliSupportsEffortFlag = original; });
}

const CLAUDE_CONFIG = {
  CLAUDE_MODEL: 'opusplan',
  SIMPLE_MODE: true,
  PROJECT_ROOT: '/fallback/global/project',
  USER_DATA_ROOT: os.tmpdir(),
  CLAUDE_BIN: 'claude',
};

test('resolveEffort: canonical level or null', () => {
  const agent = new BaseTaskAgent('x', 'X');
  assert.equal(agent.resolveEffort(null), null);
  assert.equal(agent.resolveEffort(undefined), null);
  assert.equal(agent.resolveEffort({}), null);
  assert.equal(agent.resolveEffort({ effort: null }), null);
  assert.equal(agent.resolveEffort({ effort: '' }), null);
  for (const level of ['low', 'medium', 'high', 'max']) {
    assert.equal(agent.resolveEffort({ effort: level }), level);
  }
  assert.equal(agent.resolveEffort({ effort: ' HIGH ' }), 'high');
  assert.equal(agent.resolveEffort({ effort: 'xhigh' }), null, 'not a task-level value');
  assert.equal(agent.resolveEffort({ effort: 'ultra' }), null);
  assert.equal(agent.resolveEffort({ effort: 3 }), null);
  assert.deepEqual([...BaseTaskAgent.EFFORT_LEVELS], ['low', 'medium', 'high', 'max']);
});

test('Claude: effort exports CLAUDE_CODE_EFFORT_LEVEL and --effort when the CLI supports it', async (t) => {
  withEffortProbe(t, true);
  const dir = makeProjectDir({});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spec = await new ClaudeAgent().getSpawnSpec(CLAUDE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir, task: { effort: 'high' } });
  assert.equal(spec.env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  const i = spec.args.indexOf('--effort');
  assert.ok(i >= 0, '--effort flag expected');
  assert.equal(spec.args[i + 1], 'high');
  assert.equal(spec.args.filter(a => a === '--effort').length, 1);
});

test('Claude: env only when the installed CLI does not list --effort', async (t) => {
  withEffortProbe(t, false);
  const dir = makeProjectDir({});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spec = await new ClaudeAgent().getSpawnSpec(CLAUDE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir, task: { effort: 'max' } });
  assert.equal(spec.env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
  assert.ok(!spec.args.includes('--effort'));
});

test('Claude: no effort set leaves env and args untouched (and never probes)', async (t) => {
  const original = ClaudeAgent._cliSupportsEffortFlag;
  let probed = false;
  ClaudeAgent._cliSupportsEffortFlag = async () => { probed = true; return true; };
  t.after(() => { ClaudeAgent._cliSupportsEffortFlag = original; });
  const dir = makeProjectDir({});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prevEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
  t.after(() => { if (prevEnv !== undefined) process.env.CLAUDE_CODE_EFFORT_LEVEL = prevEnv; });
  for (const task of [undefined, null, { effort: null }]) {
    const spec = await new ClaudeAgent().getSpawnSpec(CLAUDE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir, task });
    assert.ok(!('CLAUDE_CODE_EFFORT_LEVEL' in spec.env));
    assert.ok(!spec.args.includes('--effort'));
  }
  assert.equal(probed, false);
});

test('toCodexEffort maps max to xhigh and passes the rest through', () => {
  assert.equal(toCodexEffort('max'), 'xhigh');
  for (const level of ['low', 'medium', 'high']) assert.equal(toCodexEffort(level), level);
  assert.deepEqual(codexEffortArgs('xhigh'), ['-c', 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(codexEffortArgs(), ['-c', 'model_reasoning_effort="high"']);
});

test('Codex: task effort replaces the default model_reasoning_effort, max -> xhigh', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-effort-codex-'));
  const previousCodexHome = process.env.CODEX_HOME;
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const projectRoot = path.join(dir, 'project');
  const globalCodexHome = path.join(dir, 'user-codex');
  fs.mkdirSync(path.join(projectRoot, '.tipatask'), { recursive: true });
  fs.mkdirSync(globalCodexHome, { recursive: true });
  fs.writeFileSync(path.join(globalCodexHome, 'config.toml'), '', 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
    API_BASE_URL: 'https://effort-spawn.test', API_PROJECT_ID: '2', API_TOKEN: 'test-token',
  }), 'utf8');
  process.env.CODEX_HOME = globalCodexHome;
  const cfg = { CODEX_BIN: 'codex', PROJECT_ROOT: projectRoot, USER_DATA_ROOT: dir };

  const cases = [
    [undefined, 'model_reasoning_effort="high"'],
    [{ effort: null }, 'model_reasoning_effort="high"'],
    [{ effort: 'low' }, 'model_reasoning_effort="low"'],
    [{ effort: 'medium' }, 'model_reasoning_effort="medium"'],
    [{ effort: 'high' }, 'model_reasoning_effort="high"'],
    [{ effort: 'max' }, 'model_reasoning_effort="xhigh"'],
  ];
  for (const [task, expected] of cases) {
    const spec = await new CodexAgent().getSpawnSpec(cfg, 'Work on task TPT99.', '', { projectPath: projectRoot, task });
    assert.deepEqual(effortArgPairs(spec.args), expected === 'model_reasoning_effort="high"' ? [] : [expected], `task=${JSON.stringify(task)}`);
    assert.match(fs.readFileSync(path.join(spec.env.CODEX_HOME, 'config.toml'), 'utf8'), /^model_reasoning_effort = "high"/);
  }
});

test('Pi: effort leaves the spawn spec unchanged', async (t) => {
  const dir = makeProjectDir({ PI_MODEL: 'openrouter/test-model', OPENROUTER_API_KEY: 'k' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { PI_MODEL: 'openrouter/test-model', SIMPLE_MODE: true, PROJECT_ROOT: '/fallback/global/project', USER_DATA_ROOT: os.tmpdir() };
  const origDebug = console.debug;
  const debugLines = [];
  console.debug = (...a) => { debugLines.push(a.join(' ')); };
  t.after(() => { console.debug = origDebug; });
  const agent = new PiAgent();
  const plain = await agent.getSpawnSpec(cfg, 'Work on task C1.', 'C1', { projectPath: dir });
  const withEffort = await agent.getSpawnSpec(cfg, 'Work on task C1.', 'C1', { projectPath: dir, task: { effort: 'high' } });
  assert.deepEqual(withEffort.args, plain.args);
  assert.deepEqual(withEffort.env, plain.env);
  assert.equal(withEffort.command, plain.command);
  assert.ok(debugLines.some(l => /effort=high ignored/.test(l)), 'debug note expected');
});
