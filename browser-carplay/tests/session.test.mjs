import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../session.mjs';
import { MAX_DECODE_QUEUE } from '../core.mjs';

const CONFIG = { type: 'config', streamId: 1, codec: 'avc1.64001f', width: 1280, height: 720 };
const ENDPOINT = 'ws://192.168.1.20:8765/carplay';

function packet(type = 1) {
  const buffer = new ArrayBuffer(15);
  const view = new DataView(buffer);
  view.setUint8(0, type);
  view.setBigUint64(1, 10000n, false);
  new Uint8Array(buffer, 9).set([0, 0, 0, 1, type === 1 ? 0x65 : 0x41, 0x88]);
  return buffer;
}

function harness() {
  const sockets = [], decoders = [], states = [], frames = [], timers = new Map();
  let now = 0, timerId = 0;
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(value) { if (this.readyState !== 1) throw new Error('Closed socket'); this.sent.push(JSON.parse(value)); }
    close(code) { this.readyState = 3; this.closeCode = code; }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(value) { this.onmessage?.({ data: typeof value === 'object' && !(value instanceof ArrayBuffer) ? JSON.stringify(value) : value }); }
    end(code = 1000) { this.readyState = 3; this.onclose?.({ code, reason: 'MUST NOT BE DISPLAYED' }); }
  }
  class FakeDecoder {
    static support = async () => ({ supported: true });
    static isConfigSupported(config) { return this.support(config); }
    constructor(callbacks) { Object.assign(this, callbacks); this.state = 'unconfigured'; this.decodeQueueSize = 0; this.chunks = []; decoders.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(chunk) { this.chunks.push(chunk); this.decodeQueueSize += 1; }
    close() { this.state = 'closed'; }
    emit() { const frame = { closed: false, close() { this.closed = true; } }; this.output(frame); return frame; }
  }
  const session = new BrowserSession({
    WebSocket: FakeSocket, VideoDecoder: FakeDecoder,
    EncodedVideoChunk: class { constructor(value) { Object.assign(this, value); } },
    onState: (state, message) => states.push({ state, message }), onFrame: frame => frames.push(frame),
    now: () => now, setTimer: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimer: id => timers.delete(id),
  });
  return { session, sockets, decoders, states, frames, timers, FakeDecoder,
    advance: ms => { now += ms; },
    connect() { session.connect(ENDPOINT, 'synthetic-test-token'); sockets.at(-1).open(); return sockets.at(-1); },
    async ready() { const socket = this.connect(); socket.receive({ type: 'authenticated' }); socket.receive(CONFIG); await Promise.resolve(); return socket; },
  };
}

test('constructing the viewer cannot connect; explicit connect sends auth first and only once', () => {
  const h = harness();
  assert.equal(h.sockets.length, 0);
  assert.equal(h.session.closed, true);
  const socket = h.connect();
  assert.equal(socket.url, ENDPOINT);
  assert.equal(socket.binaryType, 'arraybuffer');
  assert.deepEqual(socket.sent, [{ type: 'auth', token: 'synthetic-test-token' }]);
  socket.open();
  assert.equal(socket.sent.length, 1);
  assert.throws(() => h.session.connect(ENDPOINT, 'again'));
  assert.equal(h.sockets.length, 1);
});

test('authentication deadline stops independently of video availability', () => {
  const h = harness();
  const socket = h.connect();
  assert.equal([...h.timers.values()][0].delay, 10000);
  socket.receive({ type: 'authenticated' });
  assert.equal(h.timers.size, 0);
  assert.equal(h.session.authenticated, true);
  assert.equal(h.states.at(-1).state, 'waiting');
  assert.equal(h.decoders.length, 0);
});

test('first config is probed, then deltas are dropped until a complete keyframe', async () => {
  const h = harness();
  const socket = await h.ready();
  assert.deepEqual(socket.sent.at(-1), { type: 'requestKeyframe' });
  socket.receive(packet(2));
  assert.equal(h.decoders[0].chunks.length, 0);
  socket.receive(packet(1));
  socket.receive(packet(2));
  assert.equal(h.decoders[0].chunks.length, 2);
  assert.equal(h.decoders[0].config.description, undefined);
  assert.equal(h.decoders[0].config.streamId, undefined);
  assert.equal(h.session.streamId, 1);
  const frame = h.decoders[0].emit();
  assert.equal(h.states.at(-1).state, 'live');
  assert.equal(h.frames[0], frame);
});

test('decode queue is bounded and overload resynchronizes instead of queuing deltas', async () => {
  const h = harness();
  const socket = await h.ready();
  socket.receive(packet(1));
  for (let i = 1; i < MAX_DECODE_QUEUE; i++) socket.receive(packet(2));
  assert.equal(h.decoders[0].chunks.length, MAX_DECODE_QUEUE);
  h.advance(1100);
  socket.receive(packet(2));
  assert.equal(h.decoders[0].state, 'closed');
  assert.equal(h.decoders.length, 2);
  assert.equal(h.decoders[1].chunks.length, 0);
  assert.equal(h.session.needsKeyframe, true);
  assert.equal(h.states.at(-1).state, 'recovering');
  assert.deepEqual(socket.sent.at(-1), { type: 'requestKeyframe' });
  socket.receive(packet(1));
  assert.equal(h.decoders[1].chunks.length, 1);
  assert.equal(h.decoders[0].emit().closed, true, 'stale output must be closed');
});

test('decode errors request a keyframe, limit retry storms, and never reconnect automatically', async () => {
  const h = harness();
  const socket = await h.ready();
  for (let i = 0; i < 4; i++) { h.advance(1100); h.decoders.at(-1).error(new Error('private payload')); }
  assert.equal(h.session.closed, true);
  assert.equal(socket.readyState, 3);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.states.some(s => s.message.includes('private payload')), false);
});

test('keyframe requests are throttled while dropping delta packets', async () => {
  const h = harness();
  const socket = await h.ready();
  for (let i = 0; i < 200; i++) socket.receive(packet(2));
  assert.equal(socket.sent.filter(m => m.type === 'requestKeyframe').length, 1);
  h.advance(1000);
  socket.receive(packet(2));
  assert.equal(socket.sent.filter(m => m.type === 'requestKeyframe').length, 2);
  assert.equal(h.decoders[0].chunks.length, 0);
});

test('unsupported codec fails closed with no decode fallback', async () => {
  const h = harness();
  h.FakeDecoder.support = async () => ({ supported: false });
  const socket = await h.ready();
  assert.equal(h.session.closed, true);
  assert.equal(h.decoders.length, 0);
  assert.equal(socket.readyState, 3);
  assert.match(h.states.at(-1).message, /cannot decode/);
});

test('closing during asynchronous codec detection prevents stale decoder creation', async () => {
  const h = harness();
  let resolve;
  h.FakeDecoder.support = () => new Promise(r => { resolve = r; });
  const socket = h.connect();
  socket.receive({ type: 'authenticated' });
  socket.receive(CONFIG);
  h.session.close();
  resolve({ supported: true });
  await Promise.resolve();
  assert.equal(h.decoders.length, 0);
  assert.equal(h.session.closed, true);
  assert.equal(h.session.streamId, null);
  assert.equal(h.timers.size, 0);
});

test('newer configuration wins over older asynchronous codec detection', async () => {
  const h = harness();
  const pending = [];
  h.FakeDecoder.support = () => new Promise(resolve => pending.push(resolve));
  const socket = h.connect();
  socket.receive({ type: 'authenticated' });
  socket.receive(CONFIG);
  socket.receive({ ...CONFIG, streamId: 2, width: 1920 });
  pending[1]({ supported: true });
  await Promise.resolve();
  pending[0]({ supported: true });
  await Promise.resolve();
  assert.equal(h.decoders.length, 1);
  assert.equal(h.decoders[0].config.codedWidth, 1920);
  assert.equal(h.session.streamId, 2);
  h.decoders[0].emit();
  h.session.sendContacts([{ id: 0, x: .1, y: .2 }]);
  assert.equal(socket.sent.at(-1).streamId, 2);
});

test('rejects unauthenticated video/config and malformed or oversized control data', () => {
  for (const value of [packet(1), CONFIG, 'not json', ' '.repeat(16385), { type: 'unknown' }, null]) {
    const h = harness();
    const socket = h.connect();
    socket.receive(value);
    assert.equal(h.session.closed, true);
    assert.equal(h.decoders.length, 0);
  }
});

test('touch is gated until decoded video and disconnect is idempotent', async () => {
  const h = harness();
  const socket = await h.ready();
  const contacts = [{ id: 0, x: .2, y: .4 }];
  assert.equal(h.session.sendContacts(contacts), false);
  h.decoders[0].emit();
  assert.equal(h.session.sendContacts(contacts), true);
  assert.deepEqual(socket.sent.at(-1), { type: 'touch', streamId: 1, contacts });
  h.session.close();
  const count = h.states.length;
  h.session.close();
  assert.equal(h.states.length, count);
  assert.equal(h.session.sendContacts(contacts), false);
  assert.equal(h.session.streamId, null);
  assert.equal(h.decoders[0].emit().closed, true);
});

test('control backpressure closes the connection rather than losing a touch release', async () => {
  const h = harness();
  const socket = await h.ready();
  h.decoders[0].emit();
  socket.bufferedAmount = 16385;
  assert.equal(h.session.sendContacts([]), false);
  assert.equal(h.session.closed, true);
  assert.match(h.states.at(-1).message, /release touch/);
});

test('bridge loss never leaks close reason, and reconnect requires another explicit connect', () => {
  const h = harness();
  h.connect().end(1008);
  assert.equal(h.session.closed, true);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.states.some(s => s.message.includes('MUST NOT BE DISPLAYED')), false);
  h.connect();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.session.authenticated, false);
});

test('waiting status invalidates video and old output while keeping authenticated socket', async () => {
  const h = harness();
  const socket = await h.ready();
  h.decoders[0].emit();
  socket.receive({ type: 'status', code: 'waiting' });
  assert.equal(h.session.closed, false);
  assert.equal(h.session.authenticated, true);
  assert.equal(h.session.streaming, false);
  assert.equal(h.session.streamId, null);
  assert.equal(h.session.sendContacts([]), false);
  assert.equal(h.decoders[0].emit().closed, true);
  assert.equal(h.states.at(-1).state, 'waiting');
});

test('configuration replacement disables touch immediately and assigns only the new stream after probing', async () => {
  const h = harness();
  const socket = await h.ready();
  h.decoders[0].emit();
  h.session.sendContacts([{ id: 0, x: .1, y: .2 }]);
  assert.equal(socket.sent.at(-1).streamId, 1);
  let resolve;
  h.FakeDecoder.support = () => new Promise(r => { resolve = r; });
  socket.receive({ ...CONFIG, streamId: 2 });
  assert.equal(h.session.streamId, null);
  assert.equal(h.session.sendContacts([]), false);
  assert.equal(h.session.sendContacts([{ id: 0, x: .3, y: .4 }]), false);
  resolve({ supported: true });
  await Promise.resolve();
  assert.equal(h.session.streamId, 2);
  h.decoders.at(-1).emit();
  h.session.sendContacts([{ id: 1, x: .5, y: .6 }]);
  assert.deepEqual(socket.sent.at(-1), { type: 'touch', streamId: 2, contacts: [{ id: 1, x: .5, y: .6 }] });
  h.session.close();
});

test('waiting during codec negotiation never restores a stale stream identifier', async () => {
  const h = harness();
  let resolve;
  h.FakeDecoder.support = () => new Promise(r => { resolve = r; });
  const socket = h.connect();
  socket.receive({ type: 'authenticated' });
  socket.receive(CONFIG);
  socket.receive({ type: 'status', code: 'waiting' });
  resolve({ supported: true });
  await Promise.resolve();
  assert.equal(h.session.streamId, null);
  assert.equal(h.decoders.length, 0);
  assert.equal(h.session.sendContacts([]), false);
  h.session.close();
});

test('authentication and connection timeout callbacks close the one active session', () => {
  const h = harness();
  h.connect();
  [...h.timers.values()][0].callback();
  assert.equal(h.session.closed, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.sockets.length, 1);
});


test('close diagnostics report numeric code and pairing phase without server contents', () => {
  const h = harness();
  const socket = h.connect();
  socket.end(1002);
  assert.match(h.states.at(-1).message, /WebSocket 1002; during pairing/);
  assert.doesNotMatch(h.states.at(-1).message, /MUST NOT BE DISPLAYED|synthetic-test-token/);
});

test('error waits briefly for the close code rather than hiding it', async () => {
  const h = harness();
  const socket = await h.ready();
  socket.receive(packet());
  h.decoders[0].emit();
  socket.onerror();
  assert.equal(h.session.closed, false);
  assert.equal([...h.timers.values()][0].delay, 1000);
  socket.end(1006);
  assert.equal(h.session.closed, true);
  assert.equal(h.timers.size, 0);
  assert.match(h.states.at(-1).message, /WebSocket 1006; streaming video/);
});

test('error without a close event terminates after a bounded wait', () => {
  const h = harness();
  const socket = h.connect();
  socket.onerror();
  [...h.timers.values()][0].callback();
  assert.equal(h.session.closed, true);
  assert.match(h.states.at(-1).message, /during pairing; no close code/);
  assert.equal(socket.onclose, null);
});

test('close diagnostics do not reflect arbitrary values and reset on reconnect', async () => {
  const h = harness();
  const socket = await h.ready();
  socket.end('untrusted-code');
  assert.match(h.states.at(-1).message, /WebSocket unknown; waiting for video/);
  assert.doesNotMatch(h.states.at(-1).message, /untrusted-code/);
  h.connect().end(1008);
  assert.match(h.states.at(-1).message, /rejected this session.*WebSocket 1008; during pairing/);
});
