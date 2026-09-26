const { spawnSync } = require('node:child_process');
const path = require('node:path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require('electron'), [path.join(__dirname, 'probe-dialog-focus.cjs')], {
  cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.signal) console.error(`Dialog focus probe stopped by ${result.signal}`);
process.exit(result.status ?? 1);
