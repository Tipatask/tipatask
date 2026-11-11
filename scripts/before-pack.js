'use strict';

const { beforePack: stagePi } = require('./stage-pi-bundle');
const { assertWindowsPtySource } = require('./windows-pty');
const { appBuilderRequire, resolveElectronRebuild } = require('./electron-rebuild');
const { pathToFileURL } = require('node:url');

function configureDependencyLogging() {
  const { LogMessageByKey, logMessageLevelByKey } = appBuilderRequire()('./out/node-module-collector/moduleManager');
  // npm's repeated graph references are already resolved, not duplicate files.
  // Keep the list available under DEBUG=electron-builder; unresolved references
  // and every other dependency/signing diagnostic retain their original levels.
  const key = LogMessageByKey.PKG_DUPLICATE_REF;
  if (logMessageLevelByKey[key] === 'info') logMessageLevelByKey[key] = 'debug';
}

// electron-builder skips signing when discovery finds no certificate, even on arm64.
// Keep its identity selection and credential errors; only default builds may fall
// back to ad-hoc signing. Mutate the effective config, never package.json on disk.
async function prepareMacSigning(context, { env = process.env } = {}) {
  if (context.electronPlatformName !== 'darwin') return;
  const packager = context.packager;
  const config = packager.platformSpecificBuildOptions;
  if (config.identity !== undefined || config.sign || packager.forceCodeSigning
    || env.CSC_NAME || packager.getCscLink() != null) return;
  const { keychainFile } = await packager.codeSigningInfo.value;
  const identity = await packager.helper.findSigningIdentity(
    false, config.type === 'development', undefined, keychainFile, config,
  );
  if (identity == null) config.identity = '-';
}

// electron-builder's automatic rebuild is disabled: node-pty's rebuild metadata
// omits the OS, and a cross-build must never replace the development native module.
// Windows uses the package's Node-API prebuilds. POSIX retains Electron rebuilding.
async function beforePack(context, { stage = stagePi, rebuild, signing = prepareMacSigning,
  desktop = require('../src/server/computer-use-runtime').buildNative } = {}) {
  const arch = typeof context.arch === 'string' ? context.arch : require('builder-util').Arch[context.arch];
  const sourceRoot = context.packager.projectDir;
  configureDependencyLogging();
  await signing(context);
  if (context.electronPlatformName === 'darwin') await desktop(sourceRoot, arch);
  if (context.electronPlatformName === 'win32') assertWindowsPtySource(sourceRoot, arch);
  await stage(context);
  if (context.electronPlatformName !== 'win32') {
    const rebuildModules = rebuild || (await import(pathToFileURL(resolveElectronRebuild(sourceRoot)).href)).rebuild;
    // @electron/rebuild inherits process.env for node-gyp; it has no env option.
    // Preserve legacy Python selection without passing unsupported config to npm.
    const { npm_config_python, PYTHON } = process.env;
    try {
      if (npm_config_python) process.env.PYTHON = npm_config_python;
      delete process.env.npm_config_python;
      await rebuildModules({
        buildPath: sourceRoot,
        projectRootPath: sourceRoot,
        electronVersion: context.packager.info.framework.version,
        platform: context.electronPlatformName,
        arch,
        mode: 'sequential',
        disablePreGypCopy: true,
      });
    } finally {
      for (const [key, value] of Object.entries({ npm_config_python, PYTHON })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}

module.exports = beforePack;
module.exports.prepareMacSigning = prepareMacSigning;
module.exports.configureDependencyLogging = configureDependencyLogging;
