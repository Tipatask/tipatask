'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeProjectConfig } = require('../project-config');
const { resolveVoicePreset } = require('./index');

function tmpProject(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-voice-stream-'));
  writeProjectConfig(root, overrides);
  return root;
}

test('resolveVoicePreset: defaults to assemblyai with no per-project key when .tipatask/config.json has no voice fields', async () => {
  const root = tmpProject({ TASK_BACKEND: 'api' });
  const result = await resolveVoicePreset({ apiBaseUrl: 'https://api.example', apiToken: 'tok', projectId: '2', projectPath: root });
  assert.deepEqual(result, { preset: 'assemblyai', modelId: null, apiBaseUrl: 'https://api.example', apiToken: 'tok', projectId: '2', assemblyaiApiKey: null });
});

test('resolveVoicePreset: voicePreset "local" carries voiceLocalModel as modelId', async () => {
  const root = tmpProject({ voicePreset: 'local', voiceLocalModel: 'parakeet-v2' });
  const result = await resolveVoicePreset({ apiBaseUrl: 'https://api.example', apiToken: 'tok', projectId: '2', projectPath: root });
  assert.equal(result.preset, 'local');
  assert.equal(result.modelId, 'parakeet-v2');
  assert.equal(result.assemblyaiApiKey, null);
});

test('resolveVoicePreset: voicePreset "local" with no voiceLocalModel set falls back to whisper-base default', async () => {
  const root = tmpProject({ voicePreset: 'local' });
  const result = await resolveVoicePreset({ apiBaseUrl: 'https://api.example', apiToken: 'tok', projectId: '2', projectPath: root });
  assert.equal(result.modelId, 'whisper-base');
});

test('resolveVoicePreset: a configured per-project ASSEMBLYAI_API_KEY is surfaced on the assemblyai preset', async () => {
  const root = tmpProject({ voicePreset: 'assemblyai', ASSEMBLYAI_API_KEY: 'proj-key-123' });
  const result = await resolveVoicePreset({ apiBaseUrl: 'https://api.example', apiToken: 'tok', projectId: '2', projectPath: root });
  assert.equal(result.preset, 'assemblyai');
  assert.equal(result.assemblyaiApiKey, 'proj-key-123');
});

test('resolveVoicePreset: no API credentials -> "unavailable", never reads the config file', async () => {
  const result = await resolveVoicePreset({ apiBaseUrl: '', apiToken: '', projectId: '', projectPath: '/nonexistent/path/that/would/throw' });
  assert.equal(result.preset, 'unavailable');
  assert.match(result.reason, /no Tipatask API token/);
});

// (C1203) A per-project ASSEMBLYAI_API_KEY needs no Tipatask API credentials at all —
// assemblyai-provider.js mints its streaming token directly against AssemblyAI. The
// !apiBaseUrl/!apiToken guard used to run BEFORE this check, so a project with a per-project
// key still lost streaming ('unavailable') even though it didn't need to — silently,
// since the batch POST /api/transcribe fallback covered it. The batch route's own three-way
// branch already checks the key first (ws-handlers.js); this matches that ordering.
test('resolveVoicePreset: a per-project ASSEMBLYAI_API_KEY resolves to "assemblyai" even with no API credentials', async () => {
  const root = tmpProject({ voicePreset: 'assemblyai', ASSEMBLYAI_API_KEY: 'proj-key-123' });
  const result = await resolveVoicePreset({ apiBaseUrl: '', apiToken: '', projectId: '', projectPath: root });
  assert.equal(result.preset, 'assemblyai');
  assert.equal(result.assemblyaiApiKey, 'proj-key-123');
});

test('resolveVoicePreset: missing/unreadable .tipatask/config.json still resolves to the assemblyai default, not a throw', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tipatask-voice-stream-nocfg-'));
  const result = await resolveVoicePreset({ apiBaseUrl: 'https://api.example', apiToken: 'tok', projectId: '2', projectPath: root });
  assert.equal(result.preset, 'assemblyai');
});

test('resolveVoicePreset: TIPATASK_VOICE_PRESET env override bypasses the config file entirely', async () => {
  const root = tmpProject({ voicePreset: 'assemblyai', ASSEMBLYAI_API_KEY: 'should-be-ignored' });
  process.env.TIPATASK_VOICE_PRESET = 'local:whisper-base';
  try {
    const result = await resolveVoicePreset({ apiBaseUrl: 'https://api.example', apiToken: 'tok', projectId: '2', projectPath: root });
    assert.equal(result.preset, 'local');
    assert.equal(result.modelId, 'whisper-base');
    assert.equal(result.assemblyaiApiKey, null);
  } finally {
    delete process.env.TIPATASK_VOICE_PRESET;
  }
});

test('resolveVoicePreset: the local preset carries the default VAD endpointing; assemblyai does not', async () => {
  const { DEFAULT_ENDPOINTING } = require('../vad-endpointing');
  const localRoot = tmpProject({ voicePreset: 'local', voiceLocalModel: 'parakeet-v3' });
  const local = await resolveVoicePreset({ apiBaseUrl: 'https://api.example', apiToken: 'tok', projectId: '2', projectPath: localRoot });
  assert.deepEqual(local.endpointing, DEFAULT_ENDPOINTING);
  const remoteRoot = tmpProject({ voicePreset: 'assemblyai' });
  const remote = await resolveVoicePreset({ apiBaseUrl: 'https://api.example', apiToken: 'tok', projectId: '2', projectPath: remoteRoot });
  assert.equal('endpointing' in remote, false);
});
