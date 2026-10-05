'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PiAgent = require('./pi-agent');
// (C1112) getSpawnSpec/detect resolve the pi command via resolvePiLaunch() directly (checkout
// bundle / packaged extraResources / PI_BIN / system PATH) rather than reading it off the passed
// config object — FAKE_CONFIG below intentionally carries no PI_BIN. Tests compare spec.command
// against a live resolvePiLaunch() call so they pass regardless of whether the bundled
// dependency is installed on the machine running them.
const { resolvePiLaunch } = require('../spawn-utils');
const { piCustomProviderId, piDefaultSessionDir } = require('../pi-custom-endpoint');
const { matchPromptLine, PI_PROMPT_PATTERNS, GENERIC_PROMPT_PATTERNS, buildLegacyPatternTable } = require('./prompt-detect');

function makeProjectDir(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-pi-agent-'));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  return dir;
}

const FAKE_CONFIG = {
  PI_MODEL: 'openrouter/test-model',
  SIMPLE_MODE: true,
  PROJECT_ROOT: '/fallback/global/project',
  USER_DATA_ROOT: os.tmpdir(),
};

function expectedLaunch() {
  return resolvePiLaunch() || { command: 'pi', argsPrefix: [] };
}

test('PiAgent.getSpawnSpec: uses OpenRouter interactive args and project env', async () => {
  const dir = makeProjectDir({ API_PROJECT_ID: '42', OPENROUTER_API_KEY: 'sk-or-test' });
  try {
    const agent = new PiAgent();
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir });
    const launch = expectedLaunch();

    assert.strictEqual(spec.command, launch.command);
    assert.strictEqual(spec.cwd, dir);
    const argsAfterPrefix = spec.args.slice(launch.argsPrefix.length);
    assert.deepStrictEqual(spec.args.slice(0, launch.argsPrefix.length), launch.argsPrefix);
    assert.deepStrictEqual(argsAfterPrefix.slice(0, 5), ['--provider', 'openrouter', '--model', 'openrouter/test-model', '--approve']);
    assert.strictEqual(spec.model, 'openrouter/test-model'); // (C1118) resolved model, for the terminal header caption
    assert.ok(!spec.args.includes('--mcp-config'), 'Pi has no MCP config flag');
    assert.ok(spec.args.at(-1).includes('Work on task C1.'));
    assert.strictEqual(spec.env.TIPATASK_PROJECT_ROOT, dir);
    assert.strictEqual(spec.env.OPENROUTER_API_KEY, 'sk-or-test');
    assert.strictEqual(spec.env.PI_SKIP_VERSION_CHECK, '1');
    assert.strictEqual(spec.env.TIPATASK_TASK_ID, 'C1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// C1101 — live per-project --model read (same pattern as C953's CLAUDE_MODEL/CODEX_MODEL
// coverage in spawn-project-path.test.js): a project's saved "Other Model" choice must
// win over whatever getSpawnSpec's config param carries, and apply with no restart.
test('PiAgent.getSpawnSpec: --model reflects live config.json PI_MODEL over the startup snapshot', async () => {
  const dir = makeProjectDir({ PI_MODEL: 'openrouter/x-ai/grok-4' });
  try {
    const agent = new PiAgent();
    // FAKE_CONFIG.PI_MODEL is 'openrouter/test-model' — stands in for a stale/poisoned
    // global startup snapshot. The project's config.json must win.
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir });
    const argsAfterPrefix = spec.args.slice(expectedLaunch().argsPrefix.length);
    assert.deepStrictEqual(argsAfterPrefix.slice(0, 5), ['--provider', 'openrouter', '--model', 'openrouter/x-ai/grok-4', '--approve']);
    assert.strictEqual(spec.model, 'openrouter/x-ai/grok-4'); // (C1118) resolved model, for the terminal header caption
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.getSpawnSpec: blank/absent config.json PI_MODEL falls back to the passed config default', async () => {
  const dir = makeProjectDir({ PI_MODEL: '  ' });
  try {
    const agent = new PiAgent();
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir });
    const argsAfterPrefix = spec.args.slice(expectedLaunch().argsPrefix.length);
    assert.deepStrictEqual(argsAfterPrefix.slice(0, 5), ['--provider', 'openrouter', '--model', 'openrouter/test-model', '--approve']);
    assert.strictEqual(spec.model, 'openrouter/test-model'); // (C1118) resolved model, for the terminal header caption
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// C1121 — a wizard-created project has ONLY PI_MODELS (array of {model,apiKey} rows), no
// flat PI_MODEL/OPENROUTER_API_KEY at all. Row 0 must drive both the --model argv and the
// spawn env's OPENROUTER_API_KEY (projectEnvExtras' compat bridge).
test('PiAgent.getSpawnSpec: PI_MODELS-only config.json (no legacy PI_MODEL) drives --model and OPENROUTER_API_KEY from row 0', async () => {
  const dir = makeProjectDir({
    PI_MODELS: [
      { model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'sk-or-row0' },
      { model: 'openrouter/openai/gpt-4o', apiKey: 'sk-or-row1' },
    ],
  });
  try {
    const agent = new PiAgent();
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir });
    const argsAfterPrefix = spec.args.slice(expectedLaunch().argsPrefix.length);
    assert.deepStrictEqual(argsAfterPrefix.slice(0, 5), ['--provider', 'openrouter', '--model', 'openrouter/anthropic/claude-sonnet-4.5', '--approve']);
    assert.strictEqual(spec.model, 'openrouter/anthropic/claude-sonnet-4.5');
    assert.strictEqual(spec.env.OPENROUTER_API_KEY, 'sk-or-row0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// C1122 — opts.model naming a NON-default PI_MODELS row must drive --model AND that
// row's own OPENROUTER_API_KEY, not row 0's (projectEnvExtras() alone would still inject
// row 0's key — pi-agent.js's own override, added in getSpawnSpec, must win).
test('PiAgent.getSpawnSpec: opts.model naming row 1 uses --model row1 and env.OPENROUTER_API_KEY row1', async () => {
  const dir = makeProjectDir({
    PI_MODELS: [
      { model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'sk-or-row0' },
      { model: 'openrouter/openai/gpt-4o', apiKey: 'sk-or-row1' },
    ],
  });
  try {
    const agent = new PiAgent();
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir, model: 'openrouter/openai/gpt-4o' });
    const argsAfterPrefix = spec.args.slice(expectedLaunch().argsPrefix.length);
    assert.deepStrictEqual(argsAfterPrefix.slice(0, 5), ['--provider', 'openrouter', '--model', 'openrouter/openai/gpt-4o', '--approve']);
    assert.strictEqual(spec.model, 'openrouter/openai/gpt-4o');
    assert.strictEqual(spec.env.OPENROUTER_API_KEY, 'sk-or-row1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (TPT163) A row naming a non-OpenRouter provider drives --provider and the key's env var,
// whether it is reached by opts.model or as row 0 through projectEnvExtras().
test('PiAgent.getSpawnSpec: a deepseek row uses --provider deepseek and env.DEEPSEEK_API_KEY', async () => {
  const dir = makeProjectDir({
    PI_MODELS: [
      { model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'sk-or-row0' },
      { model: 'deepseek-flash', apiKey: 'sk-ds-row1', provider: 'deepseek' },
    ],
  });
  const dirRow0 = makeProjectDir({ PI_MODELS: [{ model: 'deepseek-v4-flash', apiKey: 'sk-ds-row0', provider: 'deepseek' }] });
  try {
    const agent = new PiAgent();
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir, model: 'deepseek-flash' });
    const argsAfterPrefix = spec.args.slice(expectedLaunch().argsPrefix.length);
    assert.deepStrictEqual(argsAfterPrefix.slice(0, 5), ['--provider', 'deepseek', '--model', 'deepseek-flash', '--approve']);
    assert.strictEqual(spec.env.DEEPSEEK_API_KEY, 'sk-ds-row1');
    assert.strictEqual(spec.env.OPENROUTER_API_KEY, 'sk-or-row0', 'row 0 key stays under its own provider var');

    const spec0 = await agent.getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dirRow0 });
    const args0 = spec0.args.slice(expectedLaunch().argsPrefix.length);
    assert.deepStrictEqual(args0.slice(0, 4), ['--provider', 'deepseek', '--model', 'deepseek-v4-flash']);
    assert.strictEqual(spec0.env.DEEPSEEK_API_KEY, 'sk-ds-row0');
    assert.notStrictEqual(spec0.env.OPENROUTER_API_KEY, 'sk-ds-row0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dirRow0, { recursive: true, force: true });
  }
});

// The spawn log line is how a model/provider mix-up is diagnosed without a follow-up round-trip.
test('PiAgent.getSpawnSpec: spawn log line names the resolved provider', async (t) => {
  const dir = makeProjectDir({ PI_MODELS: [{ model: 'deepseek-v4-flash', apiKey: 'sk-ds', provider: 'deepseek' }] });
  const lines = [];
  t.mock.method(console, 'log', (...args) => { lines.push(args.join(' ')); });
  try {
    await new PiAgent().getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir });
    assert.ok(
      lines.some((l) => /\[terminal:pi\] spawning task C1 model=deepseek-v4-flash provider=deepseek/.test(l)),
      `no provider=deepseek spawn line in: ${JSON.stringify(lines)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (TPT188) The full Pi provider catalog: any registry provider drives --provider and puts the
// key under ITS env var — as row 0 (projectEnvExtras) and as a non-default row (opts.model).
test('PiAgent.getSpawnSpec: a google row uses --provider google and env.GEMINI_API_KEY', async () => {
  const dir = makeProjectDir({ PI_MODELS: [{ model: 'gemini-2.5-pro', apiKey: 'sk-g-row0', provider: 'google' }] });
  try {
    const spec = await new PiAgent().getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir });
    const argsAfterPrefix = spec.args.slice(expectedLaunch().argsPrefix.length);
    assert.deepStrictEqual(argsAfterPrefix.slice(0, 5), ['--provider', 'google', '--model', 'gemini-2.5-pro', '--approve']);
    assert.strictEqual(spec.model, 'gemini-2.5-pro');
    assert.strictEqual(spec.env.GEMINI_API_KEY, 'sk-g-row0');
    assert.notStrictEqual(spec.env.OPENROUTER_API_KEY, 'sk-g-row0', 'a google key must never land under OPENROUTER_API_KEY');
    assert.ok(!spec.args.includes('sk-g-row0'), 'the key travels by env var, never argv');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.getSpawnSpec: opts.model naming a google row 1 keeps row 0 under its own provider env var', async () => {
  const dir = makeProjectDir({
    PI_MODELS: [
      { model: 'claude-sonnet-4-5', apiKey: 'sk-ant-row0', provider: 'anthropic' },
      { model: 'gemini-2.5-pro', apiKey: 'sk-g-row1', provider: 'google' },
    ],
  });
  try {
    const spec = await new PiAgent().getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir, model: 'gemini-2.5-pro' });
    const argsAfterPrefix = spec.args.slice(expectedLaunch().argsPrefix.length);
    assert.deepStrictEqual(argsAfterPrefix.slice(0, 5), ['--provider', 'google', '--model', 'gemini-2.5-pro', '--approve']);
    assert.strictEqual(spec.env.GEMINI_API_KEY, 'sk-g-row1');
    assert.strictEqual(spec.env.ANTHROPIC_API_KEY, 'sk-ant-row0', 'row 0 key stays under its own provider var');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.getSpawnSpec: a keyless Bedrock row passes --provider amazon-bedrock and injects no key', async () => {
  const dir = makeProjectDir({ PI_MODELS: [{ model: 'us.anthropic.claude-sonnet-4', apiKey: '', provider: 'amazon-bedrock' }] });
  try {
    const spec = await new PiAgent().getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir });
    const argsAfterPrefix = spec.args.slice(expectedLaunch().argsPrefix.length);
    assert.deepStrictEqual(argsAfterPrefix.slice(0, 5), ['--provider', 'amazon-bedrock', '--model', 'us.anthropic.claude-sonnet-4', '--approve']);
    // Whatever the ambient environment holds passes through untouched — an empty row key must
    // not overwrite it with ''.
    assert.strictEqual(spec.env.AWS_BEARER_TOKEN_BEDROCK, process.env.AWS_BEARER_TOKEN_BEDROCK);
    assert.notStrictEqual(spec.env.OPENROUTER_API_KEY, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (TPT189) A `custom` row runs on a provider declared in a generated models.json: --provider is the
// block id, PI_CODING_AGENT_DIR points Pi at <project>/.pi/agent, and the key never touches argv or
// the file — it travels as $TIPATASK_PI_CUSTOM_API_KEY.
test('PiAgent.getSpawnSpec: a keyed custom row passes the generated --provider, writes models.json, and keeps the key out of argv and the file', async () => {
  const SECRET = 'sk-custom-secret-9f3a';
  const row = { model: 'gpt-4o-mini', apiKey: SECRET, provider: 'custom', baseUrl: 'https://gw.example.com/v1' };
  const dir = makeProjectDir({ PI_MODELS: [row] });
  try {
    const spec = await new PiAgent().getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir });
    const providerId = piCustomProviderId(row);
    const argsAfterPrefix = spec.args.slice(expectedLaunch().argsPrefix.length);
    assert.deepStrictEqual(argsAfterPrefix.slice(0, 5), ['--provider', providerId, '--model', 'gpt-4o-mini', '--approve']);
    assert.strictEqual(spec.model, 'gpt-4o-mini');

    const modelsPath = path.join(dir, '.pi', 'agent', 'models.json');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(modelsPath, 'utf8')), {
      providers: {
        [providerId]: {
          name: 'Custom endpoint (gw.example.com)',
          baseUrl: 'https://gw.example.com/v1',
          api: 'openai-completions',
          apiKey: '$TIPATASK_PI_CUSTOM_API_KEY',
          models: [{ id: 'gpt-4o-mini' }],
        },
      },
    });

    assert.strictEqual(spec.env.PI_CODING_AGENT_DIR, path.join(dir, '.pi', 'agent'));
    assert.strictEqual(spec.env.PI_CODING_AGENT_SESSION_DIR, piDefaultSessionDir(dir, process.env), 'sessions stay in Pi\'s normal per-cwd store');
    assert.strictEqual(spec.env.TIPATASK_PI_CUSTOM_API_KEY, SECRET);
    assert.notStrictEqual(spec.env.OPENROUTER_API_KEY, SECRET, 'a custom key must never land under OPENROUTER_API_KEY');
    assert.ok(!spec.args.join('\n').includes(SECRET), 'the key travels by env var — not a substring of any argv element');
    assert.ok(!fs.readFileSync(modelsPath, 'utf8').includes(SECRET), 'the literal key is never written to models.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.getSpawnSpec: a keyless custom row gets the placeholder apiKey and exports no key var', async () => {
  const row = { model: 'llama3.1:8b', apiKey: '', provider: 'custom', baseUrl: 'http://localhost:11434/v1', api: 'openai-responses' };
  const dir = makeProjectDir({ PI_MODELS: [row] });
  try {
    const spec = await new PiAgent().getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir });
    const providerId = piCustomProviderId(row);
    const argsAfterPrefix = spec.args.slice(expectedLaunch().argsPrefix.length);
    assert.deepStrictEqual(argsAfterPrefix.slice(0, 5), ['--provider', providerId, '--model', 'llama3.1:8b', '--approve']);
    const block = JSON.parse(fs.readFileSync(path.join(dir, '.pi', 'agent', 'models.json'), 'utf8')).providers[providerId];
    assert.strictEqual(block.apiKey, 'tipatask-no-key');
    assert.strictEqual(block.api, 'openai-responses');
    // Whatever the ambient environment holds passes through untouched.
    assert.strictEqual(spec.env.TIPATASK_PI_CUSTOM_API_KEY, process.env.TIPATASK_PI_CUSTOM_API_KEY);
    assert.strictEqual(spec.env.PI_CODING_AGENT_DIR, path.join(dir, '.pi', 'agent'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.getSpawnSpec: opts.model naming a custom row 1 keeps row 0 under its own provider env var', async () => {
  const custom = { model: 'qwen3-coder', apiKey: 'sk-custom-row1', provider: 'custom', baseUrl: 'http://127.0.0.1:1234/v1' };
  const dir = makeProjectDir({ PI_MODELS: [{ model: 'a/b', apiKey: 'sk-or-row0' }, custom] });
  try {
    const spec = await new PiAgent().getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir, model: 'qwen3-coder' });
    const argsAfterPrefix = spec.args.slice(expectedLaunch().argsPrefix.length);
    assert.deepStrictEqual(argsAfterPrefix.slice(0, 5), ['--provider', piCustomProviderId(custom), '--model', 'qwen3-coder', '--approve']);
    assert.strictEqual(spec.env.TIPATASK_PI_CUSTOM_API_KEY, 'sk-custom-row1');
    assert.strictEqual(spec.env.OPENROUTER_API_KEY, 'sk-or-row0', 'row 0 key stays under its own provider var');
    assert.strictEqual(spec.env.PI_CODING_AGENT_DIR, path.join(dir, '.pi', 'agent'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.getSpawnSpec: a non-custom row leaves Pi\'s agent dir alone and creates no .pi/', async () => {
  const dir = makeProjectDir({ PI_MODELS: [{ model: 'a/b', apiKey: 'sk-or-row0' }, { model: 'gemini-2.5-pro', apiKey: 'k', provider: 'google' }] });
  try {
    for (const model of [undefined, 'gemini-2.5-pro']) {
      const spec = await new PiAgent().getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir, model });
      assert.strictEqual(spec.env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR, 'ambient value passes through untouched');
      assert.strictEqual(spec.env.PI_CODING_AGENT_SESSION_DIR, process.env.PI_CODING_AGENT_SESSION_DIR);
    }
    assert.strictEqual(fs.existsSync(path.join(dir, '.pi')), false, 'a non-custom spawn must not write anything under .pi/');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.getSpawnSpec: a models.json write failure is logged and the spawn spec is still produced', async (t) => {
  const row = { model: 'llama3.1:8b', apiKey: '', provider: 'custom', baseUrl: 'http://localhost:11434/v1' };
  const dir = makeProjectDir({ PI_MODELS: [row] });
  try {
    fs.writeFileSync(path.join(dir, '.pi'), 'i am a file, so .pi/agent cannot be created');
    const warn = t.mock.method(console, 'warn', () => {});
    const spec = await new PiAgent().getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir });
    const argsAfterPrefix = spec.args.slice(expectedLaunch().argsPrefix.length);
    assert.deepStrictEqual(argsAfterPrefix.slice(0, 5), ['--provider', piCustomProviderId(row), '--model', 'llama3.1:8b', '--approve']);
    assert.ok(warn.mock.calls.some((c) => /could not write models\.json/.test(String(c.arguments[0]))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// No opts.model → row 0 for both --model and the key (unchanged C1121 default behavior).
test('PiAgent.getSpawnSpec: no opts.model falls back to row 0 for both --model and OPENROUTER_API_KEY', async () => {
  const dir = makeProjectDir({
    PI_MODELS: [
      { model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'sk-or-row0' },
      { model: 'openrouter/openai/gpt-4o', apiKey: 'sk-or-row1' },
    ],
  });
  try {
    const agent = new PiAgent();
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir });
    assert.strictEqual(spec.model, 'openrouter/anthropic/claude-sonnet-4.5');
    assert.strictEqual(spec.env.OPENROUTER_API_KEY, 'sk-or-row0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Legacy flat-key project (no PI_MODELS array at all) — piEntryForModel() has nothing to
// match against, so the C1122 override is a no-op and the C1101 flat-key path is unchanged.
test('PiAgent.getSpawnSpec: legacy flat-key project (no PI_MODELS) is unaffected by the C1122 override', async () => {
  const dir = makeProjectDir({ OPENROUTER_API_KEY: 'sk-or-legacy', PI_MODEL: 'openrouter/anthropic/claude-3.5-sonnet' });
  try {
    const agent = new PiAgent();
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir });
    assert.strictEqual(spec.model, 'openrouter/anthropic/claude-3.5-sonnet');
    assert.strictEqual(spec.env.OPENROUTER_API_KEY, 'sk-or-legacy');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A project re-configured through the new wizard should use its new PI_MODELS row 0,
// not a stale flat OPENROUTER_API_KEY left over from an earlier (pre-C1121) pass.
test('PiAgent.getSpawnSpec: PI_MODELS row 0 wins over a stale legacy OPENROUTER_API_KEY', async () => {
  const dir = makeProjectDir({
    OPENROUTER_API_KEY: 'sk-or-stale',
    PI_MODELS: [{ model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'sk-or-fresh' }],
  });
  try {
    const agent = new PiAgent();
    const spec = await agent.getSpawnSpec(FAKE_CONFIG, 'Work on task C1.', 'C1', { projectPath: dir });
    assert.strictEqual(spec.env.OPENROUTER_API_KEY, 'sk-or-fresh');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.buildPrompt: documents Pi no-MCP constraint and approval gate', () => {
  const agent = new PiAgent();
  const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'] });

  assert.match(prompt, /Pi built-in shell\/read\/edit tools only/);
  // (C1116) No longer "end with exactly \"Plan ready.\"" — that phrasing, echoed verbatim into
  // Pi's own TUI, was itself matched by the pre-C1116 unanchored /\bplan ready\b/i pattern,
  // firing the ready dialog before Pi had studied anything. See prompt-detect.js's
  // PI_PLAN_READY_PATTERNS and this file's own comment on the instruction wording.
  assert.match(prompt, /by itself with nothing else on that line, write exactly the words Plan ready\./);
  assert.match(prompt, /Read ai\/architecture\/\{tag\}\.md/);
  assert.match(prompt, /Do the thing\./);

  // (C1119) Pi has no MCP by upstream design — the prompt must say so explicitly, not just
  // "not available", so a small model stops reporting the missing MCP server as a bug.
  assert.match(prompt, /Pi has NO MCP support at all/);
  assert.match(prompt, /is NOT a bug/);
  assert.match(prompt, /never read or edit `?\.mcp\.json`?/);
  // Pi auto-loads AGENTS.md/CLAUDE.md (resource-loader.js), which are written for MCP-capable
  // agents — the prompt must name that source and supersede it explicitly.
  assert.match(prompt, /AGENTS\.md \/ CLAUDE\.md/);
  assert.match(prompt, /"MCP Tool Schemas" section/);
  for (const tool of [
    'list_system_tags', 'get_project_tags', 'get_tag_architecture', 'get_tag_architectures',
    'create_system_tag', 'batch_grep_tags', 'list_tasks', 'get_task', 'create_task',
    'update_task', 'create_task_comment', 'push_knowledge',
  ]) {
    assert.ok(prompt.includes(tool), `expected superseded-tool list to include ${tool}`);
  }
});

// (C1353) The file task backend is retired and buildPrompt() no longer branches on backend
// type at all — the Tipatask REST recipe is unconditional now. These tests keep an explicit
// projectPath (a .tipatask/config.json) only because other prompt content (status names,
// language directive) reads project config; TASK_BACKEND itself is inert. See the coercion
// regression tests below for the historical "file" → "api" migration path.
test('PiAgent.buildPrompt: api backend gets the full Tipatask REST recipe keyed on $TIPATASK_TASK_ID', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir });

    assert.match(prompt, /TIPATASK_TOOL_SCRIPT/);
    assert.match(prompt, /tt GET "\/tasks\/\$TIPATASK_TASK_ID"/);
    assert.match(prompt, /tt complete "\$TIPATASK_TASK_ID"/);
    assert.match(prompt, /tt verify "\$TIPATASK_TASK_ID"/);
    assert.doesNotMatch(prompt, /Authorization: Bearer|AUTH=/);
    assert.match(prompt, /pending \| in_progress \| on_fire \| completed \| canceled/);
    // Regression guards: the old prompt made the model fill in <task_key> itself, and carried
    // a stray caveman-mode reference even though Pi never runs in caveman mode.
    assert.doesNotMatch(prompt, /<task_key>/);
    assert.doesNotMatch(prompt, /caveman/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (C1352/C1353) The file task backend is retired and its prompt branch deleted outright — this
// used to assert the file-mode prompt and now locks in the opposite: a stale "file" project
// config must still get the full api REST recipe, never the old TODO.md framing.
test('PiAgent.buildPrompt: a legacy TASK_BACKEND="file" project config still gets the api REST block (retired-backend coercion)', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'file' });
  try {
    const agent = new PiAgent();
    const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir });

    assert.match(prompt, /API_BASE_URL/);
    assert.match(prompt, /TIPATASK_TOOL_SCRIPT/);
    assert.match(prompt, /```sh/);
    assert.doesNotMatch(prompt, /task status lives in ai\/TODO\.md/);
    // No-MCP framing is backend-independent — Pi never has MCP regardless of task backend.
    assert.match(prompt, /Pi has NO MCP support at all/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.buildPrompt: api path carries the status/tag-review/KB rules Claude and Codex have', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir });

    assert.match(prompt, /PATCH status to in_progress as soon as you start implementing/);
    assert.match(prompt, /Re-GET the task afterwards to confirm the saved status/);
    assert.match(prompt, /POST \/tags to register it.*then create the ai\/architecture\/tt-\*\.md stub/s);
    assert.match(prompt, /400 "tags not registered"/);
    assert.match(prompt, /Never write ai\/ARCHITECTURE\.md/);
    assert.match(prompt, /Require completed:true; never use a status PATCH instead/);
    assert.match(prompt, /nothing auto-pushes your ai\/architecture\/\*\.md edits/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (C1119/C1116/C1117) The whole prompt is echoed verbatim into Pi's own TUI, and both
// prompt-detect.js consumers scan that echo for dialog/plan-ready signals. A false hit here
// would fire the plan-ready dialog (or worse, an mcpTrust/toolApproval auto-answer) before Pi
// has done anything — exactly the C1116 regression. Covers both the line-scoped consumer
// (BaseTaskAgent#isPromptLine, via matchPromptLine) and the tail-scoped one
// (terminal-session.js#getAttentionPromptMatch, reconstructed here via buildLegacyPatternTable()
// since terminal-session.js itself requires node-pty at module load and can't be required in a
// plain node:test file). The tail-scoped table strips `dialogOnly`, so ordinary prose is NOT
// exempt there — this is what keeps a future "do you want to …?"-shaped edit out of this file.
test('PiAgent.buildPrompt: no line of the kickoff prompt can false-trigger the attention/plan-ready detectors', (t) => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    // (C1134) Both variants — a discovery task appends PI_DISCOVERY_MANDATE — must stay clean.
    for (const discovery of [false, true]) {
      const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir, discovery });

      for (const line of prompt.split('\n')) {
        assert.equal(matchPromptLine(line, PI_PROMPT_PATTERNS), null, `[discovery=${discovery}] PI table matched: ${line}`);
        assert.equal(matchPromptLine(line, GENERIC_PROMPT_PATTERNS), null, `[discovery=${discovery}] generic table matched: ${line}`);
      }
      for (const { re, agents } of buildLegacyPatternTable()) {
        if (agents && !agents.includes('pi')) continue;
        assert.ok(!re.test(prompt), `[discovery=${discovery}] tail-scoped pattern matched the prompt: ${re}`);
      }
      assert.doesNotMatch(prompt, /^[\s>│┃╎┆❯➤▶›*]*plan ready[.!]?\s*$/im);
      // (C1134) Same echo-safety guard for the new question sentinel.
      assert.doesNotMatch(prompt, /^[\s>│┃╎┆❯➤▶›*]*questions ready[.!]?\s*$/im);

      // PTY-echoed prompt for small/cheap OpenRouter models — keep growth bounded. Ceiling
      // raised 8000 -> 8500 for C1566's compact process-safety directive, then 8500 -> 9000
      // for C1542's unconditional compact KB-hygiene directive (same reasoning: always
      // present, pushing the discovery/blank-tag variants past the old ceiling), then
      // 9000 -> 9300 for the unconditional compact resource-limits directive; still leaves
      // headroom (worst measured case ~9100 chars) without inviting unbounded growth.
      t.diagnostic(`Pi basic/discovery=${discovery}: ${prompt.length} / 9300`);
      assert.ok(prompt.length < 9300, `[discovery=${discovery}] prompt grew to ${prompt.length} chars`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (C1134/C1217, migrated onto the shared helper by C1528) Pi has no AskUserQuestion tool —
// buildPrompt() must give it a working substitute on every task (now BaseTaskAgent's shared
// buildClarifyDirective({ compact: true }), not a private Pi-only const), and a stronger
// "ground yourself first" mandate only when the task is tagged 'discovery' (seed-setup-tasks.js's
// discoveryBlock() — preset-A/B starter tasks). Structural checks (does the prompt contain the
// live compact directive, does it NOT contain the full variant) survive a future reword of
// buildClarifyDirective() itself — see clarify-prompt.test.js for content assertions on the
// directive's own wording (lettered options, sentinel, etc).
test('PiAgent.buildPrompt: clarify directive is present on every task (compact, not full); discovery mandate only when opts.discovery is true', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const base = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir });
    const discovery = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir, discovery: true });

    assert.ok(base.includes(agent.buildClarifyDirective({ compact: true })), 'compact clarify directive must be present verbatim');
    assert.ok(!base.includes(agent.buildClarifyDirective()), 'full clarify directive must NOT be present — Pi uses compact only');
    assert.match(base, /Questions ready\./);
    assert.doesNotMatch(base, /This is a discovery task/);

    assert.match(discovery, /This is a discovery task/);
    assert.match(discovery, /GET \/tasks\/<key>\/comments curls above/);
    assert.match(discovery, /overrides the earlier instruction to write the plan immediately/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// (C1217) A representative Pi question turn (intro + numbered questions + lettered option rows
// + trailing sentinel) must never false-trigger the attention/plan-ready detectors on any of its
// own rows, while the sentinel row itself must still fire. This is the actual OUTPUT shape the
// C1217 prompt extension asks Pi to produce, not the kickoff prompt's own text (that's covered
// separately by the "no line...can false-trigger" test below).
test('PiAgent question turn shape (lettered options + sentinel): options never false-trigger, sentinel still fires', () => {
  const turn = [
    'Answer with letters like 1A 2C or type your own wording.',
    '1. Which storage backend should the importer write to?',
    '   A) The existing Tipatask REST API',
    '   B) A local ai/TODO.md file',
    '   C) Something else — describe it',
    '2. How should duplicate rows be handled?',
    '   A) Skip silently',
    '   B) Overwrite the existing row',
    '   C) Something else — describe it',
    'Questions ready.',
  ];
  for (const line of turn.slice(0, -1)) {
    assert.equal(matchPromptLine(line, PI_PROMPT_PATTERNS), null, `option/question row false-triggered PI table: ${line}`);
    assert.equal(matchPromptLine(line, GENERIC_PROMPT_PATTERNS), null, `option/question row false-triggered generic table: ${line}`);
  }
  for (const { re, agents } of buildLegacyPatternTable()) {
    if (agents && !agents.includes('pi')) continue;
    assert.ok(!re.test(turn.slice(0, -1).join('\n')), `tail-scoped pattern matched the option block: ${re}`);
  }
  const sentinel = matchPromptLine(turn.at(-1), PI_PROMPT_PATTERNS);
  assert.ok(sentinel, 'sentinel row must still match');
  assert.equal(sentinel.kind, 'attention');
});

// (C1352/C1353) Same as above: a legacy "file" project config's discovery mandate now points
// at the GET /tasks curl, never the old ai/TODO.md framing.
test('PiAgent.buildPrompt: discovery mandate on a legacy TASK_BACKEND="file" project config points at GET /tasks, never ai/TODO.md', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'file' });
  try {
    const agent = new PiAgent();
    const prompt = agent.buildPrompt('Do the thing.', { taskTags: ['tt-pi-session'], projectPath: dir, discovery: true });
    assert.match(prompt, /This is a discovery task/);
    assert.match(prompt, /GET \/tasks/);
    assert.doesNotMatch(prompt, /Then read ai\/TODO\.md for the other tasks/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent#getApprovalText: allows follow-up questions instead of forbidding them (C1134)', () => {
  const agent = new PiAgent();
  const text = agent.getApprovalText();
  assert.doesNotMatch(text, /do not re-plan or ask again/);
  assert.match(text, /ask them now with the numbered-list mechanism/);
  assert.doesNotMatch(text, /\n/, 'must stay single-line — sent inside a bracketed-paste frame');
});

// ── Plan-approval submission (C1117) ──
// Reported bug: clicking Proceed with Implementation on a Pi terminal painted a
// whitespace-padded approval line plus a stray "<|sep|>" and Pi never implemented anything.
// Root cause (see tt-pi-session.md § Plan approval PTY protocol): the padding/token were Pi's
// OWN rendering of a message that WAS submitted — a leaked Kimi K3 chat-template separator
// token came back as the entire model reply. These tests cover the hardening this task adds
// around that proven-working PTY path: atomic bracketed-paste submission gated on PTY
// quiescence (never blind-write into a live Pi stream), and the stall-detection hooks that
// let terminal-session.js's watchdog notice + retry a degenerate reply like that one.

test('PiAgent#_submitApproval: writes a bracketed-paste frame, then waits for quiescence again before Enter', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const agent = new PiAgent();
    const writes = [];
    const session = { pty: null, lastOutputAt: 0 };
    session.pty = {
      write: (data) => {
        writes.push(data);
        // Simulate Pi's TUI echoing the pasted text right after it lands — the write must
        // NOT be followed by Enter until that echo goes quiet again too.
        if (data.startsWith('\x1b[200~')) session.lastOutputAt = Date.now();
      },
    };
    session.lastOutputAt = Date.now(); // PTY just produced output — forces the initial wait

    agent._submitApproval(session, 'approved text');

    // Drive the 100ms idle-poll past getPasteSilenceMs() (400ms default) twice: once before
    // the paste write is allowed, once again after the simulated post-paste echo.
    for (let i = 0; i < 12; i++) t.mock.timers.tick(100);

    assert.deepStrictEqual(writes, ['\x1b[200~approved text\x1b[201~', '\r']);
  } finally {
    t.mock.timers.reset();
  }
});

test('PiAgent#_submitApproval: writes nothing while the PTY is still noisy', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const agent = new PiAgent();
    const writes = [];
    const session = { pty: { write: (data) => writes.push(data) }, lastOutputAt: Date.now() };

    agent._submitApproval(session, 'approved text');

    // Keep "resetting" lastOutputAt to simulate a continuously-repainting TUI — idle never
    // reaches getPasteSilenceMs() until the ceiling in _submitApproval forces it through.
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(100);
      session.lastOutputAt = Date.now();
    }
    assert.deepStrictEqual(writes, [], 'no write while the PTY keeps producing fresh output');
  } finally {
    t.mock.timers.reset();
  }
});

test('PiAgent#approvalStalled: flags a leaked chat-template token in the post-approval tail', () => {
  const agent = new PiAgent();
  assert.strictEqual(
    agent.approvalStalled({}, { growthBytes: 500, tail: 'some output\n <|sep|>\nmore', idleMs: 500 }),
    true,
  );
  assert.strictEqual(
    agent.approvalStalled({}, { growthBytes: 500, tail: 'normal assistant reply text', idleMs: 500 }),
    false,
  );
});

test('PiAgent#approvalStalled: flags near-zero PTY growth once idle, but not a real turn', () => {
  const agent = new PiAgent();
  // Below the 40-byte floor and idle past getPasteSilenceMs() — the model answered with
  // nothing usable and the PTY went quiet again.
  assert.strictEqual(
    agent.approvalStalled({}, { growthBytes: 10, tail: '', idleMs: 1000 }),
    true,
  );
  // A real turn renders far more than the floor.
  assert.strictEqual(
    agent.approvalStalled({}, { growthBytes: 4000, tail: '', idleMs: 1000 }),
    false,
  );
  // Still mid-turn (not idle yet) — too early to call it stalled even if growth is low so far.
  assert.strictEqual(
    agent.approvalStalled({}, { growthBytes: 10, tail: '', idleMs: 50 }),
    false,
  );
});

test('PiAgent#retryApproval: fires at most once per session', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const agent = new PiAgent();
    const writes = [];
    const session = { pty: { write: (data) => writes.push(data) }, lastOutputAt: Date.now() };

    agent.retryApproval(session);
    for (let i = 0; i < 12; i++) t.mock.timers.tick(100);
    assert.strictEqual(writes.length, 2, 'first retry submits (bracketed-paste + Enter)');
    assert.strictEqual(session._piApprovalRetried, true);

    agent.retryApproval(session);
    for (let i = 0; i < 12; i++) t.mock.timers.tick(100);
    assert.strictEqual(writes.length, 2, 'a second retryApproval() call is a no-op');
  } finally {
    t.mock.timers.reset();
  }
});

// (C1184) Statuses are per-project custom now — buildPrompt must render the PROJECT'S
// actual role names when opts.statusRoles/statusNames are threaded through (as
// terminal-session.js now does), not the hardcoded legacy literals.
test('PiAgent.buildPrompt: renamed project statuses render everywhere a status name appears', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const opts = {
      taskTags: ['tt-pi-session'],
      projectPath: dir,
      statusRoles: { start: 'Backlog', in_progress: 'Doing', complete: 'Shipped' },
      statusNames: ['Backlog', 'Doing', 'on_fire', 'Shipped', 'canceled'],
    };
    const prompt = agent.buildPrompt('Do the thing.', opts);

    assert.match(prompt, /'\{"status":"Doing"\}' \| tt PATCH/);
    assert.match(prompt, /Backlog \| Doing \| on_fire \| Shipped \| canceled/);
    assert.match(prompt, /\/tasks\?status=Backlog&fields=summary&limit=20/);
    assert.match(prompt, /PATCH status to Doing as soon as you start implementing/);
    assert.match(prompt, /tt complete for Shipped — or on_fire if this task is blocked —/);
    assert.match(prompt, /MANDATORY before marking this task Shipped/);
    assert.match(prompt, /Require completed:true; never use a status PATCH instead/);
    // The legacy literals must not leak through once real roles are supplied.
    assert.doesNotMatch(prompt, /"status":"in_progress"/);
    assert.doesNotMatch(prompt, /MANDATORY before marking this task completed/);

    // Echo-safety must hold for the renamed-status rendering too — this is the same
    // guard the "no line can false-trigger" test above runs, re-applied here because
    // this test is the one that varies the interpolated data.
    for (const line of prompt.split('\n')) {
      assert.equal(matchPromptLine(line, PI_PROMPT_PATTERNS), null, `PI table matched: ${line}`);
      assert.equal(matchPromptLine(line, GENERIC_PROMPT_PATTERNS), null, `generic table matched: ${line}`);
    }
    for (const { re, agents } of buildLegacyPatternTable()) {
      if (agents && !agents.includes('pi')) continue;
      assert.ok(!re.test(prompt), `tail-scoped pattern matched the prompt: ${re}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PiAgent.buildPrompt: a project that removed on_fire entirely drops the "or on_fire" clause', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const opts = {
      taskTags: ['tt-pi-session'],
      projectPath: dir,
      statusRoles: { start: 'Backlog', in_progress: 'Doing', complete: 'Shipped' },
      statusNames: ['Backlog', 'Doing', 'Shipped'], // no on_fire
    };
    const prompt = agent.buildPrompt('Do the thing.', opts);
    assert.doesNotMatch(prompt, /or on_fire if you are leaving it broken/);
    assert.match(prompt, /PATCH status to Doing as soon as you start implementing \(right after plan approval\), and use tt complete for Shipped before your final message/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Pi assembled kickoff uses REST and compact rules without embedding the static bundle', () => {
  const dir = makeProjectDir({ TASK_BACKEND: 'api' });
  try {
    const agent = new PiAgent();
    const prompt = agent.buildPrompt('TASK_MARKER', { projectPath: dir });
    assert.match(prompt, /Pi has NO MCP/);
    assert.match(prompt, /POST .*comments/);
    assert.match(prompt, /PATCH .*tasks/);
    assert.doesNotMatch(prompt, /ensure_project_tag|list_task_resolutions|thousands of runaway/);
    assert.doesNotMatch(prompt, /━━ STATIC CONTEXT/);
    assert.ok(prompt.length < 9300);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
