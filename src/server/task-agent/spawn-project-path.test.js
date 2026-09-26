'use strict';

// Regression test for C790: in a packaged GUI launch, config.PROJECT_ROOT points
// inside the .app bundle, so the coding-agent spawn cwd + --mcp-config MUST come
// from the window's bound project (opts.projectPath), not the global config.
// Pre-fix, claude-agent hardcoded config.PROJECT_ROOT → claude looked for
// `<bundle>/.mcp.json` → "Invalid MCP configuration: MCP config file not found".
//
// Also covers C953: the --model flag must live-read project config.json at spawn
// time (not a frozen startup config.CLAUDE_MODEL snapshot, which a stale exported
// env var could poison), with precedence task override > config.json > 'opusplan'.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ClaudeAgent = require('./claude-agent');
const { projectEnvExtras, resolveSpawnModel } = require('../spawn-utils');

function makeProjectDir(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-c790-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  return dir;
}

// Minimal fake config; SIMPLE_MODE:true keeps getSpawnSpec off the append-system-prompt path.
const FAKE_CONFIG = {
  CLAUDE_MODEL: 'opusplan',
  SIMPLE_MODE: true,
  PROJECT_ROOT: '/fallback/global/project',
  USER_DATA_ROOT: os.tmpdir(),
  CLAUDE_BIN: 'claude',
};

function mcpConfigArg(args) {
  const i = args.indexOf('--mcp-config');
  return i >= 0 ? args[i + 1] : null;
}

test('projectEnvExtras: empty for falsy path, populated from project config.json', () => {
  assert.deepStrictEqual(projectEnvExtras(''), {});
  assert.deepStrictEqual(projectEnvExtras(null), {});

  const dir = makeProjectDir({ API_PROJECT_ID: '7', API_TOKEN: 'tok', projectName: 'X' });
  try {
    const extras = projectEnvExtras(dir);
    assert.strictEqual(extras.TIPATASK_PROJECT_ROOT, dir);
    assert.strictEqual(extras.API_PROJECT_ID, '7');
    assert.strictEqual(extras.API_TOKEN, 'tok');
    assert.ok(!('projectName' in extras), 'projectName must not leak into spawn env');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A Pi row's key travels under its OWN provider's env var — and only that one, so a DeepSeek
// key is never handed to an OpenRouter-authenticated process (or the reverse).
test('projectEnvExtras: row 0 key lands under its provider env var only', () => {
  const dsDir = makeProjectDir({ PI_MODELS: [{ model: 'deepseek-v4-flash', apiKey: 'sk-ds', provider: 'deepseek' }] });
  const orDir = makeProjectDir({ PI_MODELS: [{ model: 'openrouter/openai/gpt-4o', apiKey: 'sk-or' }] });
  try {
    const ds = projectEnvExtras(dsDir);
    assert.strictEqual(ds.DEEPSEEK_API_KEY, 'sk-ds');
    assert.ok(!('OPENROUTER_API_KEY' in ds), 'deepseek row must not populate OPENROUTER_API_KEY');

    const or = projectEnvExtras(orDir);
    assert.strictEqual(or.OPENROUTER_API_KEY, 'sk-or');
    assert.ok(!('DEEPSEEK_API_KEY' in or), 'openrouter row must not populate DEEPSEEK_API_KEY');
  } finally {
    fs.rmSync(dsDir, { recursive: true, force: true });
    fs.rmSync(orDir, { recursive: true, force: true });
  }
});

// (TPT188) Every provider in the registry exports row 0's key under its own env var — never
// OPENROUTER_API_KEY unless the row IS an OpenRouter row.
test('projectEnvExtras: an anthropic row sets ANTHROPIC_API_KEY and never OPENROUTER_API_KEY', () => {
  const dir = makeProjectDir({ PI_MODELS: [{ model: 'claude-sonnet-4-5', apiKey: 'sk-ant', provider: 'anthropic' }] });
  try {
    const extras = projectEnvExtras(dir);
    assert.strictEqual(extras.ANTHROPIC_API_KEY, 'sk-ant');
    assert.ok(!('OPENROUTER_API_KEY' in extras), 'an anthropic row must not populate OPENROUTER_API_KEY');
    assert.ok(!('DEEPSEEK_API_KEY' in extras));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('projectEnvExtras: each provider row lands only under its own env var', () => {
  const cases = [
    ['google', 'GEMINI_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['groq', 'GROQ_API_KEY'],
    ['xai', 'XAI_API_KEY'],
    ['mistral', 'MISTRAL_API_KEY'],
    ['cerebras', 'CEREBRAS_API_KEY'],
    ['huggingface', 'HF_TOKEN'],
    ['google-vertex', 'GOOGLE_CLOUD_API_KEY'],
  ];
  for (const [provider, envKey] of cases) {
    const dir = makeProjectDir({ PI_MODELS: [{ model: `${provider}-model`, apiKey: 'sk-x', provider }] });
    try {
      const extras = projectEnvExtras(dir);
      assert.strictEqual(extras[envKey], 'sk-x', `${provider} → ${envKey}`);
      assert.ok(!('OPENROUTER_API_KEY' in extras), `${provider} row must not populate OPENROUTER_API_KEY`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('projectEnvExtras: a keyless row exports no key env var, and a key on a key-optional row is exported', () => {
  const keyless = makeProjectDir({ PI_MODELS: [{ model: 'us.anthropic.claude-sonnet-4', apiKey: '', provider: 'amazon-bedrock' }] });
  const keyed = makeProjectDir({ PI_MODELS: [{ model: 'us.anthropic.claude-sonnet-4', apiKey: 'bearer-tok', provider: 'amazon-bedrock' }] });
  try {
    const a = projectEnvExtras(keyless);
    assert.ok(!('AWS_BEARER_TOKEN_BEDROCK' in a), 'an empty key must not be exported (it would shadow an ambient value)');
    assert.ok(!('OPENROUTER_API_KEY' in a));
    assert.strictEqual(a.TIPATASK_PROJECT_ROOT, keyless, 'the rest of the extras are unaffected');

    assert.strictEqual(projectEnvExtras(keyed).AWS_BEARER_TOKEN_BEDROCK, 'bearer-tok');
  } finally {
    fs.rmSync(keyless, { recursive: true, force: true });
    fs.rmSync(keyed, { recursive: true, force: true });
  }
});

test('ClaudeAgent.getSpawnSpec: cwd + --mcp-config derive from opts.projectPath', async () => {
  const dir = makeProjectDir({ API_PROJECT_ID: '42', API_TOKEN: 'abc' });
  try {
    const agent = new ClaudeAgent();
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'do thing', 'C1', { projectPath: dir });

    assert.strictEqual(spec.cwd, dir, 'cwd must be the bound project, not config.PROJECT_ROOT');
    assert.strictEqual(mcpConfigArg(spec.args), path.join(dir, '.mcp.json'),
      '--mcp-config must point at the bound project .mcp.json');
    assert.ok(spec.args.includes('--strict-mcp-config'));
    assert.strictEqual(spec.env.TIPATASK_PROJECT_ROOT, dir);
    assert.strictEqual(spec.env.API_PROJECT_ID, '42', 'per-project API identity must be injected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ClaudeAgent.getSpawnSpec: falls back to config.PROJECT_ROOT when no projectPath', async () => {
  const agent = new ClaudeAgent();
  const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'do thing', 'C2', {});

  assert.strictEqual(spec.cwd, FAKE_CONFIG.PROJECT_ROOT);
  assert.strictEqual(mcpConfigArg(spec.args), path.join(FAKE_CONFIG.PROJECT_ROOT, '.mcp.json'));
  // No projectPath → no per-project overrides leaked into env.
  assert.ok(!('TIPATASK_PROJECT_ROOT' in spec.env) || spec.env.TIPATASK_PROJECT_ROOT === process.env.TIPATASK_PROJECT_ROOT);
});

function modelArg(args) {
  const i = args.indexOf('--model');
  return i >= 0 ? args[i + 1] : null;
}

// C953 — resolveSpawnModel: shared live-read model resolver.
test('resolveSpawnModel: task override > config.json > fallback, never a hard-coded id', () => {
  const dir = makeProjectDir({ CLAUDE_MODEL: 'claude-opus-4-8' });
  try {
    // Per-task override wins over everything.
    assert.strictEqual(resolveSpawnModel('claude-sonnet-4-6', dir, 'CLAUDE_MODEL', 'opusplan'), 'claude-sonnet-4-6');
    // No override → live config.json value wins.
    assert.strictEqual(resolveSpawnModel(undefined, dir, 'CLAUDE_MODEL', 'opusplan'), 'claude-opus-4-8');
    // Blank/whitespace override is ignored, falls through to config.json.
    assert.strictEqual(resolveSpawnModel('  ', dir, 'CLAUDE_MODEL', 'opusplan'), 'claude-opus-4-8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const blankDir = makeProjectDir({});
  try {
    // config.json present but field blank/missing → fallback default, never fable.
    assert.strictEqual(resolveSpawnModel(undefined, blankDir, 'CLAUDE_MODEL', 'opusplan'), 'opusplan');
  } finally {
    fs.rmSync(blankDir, { recursive: true, force: true });
  }

  // No projectPath at all → fallback.
  assert.strictEqual(resolveSpawnModel(undefined, '', 'CLAUDE_MODEL', 'opusplan'), 'opusplan');
});

// C953 — ClaudeAgent.getSpawnSpec must emit --model from a live config.json read,
// not the (possibly env-poisoned) FAKE_CONFIG.CLAUDE_MODEL startup snapshot.
test('ClaudeAgent.getSpawnSpec: --model reflects live config.json over the startup snapshot', async () => {
  const dir = makeProjectDir({ CLAUDE_MODEL: 'claude-opus-4-8' });
  try {
    const agent = new ClaudeAgent();
    // FAKE_CONFIG.CLAUDE_MODEL is 'opusplan' — stands in for a stale/poisoned startup
    // snapshot. config.json in the project dir must win.
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'do thing', 'C3', { projectPath: dir });
    assert.strictEqual(modelArg(spec.args), 'claude-opus-4-8');
    assert.strictEqual(spec.model, 'claude-opus-4-8'); // (C1118) resolved model, for the terminal header caption
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ClaudeAgent.getSpawnSpec: blank config.json model falls back to opusplan, never fable', async () => {
  const dir = makeProjectDir({});
  try {
    const agent = new ClaudeAgent();
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'do thing', 'C4', { projectPath: dir });
    assert.strictEqual(modelArg(spec.args), 'opusplan');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ClaudeAgent.getSpawnSpec: per-task opts.model overrides config.json', async () => {
  const dir = makeProjectDir({ CLAUDE_MODEL: 'claude-opus-4-8' });
  try {
    const agent = new ClaudeAgent();
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'do thing', 'C5', { projectPath: dir, model: 'claude-sonnet-4-6' });
    assert.strictEqual(modelArg(spec.args), 'claude-sonnet-4-6');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
