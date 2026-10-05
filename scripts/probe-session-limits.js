#!/usr/bin/env node
'use strict';
require('./check-node-version');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { analyzeSessionValidation, MAX_BYTES } = require('../src/server/session-validation');

const TESTS = ['host-memory', 'session-memory', 'memory-telemetry', 'admission-policy',
  'session-queue', 'session-admission', 'watchdog-policy', 'session-validation', 'index-session-safety'];
function read(file, lines = false) {
  if (!file || fs.statSync(file).size > MAX_BYTES + 4096) throw Error('missing or oversized evidence file');
  const data = fs.readFileSync(file, 'utf8');
  return lines ? data.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(data);
}
function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--replay') {
    // One suite, serial test files; no model calls or host pressure injection.
    const env = { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' };
    delete env.TIPATASK_SESSION_PROBE; delete env.TIPATASK_SESSION_PROBE_SECONDS;
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
      ...TESTS.map(name => `src/server/${name}.test.js`)], {
      cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 ** 2,
    });
    process.stderr.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    const counters = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(k =>
      [k, Number(result.stdout?.match(new RegExp(`^# ${k} (\\d+)$`, 'm'))?.[1] ?? 0)]));
    console.log(JSON.stringify({ version: 1, kind: 'synthetic-contract-replay', ok: result.status === 0,
      stages: [6, 8, 12], ...counters, error: result.error?.code || null,
      coverage: ['pressure warning/critical', 'rolling swap/reset', 'stale/unknown samples', 'launch races',
        'cross-project FIFO', 'independent-process coordinator lock', 'recovery hysteresis', 'stable/brief-burst/runaway watchdog'],
      representativeLiveRuns: 0, recommendation: 'No hardware capacity or rollout claim from synthetic traces.' }, null, 2));
    process.exitCode = result.status === 0 ? 0 : 1; return;
  }
  if (args[0] === '--report') {
    const opts = {};
    for (let i = 1; i < args.length; i += 2) {
      if (!['--stage', '--capture', '--evidence', '--ui', '--previous'].includes(args[i]) || !args[i + 1] || opts[args[i]]) throw Error('invalid or duplicate report option');
      opts[args[i]] = args[i + 1];
    }
    const result = analyzeSessionValidation(read(opts['--capture'], true), {
      stage: Number(opts['--stage']), evidence: opts['--evidence'] ? read(opts['--evidence']) : {},
      ui: opts['--ui'] ? read(opts['--ui'], true) : [], previous: opts['--previous'] ? read(opts['--previous']) : null,
    });
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.advanceAllowed ? 0 : 2; return;
  }
  console.log(`Usage (pinned Node):
  node scripts/probe-session-limits.js --replay
  node scripts/probe-session-limits.js --report --stage 6 --capture /absolute/run.PID.ndjson
    [--evidence /absolute/workloads.json] [--ui /absolute/perf.log] [--previous /absolute/stage6.json]

Recorder: launch an updated Task App with TIPATASK_SESSION_PROBE=/absolute/new-prefix
and TIPATASK_SESSION_PROBE_SECONDS=3600 (30..7200). No admission settings are changed.
Each server writes its own 0600, exclusive, bounded capture; do not concatenate captures.
Reports exit 2 when evidence cannot qualify a stage. Synthetic and short smoke runs
cannot qualify. Read tt-task-agent.md, Session-limit validation, before live workloads.
`);
}
if (require.main === module) { try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; } }
module.exports = { read, main };
