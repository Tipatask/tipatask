#!/usr/bin/env node
'use strict';

// Manual live AssemblyAI probe; spends real quota and is excluded from CI.
// Test token mint, realtime socket, and batch regression: a containerized WAV
// transcribes, while the same audio as headerless PCM must fail upstream.
//   npm run probe:assemblyai [-- --stage token|ws|batch]
//   npm run probe:assemblyai -- --wav /path/to/16k-mono-pcm16.wav

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const STAGES = ['token', 'ws', 'batch'];

function parseArgs(argv) {
  const opts = { stage: 'all', wav: null, help: false, unknown: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stage') opts.stage = argv[++i];
    else if (a === '--wav') opts.wav = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    // unrecognized flag is a hard error, not a silent no-op (C1200 convention).
    else if (a.startsWith('--')) { opts.unknown = a; break; }
  }
  return opts;
}

const HELP = `probe-assemblyai — live verification of the AssemblyAI transcription path (C1203)

Spends real AssemblyAI quota (a few cents per run) — never run in CI, never in node --test.

Usage:
  npm run probe:assemblyai
  npm run probe:assemblyai -- --stage token|ws|batch
  npm run probe:assemblyai -- --wav /path/to/16k-mono-pcm16.wav
`;

let _pass = 0, _fail = 0, _skip = 0;
function ok(label) { _pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
function bad(label, detail) { _fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`); }
function skip(label, reason) { _skip++; console.log(`  \x1b[33m…\x1b[0m ${label} (SKIP — ${reason})`); }

// ── say-synthesized speech -> 16kHz mono WAV, and a minimal RIFF/WAVE reader. Deliberately
// duplicated from probe-local-asr.js rather than extracted into a shared helper — that script (and
// local-asr.js) belongs to a concurrent sibling task (C1202) touching the same files; sharing an
// extraction would conflict with its in-flight edits. ──
function synthesizeWav(outPath) {
  const { execFileSync } = require('node:child_process');
  if (process.platform !== 'darwin') {
    throw new Error('no --wav given and speech synthesis (macOS `say`) is only available on darwin — pass --wav explicitly');
  }
  const text = 'Testing one two three. This is a probe of AssemblyAI transcription.';
  execFileSync('say', ['-o', outPath, '--file-format=WAVE', '--data-format=LEI16@16000', text]);
  return text;
}

function readWav(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${filePath} is not a RIFF/WAVE file`);
  }
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    off = body + size + (size % 2); // chunks are word-aligned
    if (fmt && data) break;
  }
  if (!fmt || !data) throw new Error(`${filePath}: missing fmt/data chunk`);
  return { pcm: data, sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample };
}

async function mintToken(apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=60', {
      headers: { Authorization: apiKey }, // AssemblyAI: raw key, no "Bearer" prefix
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function stageToken(apiKey) {
  console.log('1. Mint streaming token — GET streaming.assemblyai.com/v3/token...');
  try {
    const data = await mintToken(apiKey);
    ok(`token minted, expires_in_seconds=${data.expires_in_seconds}`);
  } catch (err) {
    bad('token mint failed', err.message);
  }
  console.log();
}

async function stageWs(apiKey, pcmBuffer) {
  console.log('2. Live realtime socket — wss://streaming.assemblyai.com/v3/ws...');
  const WebSocket = require('ws');
  let token;
  try {
    token = (await mintToken(apiKey)).token;
  } catch (err) {
    bad('could not mint token for stage 2', err.message);
    console.log();
    return;
  }

  await new Promise((resolve) => {
    const url = `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&format_turns=true&token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    let sawBegin = false, done = false, partials = 0, finals = 0;
    const finishOnce = () => {
      if (done) return;
      done = true;
      clearTimeout(hardTimeout);
      resolve();
    };
    const hardTimeout = setTimeout(() => {
      bad('stage 2 timed out waiting for Begin/Termination (30s)', `begin=${sawBegin}`);
      try { ws.close(); } catch { /* already gone */ }
      finishOnce();
    }, 30000);
    hardTimeout.unref();

    ws.on('open', async () => {
      // ~50ms frames, mirroring live WS cadence (assemblyai-provider.js#pushAudio).
      const CHUNK_BYTES = Math.round(16000 * 0.05) * 2; // 16-bit samples
      for (let i = 0; i < pcmBuffer.length; i += CHUNK_BYTES) {
        if (ws.readyState !== WebSocket.OPEN) break;
        ws.send(pcmBuffer.subarray(i, Math.min(i + CHUNK_BYTES, pcmBuffer.length)), { binary: true });
        await new Promise((r) => setTimeout(r, 50));
      }
      try { ws.send(JSON.stringify({ type: 'Terminate' })); } catch { /* socket may already be closing */ }
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'Begin') {
        sawBegin = true;
        ok(`Begin frame received (id=${msg.id}) — this is the frame that becomes voice:ready`);
      } else if (msg.type === 'Turn') {
        if (msg.end_of_turn) finals++; else partials++;
      } else if (msg.type === 'Termination') {
        ok(`Termination received (${partials} partial turn(s), ${finals} final turn(s))`);
        try { ws.close(); } catch { /* already closing */ }
        finishOnce();
      }
    });

    ws.on('error', (err) => {
      bad('WebSocket error', err.message);
      finishOnce();
    });

    ws.on('close', () => {
      if (!sawBegin) bad('socket closed before a Begin frame arrived — sample_rate/format_turns/token params may be wrong');
      finishOnce();
    });
  });
  console.log();
}

async function stageBatch(apiKey, wavPath) {
  console.log('3. Batch upload/transcript — container vs headerless PCM (the C1203 regression pair)...');
  const { transcribeWithAssemblyAI, ASSEMBLYAI_ERRORS } = require('../src/server/assemblyai-batch');
  const wavBuffer = fs.readFileSync(wavPath);
  const { pcm } = readWav(wavPath);

  try {
    const { transcript } = await transcribeWithAssemblyAI(wavBuffer, { apiKey });
    if (transcript && transcript.trim()) {
      ok(`native WAV container transcribed: "${transcript.trim()}"`);
    } else {
      bad('native WAV container transcribed to empty text', 'uploaded audio may be silent — check --wav input');
    }
  } catch (err) {
    bad('native WAV container upload failed (expected to succeed)', `${err.code}: ${err.message}`);
  }

  try {
    const { transcript } = await transcribeWithAssemblyAI(pcm, { apiKey });
    bad('headerless PCM16 upload unexpectedly succeeded', `transcript="${transcript}" — AssemblyAI may now accept raw PCM in batch; re-check api-client.js's NEEDS_RAW_AUDIO handling`);
  } catch (err) {
    if (err.code === ASSEMBLYAI_ERRORS.UPSTREAM) {
      ok(`headerless PCM16 upload failed as expected (${err.code}): ${err.message}`);
    } else {
      bad(`headerless PCM16 upload failed with an unexpected code (wanted ${ASSEMBLYAI_ERRORS.UPSTREAM})`, `${err.code}: ${err.message}`);
    }
  }
  console.log();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  if (opts.unknown) {
    console.error(`[probe-assemblyai] unknown option "${opts.unknown}"\n`);
    console.error(HELP);
    process.exitCode = 2;
    return;
  }
  if (opts.stage !== 'all' && !STAGES.includes(opts.stage)) {
    console.error(`[probe-assemblyai] unknown --stage "${opts.stage}" — valid: ${STAGES.join(', ')}, all\n`);
    process.exitCode = 2;
    return;
  }

  const { PROJECT_ROOT } = require('../src/server/config');
  const { readVoiceSettings } = require('../src/server/project-config');
  const { assemblyaiApiKey } = readVoiceSettings(PROJECT_ROOT);
  if (!assemblyaiApiKey) {
    console.error('[probe-assemblyai] no ASSEMBLYAI_API_KEY configured in .tipatask/config.json — set one in Settings > Voice first.');
    process.exitCode = 2;
    return;
  }

  const runToken = opts.stage === 'all' || opts.stage === 'token';
  const runWs = opts.stage === 'all' || opts.stage === 'ws';
  const runBatch = opts.stage === 'all' || opts.stage === 'batch';

  if (runToken) await stageToken(assemblyaiApiKey);

  let wavPath = opts.wav;
  let cleanupWav = false;
  if ((runWs || runBatch) && !wavPath) {
    wavPath = path.join(os.tmpdir(), `probe-assemblyai-${process.pid}.wav`);
    try {
      console.log(`synthesizing speech via \`say\` -> ${wavPath}\n`);
      synthesizeWav(wavPath);
      cleanupWav = true;
    } catch (err) {
      bad('could not synthesize test audio', err.message);
      wavPath = null;
    }
  }

  if (wavPath) {
    if (runWs) {
      const { pcm } = readWav(wavPath);
      await stageWs(assemblyaiApiKey, pcm);
    }
    if (runBatch) await stageBatch(assemblyaiApiKey, wavPath);
  } else if (runWs || runBatch) {
    skip('stage ws/batch', 'no audio available (say synthesis failed and no --wav given)');
  }

  if (cleanupWav) { try { fs.unlinkSync(wavPath); } catch { /* best effort */ } }

  finish();
}

function finish() {
  console.log(`[probe-assemblyai] ${_pass} passed, ${_fail} failed, ${_skip} skipped.`);
  if (_fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[probe-assemblyai] failed:', err.stack || err.message);
  process.exitCode = 1;
});
