import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { LOCALES } from './i18n.js';
import { WIDGET_GAP } from './voice-widget.js';

// (TPT9165) The bottom-center recording widget on the real recorder: audio-recorder.js with its
// inserter, api-client.js and i18n.js, esbuild-bundled and run in happy-dom. Doubles stand in for
// the edges only: getUserMedia/MediaRecorder, the fetch behind /api/transcribe, voice-stream.js,
// Web Audio (an AudioContext whose analyser plays back a settable amplitude), the canvas 2D
// context (records each painted polyline) and requestAnimationFrame (frames run on demand).
const en = LOCALES.en;
const uk = LOCALES.uk;
const fill = (str, params) => Object.entries(params).reduce((out, [k, v]) => out.split(`{${k}}`).join(v), str);

const scratch = mkdtempSync(join(tmpdir(), 'tt-voice-widget-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let bundled = null;
let instances = 0;

function bundle() {
  bundled ??= build({
    stdin: { contents: `export * as recorder from './src/client/audio-recorder.js';
      export * as i18n from './src/client/i18n.js';`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
    plugins: [{ name: 'voice-stream-double', setup(b) {
      b.onResolve({ filter: /\/voice-stream\.js$/ }, args => ({ path: args.path, namespace: 'voice-stream-double' }));
      b.onLoad({ filter: /.*/, namespace: 'voice-stream-double' }, () => ({ contents: `
        export function createVoiceStream(callbacks = {}) {
          return { callbacks, start() {}, async stop() { return { micPeak: 0.4, sampleRate: 16000, stats: null }; } };
        }` }));
    } }],
  }).then((result) => {
    const file = join(scratch, 'recorder.mjs');
    writeFileSync(file, result.outputFiles[0].contents);
    return pathToFileURL(file).href;
  });
  return bundled;
}

const NodeEvent = globalThis.Event;
class MediaRecorderDouble extends globalThis.EventTarget {
  constructor(stream) {
    super();
    this.stream = stream;
    this.state = 'inactive';
    this.mimeType = 'audio/webm';
    globalThis.__mediaRecorders.push(this);
  }
  start() { this.state = 'recording'; }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    setTimeout(() => {
      const data = new NodeEvent('dataavailable');
      data.data = new Blob(['audio']);
      this.dispatchEvent(data);
      this.dispatchEvent(new NodeEvent('stop'));
    }, 0);
  }
}

// One AudioContext per opened tap; its analyser fills the time-domain buffer with a sine of the
// harness's current amplitude.
function audioContextDouble(audio) {
  return class AudioContextDouble {
    constructor() {
      this.state = 'running';
      this.closed = false;
      this.source = { connected: null, disconnected: false, connect(node) { this.connected = node; }, disconnect() { this.disconnected = true; } };
      audio.contexts.push(this);
    }
    createMediaStreamSource(stream) { this.stream = stream; return this.source; }
    createAnalyser() {
      return {
        fftSize: 0,
        getFloatTimeDomainData(samples) {
          for (let i = 0; i < samples.length; i++) samples[i] = audio.amplitude * Math.sin(i / 7);
        },
      };
    }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
  };
}

// The canvas 2D context double keeps the y values of the last stroked polyline.
function canvasDouble(paint) {
  return function getContext(kind) {
    if (kind !== '2d') return null;
    let current = [];
    return {
      setTransform() {}, clearRect() { paint.cleared += 1; },
      createLinearGradient() { return { stops: [], addColorStop(at, color) { this.stops.push([at, color]); paint.gradient = this.stops; } }; },
      beginPath() { current = []; }, moveTo(x, y) { current.push(y); }, lineTo(x, y) { current.push(y); },
      stroke() { paint.lines.push(current); },
    };
  };
}

async function withWidget(run, { reducedMotion = false } = {}) {
  const href = await bundle();
  const window = new Window({ url: 'http://localhost:4455/?projectPath=%2Fprojects%2Fdemo', width: 1280, height: 900 });
  const server = { transcribeCalls: 0, transcript: 'Spoken words.' };
  const audio = { amplitude: 0, contexts: [] };
  const paint = { lines: [], cleared: 0, gradient: null };
  const frames = new Map();
  let frameId = 0;
  let clock = 1_000_000;
  const realNow = Date.now;
  const globals = new Map();
  function install(key, value) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const tracks = [];
  Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => {
      const track = { stopped: false, muted: false, stop() { this.stopped = true; }, addEventListener() {} };
      tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    },
  } });
  window.AudioContext = audioContextDouble(audio);
  window.HTMLCanvasElement.prototype.getContext = canvasDouble(paint);
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get() { return 400; } });
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, get() { return 40; } });
  if (reducedMotion) window.matchMedia = query => ({ matches: /prefers-reduced-motion:\s*reduce/.test(query) });
  for (const key of ['document', 'location', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'localStorage', 'sessionStorage']) install(key, window[key]);
  install('window', window); install('self', window); install('navigator', window.navigator);
  install('requestAnimationFrame', (fn) => { frames.set(++frameId, fn); return frameId; });
  install('cancelAnimationFrame', (id) => { frames.delete(id); });
  install('MediaRecorder', MediaRecorderDouble);
  install('fetch', async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (path === '/api/transcribe') {
      server.transcribeCalls += 1;
      return { ok: true, status: 200, json: async () => ({ transcript: server.transcript }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  install('__mediaRecorders', []);
  Date.now = () => clock;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const api = await import(`${href}?instance=${++instances}`);
    const doc = window.document;
    const ctx = {
      ...api, window, doc, server, audio, paint, tracks,
      tick(ms) { clock += ms; },
      card: () => doc.getElementById('voice-rec-toast'),
      cards: () => doc.querySelectorAll('#voice-rec-toast').length,
      pendingFrames: () => frames.size,
      // Runs the queued animation frames `count` times, 16ms apart.
      frame(count = 1) {
        for (let i = 0; i < count; i++) {
          const due = [...frames.values()];
          frames.clear();
          clock += 16;
          for (const fn of due) fn(clock);
        }
      },
      lastSwing() {
        const line = paint.lines.at(-1) ?? [];
        return line.length ? Math.max(...line.map(y => Math.abs(y - 20))) : null;
      },
      mediaRecorders: () => globalThis.__mediaRecorders,
      field(id = 'new-task-desc') {
        const textarea = doc.createElement('textarea');
        textarea.id = id;
        doc.body.appendChild(textarea);
        const handle = api.recorder.attachAudioRecorder(textarea);
        return { textarea, handle, button: textarea.closest('.audio-rec-wrap').querySelector('.audio-rec-btn') };
      },
      terminal() {
        const button = doc.createElement('button');
        doc.body.appendChild(button);
        const sent = [];
        const handle = api.recorder.createVoiceRecorder({ button, iconSize: 14, onTranscript: text => sent.push(text), onError: () => {} });
        return { button, handle, sent };
      },
    };
    await run(ctx);
  } finally {
    console.warn = warn;
    Date.now = realNow;
    await window.happyDOM.abort();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const idle = button => !button.classList.contains('is-recording') && !button.classList.contains('is-busy');

test('the card carries a dot, a 00:00 timer, a wave canvas and a labelled Stop button', async () => {
  await withWidget(async ({ recorder, i18n, card, frame, terminal }) => {
    const mic = terminal();
    await mic.handle.start();
    frame();
    const el = card();
    assert.ok(el.classList.contains('voice-toast-active'), 'revealed on the next frame');
    assert.equal(el.getAttribute('role'), 'status');
    assert.ok(el.querySelector('.voice-rec-dot[aria-hidden="true"]'));
    const timer = el.querySelector('.voice-rec-timer');
    assert.equal(timer.textContent, '00:00');
    assert.equal(timer.getAttribute('role'), 'timer');
    assert.equal(timer.getAttribute('aria-live'), 'off', 'the ticking timer is not announced');
    assert.equal(el.querySelector('canvas.voice-rec-wave')?.getAttribute('aria-hidden'), 'true');
    const shortcut = recorder.voiceShortcutLabel();
    const stop = el.querySelector('button.voice-rec-stop');
    assert.equal(stop.title, fill(en['voice.stopRecording'], { shortcut }));
    assert.equal(stop.getAttribute('aria-label'), fill(en['voice.stopRecording'], { shortcut }));
    assert.equal(el.querySelector('.voice-rec-label').textContent, fill(en['voice.recordingToast'], { shortcut }));
    mic.handle.stop();
    await until(() => idle(mic.button), 'the recording to end');

    await until(() => !card(), 'the card to leave');
    i18n.setLocale('uk');
    await mic.handle.start();
    assert.equal(card().querySelector('.voice-rec-stop').title, fill(uk['voice.stopRecording'], { shortcut }));
    assert.equal(card().querySelector('.voice-rec-label').textContent, fill(uk['voice.recordingToast'], { shortcut }));
    mic.handle.stop();
    await until(() => idle(mic.button), 'the Ukrainian recording to end');
  });
});

test('the timer counts up while the card is up', async () => {
  await withWidget(async ({ card, tick, terminal }) => {
    const mic = terminal();
    await mic.handle.start();
    tick(65_000);
    await until(() => card().querySelector('.voice-rec-timer').textContent === '01:05', 'the timer to tick');
    mic.handle.stop();
    await until(() => idle(mic.button), 'the recording to end');
  });
});

test('the wave stays flat in silence, moves with sound and settles flat again', async () => {
  await withWidget(async ({ audio, paint, frame, lastSwing, terminal }) => {
    const mic = terminal();
    await mic.handle.start();
    assert.equal(audio.contexts.length, 1, 'one analyser tap for the recording');
    assert.ok(audio.contexts[0].source.connected, 'the mic stream feeds the analyser');
    assert.deepEqual(paint.gradient?.map(([at]) => at), [0, 1], 'stroked in a two-stop gradient');

    frame(20);
    assert.equal(lastSwing(), 0, 'silence draws the flat centre line');
    audio.amplitude = 0.1; // ≈ -23 dBFS, ordinary speech
    frame(20);
    assert.ok(lastSwing() > 5, `speech swings the line ${lastSwing()}px`);
    audio.amplitude = 0;
    frame(200);
    assert.equal(lastSwing(), 0, 'back to flat after the speech');

    mic.handle.stop();
    await until(() => idle(mic.button), 'the recording to end');
    assert.equal(audio.contexts[0].closed, true, 'the AudioContext is closed');
    assert.equal(audio.contexts[0].source.disconnected, true);
  });
});

test('stopping cancels the frame loop', async () => {
  await withWidget(async ({ frame, pendingFrames, paint, terminal }) => {
    const mic = terminal();
    await mic.handle.start();
    frame(3);
    assert.equal(pendingFrames(), 1, 'one frame queued while recording');
    mic.handle.stop();
    await until(() => idle(mic.button), 'the recording to end');
    assert.equal(pendingFrames(), 0, 'no frame queued after the stop');
    const painted = paint.lines.length;
    frame(5);
    assert.equal(paint.lines.length, painted, 'nothing painted after the stop');
  });
});

test('reduced motion draws one static flat line and runs no frame loop', async () => {
  await withWidget(async ({ audio, frame, pendingFrames, lastSwing, card, terminal }) => {
    const mic = terminal();
    await mic.handle.start();
    frame(); // the reveal
    assert.equal(pendingFrames(), 0);
    audio.amplitude = 0.2;
    frame(10);
    assert.equal(lastSwing(), 0);
    assert.ok(card().classList.contains('voice-toast-active'));
    mic.handle.stop();
    await until(() => idle(mic.button), 'the recording to end');
  }, { reducedMotion: true });
});

test('the Stop button ends every live recording and each one is transcribed', async () => {
  await withWidget(async ({ card, server, mediaRecorders, field, terminal }) => {
    const term = terminal();
    const desc = field();
    await term.handle.start();
    await desc.handle.start();
    assert.equal(mediaRecorders().filter(r => r.state === 'recording').length, 2);
    card().querySelector('.voice-rec-stop').click();
    assert.equal(mediaRecorders().filter(r => r.state === 'recording').length, 0, 'both stopped by one click');
    await until(() => idle(term.button) && idle(desc.button), 'both recordings to finish');
    assert.equal(server.transcribeCalls, 2);
    assert.deepEqual(term.sent, ['Spoken words.']);
    assert.equal(desc.textarea.value, 'Spoken words. ');
    await until(() => !card(), 'the card to leave');
  });
});

test('the Stop button keeps focus in the field being dictated into', async () => {
  await withWidget(async ({ card, window, field }) => {
    const desc = field();
    desc.textarea.focus();
    await desc.handle.start();
    const press = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    card().querySelector('.voice-rec-stop').dispatchEvent(press);
    assert.equal(press.defaultPrevented, true);
    desc.handle.stop();
    await until(() => idle(desc.button), 'the recording to end');
  });
});

test('the card stays until the last recording stops, and a new one replaces a fading card', async () => {
  await withWidget(async ({ card, cards, frame, terminal, field }) => {
    const term = terminal();
    const desc = field();
    await term.handle.start();
    await desc.handle.start();
    frame();
    term.handle.stop();
    await until(() => idle(term.button), 'the terminal recording to end');
    assert.ok(card()?.classList.contains('voice-toast-active'), 'still up for the field recording');
    desc.handle.stop();
    await until(() => idle(desc.button), 'the field recording to end');
    assert.equal(card()?.classList.contains('voice-toast-active'), false, 'fading out');
    await term.handle.start(); // within the 200ms fade
    frame();
    assert.equal(cards(), 1, 'the fading card is gone, one card on the page');
    assert.ok(card().classList.contains('voice-toast-active'));
    term.handle.stop();
    await until(() => idle(term.button), 'the last recording to end');
  });
});

test('the card lifts above a bottom-docked composer and settles back when it goes', async () => {
  await withWidget(async ({ card, doc, terminal }) => {
    const composer = doc.createElement('div');
    composer.className = 'chat-input-area';
    composer.getBoundingClientRect = () => ({ left: 290, right: 990, top: 700, bottom: 884, width: 700, height: 184 });
    doc.body.appendChild(composer);
    const mic = terminal();
    await mic.handle.start();
    assert.equal(card().style.getPropertyValue('--voice-rec-bottom'), `${900 - 700 + WIDGET_GAP}px`);
    assert.equal(card().style.getPropertyValue('--voice-rec-width'), '720px');
    composer.remove();
    await until(() => card().style.getPropertyValue('--voice-rec-bottom') === '16px', 'the card to settle');
    mic.handle.stop();
    await until(() => idle(mic.button), 'the recording to end');
  });
});
