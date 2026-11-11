'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

// Follow the declared dependency chain, including nested npm installs. A root
// resolve or .bin shim can select an unrelated version or be absent entirely.
function appBuilderRequire(projectRoot = path.join(__dirname, '..')) {
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  const builderRequire = createRequire(projectRequire.resolve('electron-builder/package.json'));
  return createRequire(builderRequire.resolve('app-builder-lib/package.json'));
}

function resolveElectronRebuild(projectRoot) {
  return appBuilderRequire(projectRoot).resolve('@electron/rebuild');
}

module.exports = { appBuilderRequire, resolveElectronRebuild };
