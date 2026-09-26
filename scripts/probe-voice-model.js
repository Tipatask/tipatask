#!/usr/bin/env node
'use strict';

// Check pinned voice-model URLs against expected sizes. Default --dry-run uses
// HEAD for LFS weights and GET for small compressed token files. --model and
// --all perform real downloads; --into-vendor writes the shared model root.
// Large downloads are opt-in and excluded from CI.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  VOICE_MODEL_IDS, VOICE_MODEL_REGISTRY, resolveVoiceModelUrl,
  downloadVoiceModel, voiceModelsRoot,
} = require('../src/server/voice-model-manager');

function parseArgs(argv) {
  const opts = { dryRun: true, model: null, all: false, intoVendor: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') opts.model = argv[++i];
    else if (argv[i] === '--all') { opts.all = true; opts.dryRun = false; }
    else if (argv[i] === '--into-vendor') opts.intoVendor = true;
    else if (argv[i] === '--dry-run') opts.dryRun = true;
  }
  if (opts.model) opts.dryRun = false;
  return opts;
}

async function dryRunOne(entry) {
  const rows = [];
  let totalOk = 0, totalBad = 0;
  for (const f of entry.files) {
    const url = resolveVoiceModelUrl({ repo: entry.repo, revision: entry.revision, file: f.name });
    let status, actualSize, ok;
    if (f.name.endsWith('.txt')) {
      // Non-LFS: no content-length, brotli-encoded — a real GET is the only reliable check.
      const res = await fetch(url);
      status = res.status;
      const buf = Buffer.from(await res.arrayBuffer());
      actualSize = buf.length;
      ok = res.ok && actualSize === f.size;
    } else {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      status = res.status;
      const cl = res.headers.get('content-length');
      actualSize = cl != null ? Number(cl) : null;
      ok = res.ok && actualSize === f.size;
    }
    ok ? totalOk++ : totalBad++;
    rows.push({ file: f.name, status, expected: f.size, actual: actualSize, ok });
  }
  return { rows, totalOk, totalBad };
}

async function runDryRun() {
  console.log('[probe-voice-model] dry-run: checking all pinned URLs in VOICE_MODEL_REGISTRY\n');
  let grandOk = 0, grandBad = 0;
  for (const id of VOICE_MODEL_IDS) {
    const entry = VOICE_MODEL_REGISTRY[id];
    console.log(`${id}  (${entry.repo} @ ${entry.revision.slice(0, 12)})`);
    const { rows, totalOk, totalBad } = await dryRunOne(entry);
    grandOk += totalOk; grandBad += totalBad;
    for (const r of rows) {
      const mark = r.ok ? 'ok ' : 'BAD';
      console.log(`  ${mark} ${r.file.padEnd(26)} http=${r.status}  expected=${r.expected}  actual=${r.actual}`);
    }
  }
  console.log(`\n[probe-voice-model] ${grandOk} ok, ${grandBad} bad`);
  if (grandBad > 0) process.exitCode = 1;
}

async function runDownload(modelId, { intoVendor }) {
  const rootDir = intoVendor ? voiceModelsRoot() : fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-voice-model-probe-'));
  console.log(`[probe-voice-model] downloading ${modelId} into ${rootDir}`);
  const start = Date.now();
  let lastLine = '';
  try {
    const result = await downloadVoiceModel(modelId, {
      rootDir,
      onProgress: (p) => {
        const line = `\r  ${p.file || ''} ${p.percent}%  (${(p.receivedBytes / 1048576).toFixed(1)}/${(p.totalBytes / 1048576).toFixed(1)} MB)`;
        lastLine = line;
        process.stdout.write(line.padEnd(80));
      },
    });
    if (lastLine) process.stdout.write('\n');
    const elapsedS = (Date.now() - start) / 1000;
    console.log(`[probe-voice-model] ${result.skipped ? 'already cached' : 'done'} — ${result.dir}`);
    if (result.skipped) {
      console.log(`[probe-voice-model] ${(result.totalBytes / 1048576).toFixed(1)} MB already on disk, verified in ${elapsedS.toFixed(2)}s`);
    } else {
      const mbps = (result.totalBytes / 1048576) / elapsedS;
      console.log(`[probe-voice-model] ${(result.totalBytes / 1048576).toFixed(1)} MB in ${elapsedS.toFixed(1)}s (${mbps.toFixed(1)} MB/s)`);
    }
  } finally {
    if (!intoVendor) fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.dryRun) return runDryRun();
  if (opts.all) {
    for (const id of VOICE_MODEL_IDS) await runDownload(id, opts);
    return;
  }
  if (!VOICE_MODEL_IDS.includes(opts.model)) {
    console.error(`[probe-voice-model] unknown --model "${opts.model}" — supported: ${VOICE_MODEL_IDS.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  return runDownload(opts.model, opts);
}

main().catch((err) => {
  console.error('[probe-voice-model] failed:', err.message);
  process.exitCode = 1;
});
