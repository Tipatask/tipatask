// (C1186) Shared Float32 -> PCM16LE encoder, hoisted out of a module-local copy in
// voice-stream.js so the batch retry path (audio-recorder.js, encoding a whole recording after
// a 415 NEEDS_PCM16/NEEDS_RAW_AUDIO response from POST /api/transcribe) and the C1185 realtime
// streaming path (voice-stream.js, encoding live AudioWorklet frames onto the __voice__ WS)
// share one implementation instead of drifting apart. Pure — no DOM, node --test-able like
// voice-model-state.js. (The inverse direction, int16 PCM -> Float32, only ever runs
// server-side — that copy stays in voice-stream/local-provider.js, which is CommonJS/Node code,
// not this ESM browser module.)

// float32: Float32Array of samples in [-1, 1]. Returns an ArrayBuffer of little-endian Int16
// samples (16-bit signed PCM) — the wire format POST /api/transcribe expects for the local and
// direct-AssemblyAI branches (ws-handlers.js), and the __voice__ WS frame format (C1185).
export function floatTo16LE(float32) {
  const buf = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

// (C1206) RMS + peak absolute amplitude over one Float32 frame — the pure counterpart of what
// voice-stream.js's AnalyserNode tap used to compute off a rendered animation-frame snapshot.
// Moved here (instead of a new module) so the level tap can run directly on the SAME samples
// being encoded to PCM and sent, off the audio thread — no separate AnalyserNode, no
// requestAnimationFrame dependency (which stalls when the window is backgrounded/occluded and
// was measuring a different node than the one actually transmitted). Empty input reports silence
// rather than throwing/NaN, matching floatTo16LE's empty-input handling above.
export function frameLevel(float32) {
  if (!float32 || float32.length === 0) return { rms: 0, peak: 0 };
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < float32.length; i++) {
    const v = float32[i];
    sumSquares += v * v;
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
  }
  return { rms: Math.sqrt(sumSquares / float32.length), peak };
}
