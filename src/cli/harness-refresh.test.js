'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toml = require('toml');
// The account store defaults to USER_DATA_ROOT; keep this file's tokens in a private dir.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-harness-userdata-'));
const { readAccount } = require('../server/account-store');
const { installTemplates, refreshHarnessTemplates } = require('./install-templates');
const { readManifest, writeManifest, computeFileHash } = require('./manifest');
const { writeProjectSkillsConfig, writeProjectConfig, writeProjectMcpConfig } = require('../server/project-config');
const { copyTemplates } = require('../server/project-seeder');
const { runSyncSetupStep, analyzeSetupState, configureMcpServers } = require('./setup');
const { writeProjectCodexConfig } = require('../codex-mcp-config');
const { buildVcsDirective } = require('../server/vcs-settings');
const serverRoot = path.resolve(__dirname, '../..');
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
function put(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpt258-harness-'));
  const root = path.join(dir, 'project');
  fs.mkdirSync(root);
  const home = path.join(dir, 'user-codex');
  put(home, 'config.toml', 'model = "user-model"\n');
  put(home, 'auth.json', '{"fixture":true}');
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, root, home };
}
for (const preset of ['original-specification', 'existing-code']) {
  test(`desktop ${preset} setup installs both root guides before preset context`, t => {
    const { root } = fixture(t);
    copyTemplates(preset, root, 'Example project context');
    assert.match(read(root, 'AGENTS.md'), /Tipatask/);
    assert.match(read(root, 'CLAUDE.md'), /Tipatask/);
    assert.match(read(root, 'CLAUDE.md'), /Project Approach:/);
    for (const guide of ['AGENTS.md', 'CLAUDE.md']) assert.match(read(root, guide), /^## Version Control$/m, `${guide} carries the Version Control section`);
  });
}
test('desktop opens backfill AGENTS beside custom CLAUDE; repeated opens preserve edits and KB', t => {
  const { root } = fixture(t);
  put(root, 'CLAUDE.md', '# Custom Claude\n');
  put(root, 'ai/architecture/GENERAL.md', '# Real architecture\n');
  writeProjectSkillsConfig(root, serverRoot);
  assert.match(read(root, 'AGENTS.md'), /Tipatask/);
  const agents = read(root, 'AGENTS.md') + '\nCustom Codex rule\n';
  put(root, 'AGENTS.md', agents);
  for (let i = 0; i < 3; i++) writeProjectSkillsConfig(root, serverRoot);
  assert.equal(read(root, 'CLAUDE.md'), '# Custom Claude\n');
  assert.equal(read(root, 'AGENTS.md'), agents);
  assert.equal(read(root, 'ai/architecture/GENERAL.md'), '# Real architecture\n');
  assert.equal(fs.existsSync(path.join(root, 'preset-a.md')), false);
  assert.equal(fs.existsSync(path.join(root, '.tipatask/config.json')), false);
});
test('old userModified manifests stay protected and unrelated tracked entries survive', t => {
  const { root } = fixture(t);
  put(root, 'AGENTS.md', '# My edited guide\n');
  writeManifest(root, { version: 'old', files: {
    'AGENTS.md': { hash: computeFileHash(path.join(root, 'AGENTS.md')), userModified: true },
    'ai/architecture/GENERAL.md': { hash: 'unrelated-baseline' },
  } });
  for (let i = 0; i < 3; i++) refreshHarnessTemplates(root, serverRoot);
  assert.equal(read(root, 'AGENTS.md'), '# My edited guide\n');
  assert.equal(readManifest(root).files['ai/architecture/GENERAL.md'].hash, 'unrelated-baseline');
});
test('managed guides upgrade while edited guides survive repeated full installs', t => {
  const { root, dir } = fixture(t);
  const templatesDir = path.join(dir, 'templates');
  put(templatesDir, 'AGENTS.md', 'old guide\n');
  put(templatesDir, 'CLAUDE.md', 'old Claude\n');
  const opts = { projectRoot: root, templatesDir, packageVersion: '1' };
  installTemplates(opts);
  put(root, 'CLAUDE.md', 'edited Claude\n');
  put(templatesDir, 'AGENTS.md', 'new guide\n');
  for (let i = 0; i < 3; i++) installTemplates({ ...opts, packageVersion: '2' });
  assert.equal(read(root, 'CLAUDE.md'), 'edited Claude\n');
  assert.equal(read(root, 'AGENTS.md'), 'new guide\n');
});
test('installed templates carry a Version Control section that matches the runtime directive', () => {
  // The first line of each directive is the marker an agent sees at the top of a task kickoff prompt.
  const gitMarker = buildVcsDirective({ type: 'git', worktree: false, commit: true, pr: false, merge: false }).split('\n')[0];
  const svnMarker = buildVcsDirective({ type: 'svn' }).split('\n')[0];
  const offMarker = buildVcsDirective({ type: null }).split('\n')[0].split(' — ')[0];
  assert.equal(gitMarker, 'Version control (git) is enabled for this project:');
  assert.equal(offMarker, 'Version control is OFF for this project');
  for (const guide of ['CLAUDE.md', 'AGENTS.md']) {
    const text = read(serverRoot, `templates/${guide}`);
    assert.match(text, /^## Version Control$/m, `${guide} template has the section`);
    for (const marker of [gitMarker, svnMarker, offMarker]) assert.ok(text.includes(marker), `${guide} template names the directive marker "${marker}"`);
    assert.ok(text.includes('`git_worktree_status`'), `${guide} template says where to read the setting when no directive is present`);
    assert.match(text, /off by default/i);
    assert.match(text, /never run `git add`, `git commit`/, `${guide} template keeps the prohibition for off / commit off`);
    assert.doesNotMatch(text, /Git belongs to the user|no directive block/i, `${guide} template has no blanket git ban`);
  }
});
test('a userModified CLAUDE.md is never overwritten by a template refresh that adds the Version Control section', t => {
  const { root } = fixture(t);
  put(root, 'CLAUDE.md', '# My edited Claude guide\n');
  writeManifest(root, { version: 'old', files: {
    'CLAUDE.md': { hash: computeFileHash(path.join(root, 'CLAUDE.md')), userModified: true },
  } });
  for (let i = 0; i < 3; i++) refreshHarnessTemplates(root, serverRoot);
  assert.equal(read(root, 'CLAUDE.md'), '# My edited Claude guide\n');
  assert.doesNotMatch(read(root, 'CLAUDE.md'), /Version Control/);
  assert.match(read(root, 'AGENTS.md'), /^## Version Control$/m, 'the missing sibling guide is still created from the new template');
  assert.equal(readManifest(root).files['CLAUDE.md'].userModified, true);
});
test('refresh preserves custom hooks and malformed settings; unchanged refresh is idempotent', t => {
  const { root } = fixture(t);
  const custom = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo custom' }] };
  put(root, '.claude/settings.json', JSON.stringify({ custom: 'keep', hooks: { PreToolUse: [custom] } }));
  refreshHarnessTemplates(root, serverRoot);
  const once = read(root, '.claude/settings.json');
  const manifest = read(root, '.tipatask/install-manifest.json');
  const second = refreshHarnessTemplates(root, serverRoot);
  assert.equal(second.written.length, 0);
  assert.equal(second.merged.length, 0);
  assert.equal(read(root, '.claude/settings.json'), once);
  assert.equal(read(root, '.tipatask/install-manifest.json'), manifest);
  assert.deepEqual(JSON.parse(once).hooks.PreToolUse[0], custom);
  put(root, '.claude/settings.json', '{ broken');
  assert.ok(refreshHarnessTemplates(root, serverRoot).warnings.length);
  assert.equal(read(root, '.claude/settings.json'), '{ broken');
});
test('audit and dry-run classify missing/edited guides without writes or onboarding', async t => {
  const { root } = fixture(t);
  put(root, 'CLAUDE.md', '# Custom only\n');
  const env = { values: {} };
  const requestFn = () => { throw new Error('no API call expected'); };
  const state = await analyzeSetupState(env, root, { requestFn });
  assert.equal(state.hasKb, true);
  assert.ok(state.harness.written.some(f => f.path === 'AGENTS.md'));
  assert.ok(state.harness.skipped.some(f => f.path === 'CLAUDE.md'));
  await runSyncSetupStep({ env, projectRoot: root, dryRun: true, requestFn });
  assert.deepEqual(fs.readdirSync(root), ['CLAUDE.md']);
});
test('offline sync refreshes without an agent list and keeps credentials isolated', async t => {
  const { root, home } = fixture(t);
  writeProjectConfig(root, { API_BASE_URL: 'https://selected.test', API_PROJECT_ID: '78', API_TOKEN: 'selected-secret',
    DEVICE_ID: '4', MCP_BROWSER_TOOLS: [], PI_MODELS: [{ model: 'custom', apiKey: 'pi-secret' }] });
  const before = read(root, '.tipatask/config.json');
  const requestFn = async url => { assert.match(url, /^https:\/\/selected.test\//); throw new Error('offline'); };
  await runSyncSetupStep({ projectRoot: root, env: { values: {} }, requestFn, deviceIdPath: path.join(root, 'missing-device') });
  assert.match(read(root, 'AGENTS.md'), /Tipatask/);
  assert.equal(read(root, '.tipatask/config.json'), before);
  assert.equal(JSON.parse(read(root, '.mcp.json')).mcpServers['tipatask-local'].env.TIPATASK_PROJECT_ROOT, root);
  assert.equal(JSON.parse(read(root, '.claude/settings.local.json')).env.API_TOKEN, '');
  const codex = read(root, '.codex/config.toml');
  assert.equal(toml.parse(codex).mcp_servers.tipatask.url, 'https://selected.test/api/projects/78/mcp');
  assert.doesNotMatch(codex, /selected-secret|pi-secret/);
  assert.equal(fs.readlinkSync(path.join(root, '.codex/auth.json')), path.join(home, 'auth.json'));
});
test('sync keeps provider settings, merges remote agents and only calls device endpoints', async t => {
  const { root, dir } = fixture(t);
  const deviceIdPath = path.join(dir, 'device');
  fs.writeFileSync(deviceIdPath, 'machine-fixture');
  const cfg = { API_BASE_URL: 'https://selected.test', API_PROJECT_ID: '78', API_TOKEN: 'secret', DEVICE_ID: '4',
    TASK_AGENT: 'pi', AVAILABLE_AGENTS: 'pi', LAST_AGENT: 'pi', CODEX_MODEL: 'local-model', MCP_BROWSER_TOOLS: [],
    PI_MODELS: [{ model: 'custom', provider: 'custom', baseUrl: 'http://localhost:9000/v1', apiKey: 'key' }] };
  writeProjectConfig(root, cfg);
  const calls = [];
  const requestFn = async (url, opts) => {
    calls.push(url);
    assert.match(url, /^https:\/\/selected.test\/api\/devices/);
    if (opts.method === 'GET') return { status: 200, data: { device: { available_agents: 'claude,codex', task_agent: 'claude' } } };
    assert.equal(opts.body.task_agent, 'pi');
    return { status: 200 };
  };
  for (let i = 0; i < 2; i++) await runSyncSetupStep({ env: { values: { TASK_AGENT: 'claude' } }, projectRoot: root, requestFn, deviceIdPath });
  const saved = JSON.parse(read(root, '.tipatask/config.json'));
  assert.equal(saved.AVAILABLE_AGENTS, 'pi,claude,codex');
  for (const key of Object.keys(cfg).filter(k => k !== 'AVAILABLE_AGENTS' && k !== 'API_TOKEN')) assert.deepEqual(saved[key], cfg[key]);
  assert.ok(!Object.hasOwn(saved, 'API_TOKEN'), 'config.json never carries the token');
  assert.equal(readAccount(cfg.API_BASE_URL).token, cfg.API_TOKEN);
  assert.equal(calls.length, 4);
  assert.equal(fs.existsSync(path.join(root, '.env')), false);
});
test('CLI and desktop setup generate matching scoped MCP configuration', t => {
  const { root } = fixture(t);
  writeProjectConfig(root, { API_BASE_URL: 'https://selected.test', API_PROJECT_ID: '78', API_TOKEN: 'secret', MCP_BROWSER_TOOLS: [] });
  configureMcpServers({ projectRoot: root });
  const mcp = read(root, '.mcp.json');
  const codex = read(root, '.codex/config.toml');
  writeProjectMcpConfig(root, serverRoot);
  writeProjectCodexConfig(root, serverRoot);
  assert.equal(read(root, '.mcp.json'), mcp);
  assert.equal(read(root, '.codex/config.toml'), codex);
});

test('refresh rotates and clears Claude credentials while preserving unrelated settings', t => {
  const { root } = fixture(t);
  const { writeProjectClaudeMcpApproval } = require('../server/project-config');
  put(root, '.claude/settings.local.json', JSON.stringify({ env: { CUSTOM: 'keep', API_TOKEN: 'old-token' } }));
  for (const token of ['new-token', '']) {
    writeProjectConfig(root, { API_BASE_URL: 'https://selected.test', API_PROJECT_ID: '78', API_TOKEN: token });
    writeProjectClaudeMcpApproval(root);
    const env = JSON.parse(read(root, '.claude/settings.local.json')).env;
    assert.equal(env.API_TOKEN, '');
    assert.equal(readAccount('https://selected.test')?.token || '', token);
    assert.equal(env.CUSTOM, 'keep');
  }
});

test('malformed MCP and Claude settings survive refresh and surface errors', t => {
  const { root } = fixture(t);
  const { writeProjectClaudeMcpApproval } = require('../server/project-config');
  put(root, '.mcp.json', '{ broken');
  assert.throws(() => writeProjectMcpConfig(root, serverRoot));
  assert.equal(read(root, '.mcp.json'), '{ broken');
  put(root, '.claude/settings.local.json', '{ invalid');
  assert.throws(() => writeProjectClaudeMcpApproval(root));
  assert.equal(read(root, '.claude/settings.local.json'), '{ invalid');
});

test('CLI dry-run exits without onboarding or writing the selected project', t => {
  const { root } = fixture(t);
  const { execFileSync } = require('node:child_process');
  const output = execFileSync(process.execPath, [path.join(__dirname, 'setup.js'), '--dry-run', '--project-root', root], { encoding: 'utf8' });
  assert.match(output, /dry-run/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('audit recognizes refreshed configuration and a standalone AGENTS guide', async t => {
  const { root } = fixture(t);
  put(root, 'AGENTS.md', '# Existing instructions\n');
  writeProjectConfig(root, { API_BASE_URL: 'https://selected.test', API_PROJECT_ID: '78', API_TOKEN: 'token', MCP_BROWSER_TOOLS: [] });
  configureMcpServers({ projectRoot: root });
  const state = await analyzeSetupState({ values: {} }, root);
  assert.equal(state.hasKb, true);
  assert.deepEqual(state.harnessConfiguration.map(c => c.status), ['current', 'current', 'current']);
});
