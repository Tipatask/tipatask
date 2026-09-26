'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stagePatchedWs } = require('../../scripts/stage-pi-bundle');

test('Pi staging replaces shrinkwrapped ws and rejects an unsafe source', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-pi-ws-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source');
  const target = path.join(dir, 'target');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '8.21.3' }));
  fs.writeFileSync(path.join(source, 'patched.js'), 'patched');
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ version: '8.21.0' }));

  stagePatchedWs(source, target);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'))).version, '8.21.3');
  assert.equal(fs.readFileSync(path.join(target, 'patched.js'), 'utf8'), 'patched');

  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '8.19.0' }));
  assert.throws(() => stagePatchedWs(source, target), /Cannot stage unpatched ws/);
});
