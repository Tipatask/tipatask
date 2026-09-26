'use strict';

// One __voice__ connection owns one provider. Invalid input and provider failures terminate
// only this socket; no process-wide exception handler is involved.
const realDeps = require('./index');

const MAX_CONTROL_BYTES = 4096;
const MAX_AUDIO_FRAME_BYTES = 64 * 1024;
const MAX_AUDIO_SESSION_BYTES = 25 * 1024 * 1024;
const MIN_SAMPLE_RATE = 8000;
const MAX_SAMPLE_RATE = 96000;
const MAX_ERROR_MESSAGE_LENGTH = 240;
const START_FIELDS = new Set(['type', 'sampleRate', 'declaredSampleRate', 'encoding', 'language']);

function boundedMessage(message) {
  let text;
  try { text = String(message || 'Voice stream failed'); }
  catch { text = 'Voice stream failed'; }
  return text.replace(/[\r\n\t]/g, ' ').slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function safeErrorMessage(err) {
  try { return (err && err.message) || 'Voice stream failed'; }
  catch { return 'Voice stream failed'; }
}

function validSampleRate(value) {
  return Number.isInteger(value) && value >= MIN_SAMPLE_RATE && value <= MAX_SAMPLE_RATE;
}

function validateControl(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'Invalid voice control message';
  if (msg.type === 'voice:stop') {
    return Object.keys(msg).length === 1 ? null : 'Invalid voice:stop message';
  }
  if (msg.type !== 'voice:start') return 'Unsupported voice control message';
  if (Object.keys(msg).some((key) => !START_FIELDS.has(key))) return 'Unsupported voice:start field';
  if (!validSampleRate(msg.sampleRate) ||
      (msg.declaredSampleRate != null && !validSampleRate(msg.declaredSampleRate))) {
    return 'Invalid voice sample rate';
  }
  if (msg.encoding !== 'pcm_s16le') return 'Unsupported voice encoding';
  if (msg.language != null &&
      (typeof msg.language !== 'string' || msg.language.length > 35 ||
       !/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(msg.language))) {
    return 'Invalid voice language';
  }
  return null;
}

// `deps` is injectable for protocol tests; production uses the provider registry.
function handleVoiceConnection(ws, projectCtx, deps = realDeps) {
  const { resolveVoicePreset, createProvider } = deps;
  let provider = null;
  let started = false;
  let stopped = false;
  let closed = false;
  let ready = false;
  let draining = false;
  let audioBytes = 0;
  // Aborts in-flight startup work (AssemblyAI token minting, local model load) on any stop.
  const startupAbort = new AbortController();

  function closeSocket() {
    try { ws.close(); } catch {}
  }

  function send(type, payload = {}) {
    if (closed || ws.readyState !== 1 /* OPEN */) return;
    try {
      ws.send(JSON.stringify({ type, ...payload }));
    } catch (err) {
      console.warn('[voice-stream] socket send failed:', err);
      closed = true;
      stopProvider();
      closeSocket();
    }
  }

  // Calls provider.stop() at most once, whether reached via voice:stop, a close, or an error.
  // Marks stopped even if preset resolution is still pending, so a late resolution cannot
  // create a provider. A graceful stop (voice:stop) on a ready provider drains: its final
  // transcript and voice:done still reach the client. A stop during startup has nothing to
  // drain, so the client is released immediately.
  function stopProvider(graceful = false) {
    if (stopped) {
      if (!graceful) draining = false;
      return;
    }
    draining = graceful && ready;
    stopped = true;
    startupAbort.abort();
    if (provider) {
      try {
        Promise.resolve(provider.stop()).catch((err) => {
          console.warn('[voice-stream] provider.stop() rejected:', err);
          fail('Voice stream failed');
        });
      } catch (err) {
        console.warn('[voice-stream] provider.stop() threw:', err);
        fail('Voice stream failed');
      }
    }
    if (graceful && !draining) {
      send('voice:done');
      if (!provider) {
        closed = true;
        closeSocket();
      }
    }
  }

  function fail(message, err = null) {
    if (closed) return;
    if (err) console.warn('[voice-stream] session failed:', err);
    send('voice:error', { message: boundedMessage(message) });
    closed = true;
    draining = false;
    stopProvider();
    closeSocket();
  }

  // Live frames stop at stop(); drain frames (final/done) pass only while draining.
  function relay(type, payload, { drain = false } = {}) {
    if (closed) return;
    if (stopped && !(drain && draining)) return;
    send(type, payload);
  }

  async function handleStart(msg) {
    started = true;
    try {
      const ctx = await resolveVoicePreset(projectCtx);
      if (closed || stopped) return;
      if (ctx.preset === 'unavailable') {
        relay('voice:unsupported', { reason: ctx.reason });
        closed = true;
        closeSocket();
        return;
      }

      provider = createProvider({ ...ctx, sampleRate: msg.sampleRate });
      if (!provider || typeof provider.start !== 'function' ||
          typeof provider.pushAudio !== 'function' || typeof provider.stop !== 'function') {
        throw new TypeError('Invalid voice provider');
      }
      if (closed || stopped) {
        // stopProvider() already ran without a provider; stop this late one directly.
        try { Promise.resolve(provider.stop()).catch(() => {}); } catch {}
        return;
      }
      await provider.start({
        onReady: () => {
          if (stopped) return;
          ready = true;
          relay('voice:ready', { provider: ctx.preset });
        },
        // (C1202) `payload` optional — only local-provider.js passes it (`{modelId}`).
        onLoading: (payload) => relay('voice:loading', payload || {}),
        onPartial: (text) => relay('voice:partial', { text }),
        onFinal: (text) => relay('voice:final', { text }, { drain: true }),
        // (C1202) `extra` optional (`{reasonCode, detail}`).
        onUnsupported: (reason, extra) => relay('voice:unsupported', { reason, ...extra }),
        onError: (message) => { if (!stopped || draining) fail(message || 'Voice stream failed'); },
        // (C1202) `stats` optional — a no-arg onDone() still produces `{type:'voice:done'}`.
        onDone: (stats) => {
          relay('voice:done', stats ? { stats } : {}, { drain: true });
          draining = false;
        },
      }, { signal: startupAbort.signal });
    } catch (err) {
      // A rejection caused by our own startup abort is expected, not a failure.
      if (stopped && startupAbort.signal.aborted && !draining) return;
      // Settings/factory failures stay generic; a provider's own start failure is reported
      // (bounded) so the client can show why the recognizer did not come up.
      fail(provider ? safeErrorMessage(err) : 'Voice stream failed', err);
    }
  }

  function handleAudio(data) {
    if (!Buffer.isBuffer(data) || data.length === 0 || data.length % 2 !== 0) {
      fail('Invalid PCM16 audio frame');
      return;
    }
    if (data.length > MAX_AUDIO_FRAME_BYTES ||
        audioBytes + data.length > MAX_AUDIO_SESSION_BYTES) {
      fail('Voice audio exceeds size limit');
      return;
    }
    if (!provider || stopped) return;
    audioBytes += data.length;
    try {
      Promise.resolve(provider.pushAudio(data)).catch((err) => fail('Voice stream failed', err));
    } catch (err) {
      fail('Voice stream failed', err);
    }
  }

  function handleMessage(data, isBinary) {
    if (closed) return;
    if (isBinary) { handleAudio(data); return; }
    if (!Buffer.isBuffer(data) || data.length > MAX_CONTROL_BYTES) {
      fail('Invalid voice control message');
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); }
    catch { fail('Invalid voice control message'); return; }
    const error = validateControl(msg);
    if (error) { fail(error); return; }
    if (msg.type === 'voice:start') {
      if (started || stopped) { fail('Voice session already started'); return; }
      void handleStart(msg);
      return;
    }
    if (!started) { fail('Voice session has not started'); return; }
    if (stopped) return;
    stopProvider(true);
  }

  ws.on('message', handleMessage);
  ws.on('close', () => { closed = true; stopProvider(); });
  // A socket error means the transport is gone: release the provider without trying to
  // send a frame on it.
  ws.on('error', (err) => {
    if (closed) return;
    console.warn('[voice-stream] socket error:', err);
    closed = true;
    stopProvider();
    closeSocket();
  });
}

module.exports = {
  handleVoiceConnection,
  MAX_CONTROL_BYTES,
  MAX_AUDIO_FRAME_BYTES,
  MAX_AUDIO_SESSION_BYTES,
};
