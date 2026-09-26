'use strict';
// (esbuild-platform-mismatch guard) `npm install` silently produces a broken node_modules if
// npm_config_os / npm_config_cpu / npm_config_libc are set in the shell to anything other than
// this machine's real platform -- npm treats these as real config keys (unlike an unrecognized
// key like npm_config_python, which at least gets an "Unknown env config" warning) and uses
// them to pick which optional platform-specific packages to fetch (e.g. @esbuild/win32-ia32
// instead of @esbuild/darwin-arm64), with zero warning. The failure only surfaces much later,
// as a cryptic esbuild "wrong platform" crash deep inside build.js. Catch it here, before npm
// resolves any dependencies, with a message that actually names the culprit.
const REAL_PLATFORM = process.platform; // e.g. 'darwin'
const REAL_ARCH = process.arch; // e.g. 'arm64'

const checks = [
  { env: 'npm_config_os', actual: REAL_PLATFORM, label: 'OS/platform' },
  { env: 'npm_config_cpu', actual: REAL_ARCH, label: 'CPU architecture' },
];

const mismatches = checks.filter(({ env, actual }) => {
  const v = process.env[env];
  return v && v !== actual;
});

if (mismatches.length) {
  console.error('');
  console.error('FATAL: npm is configured to install packages for a DIFFERENT platform than this machine.');
  console.error(`       This machine is: platform=${REAL_PLATFORM} arch=${REAL_ARCH}`);
  for (const { env, actual, label } of mismatches) {
    console.error(`       But ${env}=${process.env[env]} (${label} override) is set in your shell.`);
  }
  console.error('');
  console.error('       Left alone, npm will silently install the wrong platform-specific optional');
  console.error('       dependencies (e.g. @esbuild/win32-ia32 instead of @esbuild/darwin-arm64) with');
  console.error('       no warning, and the failure won\'t surface until much later as a cryptic build error.');
  console.error('');
  console.error('       Fix: find and unset the stray env var(s) above in your shell config (grep your');
  console.error('       ~/.zshrc, ~/.zprofile, etc., or just run `unset ' + mismatches.map(m => m.env).join(' ') + '`');
  console.error('       in this terminal), then re-run npm install.');
  console.error('');
  process.exit(1);
}
