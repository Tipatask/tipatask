'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { collectRelativeRequires } = require('./require-graph');

const walk = (files, entries = ['main.js']) => collectRelativeRequires(entries, {
  readFile: file => files[file],
});

test('resolves relative chains, explicit files and directory indexes without executing code', () => {
  const result = walk({
    'main.js': "throw Error('never execute'); require('./lib'); require('electron'); require(name);",
    'lib.js': 'require("./nested"); require("./package.json");',
    'nested/index.js': "require('../leaf.js');",
    'leaf.js': '',
    'package.json': '{"example": "require(\'./not-code\')"}',
  });
  assert.deepEqual(result.missing, []);
  assert.deepEqual([...result.resolved], ['main.js', 'lib.js', 'nested/index.js', 'leaf.js', 'package.json']);
});

test('reports every unresolved relative spec with its importing file', () => {
  const result = walk({
    'main.js': "require('./missing'); require('./lib');",
    'lib.js': "require('../also-missing');",
  });
  assert.deepEqual(result.missing, [
    { from: 'main.js', spec: './missing' },
    { from: 'lib.js', spec: '../also-missing' },
  ]);
  assert.deepEqual([...result.resolved], ['main.js', 'lib.js']);
});

test('visits cycles and duplicate entries only once', () => {
  const reads = [];
  const files = { 'main.js': "require('./lib.js');", 'lib.js': "require('./main.js');" };
  const result = collectRelativeRequires(['main.js', 'lib.js', 'main.js'], {
    readFile: file => { reads.push(file); return files[file]; },
  });
  assert.deepEqual(result.missing, []);
  assert.deepEqual([...result.resolved], ['main.js', 'lib.js']);
  assert.deepEqual(reads, ['main.js', 'lib.js']);
});

test('normalizes Windows entry paths and reports missing entry files', () => {
  assert.deepEqual(walk({ 'main/entry.js': '' }, ['main\\entry.js']).missing, []);
  assert.deepEqual(walk({}, ['preload.js']).missing, [{ from: 'preload.js', spec: 'preload.js' }]);
});

test('handles missing filesystem candidates but propagates other read errors', () => {
  const missing = collectRelativeRequires(['main.js'], {
    readFile: () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); },
  });
  assert.equal(missing.missing.length, 1);
  assert.throws(() => collectRelativeRequires(['main.js'], {
    readFile: () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); },
  }), /access denied/);
});

test('all checkout main-process entry points have a complete relative require graph', () => {
  const root = path.resolve(__dirname, '../..');
  const mainFiles = fs.readdirSync(path.join(root, 'main'), { recursive: true })
    .filter(file => file.endsWith('.js') && !file.endsWith('.test.js'))
    .map(file => path.join('main', file));
  const result = collectRelativeRequires(['main.js', 'preload.js', 'todo-server.js', ...mainFiles], {
    readFile: file => fs.readFileSync(path.join(root, file), 'utf8'),
  });
  assert.deepEqual(result.missing, []);
  assert.ok(result.resolved.has('src/server/app-version.js'));
  assert.ok(result.resolved.has('src/server/index.js'));
});
