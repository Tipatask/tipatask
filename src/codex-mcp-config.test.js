'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-codex-config-data-'));
test.after(() => fs.rmSync(process.env.TIPATASK_USER_DATA, { recursive: true, force: true }));

const {
  CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE,
  BROWSER_MCP_PRESETS,
  BROWSER_PRESET_MARKER,
  buildCodexMcpSection,
  buildCodexLocalMcpSection,
  getCodexPaths,
  mcpSectionHasCommand,
  mergeGlobalMcpServerTables,
  updateGlobalCodexMcpApprovalConfig,
  upsertProjectTrustLevel,
  writeCodexMcpConfig,
  applyBrowserToolPresets,
  normalizeBrowserToolIds,
  readRequiredNodeMajor,
  resolveBrowserMcpRuntime,
} = require('./codex-mcp-config');

const toml = require('toml');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-codex-mcp-'));
}

const TEST_BROWSER_RUNTIME = {
  available: true,
  requiredMajor: 22,
  nodePath: '/opt/test-node-22/bin/node',
  nodeVersion: 'v22.22.1',
  nodeBinDir: '/opt/test-node-22/bin',
  npxPath: '/opt/test-node-22/bin/npx',
  path: '/opt/test-node-22/bin:/usr/local/bin:/usr/bin:/bin',
};

function makeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '', 'utf8');
  fs.chmodSync(filePath, 0o755);
}

// Writes a minimal real .tipatask/config.json under projectRoot so
// buildCodexMcpSection's readCodexCredentials() resolves a concrete URL instead of
// degrading to an empty one.
function writeProjectConfig(projectRoot, fields) {
  const dir = path.join(projectRoot, '.tipatask');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(fields), 'utf8');
}

test('global Codex config strips tool overrides and forces tipatask prompt-free approval', () => {
  const dir = makeTempDir();
  try {
    const targetPath = path.join(dir, 'config.toml');
    fs.writeFileSync(targetPath, [
      'model = "gpt-5.5"',
      'default_tools_approval_mode = "prompt"',
      '',
      '[mcp_servers.pencil]',
      'command = "/Applications/Pencil.app/server"',
      '',
      '[mcp_servers.tipatask]',
      'command = "/old/mcp-node"',
      'args = ["/old/server.js"]',
      'default_tools_approval_mode = "auto"',
      '',
      '[mcp_servers.tipatask.tools.get_tag_architectures]',
      'approval_mode = "approve"',
      '',
      '[features]',
      'guardian_approval = true',
      '',
    ].join('\n'));

    updateGlobalCodexMcpApprovalConfig({ targetPath });

    const out = fs.readFileSync(targetPath, 'utf8');
    const topLevel = out.slice(0, out.indexOf('['));
    assert.equal(toml.parse(out).mcp_servers.tipatask, undefined);
    assert.doesNotMatch(topLevel, /^\s*default_tools_approval_mode\s*=/m);
    assert.doesNotMatch(out, /\[mcp_servers\.tipatask\.tools\./);
    assert.doesNotMatch(out, /^\s*approval_mode = "approve"/m);
    assert.match(out, /\[features\][\s\S]*guardian_approval = false/);
    assert.match(out, /\[mcp_servers\.pencil\][\s\S]*command = "\/Applications\/Pencil\.app\/server"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('project Codex config strips inherited tool approval overrides', () => {
  const dir = makeTempDir();
  try {
    const projectRoot = path.join(dir, 'project');
    const seedPath = path.join(dir, 'global.toml');
    const targetPath = path.join(projectRoot, '.codex', 'config.toml');
    fs.writeFileSync(seedPath, [
      '[mcp_servers.tipatask]',
      'command = "/old/mcp-node"',
      'default_tools_approval_mode = "auto"',
      '',
      '[mcp_servers.tipatask.tools.get_tag_architectures]',
      'approval_mode = "approve"',
      '',
    ].join('\n'));

    writeCodexMcpConfig({ targetPath, projectRoot, seedPath });

    const out = fs.readFileSync(targetPath, 'utf8');
    assert.match(out, new RegExp(`\\[mcp_servers\\.tipatask\\][\\s\\S]*default_tools_approval_mode = "${CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE}"`));
    assert.doesNotMatch(out, /\[mcp_servers\.tipatask\.tools\./);
    assert.doesNotMatch(out, /^\s*approval_mode = "approve"/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Global MCP inheritance (TPT94) ──

test('writeCodexMcpConfig imports a server added globally after project config exists', () => {
  const dir = makeTempDir();
  try {
    const projectRoot = path.join(dir, 'project');
    const seedPath = path.join(dir, 'global.toml');
    const targetPath = path.join(projectRoot, '.codex', 'config.toml');

    writeCodexMcpConfig({ targetPath, projectRoot, seedPath });
    // A neutral fixture name — not one of BROWSER_MCP_PRESETS' own ids (TPT95), so this
    // inheritance test stays independent of that feature's own dedicated tests below.
    fs.writeFileSync(seedPath, [
      '[mcp_servers.pencil]',
      'command = "npx"',
      'args = ["@pencil/mcp@latest"]',
      '',
    ].join('\n'));

    writeCodexMcpConfig({ targetPath, projectRoot, seedPath });

    const out = fs.readFileSync(targetPath, 'utf8');
    assert.match(out, /\[mcp_servers\.pencil\][\s\S]*command = "npx"/);
    assert.match(out, /\[mcp_servers\.tipatask\]/);
    assert.match(out, /\[mcp_servers\.tipatask-local\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeGlobalMcpServerTables keeps the project-defined server subtree intact', () => {
  const project = [
    '[mcp_servers.browser]',
    'command = "/project/browser"',
    '',
    '[mcp_servers.browser.env]',
    'CHANNEL = "project"',
    '',
  ].join('\n');
  const global = [
    '[mcp_servers.browser]',
    'command = "/global/browser"',
    '',
    '[mcp_servers.browser.env]',
    'CHANNEL = "global"',
    '',
    '[mcp_servers.other]',
    'command = "/global/other"',
    '',
  ].join('\n');

  const out = mergeGlobalMcpServerTables(project, global);

  assert.match(out, /command = "\/project\/browser"/);
  assert.match(out, /CHANNEL = "project"/);
  assert.doesNotMatch(out, /\/global\/browser|CHANNEL = "global"/);
  assert.match(out, /\[mcp_servers\.other\][\s\S]*command = "\/global\/other"/);
});

test('mergeGlobalMcpServerTables copies all nested tables for a quoted server name', () => {
  const global = [
    '[mcp_servers."chrome.devtools"]',
    'command = "chrome-devtools-mcp"',
    '',
    '[mcp_servers."chrome.devtools".env]',
    'CHANNEL = "stable"',
    '',
    '[[rules]]',
    'name = "global-only-rule"',
    '',
  ].join('\n');

  const out = mergeGlobalMcpServerTables('model = "gpt-5.5"\n', global);

  assert.match(out, /\[mcp_servers\."chrome\.devtools"\]/);
  assert.match(out, /\[mcp_servers\."chrome\.devtools"\.env\]/);
  assert.match(out, /CHANNEL = "stable"/);
  assert.doesNotMatch(out, /global-only-rule/);
});

test('MCP inheritance retains nested arrays of tables and adjacent comments', () => {
  const global = [
    '# global server',
    '[mcp_servers."chrome.devtools"] # server header',
    'command = "global" # keep inline comment',
    '',
    '[[mcp_servers."chrome.devtools".headers]]',
    'name = "X-First"',
    '',
    '[[mcp_servers."chrome.devtools".headers]]',
    'name = "X-Second"',
    '',
    '[[rules]]',
    'name = "not a server"',
    '',
  ].join('\n');
  const inherited = mergeGlobalMcpServerTables('model = "project"\n', global);
  assert.equal(toml.parse(inherited).mcp_servers['chrome.devtools'].headers.length, 2);
  assert.match(inherited, /command = "global" # keep inline comment/);
  assert.doesNotMatch(inherited, /not a server/);
  assert.equal(mergeGlobalMcpServerTables(inherited, global), inherited);

  const project = '[mcp_servers."chrome.devtools"]\ncommand = "project"\n';
  assert.equal(mergeGlobalMcpServerTables(project, global), project);
});

test('TOML parsing cannot pollute Object.prototype through scalar table paths', () => {
  const marker = '__tpt339_pollution_marker__';
  const payloads = [
    `[a.b]\ny = 1\n[a.b.y.__proto__.__proto__]\n${marker} = "yes"\n`,
    `aa = 1\n[[a]]\n[aa.__proto__.__proto__]\n${marker} = "yes"\n`,
  ];
  const script = `
    const toml = require('toml');
    const marker = ${JSON.stringify(marker)};
    const payloads = ${JSON.stringify(payloads)};
    for (const payload of payloads) {
      try { toml.parse(payload); } catch {}
      if (Object.prototype.hasOwnProperty.call(Object.prototype, marker) || ({})[marker] !== undefined) process.exit(1);
    }
  `;
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', script], {
    cwd: path.join(__dirname, '..'), timeout: 3000, encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('deep TOML produces a bounded, non-destructive configuration error', () => {
  const dir = makeTempDir();
  try {
    const targetPath = path.join(dir, 'config.toml');
    const content = `value = ${'['.repeat(3000)}1${']'.repeat(3000)}\n`;
    fs.writeFileSync(targetPath, content);
    const script = [
      "const fs = require('node:fs');",
      "const { writeCodexMcpConfig } = require('./src/codex-mcp-config');",
      "try { writeCodexMcpConfig({ targetPath: process.argv[1], projectRoot: process.argv[2] }); process.exit(1); }",
      "catch (err) { if (!/Invalid Codex configuration.*existing file preserved/.test(err.message)) process.exit(2); }",
    ].join('\n');
    const result = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', script, targetPath, dir], {
      cwd: path.join(__dirname, '..'), timeout: 15000, encoding: 'utf8', maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.equal(fs.readFileSync(targetPath, 'utf8'), content);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeGlobalMcpServerTables treats malformed global TOML as a no-op', () => {
  const project = '[mcp_servers.project]\ncommand = "/project"\n';
  const malformed = '[mcp_servers.broken]\nargs = [\n';
  assert.equal(mergeGlobalMcpServerTables(project, malformed), project);
});

test('writeCodexMcpConfig does not seed malformed global TOML into a new project', () => {
  const dir = makeTempDir();
  try {
    const projectRoot = path.join(dir, 'project');
    const seedPath = path.join(dir, 'global.toml');
    const targetPath = path.join(projectRoot, '.codex', 'config.toml');
    fs.writeFileSync(seedPath, '[mcp_servers.broken]\nargs = [\n');

    writeCodexMcpConfig({ targetPath, projectRoot, seedPath });

    const out = fs.readFileSync(targetPath, 'utf8');
    assert.doesNotMatch(out, /mcp_servers\.broken/);
    assert.match(out, /\[mcp_servers\.tipatask\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getCodexPaths honors an exported user CODEX_HOME outside the project', () => {
  const paths = getCodexPaths('/workspace/project', {
    env: { CODEX_HOME: '/workspace/user-codex' },
    homeDir: '/home/tester',
  });
  assert.equal(paths.globalCodexDir, path.resolve('/workspace/user-codex'));
  assert.equal(paths.globalConfigPath, path.resolve('/workspace/user-codex/config.toml'));
  assert.equal(paths.globalAuthPath, path.resolve('/workspace/user-codex/auth.json'));
});

test('getCodexPaths ignores CODEX_HOME when it already names the project home', () => {
  const projectRoot = '/workspace/project';
  const paths = getCodexPaths(projectRoot, {
    env: { CODEX_HOME: path.join(projectRoot, '.codex') },
    homeDir: '/home/tester',
  });
  assert.equal(paths.globalCodexDir, path.resolve('/home/tester/.codex'));
  assert.equal(paths.projectCodexDir, path.resolve(projectRoot, '.codex'));
});

// ── Directory-trust pre-approval (C1048) ──

test('upsertProjectTrustLevel writes a trusted entry keyed by the resolved absolute project root', () => {
  const out = upsertProjectTrustLevel('', '/Users/testuser/Projects/MyApp');
  assert.match(out, /\[projects\."\/Users\/testuser\/Projects\/MyApp"\]/);
  assert.match(out, /\[projects\."\/Users\/testuser\/Projects\/MyApp"\][\s\S]*trust_level = "trusted"/);
});

test('upsertProjectTrustLevel is a no-op when projectRoot is absent', () => {
  const seed = '[mcp_servers.tipatask]\ncommand = "/x"\n';
  assert.equal(upsertProjectTrustLevel(seed, undefined), seed);
  assert.equal(upsertProjectTrustLevel(seed, null), seed);
  assert.equal(upsertProjectTrustLevel(seed, ''), seed);
});

test('writeCodexMcpConfig marks the project directory trusted in the project-local config.toml', () => {
  const dir = makeTempDir();
  try {
    const projectRoot = path.join(dir, 'project');
    const targetPath = path.join(projectRoot, '.codex', 'config.toml');

    writeCodexMcpConfig({ targetPath, projectRoot });

    const out = fs.readFileSync(targetPath, 'utf8');
    assert.match(out, new RegExp(`\\[projects\\.${JSON.stringify(path.resolve(projectRoot)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][\\s\\S]*trust_level = "trusted"`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCodexMcpConfig is idempotent when the project is already trusted', () => {
  const dir = makeTempDir();
  try {
    const projectRoot = path.join(dir, 'project');
    const targetPath = path.join(projectRoot, '.codex', 'config.toml');

    writeCodexMcpConfig({ targetPath, projectRoot });
    const first = fs.readFileSync(targetPath, 'utf8');
    const firstMtime = fs.statSync(targetPath).mtimeMs;

    writeCodexMcpConfig({ targetPath, projectRoot });
    const second = fs.readFileSync(targetPath, 'utf8');

    assert.equal(second, first);
    assert.equal(fs.statSync(targetPath).mtimeMs, firstMtime, 'expected no rewrite on an unchanged config');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCodexMcpConfig force-overwrites a project previously marked untrusted', () => {
  const dir = makeTempDir();
  try {
    const projectRoot = path.join(dir, 'project');
    const targetPath = path.join(projectRoot, '.codex', 'config.toml');
    const absRoot = path.resolve(projectRoot);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, [
      `[projects.${JSON.stringify(absRoot)}]`,
      'trust_level = "untrusted"',
      '',
    ].join('\n'));

    writeCodexMcpConfig({ targetPath, projectRoot });

    const out = fs.readFileSync(targetPath, 'utf8');
    assert.match(out, new RegExp(`\\[projects\\.${JSON.stringify(absRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][\\s\\S]*trust_level = "trusted"`));
    assert.doesNotMatch(out, /trust_level = "untrusted"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updateGlobalCodexMcpApprovalConfig marks the project trusted without disturbing unrelated projects', () => {
  const dir = makeTempDir();
  try {
    const targetPath = path.join(dir, 'config.toml');
    const otherRoot = '/Users/other/Projects/Other';
    fs.writeFileSync(targetPath, [
      `[projects.${JSON.stringify(otherRoot)}]`,
      'trust_level = "trusted"',
      '',
      '[mcp_servers.tipatask]',
      'command = "/old/mcp-node"',
      '',
    ].join('\n'));

    const projectRoot = '/Users/testuser/Projects/MyApp';
    updateGlobalCodexMcpApprovalConfig({ targetPath, projectRoot });

    const out = fs.readFileSync(targetPath, 'utf8');
    assert.match(out, new RegExp(`\\[projects\\.${JSON.stringify(projectRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][\\s\\S]*trust_level = "trusted"`));
    assert.match(out, new RegExp(`\\[projects\\.${JSON.stringify(otherRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][\\s\\S]*trust_level = "trusted"`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('packaged asar path (local section): uses Electron binary + ELECTRON_RUN_AS_NODE, no NODE_COMPILE_CACHE', () => {
  // Simulate a packaged Electron build where mcpServerPath is inside app.asar.
  // The OS cannot spawn plain-node from inside an asar (posix_spawn hits ENOTDIR).
  // Fix: use process.execPath (the Electron binary) + ELECTRON_RUN_AS_NODE=1.
  const asarMcpPath = '/Applications/TipΔTask.app/Contents/Resources/app.asar/src/mcp/server.js';
  const projectRoot = '/Users/testuser/Projects/MyApp';
  const { sectionName, sectionLines } = buildCodexLocalMcpSection({ mcpServerPath: asarMcpPath, projectRoot });
  const toml = sectionLines.join('\n');

  // C1382 — registered under the -local name, not the primary 'tipatask' name.
  assert.equal(sectionName, 'mcp_servers.tipatask-local');
  // command must be the current process executable (Electron binary), not a path inside asar
  assert.match(toml, new RegExp(`command = ${JSON.stringify(process.execPath)}`));
  // server.js arg is the asar-internal path — Electron reads it transparently
  assert.match(toml, new RegExp(`args = \\[${JSON.stringify(asarMcpPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`));
  // ELECTRON_RUN_AS_NODE must be present so Electron acts as Node
  assert.match(toml, /ELECTRON_RUN_AS_NODE = "1"/);
  // NODE_COMPILE_CACHE must NOT appear (it would resolve inside the read-only asar)
  assert.doesNotMatch(toml, /NODE_COMPILE_CACHE/);
  // C1382 — registers only the 4 tools that still need a local checkout
  assert.match(toml, /TIPATASK_MCP_LOCAL_ONLY = "1"/);
  assert.ok(toml.includes(`TIPATASK_USER_DATA = ${JSON.stringify(path.resolve(process.env.TIPATASK_USER_DATA || path.resolve(path.dirname(asarMcpPath), '../..')))}`));
  assert.doesNotMatch(toml, /^\s*transport\s*=/m);
  // approval mode still set
  assert.match(toml, new RegExp(`default_tools_approval_mode = "${CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE}"`));
});

test('dev/plain-node path (local section): uses mcp-node wrapper + NODE_COMPILE_CACHE, no ELECTRON_RUN_AS_NODE', () => {
  const devMcpPath = '/Users/testuser/Projects/Tipatask/ai/todo/server/src/mcp/server.js';
  const projectRoot = '/Users/testuser/Projects/Tipatask';
  const { sectionName, sectionLines } = buildCodexLocalMcpSection({ mcpServerPath: devMcpPath, projectRoot });
  const toml = sectionLines.join('\n');

  assert.equal(sectionName, 'mcp_servers.tipatask-local');
  // command must NOT be the process.execPath electron binary branch
  assert.doesNotMatch(toml, /ELECTRON_RUN_AS_NODE/);
  // NODE_COMPILE_CACHE must be present
  assert.match(toml, /NODE_COMPILE_CACHE/);
  // command uses the mcp-node wrapper under the server root (not inside asar)
  assert.match(toml, /mcp-node/);
  assert.match(toml, /TIPATASK_MCP_LOCAL_ONLY = "1"/);
  assert.ok(toml.includes(`TIPATASK_USER_DATA = ${JSON.stringify(path.resolve(process.env.TIPATASK_USER_DATA || path.resolve(path.dirname(devMcpPath), '../..')))}`));
  assert.doesNotMatch(toml, /^\s*transport\s*=/m);
});

// ── Remote HTTP section (C1382) ──

test('buildCodexMcpSection (remote): emits concrete url + bearer env-var name, never token text or transport', () => {
  const dir = makeTempDir();
  try {
    const projectRoot = path.join(dir, 'project');
    writeProjectConfig(projectRoot, { API_BASE_URL: 'https://tt.example.com/', API_PROJECT_ID: '7', API_TOKEN: 'secret-jwt-value' });

    const { sectionName, sectionLines } = buildCodexMcpSection({ projectRoot });
    const toml = sectionLines.join('\n');

    assert.equal(sectionName, 'mcp_servers.tipatask');
    assert.doesNotMatch(toml, /^\s*transport\s*=/m);
    // trailing slash on API_BASE_URL must be trimmed before the path is appended
    assert.match(toml, /url = "https:\/\/tt\.example\.com\/api\/projects\/7\/mcp"/);
    assert.match(toml, /bearer_token_env_var = "TIPATASK_API_TOKEN"/);
    assert.doesNotMatch(toml, /secret-jwt-value/);
    assert.doesNotMatch(toml, /http_headers/);
    assert.doesNotMatch(toml, /Authorization/);
    // Static bearer_token is unsupported; only its env-var form belongs in TOML.
    assert.doesNotMatch(toml, /bearer_token\s*=/);
    assert.doesNotMatch(toml, /^\s*command\s*=/m);
    assert.doesNotMatch(toml, /^\s*args\s*=/m);
    assert.doesNotMatch(toml, /^\s*env\s*=/m);
    assert.match(toml, new RegExp(`default_tools_approval_mode = "${CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE}"`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildCodexMcpSection (remote): blank API_TOKEN still emits only the env-var contract', () => {
  const dir = makeTempDir();
  try {
    const projectRoot = path.join(dir, 'project');
    writeProjectConfig(projectRoot, { API_BASE_URL: 'https://tt.example.com', API_PROJECT_ID: '7', API_TOKEN: '' });

    const { sectionLines } = buildCodexMcpSection({ projectRoot });
    const toml = sectionLines.join('\n');

    assert.doesNotMatch(toml, /http_headers/);
    assert.doesNotMatch(toml, /Bearer/);
    assert.match(toml, /bearer_token_env_var = "TIPATASK_API_TOKEN"/);
    assert.match(toml, /url = "https:\/\/tt\.example\.com\/api\/projects\/7\/mcp"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildCodexMcpSection (remote): missing .tipatask/config.json degrades to an empty url, never throws', () => {
  const dir = makeTempDir();
  try {
    const projectRoot = path.join(dir, 'project-with-no-config');
    fs.mkdirSync(projectRoot, { recursive: true });

    const { sectionLines } = buildCodexMcpSection({ projectRoot });
    const toml = sectionLines.join('\n');

    assert.match(toml, /url = ""/);
    assert.doesNotMatch(toml, /http_headers/);
    assert.match(toml, /bearer_token_env_var = "TIPATASK_API_TOKEN"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const legacy of ['', '[mcp_servers.tipatask]\nurl = "https://old.test/api/projects/1/mcp"\nhttp_headers = { Authorization = "old-secret" }\n', '[mcp_servers.tipatask-local]\ncommand = "/old/mcp"\n']) {
  test(`global refresh removes project registrations while preserving user config (${legacy.length})`, () => {
    const dir = makeTempDir();
    try {
      const targetPath = path.join(dir, 'config.toml');
      fs.writeFileSync(targetPath, 'model = "user-model"\n[mcp_servers.other]\ncommand = "/other/mcp"\n' + legacy);
      updateGlobalCodexMcpApprovalConfig({ targetPath, projectRoot: dir });
      const out = fs.readFileSync(targetPath, 'utf8');
      const parsed = toml.parse(out);
      assert.equal(parsed.mcp_servers.tipatask, undefined);
      assert.equal(parsed.mcp_servers['tipatask-local'], undefined);
      assert.equal(parsed.mcp_servers.other.command, '/other/mcp');
      assert.equal(parsed.model, 'user-model');
      assert.doesNotMatch(out, /old-secret|old.test/);
      updateGlobalCodexMcpApprovalConfig({ targetPath, projectRoot: dir });
      assert.equal(fs.readFileSync(targetPath, 'utf8'), out);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('writeCodexMcpConfig removes a legacy inline Authorization header and every token value', () => {
  const dir = makeTempDir();
  try {
    const projectRoot = path.join(dir, 'project');
    const targetPath = path.join(projectRoot, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, [
      '[mcp_servers.tipatask]',
      'transport = "streamable_http"',
      'url = "https://old.example.test/api/projects/1/mcp"',
      'http_headers = { Authorization = "Bearer old-inline-token" }',
      '',
      '[mcp_servers.tipatask-local]',
      'transport = "stdio"',
      'command = "/old/mcp-node"',
      '',
      '[mcp_servers.other]',
      'command = "/other/server"',
      'transport = "stdio"',
      '',
    ].join('\n'));
    writeProjectConfig(projectRoot, {
      API_BASE_URL: 'https://tt.example.com',
      API_PROJECT_ID: '9',
      API_TOKEN: 'new-live-token',
    });

    writeCodexMcpConfig({ targetPath, projectRoot });

    const out = fs.readFileSync(targetPath, 'utf8');
    const servers = toml.parse(out).mcp_servers;
    assert.equal(servers.tipatask.url, 'https://tt.example.com/api/projects/9/mcp');
    assert.equal(servers.tipatask.bearer_token_env_var, 'TIPATASK_API_TOKEN');
    assert.equal(servers.tipatask.http_headers, undefined);
    assert.equal(servers.tipatask.transport, undefined);
    assert.equal(servers['tipatask-local'].transport, undefined);
    assert.ok(servers['tipatask-local'].command.endsWith('mcp-node'));
    assert.equal(servers.other.transport, 'stdio');
    assert.doesNotMatch(out, /old-inline-token|new-live-token|Authorization|Bearer/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('global refresh removes project-specific local entries and preserves unrelated servers', () => {
  const dir = makeTempDir();
  try {
    const targetPath = path.join(dir, 'config.toml');
    fs.writeFileSync(targetPath, [
      'model = "user-model"',
      '',
      '[mcp_servers.tipatask-local]',
      'transport = "stdio" # old generated key',
      'command = "/custom/mcp"',
      'args = ["--custom"]',
      'env = { CUSTOM = "yes" }',
      '',
      '[mcp_servers.other]',
      'transport = "stdio"',
      'command = "/other/mcp"',
      '',
    ].join('\n'));

    updateGlobalCodexMcpApprovalConfig({ targetPath });

    const parsed = toml.parse(fs.readFileSync(targetPath, 'utf8'));
    assert.equal(parsed.model, 'user-model');
    assert.equal(parsed.mcp_servers['tipatask-local'], undefined);
    assert.equal(parsed.mcp_servers.other.transport, 'stdio');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('global cleanup recognizes hyphenated tipatask-local', () => {
  const dir = makeTempDir();
  try {
    const targetPath = path.join(dir, 'config.toml');
    fs.writeFileSync(targetPath, ['[mcp_servers.tipatask-local]', 'command = "/x"', ''].join('\n'));
    updateGlobalCodexMcpApprovalConfig({ targetPath });
    const out = fs.readFileSync(targetPath, 'utf8');
    assert.equal(toml.parse(out).mcp_servers?.['tipatask-local'], undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// ── Opt-in browser-tools MCP presets (TPT95) ────────────────────────────────────
// Deliberately do NOT call ensureProjectCodexHome() anywhere below — it always also
// calls updateGlobalCodexMcpApprovalConfig against the real os.homedir()/.codex/
// config.toml with no override, so a test invoking it would rewrite the developer's
// actual global Codex config. Every case here stays on writeCodexMcpConfig (explicit
// targetPath) and the pure applyBrowserToolPresets/normalizeBrowserToolIds helpers.

test('normalizeBrowserToolIds defaults to both presets and drops unknown/invalid ids', () => {
  const bothIds = BROWSER_MCP_PRESETS.map(p => p.id);
  assert.deepEqual(normalizeBrowserToolIds(undefined), bothIds);
  assert.deepEqual(normalizeBrowserToolIds(null), bothIds);
  assert.deepEqual(normalizeBrowserToolIds('not-an-array'), bothIds);
  assert.deepEqual(normalizeBrowserToolIds([]), []);
  assert.deepEqual(normalizeBrowserToolIds(['playwright', 'nonsense', 'playwright', 42]), ['playwright']);
});

test('readRequiredNodeMajor reads engines.node and falls back to 22', () => {
  const dir = makeTempDir();
  try {
    const pkgPath = path.join(dir, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({ engines: { node: '>=24.3.0' } }));
    assert.equal(readRequiredNodeMajor(pkgPath), 24);
    assert.equal(readRequiredNodeMajor(path.join(dir, 'missing.json')), 22);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBrowserMcpRuntime skips stale PATH Node and selects compatible nvm npx', () => {
  const dir = makeTempDir();
  try {
    const staleBin = path.join(dir, 'stale', 'bin');
    const nvmBin = path.join(dir, '.nvm', 'versions', 'node', 'v22.22.1', 'bin');
    const staleNode = path.join(staleBin, 'node');
    const nvmNode = path.join(nvmBin, 'node');
    makeExecutable(staleNode);
    makeExecutable(path.join(staleBin, 'npx'));
    makeExecutable(nvmNode);
    makeExecutable(path.join(nvmBin, 'npx'));

    const runtime = resolveBrowserMcpRuntime({
      env: { PATH: `${staleBin}:/usr/bin`, NVM_DIR: path.join(dir, '.nvm') },
      homeDir: dir,
      platform: 'darwin',
      requiredMajor: 22,
      execFileSyncImpl(command) {
        return command === staleNode ? 'v14.17.0\n' : 'v22.22.1\n';
      },
    });

    assert.equal(runtime.available, true);
    assert.equal(runtime.nodePath, nvmNode);
    assert.equal(runtime.npxPath, path.join(nvmBin, 'npx'));
    assert.equal(runtime.path.split(':')[0], nvmBin);
    assert.equal(runtime.path, `${nvmBin}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBrowserMcpRuntime fails closed when TIPATASK_NODE is incompatible', () => {
  const dir = makeTempDir();
  try {
    const binDir = path.join(dir, 'override', 'bin');
    const nodePath = path.join(binDir, 'node');
    makeExecutable(nodePath);
    makeExecutable(path.join(binDir, 'npx'));
    const runtime = resolveBrowserMcpRuntime({
      env: { TIPATASK_NODE: nodePath, PATH: '' },
      homeDir: dir,
      platform: 'linux',
      requiredMajor: 22,
      execFileSyncImpl: () => 'v20.20.2\n',
    });
    assert.equal(runtime.available, false);
    assert.match(runtime.reason, /TIPATASK_NODE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyBrowserToolPresets(content, null) returns the identical string (unmanaged no-op)', () => {
  const content = 'model = "gpt-5.5"\n';
  assert.equal(applyBrowserToolPresets(content, null), content);
});

test('applyBrowserToolPresets writes both presets with the marker and approval mode', () => {
  const out = applyBrowserToolPresets('', ['playwright', 'chrome-devtools'], TEST_BROWSER_RUNTIME);
  const parsed = toml.parse(out);
  assert.equal(parsed.mcp_servers.playwright.command, TEST_BROWSER_RUNTIME.npxPath);
  assert.deepEqual(parsed.mcp_servers.playwright.args, ['-y', '@playwright/mcp@latest']);
  assert.equal(parsed.mcp_servers.playwright.env.PATH, TEST_BROWSER_RUNTIME.path);
  assert.equal(parsed.mcp_servers.playwright.startup_timeout_sec, 60);
  assert.equal(parsed.mcp_servers.playwright.default_tools_approval_mode, CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE);
  assert.equal(parsed.mcp_servers['chrome-devtools'].command, TEST_BROWSER_RUNTIME.npxPath);
  assert.deepEqual(parsed.mcp_servers['chrome-devtools'].args, ['-y', 'chrome-devtools-mcp@latest']);
  assert.equal(parsed.mcp_servers['chrome-devtools'].env.PATH, TEST_BROWSER_RUNTIME.path);
  assert.match(out, new RegExp(`\\[mcp_servers\\.playwright\\]\\n${BROWSER_PRESET_MARKER.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`));
});

test('applyBrowserToolPresets disables managed presets when no compatible Node runtime exists', () => {
  const out = applyBrowserToolPresets('', ['playwright'], {
    available: false,
    requiredMajor: 22,
    reason: 'not found',
  });
  const parsed = toml.parse(out);
  assert.equal(parsed.mcp_servers.playwright.enabled, false);
  assert.equal(parsed.mcp_servers.playwright.command, 'npx');
  assert.deepEqual(parsed.mcp_servers.playwright.args, ['-y', '@playwright/mcp@latest']);
  assert.equal(parsed.mcp_servers.playwright.startup_timeout_sec, 60);
  assert.match(out, /Disabled: Tipatask could not find Node >=22/);
});

test('applyBrowserToolPresets leaves an unmarked user-defined section alone when enabling', () => {
  const content = '[mcp_servers.playwright]\ncommand = "/custom/pw"\n';
  assert.equal(applyBrowserToolPresets(content, ['playwright']), content);
});

test('applyBrowserToolPresets refreshes a marker-owned section back to the current preset shape', () => {
  const stale = [
    '[mcp_servers.playwright]',
    BROWSER_PRESET_MARKER,
    'command = "npx"',
    'args = ["@playwright/mcp@0.1.0"]',
    '',
  ].join('\n');
  const out = applyBrowserToolPresets(stale, ['playwright'], TEST_BROWSER_RUNTIME);
  const parsed = toml.parse(out);
  assert.equal(parsed.mcp_servers.playwright.command, TEST_BROWSER_RUNTIME.npxPath);
  assert.deepEqual(parsed.mcp_servers.playwright.args, ['-y', '@playwright/mcp@latest']);
});

test('applyBrowserToolPresets removes a marker-owned section and its whole subtree on uncheck', () => {
  const content = [
    '[mcp_servers.playwright]',
    BROWSER_PRESET_MARKER,
    'command = "npx"',
    'args = ["@playwright/mcp@latest"]',
    '',
    '[mcp_servers.playwright.env]',
    'FOO = "1"',
    '',
    '[mcp_servers.other]',
    'command = "/keep/me"',
    '',
  ].join('\n');
  const out = applyBrowserToolPresets(content, []);
  assert.doesNotMatch(out, /playwright/);
  assert.match(out, /\[mcp_servers\.other\][\s\S]*command = "\/keep\/me"/);
});

test('applyBrowserToolPresets leaves an unmarked section alone when disabling', () => {
  const content = '[mcp_servers.playwright]\ncommand = "/custom/pw"\n';
  assert.equal(applyBrowserToolPresets(content, []), content);
});

test('applyBrowserToolPresets never turns an unknown enabled id into an injected section', () => {
  const out = applyBrowserToolPresets('', ['foo]\n[evil']);
  assert.doesNotMatch(out, /\[evil\]/);
  assert.equal(out, '');
});

// The live hazard this app must never reproduce: a header carrying a trailing comment
// is invisible to an exact-equality upsert, so a naive implementation would emit a
// SECOND [mcp_servers.playwright] table here — which toml.parse rejects outright.
test('applyBrowserToolPresets does not duplicate a section whose header carries a trailing comment', () => {
  const content = '[mcp_servers.playwright] # mine\ncommand = "/x"\n';
  const out = applyBrowserToolPresets(content, ['playwright']);
  assert.doesNotThrow(() => toml.parse(out));
  assert.equal(out, content);
});

test('writeCodexMcpConfig with browserTools is idempotent (byte-identical, no second write)', () => {
  const dir = makeTempDir();
  try {
    const projectRoot = path.join(dir, 'project');
    const targetPath = path.join(projectRoot, '.codex', 'config.toml');
    writeCodexMcpConfig({ targetPath, projectRoot, browserTools: ['playwright', 'chrome-devtools'], browserRuntime: TEST_BROWSER_RUNTIME });
    const first = fs.readFileSync(targetPath, 'utf8');
    const mtimeBefore = fs.statSync(targetPath).mtimeMs;
    writeCodexMcpConfig({ targetPath, projectRoot, browserTools: ['playwright', 'chrome-devtools'], browserRuntime: TEST_BROWSER_RUNTIME });
    assert.equal(fs.readFileSync(targetPath, 'utf8'), first);
    assert.equal(fs.statSync(targetPath).mtimeMs, mtimeBefore);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Note: writeCodexMcpConfig's section-append helpers place a re-added section wherever
// the file currently ends (a pre-existing, unrelated trait of upsertTomlSection's "not
// found → append at end" branch, also reachable via tipatask/tipatask-local), so a
// remove-then-re-add cycle can change byte-for-byte file layout. The real invariant is
// the parsed server definition, not its position in the file.
test('writeCodexMcpConfig toggle round-trip re-adds an equivalent playwright entry', () => {
  const dir = makeTempDir();
  try {
    const projectRoot = path.join(dir, 'project');
    const targetPath = path.join(projectRoot, '.codex', 'config.toml');
    writeCodexMcpConfig({ targetPath, projectRoot, browserTools: ['playwright'], browserRuntime: TEST_BROWSER_RUNTIME });
    const run1 = toml.parse(fs.readFileSync(targetPath, 'utf8')).mcp_servers.playwright;
    writeCodexMcpConfig({ targetPath, projectRoot, browserTools: [] });
    assert.doesNotMatch(fs.readFileSync(targetPath, 'utf8'), /mcp_servers\.playwright/);
    writeCodexMcpConfig({ targetPath, projectRoot, browserTools: ['playwright'], browserRuntime: TEST_BROWSER_RUNTIME });
    const run3 = toml.parse(fs.readFileSync(targetPath, 'utf8')).mcp_servers.playwright;
    assert.deepEqual(run3, run1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCodexMcpConfig parses chrome-devtools with a real TOML parser, approval mode included', () => {
  const dir = makeTempDir();
  try {
    const projectRoot = path.join(dir, 'project');
    const targetPath = path.join(projectRoot, '.codex', 'config.toml');
    writeCodexMcpConfig({ targetPath, projectRoot, browserTools: ['chrome-devtools'], browserRuntime: TEST_BROWSER_RUNTIME });
    const parsed = toml.parse(fs.readFileSync(targetPath, 'utf8'));
    assert.equal(parsed.mcp_servers['chrome-devtools'].command, TEST_BROWSER_RUNTIME.npxPath);
    assert.deepEqual(parsed.mcp_servers['chrome-devtools'].args, ['-y', 'chrome-devtools-mcp@latest']);
    assert.equal(parsed.mcp_servers['chrome-devtools'].env.PATH, TEST_BROWSER_RUNTIME.path);
    assert.equal(parsed.mcp_servers['chrome-devtools'].startup_timeout_sec, 60);
    assert.equal(parsed.mcp_servers['chrome-devtools'].default_tools_approval_mode, CODEX_MCP_DEFAULT_TOOLS_APPROVAL_MODE);
    assert.equal(parsed.mcp_servers.playwright, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Pins the accepted TPT94/TPT95 interaction (documented, not "fixed" later by accident):
// a hand-defined section in the GLOBAL seed is inherited as user-defined, so disabling
// the same-named preset never removes it — the section is never marker-owned. The first
// two calls each still rewrite the file (a pre-existing, unrelated quirk: the
// project-wide upsertKeyInAllMcpServerSections sweep injects an approval key into the
// inherited section, which shifts where upsertTomlSection needs to insert a blank line
// before the next table on the following pass); by the third call nothing has changed
// since the previous write, so it settles into a true no-op. Throughout, the custom
// command is never touched and no preset is ever added for playwright.
test('a hand-defined global playwright server survives disabling the preset (seed wins)', () => {
  const dir = makeTempDir();
  try {
    const projectRoot = path.join(dir, 'project');
    const seedPath = path.join(dir, 'global.toml');
    const targetPath = path.join(projectRoot, '.codex', 'config.toml');
    fs.writeFileSync(seedPath, '[mcp_servers.playwright]\ncommand = "/custom"\n');

    writeCodexMcpConfig({ targetPath, projectRoot, seedPath, browserTools: [] });
    writeCodexMcpConfig({ targetPath, projectRoot, seedPath, browserTools: [] });
    const settled = fs.readFileSync(targetPath, 'utf8');
    assert.match(settled, /command = "\/custom"/);
    assert.doesNotMatch(settled, new RegExp(BROWSER_PRESET_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const mtimeBefore = fs.statSync(targetPath).mtimeMs;
    writeCodexMcpConfig({ targetPath, projectRoot, seedPath, browserTools: [] });
    assert.equal(fs.statSync(targetPath).mtimeMs, mtimeBefore);
    assert.equal(fs.readFileSync(targetPath, 'utf8'), settled);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('existing Codex homes backfill missing global preferences while keeping project values', () => {
  const { mergeGlobalCodexPreferences } = require('./codex-mcp-config');
  const local = '# keep comment\nmodel = "project-model"\n[features] # custom\nweb_search = false\n[mcp_servers.local]\ncommand = "local"\n';
  const global = 'model = "global-model"\nmodel_reasoning_effort = "high"\n[features]\nweb_search = true\nunified_exec = true\n[shell_environment_policy]\ninherit = "all"\n[projects."/unrelated"]\ntrust_level = "trusted"\n';
  const out = mergeGlobalCodexPreferences(local, global);
  const parsed = toml.parse(out);
  assert.equal(parsed.model, 'project-model');
  assert.equal(parsed.model_reasoning_effort, 'high');
  assert.equal(parsed.features.web_search, false);
  assert.equal(parsed.features.unified_exec, true);
  assert.equal(parsed.shell_environment_policy.inherit, 'all');
  assert.equal(parsed.projects, undefined);
  assert.match(out, /# keep comment/);
  assert.equal(mergeGlobalCodexPreferences(out, global), out);
  const updated = mergeGlobalCodexPreferences(out, global + '');
  assert.equal(updated, out);
  const nextGlobal = global.replace('inherit = "all"', 'inherit = "all"\nignore_default_excludes = false');
  assert.equal(toml.parse(mergeGlobalCodexPreferences(out, nextGlobal)).shell_environment_policy.ignore_default_excludes, false);
});

test('preference inheritance handles quoted tables, arrays and inline project overrides safely', () => {
  const { mergeGlobalCodexPreferences } = require('./codex-mcp-config');
  const local = '[profiles."custom.profile"]\nmodel = "mine"\n';
  const global = 'notify = ["sh", "notify.sh"]\n[profiles."custom.profile"]\nmodel = "other"\nmodel_reasoning_effort = "high"\n';
  const parsed = toml.parse(mergeGlobalCodexPreferences(local, global));
  assert.equal(parsed.profiles['custom.profile'].model, 'mine');
  assert.equal(parsed.profiles['custom.profile'].model_reasoning_effort, 'high');
  assert.deepEqual(parsed.notify, ['sh', 'notify.sh']);
  assert.equal(mergeGlobalCodexPreferences(local, 'broken = ['), local);
  const inline = 'features = { custom = false }\n';
  assert.equal(mergeGlobalCodexPreferences(inline, '[features]\ncustom = true\n'), inline);
});

test('config writers preserve malformed user TOML rather than attempting destructive repair', () => {
  const dir = makeTempDir();
  try {
    const targetPath = path.join(dir, 'config.toml');
    fs.writeFileSync(targetPath, '[broken\n');
    assert.throws(() => writeCodexMcpConfig({ targetPath, projectRoot: dir }), /existing file preserved/);
    assert.throws(() => updateGlobalCodexMcpApprovalConfig({ targetPath, projectRoot: dir }), /existing file preserved/);
    assert.equal(fs.readFileSync(targetPath, 'utf8'), '[broken\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
