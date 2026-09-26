import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVoiceStream } from './voice-stream.js';
import { createLiveInserter } from './utils.js';

function browser(t) {
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
  class AudioContext {
    sampleRate = 16000;
    state = 'running';
    createMediaStreamSource = node;
    createScriptProcessor = node;
    createGain = node;
    close() {}
  }
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() { super(); Socket.last = this; }
    send(data) { this.sent.push(JSON.parse(data)); }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  for (const [key, value] of Object.entries({
    window: { AudioContext }, WebSocket: Socket,
    location: { protocol: 'http:', host: 'localhost', search: '' },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return { Socket, media: { getAudioTracks: () => [] } };
}

test('local stop waits for delayed rolling final; field and terminal get all words once', async t => {
  const { Socket, media } = browser(t);
  const field = { value: '', selectionStart: 0, selectionEnd: 0, dispatchEvent() {} };
  const inserter = createLiveInserter(field);
  let terminal = '';
  const stream = createVoiceStream({
    onPartial: text => inserter.setPartial(text),
    onFinal: text => { inserter.commit(text); terminal += `${text} `; },
  });
  await stream.start(media);
  const ws = Socket.last;
  ws.message({ type: 'voice:ready', provider: 'local' });
  ws.message({ type: 'voice:partial', text: 'Please keep.' });
  ws.message({ type: 'voice:partial', text: 'Please keep thinking' });
  assert.equal(terminal, '');
  const stopped = stream.stop();
  t.mock.timers.tick(3001);
  await Promise.resolve();
  assert.equal(ws.readyState, Socket.OPEN, 'a ready local model still needs time to flush rolling audio');
  ws.message({ type: 'voice:final', text: 'Please keep thinking about it.' });
  ws.message({ type: 'voice:final', text: 'Next sentence.' });
  ws.message({ type: 'voice:done', stats: { segments: 3 } });
  assert.deepEqual((await stopped).stats, { segments: 3 });
  assert.equal(ws.readyState, 3);
  assert.equal(field.value, 'Please keep thinking about it. Next sentence. ');
  assert.equal(terminal, field.value);
  assert.deepEqual(ws.sent, [{ type: 'voice:stop' }]);
  await stream.stop();
  assert.equal(ws.sent.length, 1);
});

test('stop budgets remain bounded: local 30s, cloud 3s; close resolves immediately', async t => {
  const { Socket, media } = browser(t);
  for (const [provider, budget] of [['local', 30000], ['assemblyai', 3000]]) {
    const stream = createVoiceStream();
    await stream.start(media);
    const ws = Socket.last;
    ws.message({ type: 'voice:ready', provider });
    const stopped = stream.stop();
    t.mock.timers.tick(budget - 1);
    await Promise.resolve();
    assert.equal(ws.readyState, Socket.OPEN);
    t.mock.timers.tick(1);
    assert.equal((await stopped).stats, null);
    assert.equal(ws.readyState, 3);
  }
  const stream = createVoiceStream();
  await stream.start(media);
  Socket.last.message({ type: 'voice:ready', provider: 'local' });
  const stopped = stream.stop();
  Socket.last.close();
  assert.equal((await stopped).stats, null);
});
