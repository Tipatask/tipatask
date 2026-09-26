// (C1206) Pure, DOM-free silence-auto-stop watchdog — hoisted out of audio-recorder.js so the
// arm-on-speech logic below is node --test-able in isolation, same idiom as pcm.js/voice-report.js/
// voice-devices.js/voice-model-state.js.
//
// Root-cause context: the pre-C1206 watchdog started its 10s countdown on the FIRST silent frame,
// including frame zero of a recording that never hears any audio at all (dead mic — see this
// task's own C1202-entitlement finding). That made "mic never worked" and "user paused too long"
// produce the identical auto-stop, and truncated the recording before reportNothingProduced()
// could say anything useful about WHY. Arm-on-speech fixes this: the countdown never starts until
// at least one frame has crossed the threshold, so a dead mic just keeps recording until the user
// gives up and stops it manually — at which point voice-report.js's real diagnosis (micSilent/
// micBlocked/noSpeech) fires instead of a bogus timeout.

export const SILENCE_RMS_THRESHOLD = 0.02;
export const SILENCE_TIMEOUT_MS = 10_000;
export const SILENCE_HINT_MS = 5_000;
// Caps how much elapsed wall-clock one tick can contribute to the silence counter. Ticks can stall
// (a backgrounded/occluded window throttling rAF, or now — post-C1206 — a coalesced audio-frame
// batch) far longer than the gap between two healthy ticks; without this clamp one resumed tick
// could jump the counter straight past SILENCE_TIMEOUT_MS and auto-stop on the very next frame
// after the user was actually still mid-sentence.
export const MAX_TICK_GAP_MS = 500;

// { threshold?, timeoutMs?, hintMs?, maxGapMs? } — every field optional, defaults above.
// update(rms, nowMs) -> { speaking, armed, stop, hintSeconds }
//   speaking:    this frame was at/above threshold
//   armed:       at least one speaking frame has ever been seen this recording
//   stop:        true exactly once, the instant armed+silent time crosses timeoutMs
//   hintSeconds: integer seconds remaining before stop, only inside the last hintMs; else null
export function createSilenceWatchdog(opts = {}) {
  const threshold = opts.threshold ?? SILENCE_RMS_THRESHOLD;
  const timeoutMs = opts.timeoutMs ?? SILENCE_TIMEOUT_MS;
  const hintMs = opts.hintMs ?? SILENCE_HINT_MS;
  const maxGapMs = opts.maxGapMs ?? MAX_TICK_GAP_MS;

  let armed = false;
  let silentMs = 0;
  let lastTickMs = null;

  function reset() {
    armed = false;
    silentMs = 0;
    lastTickMs = null;
  }

  function update(rms, nowMs) {
    if (rms >= threshold) {
      armed = true;
      silentMs = 0;
      lastTickMs = nowMs;
      return { speaking: true, armed, stop: false, hintSeconds: null };
    }
    if (!armed) {
      // Never heard speech yet — do not accumulate, never auto-stop. See header comment.
      lastTickMs = nowMs;
      return { speaking: false, armed, stop: false, hintSeconds: null };
    }
    const gap = lastTickMs === null ? 0 : Math.max(0, nowMs - lastTickMs);
    silentMs += Math.min(gap, maxGapMs);
    lastTickMs = nowMs;
    const remaining = timeoutMs - silentMs;
    const hintSeconds = remaining <= hintMs ? Math.max(1, Math.ceil(remaining / 1000)) : null;
    const stop = silentMs >= timeoutMs;
    return { speaking: false, armed, stop, hintSeconds };
  }

  return {
    update,
    reset,
    get armed() { return armed; },
  };
}
