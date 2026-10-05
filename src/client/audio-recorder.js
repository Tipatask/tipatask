import { api } from './api-client.js';
import { createLiveInserter, showToast } from './utils.js';
import { t } from './i18n.js';
import { createVoiceStream } from './voice-stream.js';
import { transcribeErrorMessage } from './voice-errors.js';
import { isVoiceInputReady, voiceModelStateLabelKey } from './voice-model-state.js';
import { nothingProducedMessage } from './voice-report.js';
import { audioConstraintsFor, shouldRetryWithDefault } from './voice-devices.js';
import { createSilenceWatchdog } from './voice-silence.js';
import {
  DEFAULT_VOICE_SHORTCUT, normalizeVoiceShortcut,
  matchesVoiceShortcut as pureMatchesVoiceShortcut,
  voiceShortcutLabel as pureVoiceShortcutLabel,
} from './voice-shortcut.js';

// (C1185, arm-on-speech logic moved to voice-silence.js in C1206) Silence auto-stop — recording
// stops after this much continuous below-threshold mic level ONCE at least one above-threshold
// frame has been seen, resetting the silence timer on any detected speech. See voice-silence.js's
// header comment for why arming matters: a dead mic must never auto-stop on the same timer as a
// user who paused mid-sentence — it should keep recording until the user gives up, so the real
// diagnosis (voice-report.js's micSilent/micBlocked) can fire instead of a bogus timeout. The
// last SILENCE_HINT_MS of an armed countdown show a "stopping in Ns…" hint on the recording toast.
// A few seconds into an unarmed recording, a "no sound yet" hint fills the same slot instead —
// see NO_SOUND_HINT_DELAY_MS below.
const NO_SOUND_HINT_DELAY_MS = 4_000;

// (C1202) OS-level mic permission (TCC on macOS) — separate from and upstream of the
// getUserMedia() browser prompt. Electron-only (main.js's voice:mic-access-status IPC); a
// browser tab has no such concept, so it always reports 'granted' there. Checked once per
// recording start, immediately before getUserMedia(), so chooseNothingProducedMessage() can
// tell "blocked at the OS" apart from "the user just hasn't spoken yet" instead of guessing —
// see voice-report.js and this task's root cause (a packaged macOS build silently denied at
// the hardened-runtime entitlement layer, never surfacing as an error anywhere before this).
async function checkMicAccess() {
  if (!window.electronAPI?.micAccessStatus) return 'granted';
  try { return await window.electronAPI.micAccessStatus(); } catch { return 'unknown'; }
}

export const MIC_SVG = (size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
  <line x1="12" y1="19" x2="12" y2="22"/>
  <line x1="8" y1="22" x2="16" y2="22"/>
</svg>`;

const STOP_SVG = (size = 12) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor">
  <rect x="4" y="4" width="16" height="16" rx="2"/>
</svg>`;

// (C1210) Configurable combo — the actual root cause of the "shortcut does nothing" report was
// Cmd/Ctrl+Shift+SPACE itself: claimed by macOS on any machine with >1 keyboard input source
// (input-source switching defaults to Cmd+Space; this project's own test machine has it remapped
// to Cmd+Shift+Space), so the OS never delivered the key to ANY app, this one included — proven
// by dispatching a synthetic matching KeyboardEvent straight at document, which fired the
// pre-existing handler fine. No in-app rebind can rescue a key the OS swallows before delivery;
// see voice-shortcut.js for the pure combo logic + why the default moved off Space entirely.
let _voiceShortcut = DEFAULT_VOICE_SHORTCUT;

// (C1210) Project Settings > Voice writes here (task-board.js), same "module-level store + setter,
// fanned out" shape as setVoiceInputDeviceId()/setVoiceInputAvailability() below — an already-open
// terminal mic or live #chat-input picks up a changed combo with no re-wiring, since both
// matchesVoiceShortcut() and voiceShortcutLabel() just read this at call time.
export function setVoiceShortcut(combo) {
  _voiceShortcut = normalizeVoiceShortcut(combo);
  // (C1262) Without this every idle mic keeps showing the OLD combo in its title/aria-label
  // until its next unrelated re-label (next recording, next voice-model WS frame) — worse than
  // no tooltip, since it actively lies. _applyVoiceAvailability() already skips
  // is-recording/is-busy buttons and re-derives `disabled` from _micDisabledReason(), so this is
  // a pure re-title of idle mics, no state change. A mic mid-recording when the combo changes
  // keeps its "Stop recording (old combo)" label till that recording ends — not worth yanking a
  // label off a live recording for.
  _applyVoiceAvailability();
}

export function getVoiceShortcut() {
  return _voiceShortcut;
}

// Cmd (mac) or Ctrl (everything else) + Shift + <configured key> — see matchesVoiceShortcut().
export function voiceShortcutLabel() {
  const isMac = window.electronAPI?.platform === 'darwin'
    || (typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || ''));
  return pureVoiceShortcutLabel(_voiceShortcut, isMac);
}

// Global keydown predicate for the voice-input shortcut — see voice-shortcut.js for why `code`
// (not `key`) and why the combo is configurable at all.
export function matchesVoiceShortcut(e) {
  return pureMatchesVoiceShortcut(e, _voiceShortcut);
}

// (C1206) Resolves which mic the global shortcut should toggle, in priority order:
// 1. whatever is already recording/starting/finishing — the shortcut must be able to STOP it
//    regardless of what currently has focus. Before this, an open terminal mic unconditionally
//    outranked focus (see the old order below), so opening a terminal recording then tabbing to
//    New Objective and pressing the shortcut started a SECOND recording instead of stopping the
//    first — two live mics, no way to stop either without hunting for the right button. Reuses
//    _micButtons/is-recording/is-busy (same bookkeeping isAnyVoiceCaptureActive() already scans)
//    rather than new state, via button.__voiceRecorder set at registration below.
// 2. the focused mic-enabled element, or its .audio-rec-wrap ancestor if focus landed on the mic
//    button itself rather than the field.
// 3. the visible task/project chat (including focus on its composer controls).
// 4. an open agent terminal, then New Objective and new-task fields.
export function resolveVoiceTarget() {
  for (const button of _micButtons) {
    if (!button.__voiceRecorder) continue;
    if (button.__voiceRecorder.isActive) return button.__voiceRecorder;
  }
  const active = document.activeElement;
  if (active) {
    if (active.__voiceRecorder) return active.__voiceRecorder;
    const wrap = active.closest && active.closest('.audio-rec-wrap');
    if (wrap && wrap.__voiceRecorder) return wrap.__voiceRecorder;
  }
  const chatPanels = document.querySelectorAll('.task-chat-panel:not(.task-chat-panel--gated):not(.task-chat-panel--connecting)');
  for (const panel of chatPanels) {
    if (panel.closest('[hidden]')) continue;
    const input = panel.querySelector('.task-chat-input');
    if (input?.__voiceRecorder) return input.__voiceRecorder;
  }
  // (TPT466) A task terminal in its workspace pane is a .terminal-embed; only a visible one counts.
  const terminalOverlay = document.querySelector('.terminal-overlay, .task-modal-pane--terminal:not([hidden]) .terminal-embed');
  if (terminalOverlay && terminalOverlay.__voiceRecorder) return terminalOverlay.__voiceRecorder;
  for (const id of ['chat-input', 'new-task-title', 'new-task-desc']) {
    const el = document.getElementById(id);
    if (el && el.__voiceRecorder) return el.__voiceRecorder;
  }
  return null;
}

// ── Recording toast (C1175) ─────────────────────────────────────────────────
// One bottom-right pill that lives for the whole recording and pulses, so an open
// mic is never missed when the button itself is off-screen (minimized terminal,
// scrolled form) or was never looked at (Cmd/Ctrl+Shift+Space start).
// Ref-counted: the terminal mic and a field mic can be live simultaneously — the
// toast only leaves when the last recorder stops.
let _recToastEl = null;
let _recToastCount = 0;
let _recToastRemoveTimer = 0;

export function showRecordingToast() {
  _recToastCount += 1;
  // Guard on createElement, not just `document` — same reasoning as
  // notification-center.js#_render(): unit tests stub a minimal document.
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  if (_recToastEl) return;
  if (_recToastRemoveTimer) { clearTimeout(_recToastRemoveTimer); _recToastRemoveTimer = 0; }
  const el = document.createElement('div');
  el.id = 'voice-rec-toast';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  const dot = document.createElement('span');
  dot.className = 'voice-rec-dot';
  dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = t('voice.recordingToast', { shortcut: voiceShortcutLabel() });
  el.append(dot, label);
  document.body.appendChild(el);
  _recToastEl = el;
  // rAF reveal — same idiom as showCornerBadge() in utils.js and
  // notification-center.js's `.is-shown`.
  requestAnimationFrame(() => el.classList.add('voice-toast-active'));
}

export function hideRecordingToast() {
  if (_recToastCount > 0) _recToastCount -= 1;
  if (_recToastCount > 0 || !_recToastEl) return;
  const el = _recToastEl;
  _recToastEl = null;
  el.classList.remove('voice-toast-active');
  _recToastRemoveTimer = setTimeout(() => { el.remove(); _recToastRemoveTimer = 0; }, 200);
}

// (C1185) Silence-countdown hint shown inside the toast for the last SILENCE_HINT_MS of the
// 10s auto-stop window. Last-write-wins if two mics are recording at once — a rare multi-window
// case not worth a per-source hint stack for what's just a nicety, not a correctness signal.
// `text` falsy removes the hint (speech detected again, or recording stopped).
export function setRecordingToastHint(text) {
  if (!_recToastEl) return;
  let hintEl = _recToastEl.querySelector('.voice-rec-hint');
  if (!text) {
    if (hintEl) hintEl.remove();
    return;
  }
  if (!hintEl) {
    hintEl = document.createElement('span');
    hintEl.className = 'voice-rec-hint';
    _recToastEl.appendChild(hintEl);
  }
  hintEl.textContent = text;
}

// ── Voice input availability (C1199) ────────────────────────────────────────
// Local engine (voicePreset==='local') needs its model downloaded first — recording against
// a not-ready model wastes the user's speech (fails only after upload, see local-asr.js's
// MODEL_NOT_DOWNLOADED). Every mic on the page registers here at construction (see
// createVoiceRecorder below); task-board.js's refreshVoiceInputAvailability() is the sole
// caller of setVoiceInputAvailability(), driven off GET /api/voice-models + config, both at
// boot and on every voice-model:* WS frame.
// Fail-open: starts ready — an unfetched/failed GET must never silently kill voice input.
let _voiceReady = true;
let _voiceDisabledTitle = '';
const _micButtons = new Set();

// (C1211) Per-recorder lock — e.g. the objective composer's mic while a turn is in
// flight. Independent of _voiceReady (a global, model-availability gate): a button can be
// locked, unready, or both. WeakSet so a closed/re-rendered button's lock never leaks.
const _lockedButtons = new WeakSet();

// Single source of truth for "why is this button disabled right now", read by both
// _applyVoiceAvailability() (fires on every voice-model WS frame) and setIdle() (fires at
// the end of every recording) so a lock survives either write instead of one clobbering it.
function _micDisabledReason(button) {
  if (!_voiceReady) return _voiceDisabledTitle;
  if (_lockedButtons.has(button)) return t('voice.busyAwaitingReply');
  return null;
}

// (C1262) Every mic is icon-only — no text node names it — so `title` alone is a screen-reader
// last resort, not a real accessible name. Same rule chat-ui.js's addComposerTooltips() already
// applies via COMPOSER_TOOLTIP_ICON_ONLY: icon-only button → title AND aria-label, same string,
// written together so they can never drift apart (a disabled-reason update that only patched
// title would leave a screen reader reading a stale "Record voice" over a disabled button).
function setMicButtonLabel(button, label) {
  button.title = label;
  button.setAttribute('aria-label', label);
}

function micIdleLabel() {
  return t('voice.record', { shortcut: voiceShortcutLabel() });
}

function _applyVoiceAvailability() {
  for (const button of _micButtons) {
    if (!button.isConnected) { _micButtons.delete(button); continue; } // closed terminal/re-rendered field
    if (button.classList.contains('is-recording') || button.classList.contains('is-busy')) continue; // mid-flight, don't yank control away
    const reason = _micDisabledReason(button);
    button.disabled = !!reason;
    setMicButtonLabel(button, reason || micIdleLabel());
  }
}

// `models` is a GET /api/voice-models list (or the cached copy). `selectedModelId` is the
// project's voiceLocalModel. Composes the SAME copy the post-hoc transcribe-failure toast
// already used (voice-errors.js's localAsrReason via reasonModelNotDownloaded) so the
// disabled tooltip and that toast never say different things about the same state.
export function setVoiceInputAvailability(voicePreset, models, selectedModelId) {
  _voiceReady = isVoiceInputReady(voicePreset, models, selectedModelId);
  if (!_voiceReady) {
    const status = (models || []).find(m => m && m.modelId === selectedModelId);
    const reason = t('voice.reasonModelNotDownloaded', {
      model: (status && status.label) || selectedModelId,
      state: t(voiceModelStateLabelKey(status && status.state)),
    });
    _voiceDisabledTitle = t('voice.errEngineUnavailable', { reason });
  }
  _applyVoiceAvailability();
}

// (C1204) Chosen input device (Settings > Voice, `voiceInputDeviceId` in
// .tipatask/config.json), applied at the single getUserMedia() call in start() below. Same
// "module-level store + setter, fanned out from task-board.js" shape as _voiceReady above —
// an already-open terminal mic or a live #chat-input picks up a settings change with no
// re-wiring, since both just read this at the next recording's start().
let _voiceInputDeviceId = '';
export function setVoiceInputDeviceId(id) { _voiceInputDeviceId = id || ''; }

// (C1204) Whether ANY mic on the page is mid-recording or mid-finish right now — used by
// task-board.js's device-list label-unlock (a throwaway getUserMedia() to reveal real device
// names, see voice-devices.js#labelsUnlocked) to avoid opening a second capture while one is
// already live. hasLiveFieldRecording() alone is not enough here: it only tracks
// attachAudioRecorder() field slots (#chat-input, new-task title/desc), never the terminal
// mic (console-modal.js calls createVoiceRecorder() directly, no slot registration) — scanning
// _micButtons' own is-recording/is-busy classes (set in start()/setIdle() below) covers both.
export function isAnyVoiceCaptureActive() {
  if (hasLiveFieldRecording()) return true;
  for (const button of _micButtons) {
    if (button.classList.contains('is-recording') || button.classList.contains('is-busy')) return true;
  }
  return false;
}

// Shared MediaRecorder lifecycle: mic capture → transcription → caller-supplied sink.
// `button` gets its icon/classes/title updated through record → busy → idle; the caller
// decides what happens to the transcribed text (insert into a field, inject into a PTY, ...).
//
// (C1185) Also drives a parallel streaming pipe (createVoiceStream, voice-stream.js) that
// delivers text live as speech happens: `onPartial`/`onFinal` fire incrementally while
// recording continues, `onSessionStart` fires once per recording so a caller doing live field
// insertion can anchor a fresh span. The MediaRecorder blob above is now purely a FALLBACK —
// `onTranscript`'s one-shot batch POST only runs if streaming never delivered a single final
// result (unsupported backend, connection failure, local model not selected/downloaded, ...),
// so today's one-shot behavior is preserved exactly whenever streaming can't do better.
// A Web Audio level tap (inside voice-stream.js, computed off the same PCM frames sent to the
// server) feeds an arm-on-speech silence watchdog (voice-silence.js, C1206): the 10s
// continuous-silence auto-stop only starts counting once speech has been heard at least once, so
// a dead mic never auto-stops on that timer — it keeps recording until the user gives up. The
// last few seconds of an armed countdown show a "stopping in Ns…" hint on the recording toast;
// before that first speech, a distinct "no sound yet" hint fills the same slot instead.
export function createVoiceRecorder({ button, iconSize = 14, onTranscript, onError, onPartial, onFinal, onSessionStart, onSessionEnd }) {
  let recorder = null;
  let stream = null;
  let chunks = [];
  let voiceStream = null;
  let streamingDelivered = false;
  // (C1206) Arm-on-speech silence watchdog — see voice-silence.js's header comment. Reset fresh
  // at the top of every start().
  const silenceWatchdog = createSilenceWatchdog();
  let recordingStartedAt = 0; // for the "no sound yet" hint below, distinct from the watchdog
  // (C1206) Guards the async checkMicAccess()/getUserMedia() window before `recorder` exists —
  // without this, pressing the shortcut/button again mid-acquisition (e.g. while a slow OS
  // permission prompt is up) called start() a second time, racing two getUserMedia() opens onto
  // the same button/toast state. `toggle()`/isRecording/isActive all treat `starting` the same as
  // an in-flight recording; a stop request during this window sets `startAbortRequested` so the
  // just-opened stream is released the instant it resolves instead of starting a recording nobody
  // asked for anymore.
  let starting = false;
  let startAbortRequested = false;
  // Assigned once at the bottom of this function — lets start()/setIdle() reference the SAME
  // object this factory returns, so button.__voiceRecorder (resolveVoiceTarget's priority-1 scan
  // above) and inputEl.__voiceRecorder always resolve to one identical handle.
  let handle;
  // (C1200) First-issue-wins record of any voice:unsupported/voice:error seen this recording —
  // used only if the recording ends up producing NO text at all (see reportNothingProduced()
  // below). A voice:error covered by a working batch fallback is a non-event and must NOT toast
  // immediately — that would regress C1185's deliberate "streaming failure is invisible when the
  // fallback covers it" design. 'error' kind wins over 'unsupported' if both occur, since an
  // actual error is more actionable than "this project isn't set up for streaming".
  let streamIssue = null;
  // (C1202) Set from voice-stream.js's onMicMuted — the client-side signal of a
  // captured-but-silent track (see voice-stream.js's track 'mute' listener). Combined with
  // stop()'s returned micPeak in reportNothingProduced() below.
  let micWasMuted = false;
  let lastMicAccess = 'granted'; // set by checkMicAccess() in start(), read by reportNothingProduced()
  // Latched true the instant a voice:loading frame is seen and cleared the instant voice:ready
  // (or a terminal streaming outcome) arrives — "was the recognizer still building when the
  // user gave up and stopped?"
  let modelStillLoading = false;
  // (C1200) True from the moment the batch fallback's redo starts (post-drain, streaming
  // delivered nothing) until setIdle() — see hasLiveFieldRecording()'s use of this via
  // isActive below. Recording itself already tracked via `recorder`; this covers the gap
  // AFTER recorder is nulled but BEFORE the mic is truly done with this field (WS drain +
  // batch retranscribe), which widened once stop() started awaiting the drain (C1202).
  let finishing = false;

  // (C1199) Every mic registers here so it's born in the right disabled/enabled state (a
  // terminal opened long after boot, with a not-ready local model, must start disabled) and
  // stays in sync with later WS-driven availability flips.
  _micButtons.add(button);
  _applyVoiceAvailability();

  function setIdle() {
    button.classList.remove('is-recording', 'is-busy');
    // (C1199/C1211) Not a bare `false` — a download-in-flight OR composer-locked recorder
    // must come back up disabled, not enabled, once a recording finishes.
    // _applyVoiceAvailability() also patches this on every WS frame, but setIdle() runs on
    // every single recording, so it must agree via the same _micDisabledReason() source.
    const reason = _micDisabledReason(button);
    button.disabled = !!reason;
    button.innerHTML = MIC_SVG(iconSize);
    setMicButtonLabel(button, reason || micIdleLabel());
    // (C1200) setIdle() is the single point both the streaming-delivered early-return and the
    // batch-fallback finally() converge on — i.e. "this recording is fully over, however it
    // ended" — so it's the right place to fire onSessionEnd exactly once per recording.
    if (onSessionEnd) onSessionEnd();
  }

  function handleLevel(rms) {
    const now = Date.now();
    const { armed, stop: shouldStop, hintSeconds } = silenceWatchdog.update(rms, now);
    if (!armed) {
      // (C1206) Not yet armed — nothing has crossed the speech threshold this recording, so the
      // watchdog itself is deliberately not counting down (see its header comment). Surface a
      // distinct "nothing's reaching the mic" hint instead of silence, once the recording has run
      // long enough that a normal person has started talking — a genuinely dead mic (blocked OS
      // permission, missing entitlement, wrong input device) now looks visibly different from a
      // brief pause before the user speaks, instead of racing toward the same 10s "Stopping in
      // Ns…" countdown either way.
      if (now - recordingStartedAt >= NO_SOUND_HINT_DELAY_MS) setRecordingToastHint(t('voice.noSoundYet'));
      return;
    }
    if (hintSeconds != null) setRecordingToastHint(t('voice.stoppingIn', { n: hintSeconds }));
    else setRecordingToastHint(null);
    if (shouldStop) stop(); // hoisted function declaration below
  }

  // (C1200) Called only when a recording ends having produced ZERO text via either transport —
  // streaming delivered nothing (else the 'stop' handler's early-return at streamingDelivered
  // would already have exited) AND the batch fallback's transcript was empty. Before this, both
  // outcomes were completely silent: no toast, no error, mic just returns to idle. Now a
  // recording that produces nothing always ends in exactly one visible signal.
  // (C1202) `micAccess`/`micPeak` come from the caller (the MediaRecorder 'stop' handler below)
  // — the actual decision table now lives in voice-report.js's chooseNothingProducedMessage(),
  // pure and unit-tested there. Routing stays exactly as before: onError if the caller wired
  // one (terminal mic's red PTY line), showToast otherwise (field mics).
  function reportNothingProduced(micAccess, micPeak) {
    const msg = nothingProducedMessage({
      micAccess,
      micMuted: micWasMuted,
      micPeak,
      streamIssue,
      modelLoading: modelStillLoading,
    });
    onError ? onError(msg) : showToast(msg);
  }

  async function start() {
    if (recorder || starting || finishing) return; // includes permission and transcript drain windows
    starting = true;
    startAbortRequested = false;
    try {
      // (C1199) `disabled` alone doesn't stop the global Cmd/Ctrl+Shift+Space shortcut —
      // resolveVoiceTarget()/toggle() (chat-ui.js) call this directly, bypassing the button.
      if (!_voiceReady) { showToast(_voiceDisabledTitle); return; }
      // (C1211) `disabled` alone doesn't stop the shortcut either — same reason as above.
      if (_lockedButtons.has(button)) { showToast(t('voice.busyAwaitingReply')); return; }
      // (C1202) Check the OS-level permission BEFORE getUserMedia() — a hardened-runtime
      // packaged build missing the microphone entitlement never throws here at all (that's the
      // whole failure mode this task's root cause fixes: getUserMedia() resolves normally with a
      // captured-but-silent track). Checking explicitly turns that silence into an immediate,
      // accurate toast instead of a recording that runs to completion and reports "no speech".
      lastMicAccess = await checkMicAccess();
      // (C1206) 'not-determined' means the OS has never asked — main.js's voice:request-mic-access
      // IPC (systemPreferences.askForMediaAccess) exists for exactly this and was wired into
      // preload.js at C1202, but nothing in the renderer ever called it. Without this, the FIRST
      // recording attempt on a fresh install (or after a repack — identity:"-" re-scopes the TCC
      // grant to a new cdhash on every build, see tt-audio-input.md § Electron Permission) fell
      // through to getUserMedia()'s own prompt with no explicit ask/recheck here, and a denial
      // there was reported no differently from any other micDenied case.
      if (lastMicAccess === 'not-determined' && window.electronAPI?.requestMicAccess) {
        try { await window.electronAPI.requestMicAccess(); } catch {}
        lastMicAccess = await checkMicAccess();
      }
      if (lastMicAccess === 'denied' || lastMicAccess === 'restricted') {
        const msg = nothingProducedMessage({ micAccess: lastMicAccess });
        onError ? onError(msg) : showToast(msg);
        return;
      }
      if (startAbortRequested) return; // stop() came in before the mic was even opened
      // (C1204) `wantId` can be stale — device unplugged since it was picked, or
      // .tipatask/config.json travelled from another machine's browser profile (a deviceId is
      // salted per Chromium origin+profile, meaningless elsewhere). Retry once against the
      // system default rather than fail the whole recording — see shouldRetryWithDefault()'s
      // doc comment for exactly which errors count as "this device is the problem" vs a plain
      // permission denial, which must NOT retry (same outcome, avoids a double prompt).
      const wantId = _voiceInputDeviceId;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraintsFor(wantId) });
      } catch (err) {
        if (wantId && shouldRetryWithDefault(err)) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const msg = t('voice.deviceUnavailable');
            onError ? onError(msg) : showToast(msg);
          } catch {
            onError ? onError(t('voice.micDenied')) : showToast(t('voice.micDenied'));
            return;
          }
        } else {
          onError ? onError(t('voice.micDenied')) : showToast(t('voice.micDenied'));
          return;
        }
      }
      if (startAbortRequested) {
        // (C1206) stop() arrived while getUserMedia() was still resolving — release the
        // just-opened track immediately rather than starting a recording nobody asked for
        // anymore.
        stream.getTracks().forEach(tr => tr.stop());
        stream = null;
        return;
      }
      chunks = [];
      streamingDelivered = false;
      silenceWatchdog.reset();
      recordingStartedAt = Date.now();
      streamIssue = null;
      micWasMuted = false;
      modelStillLoading = false;
      recorder = new MediaRecorder(stream);
      recorder.addEventListener('dataavailable', e => { if (e.data.size > 0) chunks.push(e.data); });
      recorder.addEventListener('stop', async () => {
        hideRecordingToast();
        finishing = true;
        // Release the mic hardware immediately — unrelated to how long the WS drain below takes,
        // and the recording indicator (browser tab dot, OS mic light) should clear right away.
        stream.getTracks().forEach(tr => tr.stop());
        stream = null;
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        chunks = [];
        recorder = null;
        button.classList.remove('is-recording');
        // (C1202) stop() is now async — it waits for the server's voice:done (capped, see
        // voice-stream.js's DRAIN_MS/DRAIN_MS_LOADING) instead of firing-and-forgetting a flat
        // 1500ms close. Show busy state for this whole wait, not just the batch-fallback leg
        // below, so a slow drain (e.g. still draining a cold parakeet-v3 init) doesn't leave the
        // button looking idle/dead. `streamOutcome` carries the mic peak level and last-known
        // server stats even when nothing was ultimately transcribed.
        let streamOutcome = null;
        if (voiceStream) {
          const vs = voiceStream;
          voiceStream = null;
          button.classList.add('is-busy');
          button.innerHTML = MIC_SVG(iconSize);
          button.disabled = true;
          streamOutcome = await vs.stop();
        }
        setRecordingToastHint(null);
        if (streamingDelivered) {
          // Streaming already delivered live text for this recording — the batch blob above is
          // redundant (would either duplicate the transcript or waste an API call).
          finishing = false;
          setIdle();
          return;
        }
        button.classList.add('is-busy');
        button.innerHTML = MIC_SVG(iconSize);
        button.disabled = true;
        try {
          const { transcript } = await api.transcribeAudio(blob);
          if (transcript) onTranscript(transcript);
          else reportNothingProduced(lastMicAccess, streamOutcome ? streamOutcome.micPeak : null);
        } catch (err) {
          const msg = transcribeErrorMessage(err);
          onError ? onError(msg) : showToast(msg);
        } finally {
          finishing = false;
          setIdle();
        }
      });
      recorder.start();
      showRecordingToast();
      if (onSessionStart) onSessionStart();
      button.classList.add('is-recording');
      button.innerHTML = STOP_SVG(iconSize - 2);
      setMicButtonLabel(button, t('voice.stop', { shortcut: voiceShortcutLabel() }));

      voiceStream = createVoiceStream({
        // (C1202) Clears the loading hint the instant the recognizer's actually ready — matters
        // for a cold parakeet-v3 build that DOES finish mid-recording (not just the "gave up
        // while it was still loading" case reportNothingProduced() handles).
        onReady: () => { modelStillLoading = false; setRecordingToastHint(null); },
        onLoading: payload => {
          modelStillLoading = true;
          setRecordingToastHint(t('voice.loadingModel', { model: (payload && payload.modelId) || '' }));
        },
        onPartial: text => { if (onPartial) onPartial(text); },
        onFinal: text => { streamingDelivered = true; if (onFinal) onFinal(text); },
        // (C1200) No immediate user-facing toast here — the MediaRecorder fallback above covers
        // both cases, and a voice:error/voice:unsupported the fallback goes on to cover
        // successfully is a non-event to the user. Console + streamIssue only; reportNothingProduced()
        // above is what turns this into a toast, and only if the fallback ALSO produces nothing.
        onUnsupported: (reason, extra) => {
          console.warn('[voice] streaming unsupported —', reason, extra || '');
          if (!streamIssue) streamIssue = { kind: 'unsupported', message: reason };
        },
        onError: message => {
          console.warn('[voice] streaming error —', message);
          if (!streamIssue || streamIssue.kind !== 'error') streamIssue = { kind: 'error', message };
        },
        onLevel: handleLevel,
        // (C1202) The single most direct client-side signal of this task's root cause — a track
        // that opens successfully but never carries real audio (a hardened-runtime macOS build
        // missing the mic entitlement). See voice-stream.js's track 'mute' listener.
        onMicMuted: () => { micWasMuted = true; },
      });
      voiceStream.start(stream);
    } finally {
      starting = false;
    }
  }

  function stop() {
    if (starting) { startAbortRequested = true; return; } // see the abort checks inside start() above
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function toggle() {
    if (recorder || starting) stop();
    else start();
  }

  handle = {
    start,
    stop,
    toggle,
    // (C1206) `starting` counts too — the async checkMicAccess()/getUserMedia() window before
    // `recorder` exists is still "this mic is busy" for every caller (toggle() above, and
    // resolveVoiceTarget()'s priority-1 scan of is-recording/is-busy).
    get isRecording() { return !!recorder || starting; },
    // (C1202) True from recorder.stop() through the end of the 'stop' handler above — covers
    // the WS-drain + batch-retranscribe window, which used to be near-instant (a flat 1500ms
    // fire-and-forget) but can now run up to DRAIN_MS_LOADING (voice-stream.js) once a
    // recording still produces a live field-insertion target after `isRecording` already went
    // false. hasLiveFieldRecording() below reads this, not isRecording, for exactly that reason.
    get isActive() { return !!recorder || starting || finishing; },
    // (C1211) Caller-driven lock — e.g. chat-ui.js while an objective turn is in flight.
    // Never yanks a live recording (matches _applyVoiceAvailability()'s own skip); the
    // idle-state re-apply below picks it up as soon as that recording ends via setIdle().
    setLocked(v) {
      if (v) _lockedButtons.add(button); else _lockedButtons.delete(button);
      if (button.classList.contains('is-recording') || button.classList.contains('is-busy')) return;
      const reason = _micDisabledReason(button);
      button.disabled = !!reason;
      setMicButtonLabel(button, reason || micIdleLabel());
    },
  };
  // (C1206) resolveVoiceTarget()'s priority-1 scan (above) reads this off every registered
  // button to find whatever's currently live, regardless of what has focus.
  button.__voiceRecorder = handle;
  return handle;
}

// (C1200) Field-mic slots currently recording, keyed by inputEl.id — e.g. '#chat-input' (New
// Objective / follow-up), '#new-task-title', '#new-task-desc'. Populated ONLY from
// attachAudioRecorder(), never from the raw createVoiceRecorder() the terminal mic uses directly
// (console-modal.js) — the terminal overlay lives on document.body and is never touched by a
// loadAndRender() innerHTML wipe, so it must never freeze board renders.
//
// Why this exists: the objective chat's #chat-input (and the new-task fields) are rebuilt from a
// template string on every loadAndRender() (template.html's `app.innerHTML = ...`), which
// destroys the live recorder's DOM (the .audio-rec-wrap + mic button attachAudioRecorder built
// imperatively) out from under an in-flight recording — the old dataset.audioRec idempotence
// guard never trips because the fresh textarea is a brand-new node. hasLiveFieldRecording()
// below lets loadAndRender() defer itself instead. See tt-audio-input.md § Voice Input Silent
// Failures (C1200).
const _liveFieldRecordings = new Map();

export function hasLiveFieldRecording() {
  // (C1202) isActive, not isRecording — the drain + batch-retranscribe window after
  // recorder.stop() now runs up to voice-stream.js's DRAIN_MS_LOADING (was a near-instant
  // fire-and-forget), so a render could otherwise wipe #chat-input's DOM mid-drain, the exact
  // hazard this function exists to prevent (see the header comment above).
  for (const handle of _liveFieldRecordings.values()) {
    if (handle.isActive) return true;
  }
  return false;
}

function _notifyFieldRecordingChange() {
  document.dispatchEvent(new CustomEvent('tiptask:voice-field-recording', {
    detail: { active: hasLiveFieldRecording() },
  }));
}

export function attachAudioRecorder(inputEl, { emphasis = false, acceptTranscript = () => true, mountTarget = null } = {}) {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return null;
  if (inputEl.dataset.audioRec) return inputEl.__voiceRecorder || null;
  inputEl.dataset.audioRec = '1';

  // (C1200) A stale slot entry means a prior recording for this same logical field (same id) is
  // still "live" but its element got replaced by this render (the element it's bound to is no
  // longer in the document) — kill it rather than adopting it. Adopting an in-flight
  // liveInserter onto a new element would mean mapping an old anchor/lastText offset pair onto
  // content that arrived via a sessionStorage round-trip — exactly the duplication hazard
  // createLiveInserter's stillOwnsField() exists to avoid. Ending the orphan cleanly instead: its
  // trailing batch-fallback transcript still commits through utils.js's re-resolving
  // createLiveInserter (see there) and lands in the live field. Exactly one mic per slot, always.
  const slotId = inputEl.id || null;
  if (slotId) {
    const stale = _liveFieldRecordings.get(slotId);
    if (stale && stale.el && !stale.el.isConnected) {
      stale.handle.stop();
      _liveFieldRecordings.delete(slotId);
    }
  }

  const wrap = document.createElement('div');
  wrap.className = emphasis ? 'audio-rec-wrap audio-rec-wrap--emphasis' : 'audio-rec-wrap';
  if (mountTarget) mountTarget.appendChild(wrap);
  else inputEl.parentNode.insertBefore(wrap, inputEl);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = emphasis ? 'audio-rec-btn voice-btn-emphasis' : 'audio-rec-btn';
  setMicButtonLabel(btn, micIdleLabel());
  const iconSize = emphasis ? 18 : 14;
  btn.innerHTML = MIC_SVG(iconSize);
  wrap.appendChild(btn);
  // (C1287) Keep the mic in normal flow before its field so every attached form shares the
  // same above-textarea placement contract. CSS keeps the field full width below the button.
  // (TPT515) A caller-owned mountTarget (task/project chat's voice row) holds a button-only
  // wrap instead; the field stays where its own markup put it.
  if (!mountTarget) wrap.appendChild(inputEl);

  // (C1212) Never steal focus from field. Click-to-edit host (task edit modal's
  // .modal-desc-textarea) tears down textarea on blur — w/o this, wrap+btn leave
  // DOM between mousedown+mouseup, click never fires.
  btn.addEventListener('mousedown', e => e.preventDefault());

  // (C1185) One fresh liveInserter per recording (not one persistent instance reused across
  // start/stop cycles) — anchoring it at construction time means each new recording starts
  // from wherever the cursor actually is, matching insertAtCursor's original per-call
  // behavior instead of drifting to a stale position from a prior session.
  let liveInserter = null;
  const recorderHandle = createVoiceRecorder({
    button: btn,
    iconSize,
    onSessionStart: () => {
      liveInserter = createLiveInserter(inputEl);
      if (slotId) { _liveFieldRecordings.set(slotId, { handle: recorderHandle, el: inputEl }); _notifyFieldRecordingChange(); }
    },
    onSessionEnd: () => {
      if (slotId && _liveFieldRecordings.get(slotId)?.el === inputEl) {
        _liveFieldRecordings.delete(slotId);
        _notifyFieldRecordingChange();
      }
    },
    onPartial: text => acceptTranscript() && liveInserter && liveInserter.setPartial(text),
    onFinal: text => acceptTranscript() && liveInserter && liveInserter.commit(text),
    // Fallback batch path — routed through the same liveInserter (or a fresh one if streaming
    // never started at all) so it correctly REPLACES any dangling uncommitted partial instead
    // of leaving it in place and inserting a duplicate copy alongside it.
    onTranscript: text => acceptTranscript() && (liveInserter || createLiveInserter(inputEl)).commit(text),
  });

  btn.addEventListener('click', () => recorderHandle.toggle());

  inputEl.__voiceRecorder = recorderHandle;
  // (C1206) resolveVoiceTarget()'s priority-2 fallback — lets the shortcut find this recorder
  // when focus is on the mic BUTTON itself (e.g. tabbed there) rather than inputEl.
  wrap.__voiceRecorder = recorderHandle;
  return recorderHandle;
}
