'use strict';

const { beforePack: stagePi } = require('./stage-pi-bundle');
const { assertWindowsPtySource } = require('./windows-pty');

// electron-builder's automatic rebuild is disabled: node-pty's rebuild metadata
// omits the OS, and a cross-build must never replace the development native module.
// Windows uses the package's Node-API prebuilds. POSIX retains Electron rebuilding.
async function beforePack(context, { stage = stagePi, rebuild } = {}) {
  const arch = typeof context.arch === 'string' ? context.arch : require('builder-util').Arch[context.arch];
  const sourceRoot = context.packager.projectDir;
  if (context.electronPlatformName === 'win32') assertWindowsPtySource(sourceRoot, arch);
  await stage(context);
  if (context.electronPlatformName !== 'win32') {
    const rebuildModules = rebuild || (await import('@electron/rebuild')).rebuild;
    await rebuildModules({
      buildPath: sourceRoot,
      projectRootPath: sourceRoot,
      electronVersion: context.packager.info.framework.version,
      platform: context.electronPlatformName,
      arch,
      mode: 'sequential',
      disablePreGypCopy: true,
    });
  }
}

module.exports = beforePack;
