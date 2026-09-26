'use strict';

// TPT349 — Claude spawn wiring for the token-refresh work: when the installed CLI supports
// `headersHelper`, --mcp-config points at a derived copy of .mcp.json whose remote `tipatask`
// entry re-reads API_TOKEN from .tipatask/config.json on every (re)connect; otherwise the
// project's own .mcp.json is passed through unchanged. Either way the spawn env carries the
// project's current API_TOKEN.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ClaudeAgent = require('./claude-agent');

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const jwt = (exp) => `${b64url({ alg: 'HS256' })}.${b64url({ id: 1, exp })}.sig`;

function makeProject(t, cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-hh-proj-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.tipatask'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), JSON.stringify(cfg), 'utf8');
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      tipatask: { type: 'http', url: '${API_BASE_URL}/api/projects/${API_PROJECT_ID}/mcp', headers: { Authorization: 'Bearer ${API_TOKEN}' } },
      'tipatask-local': { command: '/bin/local' },
    },
  }));
  return dir;
}

function makeConfig(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-hh-data-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  return { CLAUDE_MODEL: 'opusplan', SIMPLE_MODE: true, PROJECT_ROOT: '/fallback/global/project', USER_DATA_ROOT: userData, CLAUDE_BIN: 'claude' };
}

function stubProbe(t, value) {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ images: [], files: [] }) }));
  const original = ClaudeAgent._cliSupportsHeadersHelper;
  ClaudeAgent._cliSupportsHeadersHelper = async () => value;
  t.after(() => { ClaudeAgent._cliSupportsHeadersHelper = original; });
}

const mcpConfigArg = (args) => args[args.indexOf('--mcp-config') + 1];

test('headersHelper supported: --mcp-config is the derived file, only tipatask carries the helper, env has the fresh token', async (t) => {
  stubProbe(t, true);
  const fresh = jwt(Math.floor(Date.now() / 1000) + 7 * 86400);
  const dir = makeProject(t, { API_BASE_URL: 'https://api.test', API_PROJECT_ID: '2', API_TOKEN: fresh });
  const config = makeConfig(t);

  const spec = await new ClaudeAgent().getSpawnSpec(config, 'do thing', 'C1', { projectPath: dir });

  const derivedPath = mcpConfigArg(spec.args);
  assert.notEqual(derivedPath, path.join(dir, '.mcp.json'));
  assert.ok(derivedPath.startsWith(path.join(config.USER_DATA_ROOT, 'mcp-spawn') + path.sep), derivedPath);
  assert.ok(spec.args.includes('--strict-mcp-config'));
  assert.equal(spec.mcpHeadersHelper, true);

  const derived = JSON.parse(fs.readFileSync(derivedPath, 'utf8'));
  const helper = derived.mcpServers.tipatask.headersHelper;
  assert.match(helper, /auth-header-helper\.js/);
  assert.ok(helper.includes(dir), 'helper is bound to this project root');
  assert.equal(derived.mcpServers.tipatask.headers.Authorization, 'Bearer ${API_TOKEN}', 'static header kept as fallback');
  assert.equal('headersHelper' in derived.mcpServers['tipatask-local'], false);

  // The token in the spawn env is the one now in config.json — the launch-preflight contract.
  assert.equal(spec.env.API_TOKEN, fresh);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.tipatask.headersHelper, undefined);
});

test('headersHelper unsupported: project .mcp.json passed through, no derived file', async (t) => {
  stubProbe(t, false);
  const dir = makeProject(t, { API_BASE_URL: 'https://api.test', API_PROJECT_ID: '2', API_TOKEN: 'tok' });
  const config = makeConfig(t);

  const spec = await new ClaudeAgent().getSpawnSpec(config, 'do thing', 'C1', { projectPath: dir });

  assert.equal(mcpConfigArg(spec.args), path.join(dir, '.mcp.json'));
  assert.equal(spec.mcpHeadersHelper, false);
  assert.equal(fs.existsSync(path.join(config.USER_DATA_ROOT, 'mcp-spawn')), false);
});

test('headersHelper supported but nothing to derive (no .mcp.json): falls back to the project path', async (t) => {
  stubProbe(t, true);
  const dir = makeProject(t, { API_BASE_URL: 'https://api.test', API_PROJECT_ID: '2', API_TOKEN: 'tok' });
  fs.rmSync(path.join(dir, '.mcp.json'));
  const spec = await new ClaudeAgent().getSpawnSpec(makeConfig(t), 'do thing', 'C1', { projectPath: dir });
  assert.equal(mcpConfigArg(spec.args), path.join(dir, '.mcp.json'));
  assert.equal(spec.mcpHeadersHelper, false);
});

test('_scanFileForString: finds the needle, including one split across chunk boundaries; misses cleanly', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-hh-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hit = path.join(dir, 'hit.bin');
  const miss = path.join(dir, 'miss.bin');
  fs.writeFileSync(hit, Buffer.concat([Buffer.alloc(4 * 1024 * 1024 - 5, 0x61), Buffer.from('headersHelper'), Buffer.alloc(100, 0x62)]));
  fs.writeFileSync(miss, Buffer.alloc(5 * 1024 * 1024, 0x61));
  assert.equal(await ClaudeAgent._scanFileForString(hit, 'headersHelper'), true);
  assert.equal(await ClaudeAgent._scanFileForString(miss, 'headersHelper'), false);
  await assert.rejects(() => ClaudeAgent._scanFileForString(path.join(dir, 'absent.bin'), 'headersHelper'));
});
