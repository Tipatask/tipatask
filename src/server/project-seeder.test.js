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
  assert.match(handler, /const presetValue = preset\?\.value;/);
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
