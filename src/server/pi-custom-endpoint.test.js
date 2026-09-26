'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  PI_CUSTOM_KEY_ENV,
  PI_CUSTOM_NO_KEY,
  piCustomProviderId,
  piSpawnProvider,
  buildPiModelsJson,
  serializePiModelsJson,
  piRealAgentDir,
  piDefaultSessionDir,
  writePiModelsJson,
  preparePiCustomEndpoint,
} = require('./pi-custom-endpoint');
const { writeProjectConfig } = require('./project-config');

const SECRET = 'sk-very-secret-key-123';
const KEYED = { model: 'gpt-4o-mini', apiKey: SECRET, provider: 'custom', baseUrl: 'https://gw.example.com/v1' };
const KEYLESS = { model: 'llama3.1:8b', apiKey: '', provider: 'custom', baseUrl: 'http://localhost:11434/v1' };
const ID_RE = /^tipatask-custom-[0-9a-f]{8}$/;

function tmp(t, prefix = 'tt-pi-custom-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function projectWith(t, piModels) {
  const root = tmp(t);
  writeProjectConfig(root, { PI_MODELS: piModels });
  return root;
}

// Loads a file from the bundled Pi's dist/ (the package's exports map hides subpaths from a bare
// specifier, so import by file URL — same technique as project-config.test.js). null when Pi is
// not installed, e.g. a fresh checkout that has not run npm install.
async function loadPi(rel) {
  const root = path.join(__dirname, '..', '..');
  const found = [
    path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', rel),
    path.join(root, 'vendor', 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', rel),
  ].find((p) => fs.existsSync(p));
  return found ? import(pathToFileURL(found).href) : null;
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[name]; else process.env[name] = prev;
  }
}

// ── provider id ─────────────────────────────────────────────────────────────

test('piCustomProviderId is stable and keyed on url + api + whether a key exists', () => {
  const id = piCustomProviderId(KEYED);
  assert.match(id, ID_RE);
  assert.equal(piCustomProviderId({ ...KEYED }), id, 'stable');
  assert.equal(piCustomProviderId({ ...KEYED, model: 'another-model' }), id, 'same endpoint → same block, whatever the model');
  assert.equal(piCustomProviderId({ ...KEYED, apiKey: 'a-different-key' }), id, 'the key VALUE is never part of the id');
  assert.equal(piCustomProviderId({ ...KEYED, api: 'openai-completions' }), id, 'explicit default api === absent api');
  assert.notEqual(piCustomProviderId({ ...KEYED, baseUrl: 'https://other.example.com/v1' }), id);
  assert.notEqual(piCustomProviderId({ ...KEYED, api: 'anthropic-messages' }), id);
  assert.notEqual(piCustomProviderId({ ...KEYED, apiKey: '' }), id, 'keyed and keyless rows never share a block');
});

test('piSpawnProvider leaves every built-in row exactly as before and maps a custom row to its block id', () => {
  assert.equal(piSpawnProvider(null), 'openrouter');
  assert.equal(piSpawnProvider(undefined), 'openrouter');
  assert.equal(piSpawnProvider({ model: 'a/b', apiKey: 'k' }), 'openrouter');
  assert.equal(piSpawnProvider({ model: 'gemini-2.5-pro', apiKey: 'k', provider: 'google' }), 'google');
  assert.equal(piSpawnProvider(KEYLESS), piCustomProviderId(KEYLESS));
  assert.match(piSpawnProvider(KEYLESS), ID_RE);
});

// ── models.json content ─────────────────────────────────────────────────────

test('buildPiModelsJson: keyed block references the env var, keyless block a non-secret placeholder', () => {
  const json = buildPiModelsJson([KEYED, KEYLESS]);
  assert.deepEqual(Object.keys(json), ['providers']);
  const keyed = json.providers[piCustomProviderId(KEYED)];
  const keyless = json.providers[piCustomProviderId(KEYLESS)];
  assert.deepEqual(keyed, {
    name: 'Custom endpoint (gw.example.com)',
    baseUrl: 'https://gw.example.com/v1',
    api: 'openai-completions',
    apiKey: '$TIPATASK_PI_CUSTOM_API_KEY',
    models: [{ id: 'gpt-4o-mini' }],
  });
  assert.deepEqual(keyless, {
    name: 'Custom endpoint (localhost:11434)',
    baseUrl: 'http://localhost:11434/v1',
    api: 'openai-completions',
    apiKey: PI_CUSTOM_NO_KEY,
    models: [{ id: 'llama3.1:8b' }],
  });
  assert.equal(PI_CUSTOM_KEY_ENV, 'TIPATASK_PI_CUSTOM_API_KEY');
});

test('buildPiModelsJson never contains the literal key, in any serialization', () => {
  const text = serializePiModelsJson([KEYED, KEYLESS]);
  assert.ok(!text.includes(SECRET), 'the literal key must never reach models.json');
  assert.ok(text.includes('$TIPATASK_PI_CUSTOM_API_KEY'));
  assert.ok(text.endsWith('\n'));
});

test('buildPiModelsJson groups rows on one endpoint into one block and is independent of row order', () => {
  const a = { model: 'zeta', apiKey: '', provider: 'custom', baseUrl: 'http://localhost:11434/v1' };
  const b = { model: 'alpha', apiKey: '', provider: 'custom', baseUrl: 'http://localhost:11434/v1' };
  const forward = buildPiModelsJson([a, b, KEYED]);
  const reversed = buildPiModelsJson([KEYED, b, a]);
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed), 'same bytes whatever the row order');
  assert.equal(Object.keys(forward.providers).length, 2);
  assert.deepEqual(forward.providers[piCustomProviderId(a)].models, [{ id: 'alpha' }, { id: 'zeta' }]);
});

test('buildPiModelsJson ignores non-custom rows and tolerates nothing at all', () => {
  assert.deepEqual(buildPiModelsJson([{ model: 'a/b', apiKey: 'k' }, { model: 'x', apiKey: 'k', provider: 'deepseek' }]), { providers: {} });
  assert.deepEqual(buildPiModelsJson([]), { providers: {} });
  assert.deepEqual(buildPiModelsJson(undefined), { providers: {} });
});

test('a non-default api is carried into the block', () => {
  const json = buildPiModelsJson([{ ...KEYLESS, api: 'anthropic-messages' }]);
  assert.equal(Object.values(json.providers)[0].api, 'anthropic-messages');
});

// ── writer ──────────────────────────────────────────────────────────────────

test('writePiModelsJson creates <root>/.pi/agent/models.json and a self-ignoring .gitignore', (t) => {
  const root = tmp(t);
  const res = writePiModelsJson(root, [KEYED, KEYLESS]);
  assert.equal(res.dir, path.join(root, '.pi', 'agent'));
  assert.equal(res.file, path.join(root, '.pi', 'agent', 'models.json'));
  assert.equal(res.changed, true);
  assert.equal(res.error, null);
  assert.equal(fs.readFileSync(res.file, 'utf8'), serializePiModelsJson([KEYED, KEYLESS]));
  assert.equal(fs.readFileSync(path.join(res.dir, '.gitignore'), 'utf8'), '*\n');
  assert.deepEqual(fs.readdirSync(res.dir).sort(), ['.gitignore', 'models.json'], 'no tmp file left behind');
});

test('writePiModelsJson is idempotent — an identical rewrite leaves the file untouched', (t) => {
  const root = tmp(t);
  const first = writePiModelsJson(root, [KEYED]);
  const before = fs.statSync(first.file);
  const second = writePiModelsJson(root, [KEYED]);
  assert.equal(second.changed, false);
  assert.equal(fs.statSync(second.file).mtimeMs, before.mtimeMs, 'no rewrite, no mtime churn');
  assert.equal(fs.statSync(second.file).ino, before.ino);
});

test('writePiModelsJson rewrites when the rows change and never clobbers an existing .gitignore', (t) => {
  const root = tmp(t);
  const dir = path.join(root, '.pi', 'agent');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'models-store.json\n', 'utf8');
  writePiModelsJson(root, [KEYED]);
  const res = writePiModelsJson(root, [KEYED, KEYLESS]);
  assert.equal(res.changed, true);
  assert.equal(fs.readFileSync(res.file, 'utf8'), serializePiModelsJson([KEYED, KEYLESS]));
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'models-store.json\n', 'a user-owned .gitignore is left alone');
});

test('writePiModelsJson never throws — a failed write is reported and logged', (t) => {
  const root = tmp(t);
  const blocker = path.join(root, 'a-file');
  fs.writeFileSync(blocker, 'x');
  const warn = t.mock.method(console, 'warn', () => {});
  const res = writePiModelsJson(blocker, [KEYED]); // <file>/.pi cannot be created
  assert.equal(res.changed, false);
  assert.ok(res.error instanceof Error);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /could not write models\.json/);
});

// ── preparePiCustomEndpoint ─────────────────────────────────────────────────

test('preparePiCustomEndpoint does nothing for a non-custom row — no env, no disk', (t) => {
  const root = projectWith(t, [{ model: 'a/b', apiKey: 'k' }]);
  for (const entry of [null, undefined, { model: 'a/b', apiKey: 'k' }, { model: 'gemini-2.5-pro', apiKey: 'k', provider: 'google' }]) {
    const res = preparePiCustomEndpoint(root, entry, {});
    assert.deepEqual(res.env, {});
    assert.equal(res.provider, entry && entry.provider ? entry.provider : 'openrouter');
  }
  assert.equal(fs.existsSync(path.join(root, '.pi')), false, 'a non-custom spawn must not create .pi/');
});

test('preparePiCustomEndpoint writes ALL the project custom rows and returns the block id + agent-dir env', (t) => {
  const root = projectWith(t, [{ model: 'a/b', apiKey: 'k' }, KEYED, KEYLESS]);
  const res = preparePiCustomEndpoint(root, KEYLESS, {});
  assert.equal(res.provider, piCustomProviderId(KEYLESS));
  assert.deepEqual(Object.keys(res.env).sort(), ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR']);
  assert.equal(res.env.PI_CODING_AGENT_DIR, path.join(root, '.pi', 'agent'));
  assert.equal(res.env.PI_CODING_AGENT_SESSION_DIR, piDefaultSessionDir(root, {}));

  const written = JSON.parse(fs.readFileSync(path.join(root, '.pi', 'agent', 'models.json'), 'utf8'));
  assert.deepEqual(Object.keys(written.providers).sort(), [piCustomProviderId(KEYED), piCustomProviderId(KEYLESS)].sort(),
    'the file is a function of config, not of which row is spawning — a concurrent spawn on the other row finds its block');
});

test('preparePiCustomEndpoint still writes the block for a row that is not in config.json', (t) => {
  const root = projectWith(t, [{ model: 'a/b', apiKey: 'k' }]);
  const res = preparePiCustomEndpoint(root, KEYLESS, {});
  const written = JSON.parse(fs.readFileSync(path.join(root, '.pi', 'agent', 'models.json'), 'utf8'));
  assert.deepEqual(Object.keys(written.providers), [res.provider]);
});

test('preparePiCustomEndpoint tolerates a project with no config.json at all', (t) => {
  const root = tmp(t);
  const res = preparePiCustomEndpoint(root, KEYLESS, {});
  assert.equal(res.provider, piCustomProviderId(KEYLESS));
  assert.ok(fs.existsSync(path.join(root, '.pi', 'agent', 'models.json')));
});

test('the pinned sessions dir honors an ambient PI_CODING_AGENT_DIR from the spawn env', (t) => {
  const root = projectWith(t, [KEYLESS]);
  const ambient = tmp(t, 'tt-pi-ambient-');
  const res = preparePiCustomEndpoint(root, KEYLESS, { PI_CODING_AGENT_DIR: ambient });
  assert.equal(res.env.PI_CODING_AGENT_SESSION_DIR.startsWith(path.join(ambient, 'sessions') + path.sep), true);
  assert.equal(res.env.PI_CODING_AGENT_DIR, path.join(root, '.pi', 'agent'), 'the generated dir is still project-local');
});

// ── agent-dir / session-dir helpers ─────────────────────────────────────────

test('piRealAgentDir: default, override, and ~ expansion', () => {
  assert.equal(piRealAgentDir({}), path.join(os.homedir(), '.pi', 'agent'));
  assert.equal(piRealAgentDir(undefined), path.join(os.homedir(), '.pi', 'agent'));
  assert.equal(piRealAgentDir({ PI_CODING_AGENT_DIR: '/srv/pi-agent' }), path.resolve('/srv/pi-agent'));
  assert.equal(piRealAgentDir({ PI_CODING_AGENT_DIR: '~' }), os.homedir());
  assert.equal(piRealAgentDir({ PI_CODING_AGENT_DIR: '~/custom-agent' }), path.join(os.homedir(), 'custom-agent'));
});

test('piDefaultSessionDir encodes the cwd the way Pi does', () => {
  assert.equal(
    piDefaultSessionDir('/Users/alice/Projects/My App', { PI_CODING_AGENT_DIR: '/agent' }),
    path.join(path.resolve('/agent'), 'sessions', '--Users-alice-Projects-My App--'),
  );
});

// ── parity with the bundled Pi ──────────────────────────────────────────────
// Pi keeps these rules private, so they are hand-mirrored. These tests ask Pi itself, so a Pi
// upgrade that changes any of them fails here instead of silently orphaning sessions or emitting a
// models.json Pi rejects.

test('piRealAgentDir agrees with the bundled Pi getAgentDir()', async (t) => {
  const cfg = await loadPi('config.js');
  if (!cfg) return t.skip('bundled Pi not installed');
  withEnv('PI_CODING_AGENT_DIR', undefined, () => {
    assert.equal(cfg.getAgentDir(), piRealAgentDir({}));
  });
  withEnv('PI_CODING_AGENT_DIR', '/srv/pi-agent', () => {
    assert.equal(cfg.getAgentDir(), piRealAgentDir({ PI_CODING_AGENT_DIR: '/srv/pi-agent' }));
  });
  withEnv('PI_CODING_AGENT_DIR', '~/x-agent', () => {
    assert.equal(cfg.getAgentDir(), piRealAgentDir({ PI_CODING_AGENT_DIR: '~/x-agent' }));
  });
});

test('piDefaultSessionDir agrees with the bundled Pi SessionManager default', async (t) => {
  const sm = await loadPi('core/session-manager.js');
  if (!sm) return t.skip('bundled Pi not installed');
  const agentDir = tmp(t, 'tt-pi-agentdir-');
  const cwd = tmp(t, 'tt-pi-cwd-');
  withEnv('PI_CODING_AGENT_DIR', agentDir, () => {
    const piDir = sm.SessionManager.create(cwd).getSessionDir();
    assert.equal(piDefaultSessionDir(cwd, { PI_CODING_AGENT_DIR: agentDir }), piDir);
  });
});

test('the generated models.json loads clean through the bundled Pi ModelConfig', async (t) => {
  const mc = await loadPi('core/model-config.js');
  if (!mc) return t.skip('bundled Pi not installed');
  const root = tmp(t);
  const rows = [KEYED, KEYLESS, { ...KEYLESS, model: 'qwen3-coder', baseUrl: 'http://127.0.0.1:1234/v1', api: 'anthropic-messages' }];
  const { file } = writePiModelsJson(root, rows);
  const loaded = await mc.ModelConfig.load(file);
  assert.equal(loaded.getError(), undefined, `Pi rejected the generated file: ${loaded.getError()}`);
  assert.deepEqual(loaded.getProviderIds().sort(), rows.map((r) => piCustomProviderId(r)).sort());
  const provider = loaded.getProvider(piCustomProviderId(KEYED));
  assert.equal(provider.baseUrl, KEYED.baseUrl);
  assert.equal(provider.apiKey, '$TIPATASK_PI_CUSTOM_API_KEY');
  assert.deepEqual(provider.models, [{ id: 'gpt-4o-mini' }]);
});
