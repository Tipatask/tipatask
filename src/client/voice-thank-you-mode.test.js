import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { LOCALES } from './i18n.js';
import { SILENCE_TIMEOUT_MS } from './voice-silence.js';
import { STOP_PHRASE_SETTLE_MS } from './voice-stop-phrase.js';

// (TPT9158) Thank You voice mode end to end on the real recorder: audio-recorder.js, its
// inserter (utils.js), the real api-client.js and i18n.js bundled together and run in happy-dom.
// Only the edges are doubles: getUserMedia/MediaRecorder, the fetch behind /api/transcribe and
// /api/voice/cleanup, and voice-stream.js, whose callbacks the tests drive as the __voice__
// socket would (partials, finals, mic level frames, a drain on stop). Date.now() runs on a
// manual clock so a minute of silence takes no real time. Each test imports a fresh copy of
// the bundle, so recorder, toast and i18n state never leak between tests.
const en = LOCALES.en;
const uk = LOCALES.uk;
const fill = (str, params) => Object.entries(params).reduce((out, [k, v]) => out.split(`{${k}}`).join(v), str);

const scratch = mkdtempSync(join(tmpdir(), 'tt-voice-thank-you-'));
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
          const voiceStream = {
            callbacks, started: false, stopped: false, drainFinals: [],
            start() { this.started = true; },
            async stop() {
              this.stopped = true;
              for (const text of this.drainFinals) callbacks.onFinal && callbacks.onFinal(text);
              return { micPeak: 0.4, sampleRate: 16000, stats: null };
            },
          };
          globalThis.__voiceStreams.push(voiceStream);
          return voiceStream;
        }` }));
    } }],
  }).then((result) => {
    const file = join(scratch, 'recorder.mjs');
    writeFileSync(file, result.outputFiles[0].contents);
    return pathToFileURL(file).href;
  });
  return bundled;
}

// The MediaRecorder double is a Node EventTarget dispatching Node Events, captured before the
// page's happy-dom Event is installed as the global one (the inserter dispatches that one on
// the page's fields).
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

// The fetch behind api.transcribeAudio() and api.cleanupVoiceTranscript(). `server.cleanup`
// answers a cleanup request (default: a fixed rewrite per raw text, else the text unchanged);
// returning a pending promise holds the recorder in its cleanup step.
function fetchDouble(server) {
  return async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (path === '/api/transcribe') {
      server.transcribeCalls += 1;
      return server.transcribe ? server.transcribe() : reply({ transcript: '' });
    }
    if (path === '/api/voice/cleanup') {
      const body = JSON.parse(opts.body);
      server.cleanupCalls.push(body);
      if (server.cleanup) return server.cleanup(body, reply);
      return reply({ text: server.cleaned?.[body.text] ?? body.text, cleaned: true });
    }
    return reply({});
  };
}

async function withRecorder(run, server = {}) {
  const href = await bundle();
  const window = new Window({ url: 'http://localhost:4455/?projectPath=%2Fprojects%2Fdemo' });
  const state = { transcribeCalls: 0, cleanupCalls: [], ...server };
  let clock = 1_000_000;
  const realNow = Date.now;
  const globals = new Map();
  function install(key, value) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const track = { stopped: false, muted: false, stop() { this.stopped = true; }, addEventListener() {} };
  const navigator = window.navigator;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }),
  } });
  for (const key of ['document', 'location', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'localStorage', 'sessionStorage']) install(key, window[key]);
  install('window', window); install('self', window); install('navigator', navigator);
  install('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  install('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  install('MediaRecorder', MediaRecorderDouble);
  install('fetch', fetchDouble(state));
  install('__voiceStreams', []);
  install('__mediaRecorders', []);
  Date.now = () => clock;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const api = await import(`${href}?instance=${++instances}`);
    const doc = window.document;
    const ctx = {
      ...api, window, doc, server: state, track,
      tick(ms) { clock += ms; },
      voiceStream: () => globalThis.__voiceStreams.at(-1),
      mediaRecorder: () => globalThis.__mediaRecorders.at(-1),
      toastHint: () => doc.querySelector('#voice-rec-toast .voice-rec-hint')?.textContent ?? null,
      // The pill fades for 200ms after a recording before it leaves the DOM; a test that
      // starts another recording waits for that, so it reads the new pill.
      toastGone: () => until(() => !doc.getElementById('voice-rec-toast'), 'the recording pill to leave'),
      toastLabel: () => doc.querySelector('#voice-rec-toast .voice-rec-label')?.textContent ?? null,
      progressToast: () => doc.querySelector('.tt-saving-indicator--toast .tt-saving-label')?.textContent ?? null,
      // Mic level frames every 50ms for `ms` of clock time.
      level(rms, ms = 50) {
        for (let spent = 0; spent < ms; spent += 50) {
          clock += 50;
          ctx.voiceStream().callbacks.onLevel(rms, rms);
        }
      },
      // A field mic as attachAudioRecorder() builds it, on a textarea in the page.
      field() {
        const textarea = doc.createElement('textarea');
        textarea.id = 'new-task-desc';
        doc.body.appendChild(textarea);
        const handle = api.recorder.attachAudioRecorder(textarea);
        return { textarea, handle, button: textarea.closest('.audio-rec-wrap').querySelector('.audio-rec-btn') };
      },
      // The terminal mic as console-modal.js wires it: finals and the batch/once text go to the PTY.
      terminal() {
        const button = doc.createElement('button');
        doc.body.appendChild(button);
        const sent = [];
        const errors = [];
        const handle = api.recorder.createVoiceRecorder({
          button, iconSize: 14,
          onTranscript: text => sent.push(text),
          onFinal: text => sent.push(`${text} `),
          onError: msg => errors.push(msg),
        });
        return { button, handle, sent, errors };
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
const SPEECH = 0.2;
const SILENCE = 0.001;

test('the recording toast tells the speaker the stop phrase in the project language', async () => {
  await withRecorder(async ({ recorder, i18n, toastHint, toastLabel, toastGone, terminal }) => {
    recorder.setVoiceMode('thankyou');
    const mic = terminal();
    await mic.handle.start();
    assert.equal(toastHint(), fill(en['voice.sayStopPhrase'], { phrase: 'Thank you' }));
    mic.handle.stop();
    await until(() => idle(mic.button), 'the English recording to end');
    await toastGone();

    i18n.setLocale('uk');
    await mic.handle.start();
    assert.equal(toastHint(), 'Скажіть «Дякую», щоб завершити');
    assert.equal(toastHint(), fill(uk['voice.sayStopPhrase'], { phrase: 'Дякую' }));
    assert.equal(toastLabel(), fill(uk['voice.recordingToast'], { shortcut: recorder.voiceShortcutLabel() }));
    mic.handle.stop();
    await until(() => idle(mic.button), 'the Ukrainian recording to end');
  });
});

test('Standard mode keeps an empty hint slot and no stop phrase', async () => {
  await withRecorder(async ({ recorder, toastHint, terminal }) => {
    assert.equal(recorder.getVoiceMode(), 'standard');
    const mic = terminal();
    await mic.handle.start();
    assert.equal(toastHint(), null);
    mic.handle.stop();
    await until(() => idle(mic.button), 'the recording to end');
  });
});

test('field mic: speech is buffered, the stop phrase stops the recording, the cleaned text lands once', async () => {
  const server = { cleaned: { 'Fix the login bug. Also check the session timeout.': 'Fix the login bug and check the session timeout.' } };
  await withRecorder(async ({ recorder, field, voiceStream, mediaRecorder, level, server: srv }) => {
    recorder.setVoiceMode('thankyou');
    const { textarea, handle, button } = field();
    await handle.start();
    const vs = voiceStream();
    level(SPEECH, 500);
    vs.callbacks.onPartial('fix the login');
    vs.callbacks.onFinal('Fix the login bug.');
    level(SILENCE, 30_000); // a long pause mid-dictation
    vs.callbacks.onPartial('also check the session');
    vs.callbacks.onFinal('Also check the session timeout.');
    assert.equal(textarea.value, '', 'nothing is inserted while recording');
    assert.equal(mediaRecorder().state, 'recording', 'the pause did not stop it');
    vs.callbacks.onFinal('Thank you.');
    assert.equal(mediaRecorder().state, 'inactive', 'the stop phrase stopped the recording');
    await until(() => idle(button), 'the recording to finish');
    assert.equal(srv.transcribeCalls, 0, 'streaming finals are used, no batch transcription');
    assert.deepEqual(srv.cleanupCalls, [{ text: 'Fix the login bug. Also check the session timeout.', language: 'en' }]);
    assert.equal(textarea.value, 'Fix the login bug and check the session timeout. ');
    assert.equal(textarea.value.split('check the session timeout').length, 2, 'inserted exactly once');
  }, server);
});

test('long pauses never stop a Thank You recording, while Standard mode still stops on silence', async () => {
  await withRecorder(async ({ recorder, terminal, voiceStream, mediaRecorder, level, toastHint, toastGone }) => {
    const standard = terminal();
    await standard.handle.start();
    level(SPEECH, 300);
    level(SILENCE, SILENCE_TIMEOUT_MS + 100);
    assert.equal(mediaRecorder().state, 'inactive', 'Standard mode auto-stops after the silence timeout');
    await until(() => idle(standard.button), 'the Standard recording to end');
    await toastGone();

    recorder.setVoiceMode('thankyou');
    const mic = terminal();
    await mic.handle.start();
    level(SPEECH, 300);
    voiceStream().callbacks.onFinal('Ship the release notes.');
    level(SILENCE, 5 * 60_000);
    assert.equal(mediaRecorder().state, 'recording', 'five minutes of silence did not stop it');
    assert.equal(toastHint(), fill(en['voice.sayStopPhrase'], { phrase: 'Thank you' }), 'no "stopping in" countdown');
    mic.handle.stop();
    await until(() => idle(mic.button), 'the Thank You recording to end');
  });
});

test('a partial ending with the stop phrase stops once the mic stays quiet; a mid-sentence one does not', async () => {
  await withRecorder(async ({ recorder, terminal, voiceStream, mediaRecorder, level, server }) => {
    recorder.setVoiceMode('thankyou');
    const mic = terminal();
    await mic.handle.start();
    const vs = voiceStream();
    level(SPEECH, 500);
    vs.callbacks.onPartial('write a thank you');
    level(SPEECH, 300); // still talking
    vs.callbacks.onPartial('write a thank you note to the client');
    level(SILENCE, 10_000);
    assert.equal(mediaRecorder().state, 'recording', 'a mid-sentence "thank you" does not stop it');

    vs.callbacks.onPartial('write a thank you note to the client thank you');
    level(SILENCE, STOP_PHRASE_SETTLE_MS - 100);
    assert.equal(mediaRecorder().state, 'recording', 'not before the settle time');
    level(SILENCE, 150);
    assert.equal(mediaRecorder().state, 'inactive');
    vs.drainFinals = ['Write a thank you note to the client. Thank you.'];
    await until(() => idle(mic.button), 'the recording to finish');
    assert.deepEqual(server.cleanupCalls.map(call => call.text), ['Write a thank you note to the client.']);
    assert.deepEqual(mic.sent, ['Write a thank you note to the client.'], 'the terminal gets the text once, finals never');
  });
});

test('terminal mic: the cleaned text goes to the PTY exactly once, never per final', async () => {
  const server = { cleaned: { 'Run the tests and then commit.': 'Run the tests, then commit.' } };
  await withRecorder(async ({ recorder, terminal, voiceStream, mediaRecorder }) => {
    recorder.setVoiceMode('thankyou');
    const mic = terminal();
    await mic.handle.start();
    const vs = voiceStream();
    vs.callbacks.onFinal('Run the tests');
    vs.callbacks.onFinal('and then commit.');
    vs.callbacks.onFinal('Thanks!');
    assert.equal(mediaRecorder().state, 'inactive');
    await until(() => idle(mic.button), 'the recording to finish');
    assert.deepEqual(mic.sent, ['Run the tests, then commit.']);
    assert.deepEqual(mic.errors, []);
  }, server);
});

test('a manual stop takes the same path: stop phrase removed if said, cleaned, delivered once', async () => {
  await withRecorder(async ({ recorder, field, voiceStream, server }) => {
    recorder.setVoiceMode('thankyou');
    const { textarea, handle, button } = field();
    await handle.start();
    voiceStream().callbacks.onFinal('Rename the settings tab.');
    voiceStream().callbacks.onPartial('and update the docs');
    button.click(); // the mic button toggles: a manual stop
    await until(() => idle(button), 'the recording to finish');
    assert.deepEqual(server.cleanupCalls, [{ text: 'Rename the settings tab. and update the docs', language: 'en' }],
      'the unfinalized last partial is kept');
    assert.equal(textarea.value, 'Rename the settings tab. and update the docs ');
  });
});

test('the mic is busy and names the cleanup while it runs; nothing is inserted until it answers', async () => {
  let answer;
  const server = { cleanup: (body, reply) => new Promise(resolve => { answer = () => resolve(reply({ text: 'Clean text.', cleaned: true })); }) };
  await withRecorder(async ({ recorder, field, voiceStream, progressToast, doc }) => {
    recorder.setVoiceMode('thankyou');
    const { textarea, handle, button } = field();
    await handle.start();
    voiceStream().callbacks.onFinal('um clean uh text thank you');
    await until(() => typeof answer === 'function', 'the cleanup request');
    assert.ok(button.classList.contains('is-busy'));
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-label'), en['voice.cleaningUp']);
    assert.equal(button.title, en['voice.cleaningUp']);
    assert.equal(progressToast(), en['voice.cleaningUp']);
    assert.equal(doc.getElementById('voice-rec-toast')?.classList.contains('voice-toast-active') ?? false, false, 'the recording pill is gone');
    assert.equal(textarea.value, '');
    assert.equal(handle.isActive, true, 'still finishing — board renders keep waiting');
    answer();
    await until(() => idle(button), 'the recording to finish');
    assert.equal(textarea.value, 'Clean text. ');
    assert.equal(handle.isActive, false);
    assert.equal(button.getAttribute('aria-label'), fill(en['voice.record'], { shortcut: recorder.voiceShortcutLabel() }));
    await until(() => progressToast() === null, 'the progress toast to close');
  }, server);
});

test('a failed cleanup inserts the stripped raw text', async () => {
  const server = { cleanup: (body, reply) => reply({ error: 'boom' }, 500) };
  await withRecorder(async ({ recorder, field, voiceStream }) => {
    recorder.setVoiceMode('thankyou');
    const { textarea, handle, button } = field();
    await handle.start();
    voiceStream().callbacks.onFinal('Keep the raw words, thank you.');
    await until(() => idle(button), 'the recording to finish');
    assert.equal(textarea.value, 'Keep the raw words ');
  }, server);
});

test('without live streaming the batch transcript is used and the hint points at the manual stop', async () => {
  const server = { transcribe: async () => ({ ok: true, status: 200, json: async () => ({ transcript: 'Batch words here. Thank you.' }) }) };
  await withRecorder(async ({ recorder, terminal, voiceStream, toastHint, server: srv }) => {
    recorder.setVoiceMode('thankyou');
    const mic = terminal();
    await mic.handle.start();
    voiceStream().callbacks.onUnsupported('streaming is not set up');
    assert.equal(toastHint(), fill(en['voice.stopPhraseUnavailable'], { phrase: 'Thank you', shortcut: recorder.voiceShortcutLabel() }));
    mic.handle.stop();
    await until(() => idle(mic.button), 'the recording to finish');
    assert.equal(srv.transcribeCalls, 1);
    assert.deepEqual(srv.cleanupCalls, [{ text: 'Batch words here.', language: 'en' }]);
    assert.deepEqual(mic.sent, ['Batch words here.']);
  }, server);
});

test('a stream error flips the hint to the manual stop until the transcript flows again', async () => {
  await withRecorder(async ({ recorder, terminal, voiceStream, toastHint, i18n }) => {
    i18n.setLocale('uk');
    recorder.setVoiceMode('thankyou');
    const mic = terminal();
    await mic.handle.start();
    voiceStream().callbacks.onError('Local transcription decode failed');
    assert.equal(toastHint(), fill(uk['voice.stopPhraseUnavailable'], { phrase: 'Дякую', shortcut: recorder.voiceShortcutLabel() }));
    voiceStream().callbacks.onPartial('ще працює');
    assert.equal(toastHint(), fill(uk['voice.sayStopPhrase'], { phrase: 'Дякую' }));
    voiceStream().callbacks.onFinal('Ще працює. Дякую!');
    await until(() => idle(mic.button), 'the recording to finish');
    assert.deepEqual(mic.sent, ['Ще працює.']);
  });
});

test('saying only the stop phrase inserts nothing and reports nothing', async () => {
  await withRecorder(async ({ recorder, field, voiceStream, server, doc }) => {
    recorder.setVoiceMode('thankyou');
    const { textarea, handle, button } = field();
    await handle.start();
    voiceStream().callbacks.onFinal('Thank you.');
    await until(() => idle(button), 'the recording to finish');
    assert.equal(textarea.value, '');
    assert.deepEqual(server.cleanupCalls, []);
    assert.equal(doc.querySelector('.tt-toast--error'), null);
  });
});

test('a Thank You recording with no speech at all still says so', async () => {
  await withRecorder(async ({ recorder, terminal, server }) => {
    recorder.setVoiceMode('thankyou');
    const mic = terminal();
    await mic.handle.start();
    mic.handle.stop();
    await until(() => idle(mic.button), 'the recording to finish');
    assert.equal(server.transcribeCalls, 1, 'the batch fallback was tried');
    assert.deepEqual(server.cleanupCalls, []);
    assert.equal(mic.errors.length, 1, 'one nothing-produced message');
    assert.deepEqual(mic.sent, []);
  });
});

test('the mode a recording started in holds until it ends', async () => {
  await withRecorder(async ({ recorder, field, voiceStream }) => {
    recorder.setVoiceMode('thankyou');
    const { textarea, handle, button } = field();
    await handle.start();
    recorder.setVoiceMode('standard');
    voiceStream().callbacks.onFinal('Still Thank You mode. Thank you.');
    await until(() => idle(button), 'the recording to finish');
    assert.equal(textarea.value, 'Still Thank You mode. ');
  });
});

test('Standard mode is unchanged: live text, no cleanup pass', async () => {
  await withRecorder(async ({ field, voiceStream, server }) => {
    const { textarea, handle, button } = field();
    await handle.start();
    voiceStream().callbacks.onPartial('fix the');
    assert.equal(textarea.value, 'fix the');
    voiceStream().callbacks.onFinal('Fix the bug. Thank you.');
    assert.equal(textarea.value, 'Fix the bug. Thank you. ');
    handle.stop();
    await until(() => idle(button), 'the recording to finish');
    assert.deepEqual(server.cleanupCalls, []);
    assert.equal(server.transcribeCalls, 0);
    assert.equal(textarea.value, 'Fix the bug. Thank you. ');
  });
});
