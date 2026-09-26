import { buildWsUrl } from './ws-client.js';
import { floatTo16LE, frameLevel } from './pcm.js';

// (C1185) Mic PCM capture + the __voice__ WS client. See createVoiceRecorder() in
// audio-recorder.js for the caller-facing piece (button state, silence watchdog, toast) — this
// module only owns getting 16kHz Int16LE PCM frames onto the wire and turning voice:* frames
// back into callbacks.

const TARGET_SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 800; // ~50ms @ 16kHz — small enough for low latency, large enough to
                            // avoid one WS message per render quantum (128 samples).

// (C1202) How long stop() waits for the server's voice:done before forcing the socket closed.
// Was a flat 1500ms regardless of what happened — too short for AssemblyAI's own documented
// ~2.5s trailing-final window (a real, independent bug this also fixes: the client used to
// close before that window elapsed, truncating the last utterance of every recording) and,
// worse, too short to ever outlast a cold ~650MB parakeet-v3 recognizer build, which is
// exactly the scenario that silently dropped whole recordings before C1200's server-side fix
// existed. DRAIN_MS_LOADING only applies once a voice:loading frame was actually seen, so the
// warm/already-ready common case is unaffected.
const DRAIN_MS = 3000;
const DRAIN_MS_LOADING = 30000;
// Local rolling-context inference may still be queued after capture stops. Keep its
// socket alive for the same bounded budget as cold initialization, even when already ready.
const DRAIN_MS_LOCAL = 30000;

// Inline AudioWorklet processor, loaded from a blob: URL at runtime — no build.js change
// needed, and there is no Content-Security-Policy anywhere in this app (template.html,
// main.js, ws-handlers.js) that would block a blob: module load, in dev or packaged Electron.
// Buffers raw Float32 samples and posts them to the main thread in fixed-size frames.
const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(0);
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    const merged = new Float32Array(this._buf.length + channel.length);
    merged.set(this._buf, 0);
    merged.set(channel, this._buf.length);
    this._buf = merged;
    const FRAME = ${FRAME_SAMPLES};
    while (this._buf.length >= FRAME) {
      const frame = this._buf.slice(0, FRAME);
      this._buf = this._buf.slice(FRAME);
      this.port.postMessage(frame, [frame.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

// { onReady(provider), onLoading(payload), onPartial(text), onFinal(text),
//   onUnsupported(reason, extra), onError(message), onLevel(rms 0..1, peak 0..1), onMicMuted() }
// (C1206) onLevel now fires from the capture/worklet frame handler (handleFrame below), not a
// separate rAF-driven AnalyserNode tap — see handleFrame()'s header comment.
export function createVoiceStream(callbacks = {}) {
  const { onReady, onLoading, onPartial, onFinal, onUnsupported, onError, onLevel, onMicMuted } = callbacks;
  let audioCtx = null;
  let sourceNode = null;
  let workletNode = null;
  let scriptNode = null;
  let silentGain = null; // ScriptProcessorNode fallback needs a path to destination to keep firing
  let ws = null;
  let active = false;
  let micTrack = null;
  // (C1202) Peak absolute sample amplitude for the whole recording — the client-side
  // counterpart of local-provider.js's server-side `pcmStats.peak`. Whichever leg (streaming
  // or the batch fallback) ends up reporting "nothing produced", this is what tells
  // voice-report.js's chooseNothingProducedMessage() whether real audio ever left the mic at
  // all, independent of whether the WS ever even connected.
  let micPeak = 0;
  let loadingSeen = false;
  let readySeen = false;
  let localProvider = false;
  let doneResolve = null; // resolves stop()'s drain promise once voice:done arrives (or times out)

  function openSocket(actualSampleRate) {
    ws = new WebSocket(buildWsUrl('__voice__'));
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      // (C1202) Send the ACTUAL AudioContext rate, not the TARGET_SAMPLE_RATE constant used to
      // construct it — that constant is only a constructor hint (see start() below), and
      // declaring it as fact regardless of whether the browser honored it is how a silent
      // mis-decode would happen server-side. `declaredSampleRate` travels alongside purely for
      // server-side log/diagnostic legibility; the server only ever acts on `sampleRate`.
      ws.send(JSON.stringify({
        type: 'voice:start',
        sampleRate: actualSampleRate,
        declaredSampleRate: TARGET_SAMPLE_RATE,
        encoding: 'pcm_s16le',
        language: null,
      }));
    });
    ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === 'voice:ready') { readySeen = true; localProvider = msg.provider === 'local'; if (onReady) onReady(msg.provider); }
      else if (msg.type === 'voice:loading') { loadingSeen = true; if (onLoading) onLoading(msg); }
      else if (msg.type === 'voice:partial') { if (onPartial) onPartial(msg.text); }
      else if (msg.type === 'voice:final') { if (onFinal) onFinal(msg.text); }
      else if (msg.type === 'voice:unsupported') { if (onUnsupported) onUnsupported(msg.reason, { reasonCode: msg.reasonCode, detail: msg.detail }); }
      else if (msg.type === 'voice:error') { if (onError) onError(msg.message); }
      else if (msg.type === 'voice:done') { if (doneResolve) { doneResolve(msg.stats || null); doneResolve = null; } }
    });
    // (C1202) Hardcoded English was already the case pre-existing this task — left as-is here,
    // still routed through onError so voice-report.js/i18n can localize at the call site. Added
    // the 'close' listener that was previously entirely absent: an abnormal close with no prior
    // 'error' event used to leave stop()'s drain promise hanging until its own timeout, and gave
    // reportNothingProduced() no signal at all. Now it resolves the drain immediately.
    ws.addEventListener('error', () => { if (onError) onError('Voice stream connection error'); });
    ws.addEventListener('close', () => { if (doneResolve) { doneResolve(null); doneResolve = null; } });
  }

  // (C1206) Was two split concerns — a separate AnalyserNode tap driven by requestAnimationFrame
  // (measured a different node than the one transmitted, and simply stopped ticking whenever rAF
  // was throttled — a backgrounded/occluded window, most notably) and this function, which sent
  // unconditionally with no level measurement at all if the WS wasn't open yet. Now one function:
  // level is computed from the EXACT samples about to go on the wire, on every frame regardless of
  // WS state, so onLevel/micPeak stay accurate even before the socket connects.
  function handleFrame(float32) {
    const { rms, peak } = frameLevel(float32);
    if (peak > micPeak) micPeak = peak;
    if (onLevel) onLevel(rms, peak);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(floatTo16LE(float32));
  }

  async function start(mediaStream) {
    if (active) return;
    active = true;
    micPeak = 0;
    loadingSeen = false;
    readySeen = false;
    localProvider = false;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_SAMPLE_RATE });
    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    // (C1202) audioCtx.sampleRate is the ACTUAL rate after Chromium's own constructor-hint
    // negotiation — {sampleRate: TARGET_SAMPLE_RATE} above is a hint, not a guarantee. Reading
    // it back (instead of trusting the constant) is what lets openSocket() declare the truth.
    if (audioCtx.sampleRate !== TARGET_SAMPLE_RATE) {
      console.warn(`[voice] AudioContext sample rate is ${audioCtx.sampleRate}Hz, not the requested ${TARGET_SAMPLE_RATE}Hz`);
    }
    // (C1206) A freshly constructed AudioContext can land 'suspended' (autoplay-policy quirks,
    // or a tab/window that was backgrounded at the exact moment of construction) — a suspended
    // context never fires worklet/onaudioprocess callbacks at all, which looks identical to a
    // dead mic from every signal this module reports (zero level, zero frames, no error).
    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch (err) { console.warn('[voice] AudioContext.resume() failed', err); }
    }
    openSocket(audioCtx.sampleRate);

    // (C1202) `track.muted` is the single most direct signal of a captured-but-silent mic —
    // exactly what an entitlement-denied capture under a hardened-runtime macOS build looks
    // like from the client's side (getUserMedia() resolves normally; the track just never
    // carries real audio). `ended` covers a device unplugged/revoked mid-recording.
    micTrack = mediaStream.getAudioTracks()[0] || null;
    if (micTrack) {
      if (micTrack.muted && onMicMuted) onMicMuted();
      micTrack.addEventListener('mute', () => { if (onMicMuted) onMicMuted(); });
    }

    try {
      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
      try {
        await audioCtx.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture');
      // (C1206) handleFrame(), not sendFrame() — computes level off the exact frame being sent,
      // see its header comment above.
      workletNode.port.onmessage = (evt) => handleFrame(evt.data);
      sourceNode.connect(workletNode);
    } catch {
      // Fallback for contexts where audioWorklet is unavailable. ScriptProcessorNode is
      // deprecated but still present in Electron's bundled Chromium. Routed through a
      // gain(0) node rather than straight to destination — some engines only fire
      // onaudioprocess while the node has a path to the output, but we never want to play
      // the mic back out loud.
      const bufferSize = 2048;
      scriptNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      scriptNode.onaudioprocess = (evt) => handleFrame(evt.inputBuffer.getChannelData(0).slice());
      silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;
      sourceNode.connect(scriptNode);
      scriptNode.connect(silentGain);
      silentGain.connect(audioCtx.destination);
    }
  }

  function teardownAudioGraph() {
    try { workletNode && workletNode.disconnect(); } catch {}
    try { scriptNode && scriptNode.disconnect(); } catch {}
    try { silentGain && silentGain.disconnect(); } catch {}
    try { sourceNode && sourceNode.disconnect(); } catch {}
    try { audioCtx && audioCtx.close(); } catch {}
    workletNode = scriptNode = silentGain = sourceNode = audioCtx = null;
    micTrack = null;
  }

  // (C1202) Now async, resolving to { micPeak, sampleRate, stats } once the socket is actually
  // closed — replaces the old fire-and-forget stop() that tore the audio graph down immediately
  // and gave the server a flat, unconditional 1500ms to reply before forcing the close
  // regardless of whether it was still mid-decode. Callers that don't need the result can still
  // just call stop() without awaiting it; nothing here throws.
  async function stop() {
    if (!active) return { micPeak, sampleRate: audioCtx ? audioCtx.sampleRate : null, stats: null };
    active = false;
    const sampleRateAtStop = audioCtx ? audioCtx.sampleRate : null;

    const wsToClose = ws;
    ws = null;
    let stats = null;
    if (wsToClose && wsToClose.readyState === WebSocket.OPEN) {
      const drainMs = localProvider ? DRAIN_MS_LOCAL : loadingSeen && !readySeen ? DRAIN_MS_LOADING : DRAIN_MS;
      let drainTimer;
      const drained = new Promise((resolve) => {
        doneResolve = resolve;
        drainTimer = setTimeout(() => { if (doneResolve) { doneResolve(null); doneResolve = null; } }, drainMs);
      });
      try { wsToClose.send(JSON.stringify({ type: 'voice:stop' })); }
      catch { if (doneResolve) { doneResolve(null); doneResolve = null; } }
      stats = await drained;
      clearTimeout(drainTimer);
      if (wsToClose.readyState === WebSocket.OPEN) { try { wsToClose.close(); } catch {} }
    }

    teardownAudioGraph();
    return { micPeak, sampleRate: sampleRateAtStop, stats };
  }

  return {
    start,
    stop,
    get active() { return active; },
    get micPeak() { return micPeak; },
  };
}
