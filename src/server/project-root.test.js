'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveProjectRoot, findProjectRootFrom, isSameRoot, toPortablePath } = require('./project-root');

function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('resolveProjectRoot: explicit argument wins over everything', () => {
  const dir = scratch('tt-root-explicit-');
  try {
    const got = resolveProjectRoot({ explicit: dir, env: { TIPATASK_PROJECT_ROOT: '/elsewhere' }, cwd: '/' });
    assert.equal(got, path.resolve(dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resolveProjectRoot: TIPATASK_PROJECT_ROOT wins over cwd walk-up', () => {
  const dir = scratch('tt-root-env-');
  try {
    fs.mkdirSync(path.join(dir, '.tipatask'));
    fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), '{}');
    const got = resolveProjectRoot({ env: { TIPATASK_PROJECT_ROOT: '/env/root' }, cwd: dir });
    assert.equal(got, path.resolve('/env/root'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resolveProjectRoot: walks up from cwd to the nearest .tipatask/config.json', () => {
  const dir = scratch('tt-root-walk-');
  try {
    fs.mkdirSync(path.join(dir, '.tipatask'));
    fs.writeFileSync(path.join(dir, '.tipatask', 'config.json'), '{}');
    const deep = path.join(dir, 'packages', 'app', 'src');
    fs.mkdirSync(deep, { recursive: true });
    assert.equal(resolveProjectRoot({ env: {}, cwd: deep }), path.resolve(dir));
    assert.equal(findProjectRootFrom(deep), path.resolve(dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resolveProjectRoot: a .tipatask directory without config.json does not count', () => {
  const dir = scratch('tt-root-marker-');
  try {
    fs.mkdirSync(path.join(dir, '.tipatask'));
    const deep = path.join(dir, 'sub');
    fs.mkdirSync(deep);
    // No config.json anywhere above → falls back to cwd itself, never to `dir`.
    const got = resolveProjectRoot({ env: {}, cwd: deep, fsImpl: {
      statSync: (p) => { if (p.startsWith(dir)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return fs.statSync(p); },
    } });
    assert.equal(got, path.resolve(deep));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resolveProjectRoot: no marker anywhere → cwd', () => {
  const stopAtRoot = { statSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
  assert.equal(resolveProjectRoot({ env: {}, cwd: '/some/where/deep', fsImpl: stopAtRoot }), path.resolve('/some/where/deep'));
});

test('isSameRoot / toPortablePath', () => {
  assert.equal(isSameRoot('/a/b/../c', '/a/c'), true);
  assert.equal(isSameRoot('/a/c', '/a/d'), false);
  assert.equal(isSameRoot(null, '/a'), false);
  assert.equal(toPortablePath('/a/b/c').includes('\\'), false);
});
