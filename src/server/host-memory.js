'use strict';

const { execFile } = require('node:child_process');

const SAMPLE_INTERVAL_MS = 5000;
const STALE_AFTER_MS = 15000;
const COMMAND_TIMEOUT_MS = 1200;
const RECLAIMABLE_LABEL = 'Free + file-backed pages; reclaimable-memory proxy, not exact available RAM';

function unsigned(value) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function bytes(pages, pageSize) {
  if (pages === null || pageSize === null || pageSize <= 0) return null;
  const value = pages * pageSize;
  return Number.isSafeInteger(value) ? value : null;
}

function unknownHost(reason = 'unavailable') {
  return { status: reason, pressure: 'unknown', physicalBytes: null, pageSizeBytes: null,
    compressorBytes: null, compressedLogicalBytes: null, reclaimableEstimateBytes: null,
    reclaimableLabel: RECLAIMABLE_LABEL, swapInBytes: null, swapOutBytes: null };
}

function parseMacMemory(sysctlText, vmText) {
  const sys = new Map(String(sysctlText).split('\n').map(line => {
    const i = line.indexOf(':');
    return [line.slice(0, i).trim(), unsigned(line.slice(i + 1))];
  }));
  const pageSize = unsigned(String(vmText).match(/page size of (\d+) bytes/)?.[1]);
  const pages = new Map();
  for (const line of String(vmText).split('\n')) {
    const match = line.match(/^([^:]+):\s*(\d+)\.\s*$/);
    if (match) pages.set(match[1].trim(), unsigned(match[2]));
  }
  const pageBytes = key => bytes(pages.get(key) ?? null, pageSize);
  const free = pageBytes('Pages free');
  const file = pageBytes('File-backed pages');
  const physical = sys.get('hw.memsize');
  // These are NOTE_MEMORYSTATUS_PRESSURE_* dispatch flags, NOT the internal VM enum.
  const pressure = ({ 1: 'normal', 2: 'warning', 4: 'critical' })[sys.get('kern.memorystatus_vm_pressure_level')] || 'unknown';
  const host = { ...unknownHost(), pressure,
    physicalBytes: physical > 0 ? physical : null,
    pageSizeBytes: pageSize > 0 ? pageSize : null,
    compressorBytes: pageBytes('Pages occupied by compressor'),
    compressedLogicalBytes: pageBytes('Pages stored in compressor'),
    reclaimableEstimateBytes: free !== null && file !== null && Number.isSafeInteger(free + file) ? free + file : null,
    swapInBytes: pageBytes('Swapins'), swapOutBytes: pageBytes('Swapouts') };
  // Invalid physical counters cannot imply spare capacity.
  for (const key of ['compressorBytes', 'reclaimableEstimateBytes']) {
    if (host.physicalBytes === null || host[key] > host.physicalBytes) host[key] = null;
  }
  host.status = pressure !== 'unknown' && ['physicalBytes', 'pageSizeBytes', 'compressorBytes',
    'compressedLogicalBytes', 'reclaimableEstimateBytes', 'swapInBytes', 'swapOutBytes'].every(k => host[k] !== null)
    ? 'ok' : 'partial';
  return host;
}

function swapDelta(previous, current) {
  const empty = { inBytes: null, outBytes: null, intervalMs: null, status: 'baseline' };
  if (!current || current.swapInBytes === null || current.swapOutBytes === null) return { ...empty, status: 'unknown' };
  if (!previous || previous.swapInBytes === null || previous.swapOutBytes === null) return empty;
  const intervalMs = current.sampledAt - previous.sampledAt;
  if (intervalMs <= 0 || intervalMs > STALE_AFTER_MS || current.pageSizeBytes !== previous.pageSizeBytes) return { ...empty, status: 'discontinuous' };
  if (current.swapInBytes < previous.swapInBytes || current.swapOutBytes < previous.swapOutBytes) return { ...empty, status: 'reset' };
  return { inBytes: current.swapInBytes - previous.swapInBytes, outBytes: current.swapOutBytes - previous.swapOutBytes, intervalMs, status: 'ok' };
}

// Fixed commands only, no shell, environment logging, or process command lines. Cancellation
// resolves every outstanding read and kills only children this runner owns.
function createCommandRunner({ exec = execFile, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const pending = new Set();
  let stopped = false;
  function run(file, args) {
    if (stopped) return Promise.resolve(null);
    return new Promise(resolve => {
      let child, timer, done = false;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pending.delete(cancel);
        resolve(value);
      };
      const cancel = () => { try { child?.kill('SIGKILL'); } catch { /* already gone */ } finish(null); };
      pending.add(cancel);
      timer = setTimeout(cancel, timeoutMs);
      timer.unref?.();
      try {
        child = exec(file, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 },
          (err, stdout) => finish(err ? null : stdout));
      } catch { finish(null); }
    });
  }
  return { run, stop() { stopped = true; for (const cancel of [...pending]) cancel(); }, pendingCount: () => pending.size };
}

async function readHostMemory(run, platform = process.platform) {
  if (platform !== 'darwin') return unknownHost('unsupported');
  const sys = await run('/usr/sbin/sysctl', ['hw.memsize', 'kern.memorystatus_vm_pressure_level']);
  if (sys === null) return unknownHost('failed');
  const vm = await run('/usr/bin/vm_stat', []);
  return vm === null ? unknownHost('failed') : parseMacMemory(sys, vm);
}

module.exports = { SAMPLE_INTERVAL_MS, STALE_AFTER_MS, COMMAND_TIMEOUT_MS, RECLAIMABLE_LABEL,
  unsigned, parseMacMemory, unknownHost, swapDelta, createCommandRunner, readHostMemory };
