// (TPT9165) Pure helpers for the bottom-center recording widget (audio-recorder.js's
// showRecordingToast()/drawVoiceWave()): the mm:ss timer text, the wave's level and curve math,
// and the placement that keeps the card clear of composers and the notification column. No DOM
// and no imports — node --test-able like voice-silence.js (voice-widget.test.js).

// ── Timer ───────────────────────────────────────────────────────────────────

// Elapsed milliseconds as mm:ss. Minutes keep counting past 59 ("75:12") rather than growing an
// hour field, so the timer never changes width mid-recording until the 100th minute.
export function formatRecordingTime(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// ── Wave level ──────────────────────────────────────────────────────────────

// Mic RMS → shown loudness in 0…1, on a dB scale between a noise floor (a quiet room, which must
// draw a flat line) and a ceiling (loud speech fills the canvas). The exponent keeps faint room
// noise near flat while normal speech (about -30 dBFS) still swings well over half height.
export const WAVE_FLOOR_DB = -52;
export const WAVE_CEILING_DB = -18;
const WAVE_CURVE = 1.4;

export function waveLevelFromRms(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  const linear = (db - WAVE_FLOOR_DB) / (WAVE_CEILING_DB - WAVE_FLOOR_DB);
  return Math.min(1, Math.max(0, linear)) ** WAVE_CURVE;
}

// Eases the shown level toward the measured one: a fast attack so speech shows at once, a slower
// release so the line settles instead of flickering between syllables, and a snap to exactly 0 so
// silence ends on a truly flat line. Frame-rate independent (dtMs is the time since the last frame).
export const WAVE_ATTACK_MS = 70;
export const WAVE_RELEASE_MS = 320;
const WAVE_REST = 0.002;

export function smoothWaveLevel(current, target, dtMs) {
  const tau = target > current ? WAVE_ATTACK_MS : WAVE_RELEASE_MS;
  const next = current + (target - current) * (1 - Math.exp(-Math.max(0, dtMs) / tau));
  return next < WAVE_REST ? 0 : next;
}

// The curve drifts sideways a little even when quiet and faster when loud, in radians per second.
export const WAVE_DRIFT = 2.2;
export const WAVE_DRIFT_LOUD = 5.5;

export function advanceWavePhase(phase, level, dtMs) {
  return phase + (Math.max(0, dtMs) / 1000) * (WAVE_DRIFT + WAVE_DRIFT_LOUD * level);
}

// ── Wave curve ──────────────────────────────────────────────────────────────

// Height of the wave at x (0…1 across the canvas) as a share of the available amplitude, in
// −1…1. A sin² window pins both ends to the centre line, as in the mockup, and three sines
// drifting at different rates give the uneven lobes. The weights sum to 1, so the curve never
// leaves the canvas.
export function waveOffset(x, phase) {
  const envelope = Math.sin(Math.PI * x) ** 2;
  const shape = 0.62 * Math.sin(2 * Math.PI * 3.1 * x + phase)
    + 0.28 * Math.sin(2 * Math.PI * 5.3 * x - 1.7 * phase)
    + 0.10 * Math.sin(2 * Math.PI * 8.2 * x + 2.6 * phase);
  return envelope * shape;
}

// The polyline to stroke on a width×height canvas (CSS pixels): `pad` keeps the stroke and its
// glow inside the canvas at full level, `step` is the horizontal sample spacing. Level 0 is the
// flat centre line.
export function wavePoints(width, height, level, phase, { pad = 4, step = 3 } = {}) {
  const mid = height / 2;
  const amplitude = Math.max(0, Math.min(1, level)) * Math.max(0, mid - pad);
  const points = [];
  for (let x = 0; x < width; x += step) points.push([x, mid - amplitude * waveOffset(x / width, phase)]);
  points.push([width, mid]);
  return points;
}

// ── Placement ───────────────────────────────────────────────────────────────

// The card rests WIDGET_BASE_BOTTOM px above the bottom edge, centred, min(720px, 90vw) wide —
// the same numbers as the CSS defaults on #voice-rec-toast, which apply until the first placement.
export const WIDGET_MAX_WIDTH = 720;
export const WIDGET_VIEWPORT_SHARE = 0.9;
export const WIDGET_BASE_BOTTOM = 16;
export const WIDGET_GAP = 12;
export const WIDGET_MIN_WIDTH = 280;
// A card lifted higher than this share of the viewport would float mid-screen; it stays at its
// resting place instead.
export const WIDGET_MAX_LIFT = 0.6;

// Where the card goes: { bottom, width } in px. `obstacles` are viewport rects
// ({ left, top, right, bottom }) the card must keep WIDGET_GAP away from: composers, the
// notification stack, corner toasts. Tries the resting place first, then just above each
// obstacle, lowest first. At each height an obstacle wholly to one side of the centre line
// narrows the card (still centred), one across the centre line needs a higher spot. The first
// height where the card fits at WIDGET_MIN_WIDTH or wider wins; with none, the card stays at its
// resting place.
export function placeVoiceWidget({ viewportWidth, viewportHeight, height, obstacles = [] }) {
  const natural = Math.min(WIDGET_MAX_WIDTH, viewportWidth * WIDGET_VIEWPORT_SHARE);
  const center = viewportWidth / 2;
  const minWidth = Math.min(WIDGET_MIN_WIDTH, natural);
  const highest = viewportHeight * WIDGET_MAX_LIFT;
  const bottoms = [WIDGET_BASE_BOTTOM, ...obstacles.map(o => Math.ceil(viewportHeight - o.top + WIDGET_GAP))]
    .filter(b => b >= WIDGET_BASE_BOTTOM && b <= highest)
    .sort((a, b) => a - b);

  for (const bottom of new Set(bottoms)) {
    const cardBottom = viewportHeight - bottom;
    const cardTop = cardBottom - height;
    let half = natural / 2;
    let blocked = false;
    for (const o of obstacles) {
      if (o.bottom <= cardTop - WIDGET_GAP || o.top >= cardBottom + WIDGET_GAP) continue;
      if (o.right <= center - half - WIDGET_GAP || o.left >= center + half + WIDGET_GAP) continue;
      if (o.left >= center) half = Math.min(half, o.left - WIDGET_GAP - center);
      else if (o.right <= center) half = Math.min(half, center - WIDGET_GAP - o.right);
      else { blocked = true; break; }
    }
    if (!blocked && half * 2 >= minWidth) return { bottom, width: Math.floor(half * 2) };
  }
  return { bottom: WIDGET_BASE_BOTTOM, width: Math.floor(natural) };
}
