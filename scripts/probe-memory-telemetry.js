#!/usr/bin/env node
'use strict';

// Read-only macOS telemetry probe. One self-expiring idle child, no pressure injection,
// no credentials, no Task App server, and no writes to the production history store.
require('./check-node-version');
const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createCommandRunner } = require('../src/server/host-memory');
const { createMemoryTelemetry } = require('../src/server/memory-telemetry');
const { createSessionMemoryTracker } = require('../src/server/session-memory');

async function main() {
  if (process.platform !== 'darwin') throw Error('This probe requires macOS');
  const commands = new Set();
  let execCount = 0;
  const runner = createCommandRunner({ exec(file, args, opts, cb) {
    execCount++;
    const child = execFile(file, args, opts, cb);
    commands.add(child);
    child.once('close', () => commands.delete(child));
    return child;
  } });
  const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  const closed = once(worker, 'close');
  const session = { type: 'terminal', taskAgent: 'unknown', alive: true, ptyPid: worker.pid };
  const sessions = new Map([['probe', session]]);
  const tracker = createSessionMemoryTracker();
  tracker.begin(session);
  const telemetry = createMemoryTelemetry({ runner, tracker, getSessions: () => sessions,
    isRunning: s => s.alive && !s._completionEmitted });
  const summaries = [];
  const record = () => {
    const s = telemetry.snapshot();
    assert.equal(s.host.status, 'ok', 'macOS host telemetry must be readable');
    assert.equal(s.processes.status, 'ok', 'ps must be readable (run outside sandbox if denied)');
    assert.ok(s.processes.unionRssBytes > 0);
    summaries.push({ sampledAt: s.host.sampledAt, ageMs: s.host.ageMs, pressure: s.host.pressure,
      pageSizeBytes: s.host.pageSizeBytes, physicalBytes: s.host.physicalBytes,
      compressorBytes: s.host.compressorBytes, reclaimableEstimateBytes: s.host.reclaimableEstimateBytes,
      swapDelta: s.host.swapDelta, unionRssBytes: s.processes.unionRssBytes,
      admissionSlots: s.processes.admissionSlots, paused: s.processes.rows[0].paused });
  };
  try {
    telemetry.start();
    await telemetry.poll();
    record();
    session._pause = { at: Date.now() }; // fixture flag only; never signal an external process
    await delay(5300);
    record();
    session._completionEmitted = true;
    tracker.end(session, 'completed');
    await delay(5300);
    record();
    assert.equal(summaries.at(-1).admissionSlots, 0);
    assert.equal(tracker.getHistory()[0].completeLifetime, true);
    assert.ok(new Set(summaries.map(s => s.sampledAt)).size >= 3);
  } finally {
    telemetry.stop();
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    await closed;
    await Promise.all([...commands].map(child => once(child, 'close')));
  }
  const stoppedCount = execCount;
  await delay(5100);
  assert.equal(execCount, stoppedCount, 'no commands after sampler stop');
  assert.equal(commands.size, 0);
  assert.equal(runner.pendingCount(), 0);
  assert.equal(telemetry.snapshot().inFlight, false);
  assert.throws(() => process.kill(worker.pid, 0), { code: 'ESRCH' });
  console.log(JSON.stringify({ ok: true, workerPid: worker.pid, samples: summaries, execCount,
    history: tracker.getHistory(), cleanup: 'no sampler timers, commands or worker remain' }, null, 2));
}

main().catch(err => { console.error(err.message); process.exitCode = 1; });
