'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { appBuilderRequire, resolveElectronRebuild } = require('../../scripts/electron-rebuild');

for (const nested of [false, true]) {
  test(`rebuild resolves electron-builder's ${nested ? 'nested' : 'hoisted'} dependency`, t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'electron rebuild ')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pkg = (dir, data = {}) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(data));
      return dir;
    };
    pkg(root);
    const builder = pkg(path.join(root, 'node_modules/electron-builder'));
    const appBuilder = pkg(path.join(nested ? builder : root, 'node_modules/app-builder-lib'));
    const rebuild = pkg(path.join(nested ? appBuilder : root, 'node_modules/@electron/rebuild'), { exports: './main.js' });
    fs.writeFileSync(path.join(rebuild, 'main.js'), '');
    if (nested) {
      // An unrelated root copy must never win over app-builder-lib's own version.
      const other = pkg(path.join(root, 'node_modules/@electron/rebuild'), { main: 'wrong.js' });
      fs.writeFileSync(path.join(other, 'wrong.js'), '');
    }
    assert.equal(resolveElectronRebuild(root), path.join(rebuild, 'main.js'));
  });
}

test('installed builder supplies both the rebuild API and postinstall CLI', async () => {
  const entry = resolveElectronRebuild();
  assert.equal(typeof (await import(pathToFileURL(entry).href)).rebuild, 'function');
  assert.ok(fs.statSync(path.join(path.dirname(entry), 'cli.js')).isFile());
});

test('only resolved duplicate-reference info moves to debug; warnings and errors stay visible', t => {
  const { logMessageLevelByKey, LogMessageByKey } = appBuilderRequire()('./out/node-module-collector/moduleManager');
  const original = { ...logMessageLevelByKey };
  t.after(() => Object.assign(logMessageLevelByKey, original));
  const { configureDependencyLogging } = require('../../scripts/before-pack');
  configureDependencyLogging();
  configureDependencyLogging();
  assert.deepEqual(logMessageLevelByKey, { ...original, [LogMessageByKey.PKG_DUPLICATE_REF]: 'debug' });
  assert.equal(logMessageLevelByKey[LogMessageByKey.PKG_DUPLICATE_REF_UNRESOLVED], 'warn');
  // A future builder that raises the severity must keep that diagnostic visible.
  logMessageLevelByKey[LogMessageByKey.PKG_DUPLICATE_REF] = 'warn';
  configureDependencyLogging();
  assert.equal(logMessageLevelByKey[LogMessageByKey.PKG_DUPLICATE_REF], 'warn');
});
