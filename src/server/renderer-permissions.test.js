'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ALLOWED_RENDERER_PERMISSIONS, isRendererPermissionAllowed, installRendererPermissions,
} = require('../../main/renderer-permissions');

// (TPT9296) The desktop app's renderer permission policy (main/renderer-permissions.js).
test('renderer windows may use the microphone, web notifications and clipboard writes, nothing else', () => {
  assert.deepEqual([...ALLOWED_RENDERER_PERMISSIONS].sort(), ['clipboard-sanitized-write', 'media', 'notifications']);
  for (const allowed of ALLOWED_RENDERER_PERMISSIONS) assert.equal(isRendererPermissionAllowed(allowed), true, allowed);
  for (const denied of ['clipboard-read', 'geolocation', 'display-capture', 'fullscreen', 'openExternal', 'unknown', '', undefined]) {
    assert.equal(isRendererPermissionAllowed(denied), false, String(denied));
  }
  assert.throws(() => { ALLOWED_RENDERER_PERMISSIONS.push('clipboard-read'); }, TypeError, 'the list is frozen');
});

test('the request and the check handler give the same answer', () => {
  const session = {
    setPermissionRequestHandler(fn) { this.request = fn; },
    setPermissionCheckHandler(fn) { this.check = fn; },
  };
  installRendererPermissions(session);
  assert.equal(typeof session.request, 'function');
  assert.equal(typeof session.check, 'function');
  for (const permission of ['clipboard-sanitized-write', 'media', 'notifications', 'clipboard-read', 'geolocation']) {
    let granted;
    session.request({}, permission, (answer) => { granted = answer; }, {});
    assert.equal(granted, isRendererPermissionAllowed(permission), `request ${permission}`);
    assert.equal(session.check({}, permission, 'http://127.0.0.1:4455', {}), isRendererPermissionAllowed(permission), `check ${permission}`);
  }
});

test('main.js installs the policy on the default session and sets no handler of its own', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  assert.match(main, /const \{ installRendererPermissions \} = require\('\.\/main\/renderer-permissions'\);/);
  assert.equal((main.match(/installRendererPermissions\(session\.defaultSession\);/g) || []).length, 1);
  assert.doesNotMatch(main, /\.setPermission(?:Request|Check)Handler\(/);
});
