'use strict';

require('./check-node-version');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function discoverTests(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return discoverTests(file);
    return entry.isFile() && /\.test\.(?:js|cjs|mjs)$/.test(entry.name) ? [file] : [];
  }).sort();
}

function main() {
  const files = discoverTests(path.join(root, 'src'));
  if (!files.length) throw new Error('No unit tests discovered under src/');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-unit-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:API_|TIPATASK_|TASK_AGENT$|CLAUDE_|CODEX_|PI_|GEMINI_|ASSEMBLYAI_)/.test(key)
      || /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)) delete env[key];
  }
  Object.assign(env, {
    TIPATASK_PROJECT_ROOT: scratch,
    TIPATASK_USER_DATA: scratch,
    NODE_DISABLE_COMPILE_CACHE: '1',
    TIPATASK_TEST_VIOLATIONS: path.join(scratch, 'violations.log'),
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(__dirname, 'test-guard.cjs'))}`,
  });
  console.log(`Discovered ${files.length} test files under src/`);
  try {
    const result = spawnSync(process.execPath, [
      '--test', '--test-concurrency=4', ...process.argv.slice(2), ...files,
    ], { cwd: root, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    if (fs.existsSync(env.TIPATASK_TEST_VIOLATIONS)) {
      console.error(fs.readFileSync(env.TIPATASK_TEST_VIOLATIONS, 'utf8'));
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) main();
module.exports = { discoverTests };
