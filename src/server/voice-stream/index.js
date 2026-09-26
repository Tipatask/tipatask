'use strict';

// (C1185) Provider registry + voice-preset resolution for the __voice__ WS relay.
//
// Provider interface (implemented by ./assemblyai-provider.js and ./local-provider.js):
//   createProvider(ctx) -> { start(callbacks, {signal}): Promise<void>, pushAudio(buf: Buffer): void, stop(): void }
//   signal aborts pending startup; stop() also cancels providers created before startup finishes.
//   ctx: { apiBaseUrl, apiToken, projectId, modelId, assemblyaiApiKey, sampleRate, endpointing }
//        `endpointing` — local preset only: Silero VAD endpointing knobs (../vad-endpointing.js)
//        handed to LocalAsrSession, i.e. how long a pause must last before a voice:final fires.
//   callbacks: {
//     onReady(),            // upstream/local decoder is live, safe to start sending audio
//     onPartial(text),      // in-progress transcript for the current turn/utterance
//     onFinal(text),        // a turn/utterance finished — this text will not change
//     onUnsupported(reason),// can never work right now (model not downloaded, etc) — client
//                           // should fall back to the one-shot batch POST /api/transcribe path
//     onError(message),     // recoverable-looking failure mid-session
//     onDone(),             // provider fully wound down after stop()
//   }

const config = require('../config');
const { readVoiceSettings } = require('../project-config');
const { createAssemblyAiProvider } = require('./assemblyai-provider');
const { createLocalProvider } = require('./local-provider');
const { DEFAULT_ENDPOINTING } = require('../vad-endpointing');

// Test/dev override — bypasses reading .tipatask/config.json entirely. Values: 'assemblyai' or
// 'local:<modelId>' (e.g. 'local:whisper-base').
function presetFromEnvOverride() {
  const raw = process.env.TIPATASK_VOICE_PRESET;
  if (!raw) return null;
  if (raw === 'assemblyai') return { preset: 'assemblyai', modelId: null };
  if (raw.startsWith('local:')) return { preset: 'local', modelId: raw.slice('local:'.length), endpointing: DEFAULT_ENDPOINTING };
  return null;
}

// Reads voicePreset/voiceLocalModel/ASSEMBLYAI_API_KEY via project-config.js's
// readVoiceSettings() — the single shared read path (C1186) also used by the POST
// /api/transcribe batch route in ws-handlers.js, so streaming and batch can never disagree on
// what preset a project is actually on. Same underlying file the Voice settings tab (C1178)
// reads/writes via readProjectVoiceSettings()/writeProjectVoiceSettings() (task-board.js) and
// IPC/`GET /api/project-config`. Local-machine settings, never the remote Tipatask API project
// record — no network round-trip, just a synchronous file read.
//
// (C1186) `local` no longer requires apiBaseUrl/apiToken — those credentials are needed only by
// the AssemblyAI path. A project with no Tipatask API token configured at all can still use the
// local preset; only 'assemblyai' falls through to 'unavailable' when credentials are missing.
async function resolveVoicePreset({ apiBaseUrl, apiToken, projectId, projectPath }) {
  const override = presetFromEnvOverride();
  if (override) return { ...override, apiBaseUrl, apiToken, projectId, assemblyaiApiKey: null };

  const { voicePreset, voiceLocalModel, assemblyaiApiKey } = readVoiceSettings(projectPath || config.PROJECT_ROOT);

  if (voicePreset === 'local') {
    return { preset: 'local', modelId: voiceLocalModel, apiBaseUrl, apiToken, projectId, assemblyaiApiKey: null, endpointing: DEFAULT_ENDPOINTING };
  }

  // (C1203) A per-project ASSEMBLYAI_API_KEY needs no Tipatask API credentials at all —
  // assemblyai-provider.js mints its streaming token directly against AssemblyAI. This check
  // used to run AFTER the !apiBaseUrl/!apiToken guard below, so a project WITH a per-project
  // key still got 'unavailable' for streaming (silently — the batch fallback in
  // ws-handlers.js covered it, so no partials and no visible error). The batch route's own
  // three-way branch already checks the key first; match that ordering here.
  if (assemblyaiApiKey) {
    return { preset: 'assemblyai', modelId: null, apiBaseUrl, apiToken, projectId, assemblyaiApiKey };
  }

  if (!apiBaseUrl || !apiToken) {
    // No Tipatask API credentials, assemblyai preset, no per-project key — matches the existing
    // POST /api/transcribe proxy's own 502 case. The remote-API-proxied AssemblyAI path needs
    // these credentials.
    return { preset: 'unavailable', modelId: null, apiBaseUrl, apiToken, projectId, assemblyaiApiKey: null, reason: 'Streaming transcription unavailable: no Tipatask API token configured for this project' };
  }

  return { preset: 'assemblyai', modelId: null, apiBaseUrl, apiToken, projectId, assemblyaiApiKey };
}

function createProvider(ctx) {
  return ctx.preset === 'local' ? createLocalProvider(ctx) : createAssemblyAiProvider(ctx);
}

module.exports = { resolveVoicePreset, createProvider };
