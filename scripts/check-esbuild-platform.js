'use strict';
// Second half of the esbuild-platform-mismatch guard (see check-npm-platform-env.js for the
// env-var-level check that runs at preinstall). That check fires too late to actually PREVENT
// the wrong package from landing on disk -- npm fetches optionalDependencies before running the
// root package's own lifecycle scripts, so a stray npm_config_os/npm_config_cpu can still get a
// wrong-platform @esbuild/* package written to node_modules even though preinstall correctly
// fails the overall `npm install` command. This runs at postinstall, after dependencies are
// actually on disk, and checks the one thing that matters directly: does the binary for THIS
// platform actually exist. Catches the exact failure mode, not just its usual cause.
const fs = require('fs');
const path = require('path');

const pkgName = `@esbuild/${process.platform}-${process.arch}`;
const pkgDir = path.join(__dirname, '..', 'node_modules', pkgName);

if (!fs.existsSync(pkgDir)) {
  console.error('');
  console.error(`FATAL: ${pkgName} is missing from node_modules -- the build will fail on this machine.`);
  console.error('       This usually means npm installed optional dependencies for a different');
  console.error('       platform (see the preinstall check above, if it printed anything).');
  console.error('');
  console.error('       Fix:');
  console.error(`         rm -rf node_modules && npm install --os=${process.platform} --cpu=${process.arch}`);
  console.error('');
  process.exit(1);
}
