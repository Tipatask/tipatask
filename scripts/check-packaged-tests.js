'use strict';

const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { listPackage, extractFile } = require('@electron/asar');

// @electron/asar splits the requested path on path.sep, so a forward-slash path is "not found"
// on Windows for anything below the archive root. Normalize before every lookup.
function extractPackaged(archive, file) {
  return extractFile(archive, path.normalize(file));
}

// All build paths use afterPack. A stale staging directory must not silently ship an
// old directive while package.json advertises a newer version.
function assertPackagedVcs(archive, sourceRoot) {
  const files = ['package.json', 'src/server/vcs-settings.js', 'src/server/vcs-context.js',
    'src/server/vcs-runtime.js', 'src/server/task-agent/base-agent.js',
    'src/server/task-agent/codex-agent.js', 'src/server/terminal-session.js',
    'src/server/ws-handlers.js', 'src/server/index.js', 'src/server/api-backend.js',
    'src/server/git-merge/completion-guard.js', 'src/mcp/server.js'];
  for (const file of files) {
    const packaged = extractPackaged(archive, file);
    const source = fs.readFileSync(path.join(sourceRoot, file));
    if (file === 'package.json') {
      if (JSON.parse(packaged).version !== JSON.parse(source).version) throw new Error('Packaged VCS version mismatch');
    } else if (!packaged.equals(source)) throw new Error(`Packaged VCS source mismatch: ${file}`);
  }
  const context = { module: { exports: {} } };
  vm.runInNewContext(extractPackaged(archive, 'src/server/vcs-settings.js').toString(), context);
  const { buildVcsDirective } = context.module.exports;
  const all = { type: 'git', worktree: true, commit: true, pr: true, merge: true };
  for (const compact of [false, true]) {
    const prompt = buildVcsDirective(all, { compact });
    if (!prompt.includes('git merge task/') || !/nested/i.test(prompt) || !/PR.*(?:merge|separate)/.test(prompt)) throw new Error('Packaged merge directive missing');
    if (buildVcsDirective({ ...all, merge: false }, { compact }).includes('git merge task/')) throw new Error('Packaged merge-off violation');
    if (buildVcsDirective({ ...all, commit: false }, { compact }).includes('`git merge task/')) throw new Error('Packaged commit-off violation');
  }
}

function assertNoPackagedTests(archive) {
  const forbidden = listPackage(archive).filter(entry => {
    const file = entry.replace(/\\/g, '/').replace(/^\//, '');
    return /^(?:src|main)\/.*\.test\.(?:js|cjs|mjs)$/.test(file)
      || /^src\/client\/.*-dom-runner\.mjs$/.test(file)
      || file === 'src/server/git-merge/test-fixture.js'
      || file.startsWith('coverage/');
  });
  if (forbidden.length) {
    throw new Error(`Test-only files found in ${archive}:\n${forbidden.join('\n')}`);
  }
}

// afterPack runs before signing and installer creation on every packaging path.
module.exports = async function afterPack(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  assertNoPackagedTests(path.join(resources, 'app.asar'));
  assertPackagedVcs(path.join(resources, 'app.asar'), context.packager?.projectDir || path.resolve(__dirname, '..'));
};
module.exports.assertNoPackagedTests = assertNoPackagedTests;
module.exports.assertPackagedVcs = assertPackagedVcs;
