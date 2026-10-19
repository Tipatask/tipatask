#!/usr/bin/env node
'use strict';

// One read-only quota read through the real stdio client. Never logs environment
// values, RPC bodies, credentials or error text, starts a model turn or port 4455.
// Usage: [TIPATASK_PROJECT_ROOT=/path/to/project] npm run probe:codex-quota
require('./check-node-version');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { readCodexQuota } = require('../src/server/task-agent/codex-quota');
const { normalizeQuota, reasonFor } = require('../src/server/task-agent/quota-status');

const STAGES = ['setup', 'spawn', 'initialize', 'account_read', 'rate_limits', 'parse'];

async function runProbe(config, { output = console.log, spawnImpl = spawn, ...deps } = {}) {
  const start = Date.now(), timings = new Map();
  let spec, failure;
  const bin = config.CODEX_BIN, projectRoot = config.PROJECT_ROOT;
  const raw = await readCodexQuota({ CODEX_BIN: bin, PROJECT_ROOT: projectRoot }, {
    ...deps, projectRoot,
    spawnImpl(command, args, options) {
      // Only fixed app-server argv and the resolved executable; never retain env.
      spec = { command, args, windowsVerbatimArguments: !!options.windowsVerbatimArguments, stdio: options.stdio };
      return spawnImpl(command, args, options);
    },
    onStage: ({ stage, ms }) => timings.set(stage, ms),
    log: (text, detail) => { failure = { text, ...detail }; },
  });
  const result = normalizeQuota('codex', projectRoot, raw);
  output(`platform: ${process.platform} ${os.release()} (${process.arch})`);
  output(`node: ${process.version} @ ${process.execPath}`);
  output(`project root: ${projectRoot}`);
  output(`CODEX_BIN: ${bin || '(none)'}`);
  output(`exec spec: ${spec ? JSON.stringify(spec) : 'not reached'}`);
  for (const stage of STAGES) output(`${stage}: ${timings.has(stage) ? `${timings.get(stage)}ms` : 'not reached'}`);
  output(`connectionState: ${result.connectionState}`);
  output(`plan: ${result.plan || '(none)'}`);
  output(`status: ${result.status}`);
  for (const w of result.windows) output(`window ${w.id}: ${w.usagePercent ?? '?'}%, resets ${w.resetAt ?? '?'}`);
  output(`unavailableReason: ${result.unavailableReason || '(none)'}`);
  output(`failing stage: ${failure?.stage || (result.unavailableReason ? 'see unavailableReason' : '(none)')}`);
  if (failure) output(`server log line: ${failure.text}`);
  output(`elapsed: ${Date.now() - start}ms`);
  return result;
}

if (require.main === module) {
  // Config resolution stays inside the guarded entry point. Even setup failures
  // print only a classified reason and leave the diagnostic's exit status at 0.
  Promise.resolve().then(() => runProbe(require('../src/server/config'))).catch(err => {
    console.log(`[probe-codex-quota] unavailable: ${reasonFor(err)} (setup)`);
  });
}

module.exports = { runProbe };
