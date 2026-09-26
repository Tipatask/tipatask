'use strict';

// (C1185) Relays PCM audio to AssemblyAI's v3 realtime streaming endpoint and maps its Turn
// events back to the provider callback interface (see ./index.js's header comment).
//
// Two ways to get the short-lived streaming token that authenticates the upstream WS, mirroring
// the fallback shape C1186 uses for the batch /api/transcribe path:
//   1. Per-project key (ctx.assemblyaiApiKey, from .tipatask/config.json — C1178's Voice tab):
//      mint the token DIRECTLY against AssemblyAI from this machine. The key never leaves it.
//   2. No per-project key (the default for every project until someone opens Settings > Voice
//      and sets one): fall back to the existing remote-API-proxied mint — the Tipatask API's
//      GET /api/transcribe/stream-token (api/src/routes/transcription.js), reached through the
//      Task App's own same-origin proxy of the same path (ws-handlers.js). Never let a missing
//      per-project key break the currently-working default.
//
// ⚠️ Query params verified against AssemblyAI's public docs at implementation time, not against
// a live socket — see tt-api-audio-transcription.md for the verification note. If a live
// connection rejects `encoding`/`sample_rate`, that doc's probe script is where to iterate.

const WebSocket = require('ws');

const STREAM_TOKEN_PATH = '/api/transcribe/stream-token';
const ASSEMBLYAI_TOKEN_URL = 'https://streaming.assemblyai.com/v3/token';
const UPSTREAM_URL = 'wss://streaming.assemblyai.com/v3/ws';
const TOKEN_EXPIRES_IN_SECONDS = 60;
// After a client-initiated stop(), AssemblyAI's docs say to keep the socket open long enough to
// receive the last final Turn before the server sends Termination — bound that wait so a socket
// that never terminates cleanly doesn't leak.
const TERMINATE_GRACE_MS = 2500;

async function fetchStreamTokenViaRemoteApi({ apiBaseUrl, apiToken }, signal) {
  const { request: httpRequest } = require('../../cli/http');
  const { status, data } = await httpRequest(`${apiBaseUrl}${STREAM_TOKEN_PATH}?expires_in_seconds=${TOKEN_EXPIRES_IN_SECONDS}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiToken}` },
    timeoutMs: 8000,
    signal,
  });
  if (status < 200 || status >= 300 || !data || !data.token) {
    const message = (data && data.error) || `stream-token request failed (HTTP ${status})`;
    throw new Error(message);
  }
  return data.token;
}

async function fetchStreamTokenDirect(assemblyaiApiKey, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const res = await fetch(`${ASSEMBLYAI_TOKEN_URL}?expires_in_seconds=${TOKEN_EXPIRES_IN_SECONDS}`, {
      headers: { Authorization: assemblyaiApiKey }, // AssemblyAI: raw key, no "Bearer" prefix
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      throw new Error((data && data.error) || `AssemblyAI stream-token request failed (HTTP ${res.status})`);
    }
    return data.token;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function fetchStreamToken(ctx, signal) {
  return ctx.assemblyaiApiKey ? fetchStreamTokenDirect(ctx.assemblyaiApiKey, signal) : fetchStreamTokenViaRemoteApi(ctx, signal);
}

function createAssemblyAiProvider(ctx, deps = {}) {
  const mintToken = deps.fetchStreamToken || fetchStreamToken;
  const Socket = deps.WebSocket || WebSocket;
  let upstream = null;
  let stopped = false;
  let ready = false;
  let draining = false;
  let done = false;
  let terminateTimer = null;
  const tokenAbort = new AbortController();

  async function start(callbacks, { signal } = {}) {
    if (stopped) return;
    const abort = () => tokenAbort.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) tokenAbort.abort();
    let token;
    try {
      token = await mintToken(ctx, tokenAbort.signal);
    } catch (err) {
      if (!stopped && !tokenAbort.signal.aborted) callbacks.onError(`Could not start AssemblyAI streaming: ${err.message}`);
      return;
    } finally {
      signal?.removeEventListener('abort', abort);
    }

    // A client can disconnect while token minting is in flight. Do not open an upstream socket
    // after stop() has already disposed this provider.
    if (stopped || tokenAbort.signal.aborted) return;

    const url = `${UPSTREAM_URL}?sample_rate=${ctx.sampleRate || 16000}&format_turns=true&token=${encodeURIComponent(token)}`;
    upstream = new Socket(url);

    upstream.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (msg.type === 'Begin') {
        if (stopped) return;
        ready = true;
        callbacks.onReady();
      } else if (msg.type === 'Turn') {
        if (done || (stopped && !draining)) return;
        const text = msg.transcript || '';
        if (!text) return;
        if (msg.end_of_turn) callbacks.onFinal(text);
        else if (!stopped) callbacks.onPartial(text);
      } else if (msg.type === 'Termination') {
        if (done) return;
        done = true;
        if (!stopped || draining) callbacks.onDone();
        draining = false;
        try { upstream.close(); } catch {}
      }
    });

    upstream.on('error', (err) => {
      if (stopped) return; // a close-triggered error after we already asked to stop is expected
      callbacks.onError(`AssemblyAI streaming connection error: ${err.message}`);
    });

    upstream.on('close', () => {
      if (terminateTimer) { clearTimeout(terminateTimer); terminateTimer = null; }
      if (!stopped && !done) { done = true; callbacks.onDone(); }
    });
  }

  function pushAudio(buf) {
    if (!stopped && upstream && upstream.readyState === Socket.OPEN) upstream.send(buf, { binary: true });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    tokenAbort.abort();
    draining = ready && upstream && upstream.readyState === Socket.OPEN;
    if (!upstream || upstream.readyState !== Socket.OPEN) {
      if (upstream) try { upstream.terminate(); } catch {}
      return;
    }
    if (!draining) {
      try { upstream.terminate(); } catch {}
      return;
    }
    try {
      upstream.send(JSON.stringify({ type: 'Terminate' }));
    } catch {}
    // Give the upstream a moment to flush the last final + Termination event, then force-close.
    terminateTimer = setTimeout(() => {
      terminateTimer = null;
      if (upstream && upstream.readyState === Socket.OPEN) { try { upstream.close(); } catch {} }
    }, TERMINATE_GRACE_MS);
  }

  return { start, pushAudio, stop };
}

module.exports = { createAssemblyAiProvider };
