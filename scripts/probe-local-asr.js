#!/usr/bin/env node
'use strict';

// Re-exec under Electron to test sherpa-onnx with V8 external buffers disabled;
// plain Node cannot reproduce that failure. Check addon loading, CircularBuffer.get()
// with/without external buffers, and a real LocalAsrSession decode.
// --no-electron skips the sandbox throw assertion. --wav supplies 16k mono PCM16;
// --model selects a registered model. --gap-ms/--min-silence/--pauses exercise VAD
// endpointing. `vad segments=X empty=Y` distinguishes capture/VAD from decode failure.
// Examples:
//   npm run probe:local-asr
//   npm run probe:local-asr -- --model parakeet-v3 --pauses
//   npm run probe:local-asr -- --wav /path/to/16k-mono-pcm16.wav

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function parseArgs(argv) {
  const opts = { noElectron: false, pauses: false, wav: null, model: null, gapMs: 0, minSilence: null, help: false, unknown: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-electron') opts.noElectron = true;
    else if (a === '--pauses') opts.pauses = true;
    else if (a === '--wav') opts.wav = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--gap-ms') opts.gapMs = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--min-silence') opts.minSilence = Number(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
    // (C1200) unrecognized flag is now a hard error, not a silent no-op — an unrecognized flag
    // used to be dropped on the floor with no warning (e.g. `-- --model parakeet-v3` before the
    // --model handler above existed did nothing at all).
    else if (a.startsWith('--')) { opts.unknown = a; break; }
  }
  return opts;
}

const HELP = `probe-local-asr — regression probe for C1196 (external-buffer crash in local ASR)

Usage:
  npm run probe:local-asr
  npm run probe:local-asr -- --no-electron
  npm run probe:local-asr -- --wav /path/to/16k-mono-pcm16.wav
  npm run probe:local-asr -- --model parakeet-v3
  npm run probe:local-asr -- --gap-ms 1000 [--min-silence 0.5]
  npm run probe:local-asr -- --pauses [--model parakeet-v3] [--min-silence 0.5]

--pauses uses macOS say to build a fixed two-sentence fixture with 1s, 2s, and 3s
thinking pauses and a 5s sentence boundary. Requires a ready Parakeet
model and VAD; missing prerequisites fail. Cannot combine with --wav/--gap-ms.
--min-silence 0.5 forces early VAD splits; sentence continuity must still pass.
`;

// ── re-exec under Electron-as-Node unless already there or explicitly opted out ──
function reexecUnderElectron() {
  let electronBin;
  try {
    electronBin = require('electron'); // the npm package's main export IS the binary path
  } catch (err) {
    console.error(`[probe-local-asr] couldn't resolve the electron package: ${err.message}`);
    process.exit(1);
  }
  const { spawnSync } = require('node:child_process');
  const res = spawnSync(electronBin, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (res.error) {
    console.error(`[probe-local-asr] failed to spawn Electron: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status == null ? 1 : res.status);
}

let _pass = 0, _fail = 0, _skip = 0;
function ok(label) { _pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
function bad(label, detail) { _fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`); }
function skip(label, reason) { _skip++; console.log(`  \x1b[33m…\x1b[0m ${label} (SKIP — ${reason})`); }

// ── minimal WAV reader: walks RIFF chunks, returns { sampleRate, channels, bitsPerSample, data } ──
// Deliberately NOT sherpa's own readWave()/readWaveFromBinary() — those are themselves
// enableExternalBuffer APIs (see addon.js), and using one to build this probe's input would
// muddy exactly the thing being probed.
function readWavPcm16(filePath) {
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
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(`${filePath}: expected PCM16 (format=1, bits=16), got format=${fmt.audioFormat} bits=${fmt.bitsPerSample} — try: afconvert -f WAVE -d LEI16@16000 <in> <out>`);
  }
  if (fmt.channels !== 1) {
    throw new Error(`${filePath}: expected mono, got ${fmt.channels} channels — try: afconvert -f WAVE -d LEI16@16000 -c 1 <in> <out>`);
  }
  if (fmt.sampleRate !== 16000) {
    throw new Error(`${filePath}: expected 16000Hz, got ${fmt.sampleRate}Hz — try: afconvert -f WAVE -d LEI16@16000 <in> <out>`);
  }
  return data; // raw PCM16LE Buffer
}

function synthesizeWav(outPath, text = 'Testing one two three. This is a probe of local voice transcription running under Electron.') {
  const { execFileSync } = require('node:child_process');
  if (process.platform !== 'darwin') {
    throw new Error('no --wav given and speech synthesis (macOS `say`) is only available on darwin — pass --wav explicitly');
  }
  execFileSync('say', ['-o', outPath, '--file-format=WAVE', '--data-format=LEI16@16000', text]);
  return text;
}

function pcmToFloat(pcm) {
  return Float32Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32768);
}

function checkPunctuation(raw, text, label) {
  const first = typeof text === 'string' && text.match(/\p{L}/u)?.[0];
  const capitalized = first && first === first.toUpperCase() && first !== first.toLowerCase();
  const terminated = typeof text === 'string' && /[.!?…。！？]["'”’»\)\]\}]*$/u.test(text.trim());
  if (capitalized && terminated) ok(`${label}: capitalized and sentence-terminated`);
  else bad(`${label}: punctuation regression`, `raw=${JSON.stringify(raw)} punctuated=${JSON.stringify(text)}`);
}

// Observe commits rather than decoder calls: a rolling decode is provisional.
function observePunctuation(session) {
  if (!/^parakeet-v[23]$/.test(session.modelId)) return;
  const commit = session._commitPending.bind(session);
  let count = 0;
  session._commitPending = (options) => {
    const results = commit(options);
    if (options?.final !== false) {
      for (const result of results) checkPunctuation(result.text, result.text, `final ${++count}`);
    }
    return results;
  };
}

async function probePauses(LocalAsrSession, modelId, endpointing, sampleRate) {
  if (!/^parakeet-v[23]$/.test(modelId)) throw new Error('--pauses requires a Parakeet model to exercise punctuate()');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-local-asr-pauses-'));
  try {
    // Synthesize phrases separately, trimming say's padding before inserting exact
    // digital-silence gaps at word boundaries. Fixed durations must not track defaults:
    // a regression to short endpointing must make this fixture fail.
    const phrases = ['Please keep listening', 'while I think', 'about the words', 'I want to say.', 'This is the second sentence.'];
    const audio = phrases.map((phrase, i) => {
      const wav = path.join(dir, `${i}.wav`);
      synthesizeWav(wav, phrase);
      const samples = pcmToFloat(readWavPcm16(wav));
      const first = samples.findIndex((v) => Math.abs(v) > 0.005);
      const last = samples.findLastIndex((v) => Math.abs(v) > 0.005);
      if (first < 0) throw new Error(`speech synthesis produced silence for ${JSON.stringify(phrase)}`);
      const pad = Math.round(sampleRate * 0.02);
      return samples.slice(Math.max(0, first - pad), Math.min(samples.length, last + pad + 1));
    });
    const session = new LocalAsrSession({ modelId, endpointing });
    console.log(`   endpointing: ${JSON.stringify(session.endpointing)}`);
    console.log(`   fixture: ${phrases.join(' ')} (mid-sentence pauses: 1s, 2s, 3s; boundary: 5s)`);
    await session.init();
    observePunctuation(session);
    const finals = [];
    const partials = [];
    const { createLiveInserter } = await import('../src/client/utils.js');
    const field = { value: '', selectionStart: 0, selectionEnd: 0, dispatchEvent() {} };
    const inserter = createLiveInserter(field);
    let terminal = '';
    let lastPartial = null;
    const deliver = (results) => {
      for (const result of results) {
        finals.push(result);
        inserter.commit(result.text);
        terminal += `${result.text} `;
        lastPartial = null;
      }
      const partial = session.partial?.text;
      if (partial && partial !== lastPartial) {
        partials.push(partial);
        inserter.setPartial(partial);
      }
      lastPartial = partial;
    };
    const feed = async (samples) => {
      const chunk = Math.round(sampleRate * 0.05);
      for (let i = 0; i < samples.length; i += chunk) {
        deliver(await session.acceptWaveform(samples.subarray(i, i + chunk)));
      }
    };
    const expectCount = (expected, label) => {
      const detail = `expected=${expected} finals=${finals.length} vad segments=${session.stats.segments} empty=${session.stats.emptySegments} text=${JSON.stringify(finals.map((f) => f.text))}`;
      if (finals.length === expected && session.stats.emptySegments === 0) ok(`${label}: ${detail}`);
      else bad(label, detail);
    };
    for (let i = 0; i < audio.length; i++) {
      await feed(audio[i]);
      if (i < 3) {
        await feed(new Float32Array(Math.round(sampleRate * [1, 2, 3][i])));
        expectCount(0, `no final at mid-sentence pause ${i + 1}`);
      } else if (i === 3) {
        await feed(new Float32Array(Math.round(sampleRate * 5)));
        expectCount(1, 'one final at first sentence boundary');
      }
    }
    expectCount(1, 'second sentence stays open until stop');
    deliver(await session.flush());
    expectCount(2, 'exactly one final per sentence after flush');
    deliver(await session.flush());
    expectCount(2, 'repeated flush adds no duplicate final');
    const expected = phrases.join(' ');
    const text = finals.map(result => result.text).join(' ');
    const normalize = value => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (normalize(text) === normalize(expected)) ok('all expected words appear exactly once');
    else bad('transcript words differ', JSON.stringify({ expected, text }));
    if ((text.match(/[.!?]/g) || []).length === 2) ok('exactly two sentence endings');
    else bad('premature punctuation', JSON.stringify(text));
    if (partials.length >= 2) ok(`rolling partials delivered: ${partials.length}`);
    else bad('missing rolling revisions', JSON.stringify(partials));
    if (field.value.trim() === text && terminal.trim() === text) ok('field revisions and terminal finals produce identical text');
    else bad('field/terminal mismatch', JSON.stringify({ field: field.value, terminal, text }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  if (opts.pauses && (opts.wav || process.argv.includes('--gap-ms'))) {
    console.error('[probe-local-asr] --pauses cannot combine with --wav or --gap-ms; it uses a controlled fixture.');
    process.exitCode = 2;
    return;
  }
  if (opts.unknown) {
    console.error(`[probe-local-asr] unknown option "${opts.unknown}"\n`);
    console.error(HELP);
    process.exitCode = 2;
    return;
  }
  if (opts.model) {
    // (C1200) validate before the Electron re-exec so a typo'd --model fails fast with one clear
    // message instead of spawning Electron first and failing deep inside stage 3.
    const { VOICE_MODEL_REGISTRY, VOICE_MODEL_IDS } = require('../src/server/voice-model-manager');
    if (!Object.hasOwn(VOICE_MODEL_REGISTRY, opts.model)) {
      console.error(`[probe-local-asr] unknown model "${opts.model}" — valid ids: ${VOICE_MODEL_IDS.join(', ')}`);
      process.exitCode = 2;
      return;
    }
  }

  const isElectron = !!process.versions.electron;
  if (!isElectron && !opts.noElectron) {
    reexecUnderElectron();
    return; // reexecUnderElectron() always process.exit()s
  }

  console.log(`[probe-local-asr] runtime: ${isElectron ? `electron ${process.versions.electron} (ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE || '0'})` : `node ${process.version}`}\n`);

  // ── Stage 1: addon loads ──
  console.log('1. require("sherpa-onnx-node")...');
  let sherpa;
  try {
    sherpa = require('sherpa-onnx-node');
    ok('addon loaded');
  } catch (err) {
    bad('addon failed to load', err.message);
    finish();
    return;
  }
  console.log();

  // ── Stage 2: the exact enableExternalBuffer call C1196 fixed ──
  console.log('2. CircularBuffer.get() — enableExternalBuffer true (default) vs false...');
  {
    const { CircularBuffer } = sherpa;
    const N = 512;
    const samples = new Float32Array(N);
    for (let i = 0; i < N; i++) samples[i] = Math.sin(i / 10) * 0.5;

    const bufA = new CircularBuffer(N * 4);
    bufA.push(samples);
    try {
      const w = bufA.get(bufA.head(), N); // default true — the pre-fix call shape
      if (isElectron) {
        bad('default (true) should have thrown under Electron\'s V8 sandbox, but returned', JSON.stringify({ len: w && w.length }));
      } else {
        skip('default (true) throw check', 'no V8 sandbox under plain Node — nothing to trip');
      }
    } catch (err) {
      if (isElectron && /external buffers? (are )?not allowed/i.test(err.message)) {
        ok(`default (true) throws as expected under Electron: "${err.message}"`);
      } else if (isElectron) {
        bad('default (true) threw, but not the expected external-buffer error', err.message);
      } else {
        bad('default (true) threw under plain Node (unexpected — no sandbox here)', err.message);
      }
    }

    const bufB = new CircularBuffer(N * 4);
    bufB.push(samples);
    try {
      const w = bufB.get(bufB.head(), N, false); // (C1196) the fix
      if (w instanceof Float32Array && w.length === N && Math.abs(w[10] - samples[10]) < 1e-6) {
        ok(`enableExternalBuffer:false returns a real Float32Array(${w.length}) with correct data`);
      } else {
        bad('enableExternalBuffer:false returned wrong shape/data', JSON.stringify({ len: w && w.length, sample: w && w[10] }));
      }
    } catch (err) {
      bad('enableExternalBuffer:false threw (the fix itself is broken)', err.message);
    }
  }
  console.log();

  // ── Stage 3: real end-to-end decode through LocalAsrSession, project's configured model ──
  console.log('3. Real LocalAsrSession decode (VAD + OfflineRecognizer)...');
  try {
    const { PROJECT_ROOT } = require('../src/server/config');
    const { readVoiceSettings } = require('../src/server/project-config');
    const { getVoiceModelStatus, VOICE_MODEL_REGISTRY } = require('../src/server/voice-model-manager');
    const { LocalAsrSession, SAMPLE_RATE, punctuate } = require('../src/server/local-asr');

    const settings = readVoiceSettings(PROJECT_ROOT);
    const modelId = opts.model || settings.voiceLocalModel;
    const endpointing = Number.isFinite(opts.minSilence) ? { minSilenceDuration: opts.minSilence } : null;
    if (/^parakeet-v[23]$/.test(modelId)) {
      // Deterministic input makes a no-op pass fail even if the model happens to
      // supply its own punctuation on all the real audio in this run.
      const raw = 'please keep listening while I think';
      checkPunctuation(raw, punctuate(raw), 'punctuate() unformatted control');
    }
    console.log(`   model: ${modelId} (${opts.model ? 'from --model' : `project config, voicePreset=${settings.voicePreset}`})`);
    if (!Object.hasOwn(VOICE_MODEL_REGISTRY, modelId)) {
      (opts.pauses ? bad : skip)('stage 3', `unknown model id "${modelId}"`);
    } else {
      const status = await getVoiceModelStatus(modelId);
      if (status.state !== 'ready') {
        (opts.pauses ? bad : skip)('stage 3', `model "${modelId}" not ready (state: ${status.state}) — download it in Settings > Voice first`);
      } else if (opts.pauses) {
        // Prevent init() from downloading a missing VAD during a regression check.
        const { VAD_MODEL_REGISTRY } = require('../src/server/voice-model-manager');
        const vadStatus = await getVoiceModelStatus('silero-vad', { registry: VAD_MODEL_REGISTRY });
        if (vadStatus.state !== 'ready') throw new Error(`--pauses requires a ready VAD model (state: ${vadStatus.state})`);
        await probePauses(LocalAsrSession, modelId, endpointing, SAMPLE_RATE);
      } else {
        const wavPath = opts.wav || path.join(os.tmpdir(), `probe-local-asr-${process.pid}.wav`);
        let spokenText = null;
        if (!opts.wav) {
          console.log(`   synthesizing speech via \`say\` -> ${wavPath}`);
          spokenText = synthesizeWav(wavPath);
        } else {
          console.log(`   using provided --wav ${wavPath}`);
        }
        const pcm = readWavPcm16(wavPath);
        const sampleCount = pcm.length / 2;
        let floatSamples = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) floatSamples[i] = pcm.readInt16LE(i * 2) / 32768;
        console.log(`   ${(sampleCount / SAMPLE_RATE).toFixed(2)}s of audio, ${sampleCount} samples`);
        if (opts.gapMs > 0) {
          // Float32Array is zero-filled, so the spliced region is pure digital silence.
          const gapSamples = Math.round(SAMPLE_RATE * opts.gapMs / 1000);
          const mid = Math.floor(sampleCount / 2);
          const withGap = new Float32Array(sampleCount + gapSamples);
          withGap.set(floatSamples.subarray(0, mid), 0);
          withGap.set(floatSamples.subarray(mid), mid + gapSamples);
          floatSamples = withGap;
          console.log(`   spliced ${opts.gapMs}ms of silence at ${(mid / SAMPLE_RATE).toFixed(2)}s`);
        }

        const session = new LocalAsrSession({ modelId, endpointing });
        console.log(`   endpointing: ${JSON.stringify(session.endpointing)}`);
        const t0 = Date.now();
        await session.init();
        observePunctuation(session);
        const CHUNK = Math.round(SAMPLE_RATE * 0.05); // ~50ms, mirrors live WS frame cadence
        const finals = [];
        for (let i = 0; i < floatSamples.length; i += CHUNK) {
          const chunk = floatSamples.subarray(i, Math.min(i + CHUNK, floatSamples.length));
          finals.push(...await session.acceptWaveform(chunk));
        }
        finals.push(...await session.flush());
        const elapsedMs = Date.now() - t0;

        // (C1200) session.stats disambiguates the two failure modes that look identical on the
        // wire: segments=0 means VAD never detected speech at all (capture/VAD problem, not the
        // model); segments>0 && empty===segments means the model decoded every segment to blank
        // text (a model/decode problem) — see tt-audio-input.md § Voice Input Silent Failures.
        const { segments, emptySegments } = session.stats;
        const statsStr = `vad segments=${segments} empty=${emptySegments}`;
        const text = finals.map((f) => f.text).filter(Boolean).join(' ').trim();
        if (finals.length > 0 && text) {
          ok(`decoded ${finals.length} segment(s) in ${elapsedMs}ms (${statsStr}): "${text}"`);
          if (!opts.wav) console.log(`   (spoken text was: "${spokenText}")`);
        } else if (segments === 0) {
          bad('no VAD speech segments detected at all', statsStr);
        } else {
          bad('VAD detected speech but every segment decoded to blank text — model is producing blanks', statsStr);
        }
        if (!opts.wav) {
          try { fs.unlinkSync(wavPath); } catch { /* best effort */ }
        }
      }
    }
  } catch (err) {
    if (/external buffers? (are )?not allowed/i.test(err.message)) {
      bad('stage 3 hit the exact C1196 bug — fix regressed', err.message);
    } else {
      bad('stage 3 threw', err.message);
    }
  }
  console.log();

  finish();
}

function finish() {
  console.log(`[probe-local-asr] ${_pass} passed, ${_fail} failed, ${_skip} skipped.`);
  if (_fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[probe-local-asr] failed:', err.stack || err.message);
  process.exitCode = 1;
});
