'use strict';

// (TPT9316) The creation wizard's preset A, "compose the knowledge base as you go"
// ('compose-as-you-go'): KB_MODE: 'compose' in config.json, no starter tasks, base templates only
// — while presets B/C ('original-specification', 'existing-code') keep seeding as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// refreshHarnessTemplates() resolves USER_DATA_ROOT for its placeholders; keep it private.
process.env.TIPATASK_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-seeder-userdata-'));

const {
  copyTemplates, COMPOSE_PRESET, isComposePreset, presetConfigFields, presetSeedsTasks,
} = require('./project-seeder');
const { KB_MODE_COMPOSE, CONFIG_FIELDS } = require('./project-config');
const { BASE_GENERAL_PENDING } = require('../cli/seed-setup-tasks');

const SERVER_ROOT = path.resolve(__dirname, '../..');
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function scratchProject(t, name = 'demo-app') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-seeder-'));
  const root = path.join(dir, name);
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return root;
}

test('compose preset: KB_MODE compose in config, no starter tasks; B/C unchanged', () => {
  assert.equal(COMPOSE_PRESET, 'compose-as-you-go');
  assert.equal(KB_MODE_COMPOSE, 'compose');
  assert.ok(CONFIG_FIELDS.includes('KB_MODE'), 'KB_MODE is a project config field');

  assert.deepEqual(presetConfigFields(COMPOSE_PRESET), { KB_MODE: 'compose' });
  assert.equal(presetSeedsTasks(COMPOSE_PRESET), false);
  assert.equal(isComposePreset(COMPOSE_PRESET), true);
  for (const preset of ['original-specification', 'existing-code', undefined, null, '']) {
    assert.deepEqual(presetConfigFields(preset), {}, `${preset} adds no config keys`);
    assert.equal(presetSeedsTasks(preset), true, `${preset} still goes through the seeder`);
    assert.equal(isComposePreset(preset), false);
  }
});

test('compose preset copies the base guides and the base GENERAL.md, with no preset overlay', (t) => {
  const root = scratchProject(t);
  copyTemplates(COMPOSE_PRESET, root, null);

  const claude = read(root, 'CLAUDE.md');
  assert.match(claude, /Tipatask/);
  assert.match(claude, /^## Version Control$/m, 'the base harness CLAUDE.md');
  assert.doesNotMatch(claude, /Project Approach:/, 'no preset CLAUDE.md overlay');
  assert.match(read(root, 'AGENTS.md'), /Tipatask/);

  const general = read(root, 'ai/architecture/GENERAL.md');
  assert.match(general, /^# demo-app — General Architecture$/m, 'base template heading with the project name');
  for (const heading of ['## Stack', '## Project Structure', '## Environment Variables', '## Local Setup',
    '## Database / Storage', '## Common Commands', '## System Tags', '## Conventions']) {
    assert.ok(general.includes(`\n${heading}\n`), `base GENERAL.md keeps ${heading}`);
  }
  assert.ok(general.includes(BASE_GENERAL_PENDING), 'scan-filled slots say they are not documented yet');
  assert.doesNotMatch(general, /\{\{[A-Z0-9_]+\}\}/, 'every placeholder resolved');
  assert.doesNotMatch(general, /## Existing Code|## Source Documents|## Project Profile/, 'no preset GENERAL.md seed');
});

test('compose preset never replaces a GENERAL.md that already has content', (t) => {
  const root = scratchProject(t);
  fs.mkdirSync(path.join(root, 'ai', 'architecture'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ai', 'architecture', 'GENERAL.md'), '# Real architecture\n');
  copyTemplates(COMPOSE_PRESET, root, null);
  assert.equal(read(root, 'ai/architecture/GENERAL.md'), '# Real architecture\n');

  // An empty file counts as absent.
  const empty = scratchProject(t);
  fs.mkdirSync(path.join(empty, 'ai', 'architecture'), { recursive: true });
  fs.writeFileSync(path.join(empty, 'ai', 'architecture', 'GENERAL.md'), '  \n');
  copyTemplates(COMPOSE_PRESET, empty, null);
  assert.ok(read(empty, 'ai/architecture/GENERAL.md').includes(BASE_GENERAL_PENDING));
});

test('presets B and C still apply their own CLAUDE.md overlay and GENERAL.md seed', (t) => {
  const spec = scratchProject(t);
  copyTemplates('original-specification', spec, null);
  assert.match(read(spec, 'CLAUDE.md'), /### Project Approach: Greenfield \(Original Specification\)/);
  assert.match(read(spec, 'ai/architecture/GENERAL.md'), /^## Existing Code$/m);
  assert.doesNotMatch(read(spec, 'ai/architecture/GENERAL.md'), new RegExp(BASE_GENERAL_PENDING.replace(/[()]/g, '\\$&')));

  const existing = scratchProject(t);
  copyTemplates('existing-code', existing, null);
  assert.match(read(existing, 'CLAUDE.md'), /### Project Approach: Existing Codebase Discovery/);
  assert.match(read(existing, 'ai/architecture/GENERAL.md'), /^## Project Profile$/m);
});

// main.js's IPC handlers can't run under node --test, so their wiring is pinned at source level.
test('project:create-from-wizard writes the preset config keys and skips seeding for compose', () => {
  const src = fs.readFileSync(path.join(SERVER_ROOT, 'main.js'), 'utf8');
  const start = src.indexOf("ipcMain.handle('project:create-from-wizard'");
  assert.ok(start !== -1, 'create-from-wizard handler not found');
  const handler = src.slice(start, src.indexOf('ipcMain.handle(', start + 10));

  const write = handler.slice(handler.indexOf('writeProjectConfig(projectPath, {'));
  const writeBody = write.slice(0, write.indexOf('});'));
  assert.match(writeBody, /\.\.\.presetConfigFields\(presetValue\),/);
  assert.match(handler, /projectPresets\.includes\('software'\) \? preset\?\.value : COMPOSE_PRESET/);
  assert.match(handler, /copyTemplates\(presetValue, projectPath, presetDescription \|\| null\);/);
  assert.match(handler, /if \(presetSeedsTasks\(presetValue\)\) \{\s*presetSeed = await callSeedPresetTasks\(presetValue,/);
  assert.doesNotMatch(handler, /preset\.value/, 'no unguarded preset.value dereference left');
});

test('project:open-existing carries an existing KB_MODE through its whole-file rewrite', () => {
  const src = fs.readFileSync(path.join(SERVER_ROOT, 'main.js'), 'utf8');
  const start = src.indexOf("ipcMain.handle('project:open-existing'");
  assert.ok(start !== -1, 'open-existing handler not found');
  const handler = src.slice(start, src.indexOf('ipcMain.handle(', start + 10));
  assert.match(handler, /\.\.\.\(existingCfg\.KB_MODE \? \{ KB_MODE: existingCfg\.KB_MODE \} : \{\}\),/);
});

// KB_MODE is per project: the startup project's value must not become process-global (config.js
// seeds most config.json keys into process.env), while each spawn gets its own project's value.
test('KB_MODE reaches only its own project spawns, never process.env at startup', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-kbmode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = (name, cfg) => {
    const root = path.join(dir, name);
    fs.mkdirSync(path.join(root, '.tipatask'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify(cfg));
    return root;
  };
  const composeRoot = project('compose', { TASK_BACKEND: 'api', KB_MODE: 'compose', TT_SEED_PROBE: 'seeded' });
  const plainRoot = project('plain', { TASK_BACKEND: 'api' });
  const script = [
    `require(${JSON.stringify(path.join(__dirname, 'config.js'))});`,
    `const { projectEnvExtras } = require(${JSON.stringify(path.join(__dirname, 'spawn-utils.js'))});`,
    `process.stdout.write(JSON.stringify({`,
    `  startupEnv: process.env.KB_MODE ?? null, probe: process.env.TT_SEED_PROBE ?? null,`,
    `  compose: projectEnvExtras(${JSON.stringify(composeRoot)}).KB_MODE ?? null,`,
    `  plain: projectEnvExtras(${JSON.stringify(plainRoot)}).KB_MODE ?? null,`,
    `}));`,
  ].join('\n');
  const env = { ...process.env, TIPATASK_PROJECT_ROOT: composeRoot, TIPATASK_USER_DATA: path.join(dir, 'user-data') };
  delete env.KB_MODE;
  delete env.TT_SEED_PROBE;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env }));
  assert.deepEqual(out, { startupEnv: null, probe: 'seeded', compose: 'compose', plain: null });
});

test('every work domain supplies guides, role-specific rules, outputs, verification and completion', () => {
  const { resolvePresetHarness } = require('./project-seeder');
  const ids = ['software', 'science', 'marketing', 'sales', 'finance', 'health', 'home', 'personal-growth'];
  const all = resolvePresetHarness([...ids].reverse().concat('home'));
  assert.deepEqual(all.entries.map(entry => entry.id), ids);
  for (const domain of all.entries) {
    assert.ok(domain.guides.length);
    for (const field of ['planner', 'executor', 'deliverables', 'verification', 'completion']) assert.ok(domain[field], domain.id + '.' + field);
  }
  assert.deepEqual(resolvePresetHarness(['home', 'invalid']).entries.map(entry => entry.id), ['home']);
  assert.deepEqual(resolvePresetHarness(), resolvePresetHarness(['software']));
});

test('project metadata takes precedence and an unavailable backend uses the linked checkout', async t => {
  const root = scratchProject(t);
  require('./project-config').writeProjectConfig(root, { projectPresets: ['home'] });
  const { readProjectHarness } = require('./project-seeder');
  const online = await readProjectHarness({ getProjectSettings: async () => ({ projectPresets: ['sales'], use_objective_grouping: 0 }) }, root);
  assert.equal(online.harness.entries[0].id, 'sales');
  assert.equal(online.groupingEnabled, false);
  const offline = await readProjectHarness({ getProjectSettings: async () => { throw new Error('offline'); } }, root);
  assert.equal(offline.harness.entries[0].id, 'home');
});

test('Claude, Codex and Pi kickoffs read the selected project and preserve Software defaults', t => {
  const root = scratchProject(t);
  const opts = { projectPath: root, vcsContext: { verified: true, vcs: { type: null } }, kbMode: 'compose', task: { category: 'CODING' } };
  const { writeProjectConfig } = require('./project-config');
  for (const id of ['claude', 'codex', 'pi']) {
    const Agent = require('./task-agent/' + id + '-agent');
    const agent = new Agent();
    writeProjectConfig(root, {});
    const legacy = agent.buildPrompt('Task brief', opts);
    writeProjectConfig(root, { projectPresets: ['software'] });
    assert.equal(agent.buildPrompt('Task brief', opts), legacy);
    writeProjectConfig(root, { projectPresets: ['home'] });
    const home = agent.buildPrompt('Task brief', opts);
    assert.match(home, /Sequence the work around household constraints/);
    assert.match(home, /Household checklist/);
    assert.match(home, /Check quantities, timing, cost/);
    assert.match(home, /owners, timing/);
    assert.doesNotMatch(home, /\/tipatask-expert|\/caveman|npm run|After any code change|Campaign brief/);
    assert.match(home, /complete_task|tt complete/);
  }
});

test('each non-software preset delivers its sources, checks and standing topics to plan, kickoff, guide and KB', async t => {
  const { projectObjectivePrompt, resolvePresetHarness } = require('./project-seeder');
  const { writeProjectConfig } = require('./project-config');
  const Agent = require('./task-agent/codex-agent');
  const { installTemplates } = require('../cli/install-templates');
  for (const id of ['science', 'marketing', 'sales', 'finance', 'health', 'home', 'personal-growth']) {
    const root = scratchProject(t, id);
    writeProjectConfig(root, { projectPresets: [id] });
    const [contract] = resolvePresetHarness([id]).entries;
    const planner = (await projectObjectivePrompt(null, root, {})).systemPrompt;
    const kickoff = new Agent().buildPrompt('Deliver the task', { projectPath: root });
    copyTemplates(COMPOSE_PRESET, root);
    const guide = read(root, contract.guides[0]);
    assert.ok(planner.includes(contract.planner));
    assert.ok(kickoff.includes(contract.executor));
    for (const text of [contract.sources, contract.deliverables, contract.verification, contract.completion, ...contract.kbSections]) {
      for (const surface of [planner, kickoff, guide]) assert.ok(surface.includes(text), id + ': ' + text);
    }
    const cli = scratchProject(t, id);
    writeProjectConfig(cli, { projectPresets: [id] });
    installTemplates({ projectRoot: cli, placeholders: { PROJECT_NAME: id } });
    const kb = read(root, 'ai/architecture/GENERAL.md');
    assert.equal(kb, read(cli, 'ai/architecture/GENERAL.md'));
    for (const title of contract.kbSections) assert.ok(kb.includes('### ' + title + '\n'));
    assert.doesNotMatch(kb, /^## Stack$/m);
  }
});

test('a mixed objective hands each task its own contract across Claude, Codex and Pi', async () => {
  const { projectObjectivePrompt, resolvePresetHarness } = require('./project-seeder');
  const projectPresets = ['science', 'marketing'];
  const backend = { getProjectSettings: async () => ({ projectPresets }) };
  const planner = (await projectObjectivePrompt(backend, null, {})).systemPrompt;
  assert.match(planner, /Work presets: <ids>.*science, marketing/);
  const harness = resolvePresetHarness(projectPresets);
  const [science, marketing] = harness.entries;
  for (const id of ['claude', 'codex', 'pi']) {
    const Agent = require('./task-agent/' + id + '-agent');
    const run = description => new Agent().buildPrompt(description, { harness, task: { description } });
    const analyze = run('Work presets: science\n\nEstimate drying time from the lab observations.');
    assert.ok(analyze.includes(science.verification));
    assert.ok(!analyze.includes(marketing.verification));
    const brief = run('Work presets: marketing\r\n\r\nUse the approved study summary to write a search brief.');
    assert.ok(brief.includes(marketing.verification));
    assert.ok(!brief.includes(science.verification));
    for (const description of ['Work presets: marketing, science\n\nProduce a joint evidence brief.',
      'Write a brief.\n\nSource material\nWork presets: marketing', 'Work presets: science, home']) {
      const prompt = run(description);
      assert.ok(prompt.includes(science.verification) && prompt.includes(marketing.verification));
      assert.doesNotMatch(prompt, /Household checklist/);
    }
  }
});
