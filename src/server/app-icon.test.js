'use strict';

// TPT563: guards the Windows taskbar icon. icon.ico must carry every frame Windows picks
// for the taskbar at common DPIs, and the AppUserModelID main.js sets must stay the
// build.appId electron-builder stamps on the installer shortcuts.
// TPT569: the NSIS installer must recreate a missing Start menu shortcut itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function readIcoFrames(buffer) {
  assert.equal(buffer.readUInt16LE(0), 0, 'ICONDIR reserved field');
  assert.equal(buffer.readUInt16LE(2), 1, 'ICONDIR type must be icon');
  const count = buffer.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    frames.push({
      width: buffer[entry] || 256,
      height: buffer[entry + 1] || 256,
      bitCount: buffer.readUInt16LE(entry + 6),
    });
  }
  return frames;
}

test('icon.ico carries 256, 64, 48, 32, 24 and 16px 32bpp frames', () => {
  const frames = readIcoFrames(fs.readFileSync(path.join(ROOT, 'assets', 'icon.ico')));
  assert.deepEqual(frames.map((f) => f.width), [256, 64, 48, 32, 24, 16]);
  for (const f of frames) {
    assert.equal(f.height, f.width, `${f.width}px frame must be square`);
    assert.equal(f.bitCount, 32, `${f.width}px frame must be 32bpp`);
  }
});

test('main.js sets the Windows AppUserModelID from build.appId', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.build.appId, 'com.tipatask.app');
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(source, /require\('\.\/package\.json'\)\.build\.appId/);
  assert.match(source, /app\.setAppUserModelId\(appId\)/);
});

test('Windows installer guarantees the Start menu shortcut', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.build.nsis.createStartMenuShortcut, true);
  assert.equal(pkg.build.nsis.shortcutName, 'TipATask');
  const nsh = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
  const body = nsh.match(/!macro customInstall\n([\s\S]*?)!macroend/);
  assert.ok(body, 'installer.nsh defines customInstall');
  assert.match(body[1], /SetShellVarContext current/);
  assert.match(body[1], /CreateShortCut "\$newStartMenuLink" "\$appExe"/);
  assert.match(body[1], /WinShell::SetLnkAUMI "\$newStartMenuLink" "\$\{APP_ID\}"/);
});

test('every taskbar-visible window passes the shared window icon', () => {
  const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.equal((source.match(/icon: getWindowIcon\(\)/g) || []).length, 3, 'splash, setup and project windows');
  const about = fs.readFileSync(path.join(ROOT, 'main', 'about-window.js'), 'utf8');
  assert.match(about, /icon: path\.join\(__dirname, '\.\.', 'assets', 'icon\.ico'\)/);
});
