'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

// The account store defaults to USER_DATA_ROOT; keep this file's writes in a private dir.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-pc-userdata-'));
const { readAccount } = require('./account-store');

const { migrateFromLegacy, readProjectConfig, writeProjectConfig, writeProjectMcpConfig, writeProjectClaudeMcpApproval, PI_MAX_MODELS, PI_PROVIDERS, PI_DEFAULT_PROVIDER, PI_CUSTOM_PROVIDER, PI_CUSTOM_APIS, PI_CUSTOM_DEFAULT_API, normalizePiProvider, normalizePiBaseUrl, normalizePiApi, isPiCustomEntry, piProviderEnv, piKeyEnvVars, piConfiguredModelIds, sanitizePiModels, readPiEntries, piDefaultEntry, piEntryForModel, recordLastUsedAgent, buildAgentsConfigPatch, summarizeAgents, rendererProjectConfig, rendererPiModels, mergeRendererProjectConfig } = require('./project-config');

test('plain Node project config import never loads the Electron package', () => {
  const modulePath = require.resolve('./project-config');
  const script = `
    const Module = require('node:module');
    const load = Module._load;
    let electronLoads = 0;
    Module._load = function(request, ...args) {
      if (request === 'electron') {
        electronLoads++;
        return { app: { isPackaged: true } };
      }
      return load.call(this, request, ...args);
    };
    require(${JSON.stringify(modulePath)});
    process.stdout.write(String(electronLoads));
  `;
  const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.strictEqual(output, '0');
});

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-project-config-'));
  fs.mkdirSync(path.join(root, 'ai', 'todo', 'server'), { recursive: true });
  return root;
}

function writeLegacyEnv(root, content) {
  fs.writeFileSync(path.join(root, 'ai', 'todo', 'server', '.env'), content, 'utf8');
}

test('migrateFromLegacy creates config and removes credential keys from legacy .env', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeLegacyEnv(root, [
    '# keep this comment',
    'TASK_BACKEND=api',
    'API_BASE_URL=https://example.test/',
    'API_TOKEN=legacy-token',
    'API_PROJECT_ID=7',
    'TASK_AGENT=codex',
    '',
  ].join('\n'));

  const migrated = migrateFromLegacy(root);
  assert.ok(migrated);
  const cfg = readProjectConfig(root);
  assert.strictEqual(cfg.API_BASE_URL, 'https://example.test/');
  assert.ok(!Object.hasOwn(cfg, 'API_TOKEN'), 'the token goes to the account store, never config.json');
  assert.strictEqual(readAccount('https://example.test').token, 'legacy-token');
  assert.strictEqual(cfg.API_PROJECT_ID, '7');
  assert.strictEqual(cfg.TASK_AGENT, 'codex');

  const env = fs.readFileSync(path.join(root, 'ai', 'todo', 'server', '.env'), 'utf8');
  assert.match(env, /# keep this comment/);
  assert.match(env, /TASK_BACKEND=api/);
  assert.match(env, /TASK_AGENT=codex/);
  assert.doesNotMatch(env, /^API_(?:BASE_URL|TOKEN|PROJECT_ID)=/m);
  assert.strictEqual(migrateFromLegacy(root), null, 'second run should be idempotent');
});

test('existing config wins while stale legacy credentials are removed', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api',
    API_BASE_URL: 'https://live.example.test',
    API_TOKEN: 'live-token',
    API_PROJECT_ID: '2',
  }));
  writeLegacyEnv(root, [
    'TASK_BACKEND=api',
    'API_BASE_URL=https://stale.example.test',
    'API_TOKEN=stale-token',
    'API_PROJECT_ID=999',
    'PORT=4455',
    '',
  ].join('\n'));

  assert.ok(migrateFromLegacy(root));
  const cfg = readProjectConfig(root);
  assert.strictEqual(cfg.API_BASE_URL, 'https://live.example.test');
  assert.equal(cfg.API_TOKEN, undefined);
  assert.equal(readAccount('https://live.example.test').token, 'live-token');
  assert.strictEqual(cfg.API_PROJECT_ID, '2');

  const env = fs.readFileSync(path.join(root, 'ai', 'todo', 'server', '.env'), 'utf8');
  assert.strictEqual(env, 'TASK_BACKEND=api\nPORT=4455\n');
});

test('existing config backfills absent credentials before sanitizing legacy .env', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api',
    API_TOKEN: '',
  }));
  writeLegacyEnv(root, [
    'API_BASE_URL=https://example.test',
    'API_TOKEN=must-not-revive-explicit-blank',
    'API_PROJECT_ID=3',
    '',
  ].join('\n'));

  const previousAccount = readAccount('https://example.test');
  migrateFromLegacy(root);
  const cfg = readProjectConfig(root);
  assert.strictEqual(cfg.API_BASE_URL, 'https://example.test');
  assert.strictEqual(cfg.API_PROJECT_ID, '3');
  assert.ok(!Object.hasOwn(cfg, 'API_TOKEN'));
  assert.deepEqual(readAccount('https://example.test'), previousAccount, 'legacy blank never signs out another project or revives stale fallback');
  assert.strictEqual(
    fs.readFileSync(path.join(root, 'ai', 'todo', 'server', '.env'), 'utf8').trim(),
    ''
  );
});

// ── C1121: sanitizePiModels() / readPiEntries() / piDefaultEntry() ──────────

test('sanitizePiModels accepts the legacy {piModel,piApiKey} scalar shape', () => {
  assert.deepStrictEqual(sanitizePiModels({ piModel: '  m1  ', piApiKey: ' k1 ' }), [{ model: 'm1', apiKey: 'k1' }]);
  assert.deepStrictEqual(sanitizePiModels({ piModel: '', piApiKey: '' }), []);
  assert.deepStrictEqual(sanitizePiModels(undefined), []);
});

test('sanitizePiModels accepts {piModels:[...]} and a bare array, trims, drops incomplete rows', () => {
  assert.deepStrictEqual(
    sanitizePiModels({ piModels: [{ model: ' m1 ', apiKey: ' k1 ' }, { model: 'm2', apiKey: '' }, { model: '', apiKey: 'k3' }] }),
    [{ model: 'm1', apiKey: 'k1' }]
  );
  assert.deepStrictEqual(
    sanitizePiModels([{ model: 'm1', apiKey: 'k1' }, { model: 'm2', apiKey: 'k2' }]),
    [{ model: 'm1', apiKey: 'k1' }, { model: 'm2', apiKey: 'k2' }]
  );
});

test('sanitizePiModels de-dupes by case-insensitive model id, first row wins', () => {
  const rows = sanitizePiModels({ piModels: [
    { model: 'openrouter/x/m', apiKey: 'first' },
    { model: 'OpenRouter/X/M', apiKey: 'second' },
  ] });
  assert.deepStrictEqual(rows, [{ model: 'openrouter/x/m', apiKey: 'first' }]);
});

test('sanitizePiModels caps at PI_MAX_MODELS (8)', () => {
  const piModels = Array.from({ length: 12 }, (_, i) => ({ model: `m${i}`, apiKey: `k${i}` }));
  const rows = sanitizePiModels({ piModels });
  assert.strictEqual(PI_MAX_MODELS, 8);
  assert.strictEqual(rows.length, 8);
  assert.deepStrictEqual(rows[7], { model: 'm7', apiKey: 'k7' });
});

test('readPiEntries/piDefaultEntry read PI_MODELS off a config object', () => {
  assert.deepStrictEqual(readPiEntries(null), []);
  assert.deepStrictEqual(readPiEntries({}), []);
  const cfg = { PI_MODELS: [{ model: 'm1', apiKey: 'k1' }, { model: 'm2', apiKey: 'k2' }] };
  assert.deepStrictEqual(readPiEntries(cfg), [{ model: 'm1', apiKey: 'k1' }, { model: 'm2', apiKey: 'k2' }]);
  assert.deepStrictEqual(piDefaultEntry(cfg), { model: 'm1', apiKey: 'k1' });
  assert.strictEqual(piDefaultEntry({}), null);
});

// ── C1122: piEntryForModel() ──────────────────────────────────────────────
test('piEntryForModel finds a row by exact model id', () => {
  const cfg = { PI_MODELS: [{ model: 'm1', apiKey: 'k1' }, { model: 'm2', apiKey: 'k2' }] };
  assert.deepStrictEqual(piEntryForModel(cfg, 'm2'), { model: 'm2', apiKey: 'k2' });
  assert.deepStrictEqual(piEntryForModel(cfg, 'm1'), { model: 'm1', apiKey: 'k1' });
});

test('piEntryForModel matches case- and whitespace-insensitively', () => {
  const cfg = { PI_MODELS: [{ model: 'openrouter/Anthropic/Claude-3.5-Sonnet', apiKey: 'k1' }] };
  assert.deepStrictEqual(
    piEntryForModel(cfg, '  openrouter/anthropic/claude-3.5-sonnet  '),
    { model: 'openrouter/Anthropic/Claude-3.5-Sonnet', apiKey: 'k1' },
  );
});

test('piEntryForModel returns null on miss, null cfg, or a project with no PI_MODELS', () => {
  const cfg = { PI_MODELS: [{ model: 'm1', apiKey: 'k1' }] };
  assert.strictEqual(piEntryForModel(cfg, 'nope'), null);
  assert.strictEqual(piEntryForModel(cfg, ''), null);
  assert.strictEqual(piEntryForModel(cfg, null), null);
  assert.strictEqual(piEntryForModel(null, 'm1'), null);
  assert.strictEqual(piEntryForModel({}, 'm1'), null);
});

// ── C1131: recordLastUsedAgent() ────────────────────────────────────────────

function configPath(root) {
  return path.join(root, '.tipatask', 'config.json');
}

function initConfig(root, cfg) {
  writeProjectConfig(root, cfg);
}

test('recordLastUsedAgent writes LAST_AGENT for claude/codex/pi and round-trips', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initConfig(root, { TASK_AGENT: 'claude' });

  assert.strictEqual(recordLastUsedAgent(root, 'codex', ''), true);
  assert.strictEqual(readProjectConfig(root).LAST_AGENT, 'codex');

  assert.strictEqual(recordLastUsedAgent(root, 'pi', ''), true);
  assert.strictEqual(readProjectConfig(root).LAST_AGENT, 'pi');
});

test('recordLastUsedAgent is idempotent — repeating the same combination performs no write', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initConfig(root, { TASK_AGENT: 'claude' });

  assert.strictEqual(recordLastUsedAgent(root, 'claude', 'opusplan'), true);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(configPath(root), past, past);
  const mtimeBefore = fs.statSync(configPath(root)).mtimeMs;

  assert.strictEqual(recordLastUsedAgent(root, 'claude', 'opusplan'), false, 'unchanged combination must not write');
  assert.strictEqual(fs.statSync(configPath(root)).mtimeMs, mtimeBefore);
});

test('recordLastUsedAgent returns false and creates nothing when the project has no config.json', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.strictEqual(recordLastUsedAgent(root, 'claude', 'opusplan'), false);
  assert.strictEqual(fs.existsSync(path.join(root, '.tipatask')), false, 'must not materialize .tipatask/ for an unconfigured project');
});

test('recordLastUsedAgent: claude/codex write CLAUDE_MODEL/CODEX_MODEL; blank model leaves them untouched', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initConfig(root, { TASK_AGENT: 'claude', CLAUDE_MODEL: 'opusplan' });

  recordLastUsedAgent(root, 'claude', 'claude-opus-5');
  assert.strictEqual(readProjectConfig(root).CLAUDE_MODEL, 'claude-opus-5');

  recordLastUsedAgent(root, 'codex', '');
  assert.strictEqual(readProjectConfig(root).CODEX_MODEL, undefined, 'blank model must not write CODEX_MODEL');

  recordLastUsedAgent(root, 'codex', 'o4-mini');
  assert.strictEqual(readProjectConfig(root).CODEX_MODEL, 'o4-mini');
  // claude/codex writes never touch PI_MODELS.
  assert.strictEqual(readProjectConfig(root).PI_MODELS, undefined);
});

test('recordLastUsedAgent: pi moves the matching row to index 0, preserving every row losslessly', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initConfig(root, {
    TASK_AGENT: 'pi',
    PI_MODELS: [
      { model: 'm0', apiKey: 'k0' },
      { model: 'm1', apiKey: 'k1' },
      { model: 'm2', apiKey: 'k2' },
    ],
  });

  recordLastUsedAgent(root, 'pi', 'm2');
  assert.deepStrictEqual(readProjectConfig(root).PI_MODELS, [
    { model: 'm2', apiKey: 'k2' },
    { model: 'm0', apiKey: 'k0' },
    { model: 'm1', apiKey: 'k1' },
  ]);
});

test('recordLastUsedAgent: pi row already at index 0 is a no-op write', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // LAST_AGENT pre-seeded to 'pi' so the calls below have nothing left to change —
  // otherwise the first call would legitimately write LAST_AGENT for the first time.
  initConfig(root, { TASK_AGENT: 'pi', LAST_AGENT: 'pi', PI_MODELS: [{ model: 'm0', apiKey: 'k0' }, { model: 'm1', apiKey: 'k1' }] });

  assert.strictEqual(recordLastUsedAgent(root, 'pi', 'm0'), false);
  assert.strictEqual(recordLastUsedAgent(root, 'pi', '  M0  '), false, 'case/whitespace-insensitive match against row 0');
});

test('recordLastUsedAgent: pi model absent from PI_MODELS leaves PI_MODELS byte-identical, still records LAST_AGENT', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = [{ model: 'm0', apiKey: 'k0' }, { model: 'm1', apiKey: 'k1' }];
  initConfig(root, { TASK_AGENT: 'claude', PI_MODELS: rows });

  assert.strictEqual(recordLastUsedAgent(root, 'pi', 'unknown-model'), true);
  const cfg = readProjectConfig(root);
  assert.strictEqual(cfg.LAST_AGENT, 'pi');
  assert.deepStrictEqual(cfg.PI_MODELS, rows, 'unknown model id must never fabricate or reorder a row');
  assert.strictEqual(cfg.PI_MODEL, undefined, 'must not create a legacy flat key alongside a real PI_MODELS array');
});

test('recordLastUsedAgent: pi reorder survives a malformed row (blank apiKey) instead of dropping it', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initConfig(root, {
    TASK_AGENT: 'pi',
    PI_MODELS: [
      { model: 'm0', apiKey: 'k0' },
      { model: 'm1', apiKey: '' }, // sanitizePiModels() would normally drop this row
    ],
  });

  recordLastUsedAgent(root, 'pi', 'm1');
  assert.deepStrictEqual(readProjectConfig(root).PI_MODELS, [
    { model: 'm1', apiKey: '' },
    { model: 'm0', apiKey: 'k0' },
  ], 'raw reorder must not run the malformed row through the sanitizer');
});

test('recordLastUsedAgent: legacy flat-PI_MODEL project (no PI_MODELS array) updates the flat field', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initConfig(root, { TASK_AGENT: 'pi', PI_MODEL: 'old-model', OPENROUTER_API_KEY: 'sk-only-key' });

  recordLastUsedAgent(root, 'pi', 'new-model');
  const cfg = readProjectConfig(root);
  assert.strictEqual(cfg.PI_MODEL, 'new-model');
  assert.strictEqual(cfg.OPENROUTER_API_KEY, 'sk-only-key', 'the single legacy key is left alone');
  assert.strictEqual(cfg.PI_MODELS, undefined, 'must not fabricate an array for a legacy project');
});

test('recordLastUsedAgent preserves unrelated keys (API_TOKEN, AVAILABLE_AGENTS, theme, language)', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initConfig(root, {
    TASK_AGENT: 'claude',
    API_BASE_URL: 'https://preserve.test', API_TOKEN: 'secret-token',
    AVAILABLE_AGENTS: 'claude,codex,pi',
    theme: 'blueish',
    language: 'uk',
  });

  recordLastUsedAgent(root, 'codex', 'o4-mini');
  const cfg = readProjectConfig(root);
  assert.strictEqual(cfg.API_TOKEN, undefined);
  assert.strictEqual(require('./account-store').readAccount('https://preserve.test').token, 'secret-token');
  assert.strictEqual(cfg.AVAILABLE_AGENTS, 'claude,codex,pi');
  assert.strictEqual(cfg.theme, 'blueish');
  assert.strictEqual(cfg.language, 'uk');
});

test('recordLastUsedAgent never throws — falsy projectRoot/agentId are no-ops', () => {
  assert.doesNotThrow(() => recordLastUsedAgent('', 'claude', 'x'));
  assert.doesNotThrow(() => recordLastUsedAgent(null, 'claude', 'x'));
  assert.strictEqual(recordLastUsedAgent('', 'claude', 'x'), false);
  assert.strictEqual(recordLastUsedAgent('/tmp/definitely-not-a-project-root', '', 'x'), false);
});

// ── buildAgentsConfigPatch / summarizeAgents (C1124) ──────────────────────────

test('buildAgentsConfigPatch dedupes availableAgents, forces taskAgent into the list, sets LAST_AGENT to match', () => {
  const patch = buildAgentsConfigPatch({ TASK_BACKEND: 'api' }, {
    taskAgent: 'codex',
    availableAgents: ['claude', 'codex', 'claude'],
  });
  assert.strictEqual(patch.TASK_AGENT, 'codex');
  assert.strictEqual(patch.AVAILABLE_AGENTS, 'claude,codex');
  assert.strictEqual(patch.LAST_AGENT, 'codex', 'must mirror TASK_AGENT so it is not shadowed by a stale LAST_AGENT (C1131 precedence)');
  assert.strictEqual(patch.TASK_BACKEND, 'api', 'unrelated existing keys survive');
});

test('buildAgentsConfigPatch falls back taskAgent to the first available agent, and pushes an unlisted taskAgent into availableAgents', () => {
  const p1 = buildAgentsConfigPatch({}, { taskAgent: '', availableAgents: ['codex'] });
  assert.strictEqual(p1.TASK_AGENT, 'codex');
  const p2 = buildAgentsConfigPatch({}, { taskAgent: 'pi', availableAgents: ['claude'] });
  assert.strictEqual(p2.TASK_AGENT, 'pi');
  assert.strictEqual(p2.AVAILABLE_AGENTS, 'claude,pi');
});

test('buildAgentsConfigPatch: empty selection clears TASK_AGENT/AVAILABLE_AGENTS and leaves LAST_AGENT untouched', () => {
  const patch = buildAgentsConfigPatch({ LAST_AGENT: 'codex' }, {});
  assert.strictEqual(patch.TASK_AGENT, '');
  assert.strictEqual(patch.AVAILABLE_AGENTS, '');
  assert.strictEqual(patch.LAST_AGENT, 'codex', 'nothing enabled — must not clobber an existing LAST_AGENT');
});

test('buildAgentsConfigPatch: pi enabled with rows writes PI_MODELS and migrates off the legacy flat pair', () => {
  const existing = { PI_MODEL: 'old-model', OPENROUTER_API_KEY: 'old-key' };
  const patch = buildAgentsConfigPatch(existing, {
    taskAgent: 'pi',
    availableAgents: ['pi'],
    piModels: [{ model: 'openrouter/x/m', apiKey: 'sk-new' }],
  });
  assert.deepStrictEqual(patch.PI_MODELS, [{ model: 'openrouter/x/m', apiKey: 'sk-new' }]);
  assert.strictEqual(patch.PI_MODEL, undefined, 'legacy flat key must be removed once PI_MODELS is written');
  assert.strictEqual(patch.OPENROUTER_API_KEY, undefined);
});

test('buildAgentsConfigPatch: pi left unchecked preserves any existing PI_MODELS/legacy pair untouched', () => {
  const existing = { PI_MODELS: [{ model: 'm1', apiKey: 'k1' }] };
  const patch = buildAgentsConfigPatch(existing, { taskAgent: 'claude', availableAgents: ['claude', 'codex'] });
  assert.deepStrictEqual(patch.PI_MODELS, [{ model: 'm1', apiKey: 'k1' }], 'unchecking Other Model must never destroy a stored key');

  const existingLegacy = { PI_MODEL: 'old-model', OPENROUTER_API_KEY: 'old-key' };
  const patch2 = buildAgentsConfigPatch(existingLegacy, { taskAgent: 'claude', availableAgents: ['claude'] });
  assert.strictEqual(patch2.PI_MODEL, 'old-model');
  assert.strictEqual(patch2.OPENROUTER_API_KEY, 'old-key');
});

test('buildAgentsConfigPatch rejects incomplete Pi rows without changing stored credentials', () => {
  const existing = { PI_MODELS: [{ model: 'm1', apiKey: 'k1' }] };
  assert.throws(() => buildAgentsConfigPatch(existing, {
    taskAgent: 'pi',
    availableAgents: ['pi'],
    piModels: [{ model: 'm2', apiKey: '' }],
  }), /Incomplete or duplicate Pi model row/);
  assert.deepStrictEqual(existing.PI_MODELS, [{ model: 'm1', apiKey: 'k1' }]);
});

test('buildAgentsConfigPatch sets CLAUDE_MODEL/CODEX_MODEL only when provided', () => {
  const patch = buildAgentsConfigPatch({ CLAUDE_MODEL: 'opusplan', CODEX_MODEL: 'gpt-5.4' }, {
    taskAgent: 'claude',
    availableAgents: ['claude'],
    claudeModel: 'claude-sonnet-5',
  });
  assert.strictEqual(patch.CLAUDE_MODEL, 'claude-sonnet-5');
  assert.strictEqual(patch.CODEX_MODEL, 'gpt-5.4', 'omitted field is left untouched, not blanked');
});

test('renderer settings DTO recursively excludes stored credentials and preserves useful flags', () => {
  const cfg = {
    API_TOKEN: 'sentinel-account-token', ASSEMBLYAI_API_KEY: 'sentinel-voice-key',
    OPENROUTER_API_KEY: 'sentinel-legacy-key', PI_MODEL: 'legacy-model',
    PI_MODELS: [{ model: 'm1', apiKey: 'sentinel-pi-key', provider: 'deepseek' }],
    API_PROJECT_ID: '42', theme: 'ink', AVAILABLE_AGENTS: 'pi',
  };
  const dto = rendererProjectConfig(cfg);
  const serialized = JSON.stringify(dto);
  for (const secret of ['sentinel-account-token', 'sentinel-voice-key', 'sentinel-legacy-key', 'sentinel-pi-key']) {
    assert.ok(!serialized.includes(secret), `${secret} leaked`);
  }
  assert.strictEqual(dto.API_PROJECT_ID, '42');
  assert.strictEqual(dto.theme, 'ink');
  assert.strictEqual(dto.hasApiToken, true);
  assert.strictEqual(dto.hasAssemblyaiKey, true);
  assert.deepStrictEqual(dto.PI_MODELS, [{ model: 'm1', provider: 'deepseek', hasApiKey: true,
    apiKeyAction: 'preserve', credentialRef: { model: 'm1', provider: 'deepseek' } }]);
});

test('settings writes preserve, replace, clear, and isolate credentials by project', () => {
  const a = { API_TOKEN: 'a-token', ASSEMBLYAI_API_KEY: 'a-voice',
    PI_MODELS: [{ model: 'm1', apiKey: 'a-pi', provider: 'deepseek' }] };
  const b = { API_TOKEN: 'b-token', PI_MODELS: [{ model: 'm1', apiKey: 'b-pi', provider: 'deepseek' }] };
  const safeRow = rendererPiModels(a)[0];
  const unchanged = buildAgentsConfigPatch(a, { taskAgent: 'pi', availableAgents: ['pi'], piModels: [safeRow] });
  assert.strictEqual(unchanged.PI_MODELS[0].apiKey, 'a-pi');
  assert.strictEqual(unchanged.API_TOKEN, 'a-token');
  assert.strictEqual(buildAgentsConfigPatch(b, { taskAgent: 'pi', availableAgents: ['pi'], piModels: [safeRow] }).PI_MODELS[0].apiKey, 'b-pi');
  const replaced = buildAgentsConfigPatch(a, { taskAgent: 'pi', availableAgents: ['pi'],
    piModels: [{ ...safeRow, apiKeyAction: 'replace', apiKey: 'new-pi' }] });
  assert.strictEqual(replaced.PI_MODELS[0].apiKey, 'new-pi');
  assert.deepStrictEqual(buildAgentsConfigPatch(a, { taskAgent: 'claude', availableAgents: ['claude'],
    clearPiModels: true }).PI_MODELS, []);
  assert.throws(() => mergeRendererProjectConfig(a, { PI_MODELS: [{ ...safeRow, apiKeyAction: 'replace', apiKey: '••••••••' }] }), /Replacement API key/);
  assert.throws(() => mergeRendererProjectConfig(a, { PI_MODELS: [{ ...safeRow, apiKeyAction: 'replace', apiKey: '•••••••• (saved)' }] }), /Replacement API key/);
  assert.deepStrictEqual(mergeRendererProjectConfig(a, { assemblyaiKey: { action: 'preserve' } }).ASSEMBLYAI_API_KEY, 'a-voice');
  assert.deepStrictEqual(mergeRendererProjectConfig(a, { assemblyaiKey: { action: 'replace', value: 'new-voice' } }).ASSEMBLYAI_API_KEY, 'new-voice');
  assert.deepStrictEqual(mergeRendererProjectConfig(a, { assemblyaiKey: { action: 'clear' } }).ASSEMBLYAI_API_KEY, '');
  assert.throws(() => mergeRendererProjectConfig(a, { assemblyaiKey: { action: 'replace', value: '•••••••• (saved)' } }), /Invalid AssemblyAI key action/);
  assert.strictEqual(mergeRendererProjectConfig(a, rendererProjectConfig(a)).API_TOKEN, 'a-token');
  assert.strictEqual(mergeRendererProjectConfig(a, rendererProjectConfig(a)).PI_MODELS[0].apiKey, 'a-pi');
});

test('summarizeAgents: LAST_AGENT outranks TASK_AGENT, matching resolveTaskAgentId precedence', () => {
  const s = summarizeAgents({ TASK_AGENT: 'claude', LAST_AGENT: 'codex', AVAILABLE_AGENTS: 'claude,codex' });
  assert.strictEqual(s.taskAgent, 'codex');
});

test('summarizeAgents: falls back to TASK_AGENT when LAST_AGENT is absent/unknown, then to claude', () => {
  assert.strictEqual(summarizeAgents({ TASK_AGENT: 'codex', AVAILABLE_AGENTS: 'codex' }).taskAgent, 'codex');
  assert.strictEqual(summarizeAgents({ LAST_AGENT: 'not-a-real-agent', TASK_AGENT: 'codex' }).taskAgent, 'codex');
  assert.strictEqual(summarizeAgents({}).taskAgent, 'claude');
});

test('summarizeAgents builds per-agent entries with models and a readable summary string', () => {
  const s = summarizeAgents(
    { TASK_AGENT: 'codex', AVAILABLE_AGENTS: 'claude,codex', CLAUDE_MODEL: 'opusplan', CODEX_MODEL: 'gpt-5.4' },
    { claude: 'Claude Code', codex: 'Codex' }
  );
  assert.strictEqual(s.taskAgentLabel, 'Codex');
  assert.deepStrictEqual(s.availableAgents, ['claude', 'codex']);
  assert.deepStrictEqual(s.entries, [
    { id: 'claude', label: 'Claude Code', isDefault: false, models: ['opusplan'] },
    { id: 'codex', label: 'Codex', isDefault: true, models: ['gpt-5.4'] },
  ]);
  assert.strictEqual(s.summary, 'Claude Code (opusplan) · Codex (gpt-5.4)');
});

test('summarizeAgents: PI_MODELS array wins over the legacy flat PI_MODEL when both are present', () => {
  const s = summarizeAgents({
    AVAILABLE_AGENTS: 'pi',
    PI_MODELS: [{ model: 'new-model', apiKey: 'k' }],
    PI_MODEL: 'stale-model',
  });
  assert.deepStrictEqual(s.piModels, ['new-model']);
});

test('summarizeAgents: falls back to the legacy flat PI_MODEL when PI_MODELS is absent (pre-C1121 project)', () => {
  const s = summarizeAgents({ AVAILABLE_AGENTS: 'pi', PI_MODEL: 'openrouter/moonshotai/kimi-k3' }, { pi: 'Other Model' });
  assert.deepStrictEqual(s.piModels, ['openrouter/moonshotai/kimi-k3']);
  assert.strictEqual(s.summary, 'Other Model (openrouter/moonshotai/kimi-k3)');
});

test('summarizeAgents on an empty/unconfigured project returns safe defaults, no throw', () => {
  const s = summarizeAgents(null);
  assert.strictEqual(s.taskAgent, 'claude');
  assert.deepStrictEqual(s.availableAgents, []);
  assert.deepStrictEqual(s.entries, []);
  assert.strictEqual(s.summary, '');
});

// ── writeProjectMcpConfig / writeProjectClaudeMcpApproval (C1382) ──

// A "shared install" root: serverRoot lives at <installRoot>/ai/todo/server, but the
// external project being configured is a SEPARATE directory tree entirely — this is the
// real Electron shape (an installed Task App configuring a user's own project), unlike
// makeRoot()'s single-tree layout which is only meant for the migrateFromLegacy tests
// above (there, projectRoot IS serverRoot's grandparent, which would trip
// writeProjectMcpConfig's own repo-guard if reused here).
function makeInstallRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-install-'));
  fs.mkdirSync(path.join(root, 'ai', 'todo', 'server'), { recursive: true });
  return { installRoot: root, serverRoot: path.join(root, 'ai', 'todo', 'server') };
}

function makeExternalProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-external-project-'));
}

test('writeProjectMcpConfig writes both servers with a credential-free ${VAR} remote entry', (t) => {
  const { serverRoot } = makeInstallRoot();
  const projectRoot = makeExternalProjectRoot();
  t.after(() => { fs.rmSync(serverRoot, { recursive: true, force: true }); fs.rmSync(projectRoot, { recursive: true, force: true }); });

  writeProjectMcpConfig(projectRoot, serverRoot);

  const mcp = JSON.parse(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8'));
  assert.strictEqual(mcp.mcpServers.tipatask.type, 'http');
  assert.strictEqual(mcp.mcpServers.tipatask.url, '${API_BASE_URL}/api/projects/${API_PROJECT_ID}/mcp');
  assert.strictEqual(mcp.mcpServers.tipatask.headers.Authorization, '');
  // No concrete credential anywhere in the remote entry — it must stay git-safe.
  assert.doesNotMatch(JSON.stringify(mcp.mcpServers.tipatask), /[0-9a-f]{20,}/);
  assert.strictEqual(mcp.mcpServers['tipatask-local'].command, path.join(path.resolve(serverRoot), 'bin', 'mcp-node'));
  assert.strictEqual(mcp.mcpServers['tipatask-local'].env.TIPATASK_MCP_LOCAL_ONLY, '1');
});

test('writeProjectMcpConfig preserves a third-party MCP server already in .mcp.json', (t) => {
  const { serverRoot } = makeInstallRoot();
  const projectRoot = makeExternalProjectRoot();
  t.after(() => { fs.rmSync(serverRoot, { recursive: true, force: true }); fs.rmSync(projectRoot, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: '/bin/other' } } }));

  writeProjectMcpConfig(projectRoot, serverRoot);

  const mcp = JSON.parse(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8'));
  assert.strictEqual(mcp.mcpServers.other.command, '/bin/other');
  assert.ok(mcp.mcpServers.tipatask);
  assert.ok(mcp.mcpServers['tipatask-local']);
});

test('writeProjectMcpConfig is idempotent — second call does not rewrite the file', (t) => {
  const { serverRoot } = makeInstallRoot();
  const projectRoot = makeExternalProjectRoot();
  t.after(() => { fs.rmSync(serverRoot, { recursive: true, force: true }); fs.rmSync(projectRoot, { recursive: true, force: true }); });

  writeProjectMcpConfig(projectRoot, serverRoot);
  const mcpPath = path.join(projectRoot, '.mcp.json');
  const firstContent = fs.readFileSync(mcpPath, 'utf8');
  const firstMtime = fs.statSync(mcpPath).mtimeMs;

  writeProjectMcpConfig(projectRoot, serverRoot);
  assert.strictEqual(fs.readFileSync(mcpPath, 'utf8'), firstContent);
  assert.strictEqual(fs.statSync(mcpPath).mtimeMs, firstMtime, 'expected no rewrite on an unchanged config');
});

test('writeProjectMcpConfig dogfooding: when projectRoot IS this checkout, .mcp.json is still written with absolute paths and settings.local.json gets pre-approval', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-self-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // projectRoot === serverRoot — the Task App opened as its own project. No layout guard
  // exists any more: the checkout can live anywhere, and /.mcp.json is gitignored here.
  writeProjectMcpConfig(root, root);

  const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.strictEqual(mcp.mcpServers['tipatask-local'].command, path.join(path.resolve(root), 'bin', process.platform === 'win32' ? 'mcp-node.cmd' : 'mcp-node'));
  assert.strictEqual(mcp.mcpServers['tipatask-local'].env.TIPATASK_PROJECT_ROOT, path.resolve(root));
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8'));
  assert.ok(settings.enabledMcpjsonServers.includes('tipatask'));
  assert.ok(settings.enabledMcpjsonServers.includes('tipatask-local'));
});

test('writeProjectClaudeMcpApproval pre-approves both server names and their wildcard tool permission', (t) => {
  const projectRoot = makeExternalProjectRoot();
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  writeProjectClaudeMcpApproval(projectRoot);

  const settings = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepStrictEqual(new Set(settings.enabledMcpjsonServers), new Set(['tipatask', 'tipatask-local']));
  for (const n of ['mcp__tipatask', 'mcp__tipatask__*', 'mcp__tipatask-local', 'mcp__tipatask-local__*']) {
    assert.ok(settings.permissions.allow.includes(n), `expected ${n} in permissions.allow`);
  }
});

test('writeProjectClaudeMcpApproval writes concrete credentials into settings.env from .tipatask/config.json, and adds settings.local.json to .gitignore', (t) => {
  const projectRoot = makeExternalProjectRoot();
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectRoot, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.tipatask', 'config.json'), JSON.stringify({
    API_BASE_URL: 'https://tt.example.com', API_PROJECT_ID: '9', API_TOKEN: 'concrete-jwt',
  }));

  writeProjectClaudeMcpApproval(projectRoot);

  const settings = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'settings.local.json'), 'utf8'));
  assert.strictEqual(settings.env.API_BASE_URL, 'https://tt.example.com');
  assert.strictEqual(settings.env.API_PROJECT_ID, '9');
  assert.strictEqual(settings.env.API_TOKEN, '');

  const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.claude\/settings\.local\.json$/m);
});

test('writeProjectClaudeMcpApproval never writes a blank credential over a value already present', (t) => {
  const projectRoot = makeExternalProjectRoot();
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.local.json'), JSON.stringify({
    env: { API_TOKEN: 'existing-token' },
  }));
  // No .tipatask/config.json at all this time — readProjectConfig returns null, so
  // `wanted` stays empty and the existing env value must survive untouched.

  writeProjectClaudeMcpApproval(projectRoot);

  const settings = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'settings.local.json'), 'utf8'));
  assert.strictEqual(settings.env.API_TOKEN, 'existing-token');
});

// ── (TPT163) per-row Pi provider ─────────────────────────────────────────────

test('piConfiguredModelIds returns a bare slash-less id', () => {
  const cfg = { PI_MODELS: [{ model: 'deepseek-flash', apiKey: 'sk-ds', provider: 'deepseek' }] };
  assert.deepEqual(piConfiguredModelIds(cfg), ['deepseek-flash']);
  assert.deepEqual(piConfiguredModelIds({ PI_MODELS: [{ model: 'deepseek-flash', apiKey: 'sk-ds' }] }), ['deepseek-flash']);
});

test('sanitizePiModels keeps a known non-default provider and omits the default/unknown one', () => {
  assert.deepEqual(
    sanitizePiModels([
      { model: 'deepseek-v4-flash', apiKey: 'k1', provider: ' DeepSeek ' },
      { model: 'openrouter/openai/gpt-4o', apiKey: 'k2', provider: 'openrouter' },
      { model: 'x/y', apiKey: 'k3', provider: 'not-a-provider' },
      { model: 'a/b', apiKey: 'k4' },
    ]),
    [
      { model: 'deepseek-v4-flash', apiKey: 'k1', provider: 'deepseek' },
      { model: 'openrouter/openai/gpt-4o', apiKey: 'k2' },
      { model: 'x/y', apiKey: 'k3' },
      { model: 'a/b', apiKey: 'k4' },
    ],
  );
});

test('piProviderEnv maps a row to its provider id, key env var and key requirement', () => {
  assert.deepEqual(piProviderEnv({ provider: 'deepseek' }), { provider: 'deepseek', envKey: 'DEEPSEEK_API_KEY', keyRequired: true });
  assert.deepEqual(piProviderEnv({ model: 'a/b', apiKey: 'k' }), { provider: 'openrouter', envKey: 'OPENROUTER_API_KEY', keyRequired: true });
  assert.deepEqual(piProviderEnv(null), { provider: 'openrouter', envKey: 'OPENROUTER_API_KEY', keyRequired: true });
  assert.deepEqual(piProviderEnv({ provider: 'anthropic' }), { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', keyRequired: true });
  assert.deepEqual(piProviderEnv({ provider: 'amazon-bedrock' }), { provider: 'amazon-bedrock', envKey: 'AWS_BEARER_TOKEN_BEDROCK', keyRequired: false });
  assert.equal(normalizePiProvider('bogus'), 'openrouter');
});

test('buildAgentsConfigPatch persists the provider of a deepseek row and round-trips through piEntryForModel', () => {
  const cfg = buildAgentsConfigPatch({}, {
    taskAgent: 'pi', availableAgents: ['pi'],
    piModels: [{ model: 'deepseek-flash', apiKey: 'sk-ds', provider: 'deepseek' }],
  });
  assert.deepEqual(cfg.PI_MODELS, [{ model: 'deepseek-flash', apiKey: 'sk-ds', provider: 'deepseek' }]);
  assert.equal(piProviderEnv(piEntryForModel(cfg, 'DeepSeek-Flash')).envKey, 'DEEPSEEK_API_KEY');
});

test('a deepseek row round-trips through a real config.json write and read', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = [
    { model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'sk-or' },
    { model: 'deepseek-v4-flash', apiKey: 'sk-ds', provider: 'deepseek' },
  ];
  initConfig(root, { PI_MODELS: rows });

  const onDisk = JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
  assert.deepEqual(onDisk.PI_MODELS, rows, 'provider is written to disk only on the deepseek row');

  const cfg = readProjectConfig(root);
  assert.deepEqual(readPiEntries(cfg), rows);
  assert.equal(piEntryForModel(cfg, 'deepseek-v4-flash').provider, 'deepseek');
  assert.equal(piProviderEnv(piEntryForModel(cfg, 'deepseek-v4-flash')).envKey, 'DEEPSEEK_API_KEY');
});

test('a legacy row without the provider field reads back as openrouter', () => {
  const cfg = { PI_MODELS: [{ model: 'openrouter/openai/gpt-4o', apiKey: 'sk-or' }] };
  const entry = piDefaultEntry(cfg);
  assert.equal('provider' in entry, false, 'reading must not invent a stored provider');
  assert.deepEqual(piProviderEnv(entry), { provider: 'openrouter', envKey: 'OPENROUTER_API_KEY', keyRequired: true });
});

test('recordLastUsedAgent moves a deepseek row to index 0 without dropping its provider', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initConfig(root, {
    PI_MODELS: [
      { model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'sk-or' },
      { model: 'deepseek-v4-flash', apiKey: 'sk-ds', provider: 'deepseek' },
    ],
  });

  assert.strictEqual(recordLastUsedAgent(root, 'pi', 'deepseek-v4-flash'), true);
  const cfg = readProjectConfig(root);
  assert.deepEqual(cfg.PI_MODELS, [
    { model: 'deepseek-v4-flash', apiKey: 'sk-ds', provider: 'deepseek' },
    { model: 'openrouter/anthropic/claude-sonnet-4.5', apiKey: 'sk-or' },
  ]);
  assert.equal(piProviderEnv(piDefaultEntry(cfg)).provider, 'deepseek');
});

// ── (TPT188) full Pi provider catalog ────────────────────────────────────────

test('PI_PROVIDERS entries are well-formed and openrouter stays the default (first) provider', () => {
  const ids = Object.keys(PI_PROVIDERS);
  assert.equal(PI_DEFAULT_PROVIDER, 'openrouter');
  assert.equal(ids[0], PI_DEFAULT_PROVIDER, 'the first key is the default provider');
  const labels = new Set();
  for (const id of ids) {
    const p = PI_PROVIDERS[id];
    assert.match(id, /^[a-z][a-z0-9-]*$/, `${id}: id shape`);
    assert.ok(typeof p.label === 'string' && p.label.trim(), `${id}: label`);
    assert.ok(!labels.has(p.label), `${id}: duplicate label "${p.label}"`);
    labels.add(p.label);
    assert.ok(p.envKey === null || /^[A-Z][A-Z0-9_]*$/.test(p.envKey), `${id}: envKey`);
    assert.equal(typeof p.keyRequired, 'boolean', `${id}: keyRequired`);
    assert.equal(typeof p.supportsBaseUrl, 'boolean', `${id}: supportsBaseUrl`);
    if (p.envKey === null) assert.equal(p.keyRequired, false, `${id}: a provider with no key env var cannot require a key`);
  }
  for (const id of ['anthropic', 'openai', 'google', 'groq', 'xai', 'mistral', 'cerebras', 'deepseek', 'openrouter']) {
    assert.ok(Object.prototype.hasOwnProperty.call(PI_PROVIDERS, id), `${id} is in the registry`);
  }
  // `custom` (TPT189) is key-optional too: a local Ollama/LM Studio server has no key.
  assert.deepEqual(ids.filter((id) => !PI_PROVIDERS[id].keyRequired).sort(), ['amazon-bedrock', 'custom', 'google-vertex']);
  assert.deepEqual(ids.filter((id) => PI_PROVIDERS[id].supportsBaseUrl), ['custom']);
});

test('every PI_PROVIDERS envKey is one the bundled Pi itself resolves for that provider', async (t) => {
  // The registry is hand-copied from pi-ai's env-api-keys map, so ask Pi's own resolver. Skips
  // when the package isn't installed (e.g. a fresh checkout that has not run npm install).
  const rel = ['@earendil-works', 'pi-ai', 'dist', 'env-api-keys.js'];
  const nm = path.join(__dirname, '..', '..', 'node_modules', '@earendil-works');
  const candidates = [
    path.join(nm, 'pi-coding-agent', 'node_modules', ...rel),
    path.join(nm, '..', ...rel),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) return t.skip('bundled Pi (pi-ai) not installed');
  const { getEnvApiKey } = await import(pathToFileURL(found).href);
  for (const [id, { envKey }] of Object.entries(PI_PROVIDERS)) {
    if (id === PI_CUSTOM_PROVIDER) continue; // not a Pi built-in — its key var is Tipatask's own (see pi-custom-endpoint.js)
    assert.notEqual(getEnvApiKey(id, { [envKey]: 'x' }), undefined, `Pi does not read ${envKey} for provider "${id}"`);
  }
});

test('a row for every provider round-trips through the save path, config.json and the read path', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // One provider per save — PI_MAX_MODELS (8) caps a single PI_MODELS array.
  for (const [id, meta] of Object.entries(PI_PROVIDERS)) {
    const row = {
      model: `${id}-model`, apiKey: 'sk-test',
      ...(id === PI_DEFAULT_PROVIDER ? {} : { provider: id }),
      ...(id === PI_CUSTOM_PROVIDER ? { baseUrl: 'http://localhost:11434/v1' } : {}), // a custom row without one is dropped
    };
    writeProjectConfig(root, buildAgentsConfigPatch({}, { taskAgent: 'pi', availableAgents: ['pi'], piModels: [row] }));

    const onDisk = JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
    assert.deepEqual(onDisk.PI_MODELS, [row], `${id}: on-disk row (provider written only when non-default)`);
    const entry = piEntryForModel(readProjectConfig(root), `${id}-MODEL`);
    assert.deepEqual(entry, row, `${id}: read-side row`);
    assert.deepEqual(piProviderEnv(entry), { provider: id, envKey: meta.envKey, keyRequired: meta.keyRequired }, `${id}: provider env`);
    assert.deepEqual(piKeyEnvVars(entry), { [meta.envKey]: 'sk-test' }, `${id}: key env`);
  }
});

test('sanitizePiModels normalizes a new provider id and still falls back to openrouter for an unknown one', () => {
  assert.deepEqual(
    sanitizePiModels([{ model: 'claude-x', apiKey: 'k', provider: ' Anthropic ' }]),
    [{ model: 'claude-x', apiKey: 'k', provider: 'anthropic' }],
  );
  assert.deepEqual(
    sanitizePiModels([{ model: 'x/y', apiKey: 'k', provider: 'anthropicc' }]),
    [{ model: 'x/y', apiKey: 'k' }],
    'an unknown id becomes an OpenRouter row (no stored provider)',
  );
});

test('a key-optional provider row persists without a key; a key-required one is still dropped', () => {
  assert.deepEqual(
    sanitizePiModels([{ model: 'us.anthropic.claude-sonnet-4', apiKey: '', provider: 'amazon-bedrock' }]),
    [{ model: 'us.anthropic.claude-sonnet-4', apiKey: '', provider: 'amazon-bedrock' }],
  );
  assert.deepEqual(
    sanitizePiModels([{ model: 'gemini-2.5-pro', apiKey: ' tok ', provider: 'google-vertex' }]),
    [{ model: 'gemini-2.5-pro', apiKey: 'tok', provider: 'google-vertex' }],
    'a key given to a key-optional provider is kept',
  );
  assert.deepEqual(sanitizePiModels([{ model: 'claude-x', apiKey: '  ', provider: 'anthropic' }]), []);
  assert.deepEqual(sanitizePiModels([{ model: 'x/y', apiKey: '', provider: 'bogus' }]), [], 'unknown → openrouter, which needs a key');
  assert.deepEqual(sanitizePiModels(['x/y']), [], 'a bare model-id string carries no key');
  assert.deepEqual(sanitizePiModels([{ model: '', apiKey: 'k', provider: 'amazon-bedrock' }]), [], 'a model is always required');
});

test('a keyless Bedrock row round-trips through config.json, counts as configured, and exports no key', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const row = { model: 'us.anthropic.claude-sonnet-4', apiKey: '', provider: 'amazon-bedrock' };
  writeProjectConfig(root, buildAgentsConfigPatch({}, { taskAgent: 'pi', availableAgents: ['pi'], piModels: [row] }));

  const cfg = readProjectConfig(root);
  assert.deepEqual(cfg.PI_MODELS, [row]);
  assert.deepEqual(readPiEntries(cfg), [row]);
  assert.deepEqual(piConfiguredModelIds(cfg), ['us.anthropic.claude-sonnet-4']);
  assert.deepEqual(piKeyEnvVars(piDefaultEntry(cfg)), {}, 'an empty key must never be exported');
});

test('piKeyEnvVars exports the row key under its own provider env var and nothing when there is nothing to export', () => {
  assert.deepEqual(piKeyEnvVars(null), {});
  assert.deepEqual(piKeyEnvVars(undefined), {});
  assert.deepEqual(piKeyEnvVars({ model: 'a/b', apiKey: 'k' }), { OPENROUTER_API_KEY: 'k' });
  assert.deepEqual(piKeyEnvVars({ model: 'gemini-2.5-pro', apiKey: 'k', provider: 'google' }), { GEMINI_API_KEY: 'k' });
  assert.deepEqual(piKeyEnvVars({ model: 'm', apiKey: 'tok', provider: 'amazon-bedrock' }), { AWS_BEARER_TOKEN_BEDROCK: 'tok' });
  assert.deepEqual(piKeyEnvVars({ model: 'm', apiKey: '', provider: 'amazon-bedrock' }), {});

  // A provider with no key env var exports nothing even when the row carries a key.
  PI_PROVIDERS.__nokey = { label: 'No Key Var', envKey: null, keyRequired: false };
  try {
    assert.deepEqual(piKeyEnvVars({ model: 'm', apiKey: 'k', provider: '__nokey' }), {});
  } finally {
    delete PI_PROVIDERS.__nokey;
  }
});


// ── (TPT189) custom OpenAI-compatible endpoint rows ─────────────────────────

const OLLAMA = 'http://localhost:11434/v1';

test('custom is a key-optional base-URL provider appended after the built-ins; openrouter stays first', () => {
  assert.equal(PI_CUSTOM_PROVIDER, 'custom');
  assert.deepEqual(PI_PROVIDERS.custom, {
    label: 'Custom endpoint',
    envKey: 'TIPATASK_PI_CUSTOM_API_KEY',
    keyRequired: false,
    supportsBaseUrl: true,
  });
  assert.equal(Object.keys(PI_PROVIDERS)[0], PI_DEFAULT_PROVIDER);
  assert.equal(Object.keys(PI_PROVIDERS).at(-1), 'custom', 'custom is not a Pi built-in — appended last');
  assert.equal(PI_CUSTOM_DEFAULT_API, 'openai-completions');
  assert.ok(PI_CUSTOM_APIS.includes(PI_CUSTOM_DEFAULT_API));
});

test('a custom row keeps baseUrl, omits the default api, and needs no key', () => {
  assert.deepEqual(
    sanitizePiModels([{ model: 'llama3.1:8b', apiKey: '', provider: 'custom', baseUrl: OLLAMA }]),
    [{ model: 'llama3.1:8b', apiKey: '', provider: 'custom', baseUrl: OLLAMA }],
  );
  assert.deepEqual(
    sanitizePiModels([{ model: 'gpt-x', apiKey: 'sk-1', provider: ' Custom ', baseUrl: `  ${OLLAMA}  `, api: 'OpenAI-Completions' }]),
    [{ model: 'gpt-x', apiKey: 'sk-1', provider: 'custom', baseUrl: OLLAMA }],
    'provider/api are case-normalized, baseUrl trimmed, the default api is not written',
  );
});

test('a custom row keeps a non-default api and falls back to the default for an unknown one', () => {
  const [a] = sanitizePiModels([{ model: 'm', apiKey: '', provider: 'custom', baseUrl: OLLAMA, api: ' anthropic-messages ' }]);
  assert.deepEqual(a, { model: 'm', apiKey: '', provider: 'custom', baseUrl: OLLAMA, api: 'anthropic-messages' });
  const [b] = sanitizePiModels([{ model: 'm', apiKey: '', provider: 'custom', baseUrl: OLLAMA, api: 'not-an-api' }]);
  assert.deepEqual(b, { model: 'm', apiKey: '', provider: 'custom', baseUrl: OLLAMA });
  assert.equal(normalizePiApi(undefined), 'openai-completions');
  assert.equal(normalizePiApi('OPENAI-RESPONSES'), 'openai-responses');
});

test('a custom row with a missing or non-http(s) baseUrl is dropped; other rows survive', () => {
  const bad = ['', '   ', undefined, null, 'localhost:11434/v1', 'ftp://host/v1', 'file:///etc/passwd',
    'javascript:alert(1)', 'ws://host/v1', 'not a url', 'http://', 'http://user:pw@host/v1', 'https://:secret@host/v1'];
  for (const baseUrl of bad) {
    assert.deepEqual(
      sanitizePiModels([
        { model: 'x', apiKey: 'k', provider: 'custom', baseUrl },
        { model: 'keep/me', apiKey: 'k' },
      ]),
      [{ model: 'keep/me', apiKey: 'k' }],
      `baseUrl ${JSON.stringify(baseUrl)} must drop the custom row`,
    );
  }
  assert.equal(normalizePiBaseUrl('https://gw.example.com:8443/openai/v1'), 'https://gw.example.com:8443/openai/v1');
  assert.equal(normalizePiBaseUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1');
  assert.equal(normalizePiBaseUrl('http://[::1]:8080/v1'), 'http://[::1]:8080/v1');
});

test('baseUrl/api on a non-custom row are discarded, so existing on-disk shapes never change', () => {
  assert.deepEqual(
    sanitizePiModels([
      { model: 'a/b', apiKey: 'k1', baseUrl: OLLAMA, api: 'anthropic-messages' },
      { model: 'deepseek-v4-flash', apiKey: 'k2', provider: 'deepseek', baseUrl: OLLAMA },
    ]),
    [{ model: 'a/b', apiKey: 'k1' }, { model: 'deepseek-v4-flash', apiKey: 'k2', provider: 'deepseek' }],
  );
  assert.equal(isPiCustomEntry({ model: 'a', provider: 'deepseek' }), false);
  assert.equal(isPiCustomEntry({ model: 'a' }), false);
  assert.equal(isPiCustomEntry(null), false);
  assert.equal(isPiCustomEntry({ model: 'a', provider: 'custom', baseUrl: OLLAMA }), true);
});

test('a custom row round-trips through config.json with and without a key', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyed = { model: 'gpt-4o-mini', apiKey: 'sk-secret', provider: 'custom', baseUrl: 'https://gw.example.com/v1', api: 'openai-responses' };
  const keyless = { model: 'llama3.1:8b', apiKey: '', provider: 'custom', baseUrl: OLLAMA };
  writeProjectConfig(root, buildAgentsConfigPatch({}, { taskAgent: 'pi', availableAgents: ['pi'], piModels: [keyed, keyless] }));

  const cfg = readProjectConfig(root);
  assert.deepEqual(cfg.PI_MODELS, [keyed, keyless]);
  assert.deepEqual(readPiEntries(cfg), [keyed, keyless]);
  // piEntryForModel hands back the whole row, baseUrl/api included — spawn code needs them.
  assert.deepEqual(piEntryForModel(cfg, ' GPT-4O-MINI '), keyed);
  assert.deepEqual(piEntryForModel(cfg, 'llama3.1:8b'), keyless);
  assert.deepEqual(piProviderEnv(keyed), { provider: 'custom', envKey: 'TIPATASK_PI_CUSTOM_API_KEY', keyRequired: false });
  assert.deepEqual(piKeyEnvVars(keyed), { TIPATASK_PI_CUSTOM_API_KEY: 'sk-secret' });
  assert.deepEqual(piKeyEnvVars(keyless), {}, 'a keyless custom row exports nothing');
  assert.deepEqual(piConfiguredModelIds(cfg), ['gpt-4o-mini', 'llama3.1:8b'], 'a keyless custom row still counts as configured');
});

test('a hand-edited config.json custom row without a baseUrl reads back as unconfigured, not as a broken spawn', () => {
  const cfg = { PI_MODELS: [{ model: 'llama3.1:8b', apiKey: '', provider: 'custom' }] };
  assert.deepEqual(readPiEntries(cfg), []);
  assert.deepEqual(piConfiguredModelIds(cfg), []);
  assert.equal(piEntryForModel(cfg, 'llama3.1:8b'), null);
});

test('recordLastUsedAgent moves a custom row to index 0 without dropping its baseUrl/api', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const custom = { model: 'qwen3-coder', apiKey: '', provider: 'custom', baseUrl: OLLAMA, api: 'openai-responses' };
  initConfig(root, { PI_MODELS: [{ model: 'a/b', apiKey: 'k' }, custom] });
  assert.equal(recordLastUsedAgent(root, 'pi', 'qwen3-coder'), true);
  assert.deepEqual(readProjectConfig(root).PI_MODELS, [custom, { model: 'a/b', apiKey: 'k' }]);
});

test('model-id de-dupe is id-only across providers, custom included', () => {
  assert.deepEqual(
    sanitizePiModels([
      { model: 'gpt-4o', apiKey: 'k', provider: 'openai' },
      { model: 'GPT-4O', apiKey: '', provider: 'custom', baseUrl: OLLAMA },
    ]),
    [{ model: 'gpt-4o', apiKey: 'k', provider: 'openai' }],
  );
});

test('writeProjectConfig routes API_TOKEN to the account store and never writes it to config.json', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeProjectConfig(root, { API_BASE_URL: 'https://route.example.test/', API_PROJECT_ID: '5', API_TOKEN: 'route-token', language: 'uk' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.tipatask', 'config.json'), 'utf8'));
  assert.deepStrictEqual(onDisk, { API_BASE_URL: 'https://route.example.test/', API_PROJECT_ID: '5', language: 'uk' });
  assert.strictEqual(readAccount('https://route.example.test').token, 'route-token');

  // A second project on the same server shares the account.
  const other = makeRoot();
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  writeProjectConfig(other, { API_BASE_URL: 'https://route.example.test', API_PROJECT_ID: '6' });
  assert.strictEqual(readAccount('https://route.example.test').token, 'route-token');

  // A blank token signs that server out.
  writeProjectConfig(root, { API_BASE_URL: 'https://route.example.test', API_PROJECT_ID: '5', API_TOKEN: '' });
  assert.strictEqual(readAccount('https://route.example.test'), null);
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(path.join(root, '.tipatask', 'config.json'), 'utf8')), 'API_TOKEN'));
});

test('writeProjectConfig keeps the token inline when the config has no API_BASE_URL to key the store', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => writeProjectConfig(root, { API_TOKEN: 'orphan-token', API_PROJECT_ID: '1' }), /API_BASE_URL is required/);
  assert.equal(readProjectConfig(root), null);
});

test('rendererProjectConfig reports hasApiToken from the account store', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeProjectConfig(root, { API_BASE_URL: 'https://flag.example.test', API_PROJECT_ID: '1', API_TOKEN: 'flag-token' });
  const safe = rendererProjectConfig(readProjectConfig(root));
  assert.strictEqual(safe.hasApiToken, true);
  assert.ok(!Object.hasOwn(safe, 'API_TOKEN'));
});
