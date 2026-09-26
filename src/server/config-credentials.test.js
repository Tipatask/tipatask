'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CONFIG_MODULE = path.join(__dirname, 'config.js');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-config-startup-'));
  fs.mkdirSync(path.join(root, 'ai', 'todo', 'server'), { recursive: true });
  return root;
}

function loadConfigInChild(root, extraEnv = {}) {
  const script = [
    `const c = require(${JSON.stringify(CONFIG_MODULE)});`,
    `process.stdout.write(JSON.stringify({`,
    `baseUrl:c.API_BASE_URL,token:c.API_TOKEN,projectId:c.API_PROJECT_ID,`,
    `envBaseUrl:process.env.API_BASE_URL,envToken:process.env.API_TOKEN,envProjectId:process.env.API_PROJECT_ID`,
    `}));`,
  ].join('');
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TIPATASK_PROJECT_ROOT: root,
      TIPATASK_USER_DATA: path.join(root, 'ai', 'todo', 'server'),
      ...extraEnv,
    },
  }));
}

test('startup credentials come from config.json, never parent env or legacy .env', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.tipatask'));
  fs.writeFileSync(path.join(root, '.tipatask', 'config.json'), JSON.stringify({
    TASK_BACKEND: 'api',
    API_BASE_URL: 'https://config.example.test',
    API_TOKEN: 'config-token',
    API_PROJECT_ID: '2',
  }));
  fs.writeFileSync(path.join(root, 'ai', 'todo', 'server', '.env'), [
    'TASK_BACKEND=api',
    'API_BASE_URL=https://legacy.example.test',
    'API_TOKEN=legacy-token',
    'API_PROJECT_ID=999',
    '',
  ].join('\n'));

  const loaded = loadConfigInChild(root, {
    API_BASE_URL: 'https://parent.example.test',
    API_TOKEN: 'parent-token',
    API_PROJECT_ID: '888',
  });
  assert.deepStrictEqual(loaded, {
    baseUrl: 'https://config.example.test',
    token: 'config-token',
    projectId: '2',
    envBaseUrl: 'https://config.example.test',
    envToken: 'config-token',
    envProjectId: '2',
  });
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, 'ai', 'todo', 'server', '.env'), 'utf8'),
    /^API_(?:BASE_URL|TOKEN|PROJECT_ID)=/m
  );
});

test('fresh legacy install migrates before startup config snapshot', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'ai', 'todo', 'server', '.env'), [
    'TASK_BACKEND=api',
    'API_BASE_URL=https://fresh.example.test',
    'API_TOKEN=fresh-token',
    'API_PROJECT_ID=4',
    '',
  ].join('\n'));

  const loaded = loadConfigInChild(root);
  assert.strictEqual(loaded.baseUrl, 'https://fresh.example.test');
  assert.strictEqual(loaded.token, 'fresh-token');
  assert.strictEqual(loaded.projectId, '4');
  assert.ok(fs.existsSync(path.join(root, '.tipatask', 'config.json')));
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, 'ai', 'todo', 'server', '.env'), 'utf8'),
    /^API_(?:BASE_URL|TOKEN|PROJECT_ID)=/m
  );
});
