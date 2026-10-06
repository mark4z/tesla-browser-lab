import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../session.mjs';
import { MAX_DECODE_QUEUE } from '../core.mjs';

const CONFIG = { type: 'config', streamId: 1, codec: 'avc1.64001f', width: 1280, height: 720 };
const ENDPOINT = 'ws://192.168.1.20:8765/carplay';
const approve = socket => { socket.receive({ type: 'approvalPending', version: 2 }); socket.receive({ type: 'authenticated', version: 2 }); };
const ownTouch = (session, socket) => { session.setTouchOwnership(true); socket.receive({ ...socket.sent.at(-1), type: 'touchOwnership' }); };

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
    end(code = 1000, reason = 'MUST NOT BE DISPLAYED') { this.readyState = 3; this.onclose?.({ code, reason }); }
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
    connect() { session.connect('192.168.1.20', '8765'); sockets.at(-1).open(); return sockets.at(-1); },
    async ready() { const socket = this.connect(); approve(socket); socket.receive(CONFIG); await Promise.resolve(); return socket; },
  };
}

test('constructing the viewer cannot connect; explicit connect sends approval request first and only once', () => {
  const h = harness();
  assert.equal(h.sockets.length, 0);
  assert.equal(h.session.closed, true);
  const socket = h.connect();
  assert.equal(socket.url, ENDPOINT);
  assert.equal(socket.binaryType, 'arraybuffer');
  assert.deepEqual(socket.sent, [{ type: 'requestApproval', version: 2 }]);
  socket.open();
  assert.equal(socket.sent.length, 1);
  assert.throws(() => h.session.connect('192.168.1.20', '8765'));
  assert.equal(h.sockets.length, 1);
});

test('approval deadline stops independently of video availability', () => {
  const h = harness();
  const socket = h.connect();
  assert.equal([...h.timers.values()][0].delay, 30000);
  approve(socket);
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
  approve(socket);
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
  approve(socket);
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
  ownTouch(h.session, socket);
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
  assert.equal(h.session.sendContacts(contacts), false, 'decoded video alone cannot enable control');
  ownTouch(h.session, socket);
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
  ownTouch(h.session, socket);
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
  ownTouch(h.session, socket);
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
  ownTouch(h.session, socket);
  h.session.sendContacts([{ id: 1, x: .5, y: .6 }]);
  assert.deepEqual(socket.sent.at(-1), { type: 'touch', streamId: 2, contacts: [{ id: 1, x: .5, y: .6 }] });
  h.session.close();
});

test('waiting during codec negotiation never restores a stale stream identifier', async () => {
  const h = harness();
  let resolve;
  h.FakeDecoder.support = () => new Promise(r => { resolve = r; });
  const socket = h.connect();
  approve(socket);
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
  assert.match(h.states.at(-1).message, /WebSocket 1002; requesting Android approval/);
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
  assert.match(h.states.at(-1).message, /requesting Android approval; no close code/);
  assert.equal(socket.onclose, null);
});

test('close diagnostics do not reflect arbitrary values and reset on reconnect', async () => {
  const h = harness();
  const socket = await h.ready();
  socket.end('untrusted-code');
  assert.match(h.states.at(-1).message, /WebSocket unknown; waiting for video/);
  assert.doesNotMatch(h.states.at(-1).message, /untrusted-code/);
  h.connect().end(1008);
  assert.match(h.states.at(-1).message, /rejected this session.*WebSocket 1008; requesting Android approval/);
});


test('approvalPending does not authenticate, release controls, or extend the deadline', () => {
  const h = harness();
  const socket = h.connect();
  const timer = [...h.timers.values()][0];
  socket.receive({ type: 'approvalPending', version: 2 });
  assert.equal(h.session.authenticated, false);
  assert.equal(h.session.approvalPending, true);
  assert.equal(h.states.at(-1).state, 'approvalPending');
  assert.equal(h.session.setTouchOwnership(true), false);
  assert.equal(h.session.sendContacts([]), false);
  assert.equal(h.session.send({ type: 'requestKeyframe' }), false);
  h.session.requestKeyframe();
  assert.deepEqual(socket.sent, [{ type: 'requestApproval', version: 2 }]);
  assert.equal([...h.timers.values()][0], timer);
  timer.callback();
  assert.equal(h.session.closed, true);
  assert.equal(h.timers.size, 0);
  assert.match(h.states.at(-1).message, /Approval timed out/);
  assert.equal(h.sockets.length, 1);
  h.connect();
  assert.equal(h.session.approvalPending, false);
  h.session.close();
});

test('legacy, unversioned, newer, and out-of-order handshakes all fail closed', () => {
  for (const sequence of [
    [{ type: 'authenticated' }], [{ type: 'authenticated', version: 2 }],
    [{ type: 'approvalPending' }], [{ type: 'approvalPending', version: 1 }],
    [{ type: 'approvalPending', version: '2' }], [{ type: 'approvalPending', version: 3 }],
    [{ type: 'auth', token: 'MUST NOT BE DISPLAYED' }], [{ type: 'error' }],
    [{ type: 'approvalPending', version: 2 }, { type: 'authenticated', version: 1 }],
    [{ type: 'approvalPending', version: 2 }, { type: 'approvalPending', version: 2 }],
    [{ type: 'approvalPending', version: 2 }, CONFIG],
  ]) {
    const h = harness();
    const socket = h.connect();
    sequence.forEach(message => socket.receive(message));
    assert.equal(h.session.closed, true, JSON.stringify(sequence));
    assert.equal(h.session.authenticated, false);
    assert.equal(h.decoders.length, 0);
    assert.match(h.states.at(-1).message, /latest DiPlay APK.*updated browser viewer/);
    assert.doesNotMatch(h.states.at(-1).message, /MUST NOT BE DISPLAYED/);
    assert.equal(h.timers.size, 0);
  }
});

test('rejection, expiry, and upgrade errors have clear fixed messages and never reconnect', () => {
  for (const [code, expected] of [
    ['approvalRejected', /rejected on Android/], ['approvalTimeout', /Approval timed out/],
    ['upgradeRequired', /latest DiPlay APK.*updated browser viewer/],
  ]) {
    for (const viaClose of [false, true]) {
      const h = harness();
      const socket = h.connect();
      socket.receive({ type: 'approvalPending', version: 2 });
      if (viaClose) socket.end(1008, code);
      else socket.receive({ type: 'error', code, version: 2, message: 'MUST NOT BE DISPLAYED' });
      assert.equal(h.session.closed, true);
      assert.equal(h.session.authenticated, false);
      assert.match(h.states.at(-1).message, expected);
      assert.doesNotMatch(h.states.at(-1).message, /MUST NOT BE DISPLAYED/);
      assert.equal(h.sockets.length, 1);
      assert.equal(h.timers.size, 0);
    }
  }
});

test('error codes never resolve inherited object keys or display arbitrary bridge content', () => {
  for (const code of ['constructor', '__proto__', 'toString', 'MUST NOT BE DISPLAYED', { toString: 1 }, ['approvalRejected'], null]) {
    const h = harness();
    const socket = h.connect();
    socket.receive({ type: 'error', code, version: 2 });
    assert.equal(typeof h.states.at(-1).message, 'string');
    assert.match(h.states.at(-1).message, /latest DiPlay APK/);
  }
});

test('preapproval disconnect and stale socket callbacks cannot authorize a later attempt', () => {
  const h = harness();
  const old = h.connect();
  old.receive({ type: 'approvalPending', version: 2 });
  const staleMessage = old.onmessage;
  h.session.close();
  const current = h.connect();
  staleMessage({ data: JSON.stringify({ type: 'authenticated', version: 2 }) });
  assert.equal(h.session.authenticated, false);
  assert.equal(h.session.closed, false);
  assert.equal(h.session.approvalPending, false);
  approve(current);
  assert.equal(h.session.authenticated, true);
  h.session.close();
  h.session.receiveText('{"type":"approvalPending","version":2}');
  h.session.receiveText('{"type":"authenticated","version":2}');
  assert.equal(h.session.authenticated, false);
});

test('touch ownership requires explicit request and matching stream and request acknowledgments', async () => {
  const h = harness();
  const socket = await h.ready();
  const contacts = [{ id: 0, x: .5, y: .5 }];
  assert.equal(h.session.setTouchOwnership(true), false, 'cannot acquire before decoded output');
  h.decoders[0].emit();
  socket.receive({ type: 'touchOwnership', enabled: true, streamId: 1, requestId: 1 });
  assert.equal(h.session.touchOwned, false, 'unsolicited acknowledgment is not an opt-in');
  assert.equal(h.session.setTouchOwnership(true), true);
  const request = socket.sent.at(-1);
  assert.deepEqual(request, { type: 'setTouchOwnership', enabled: true, streamId: 1, requestId: 1 });
  assert.equal(h.session.touchOwned, false);
  assert.equal(h.session.touchPending, true);
  assert.equal(h.session.sendContacts(contacts), false);
  socket.receive({ ...request, type: 'touchOwnership', streamId: 2 });
  socket.receive({ ...request, type: 'touchOwnership', requestId: 2 });
  assert.equal(h.session.touchOwned, false);
  socket.receive({ ...request, type: 'touchOwnership' });
  assert.equal(h.session.touchPending, false);
  assert.equal(h.session.sendContacts(contacts), true);
  assert.equal(h.session.setTouchOwnership(false), true);
  const disable = socket.sent.at(-1);
  assert.deepEqual(disable, { type: 'setTouchOwnership', enabled: false, streamId: 1, requestId: 2 });
  assert.equal(h.session.touchOwned, false, 'local disable does not wait for acknowledgment');
  assert.equal(h.session.sendContacts(contacts), false);
  socket.receive({ ...request, type: 'touchOwnership' });
  assert.equal(h.session.touchOwned, false, 'late enable cannot reverse disable');
  assert.equal(h.session.setTouchOwnership(true), true);
  const secondEnable = socket.sent.at(-1);
  assert.equal(secondEnable.requestId, 3);
  socket.receive({ ...request, type: 'touchOwnership' });
  socket.receive({ ...disable, type: 'touchOwnership' });
  assert.equal(h.session.touchOwned, false, 'earlier acknowledgments cannot satisfy later opt-in');
  assert.equal(h.session.touchPending, true);
  socket.receive({ ...secondEnable, type: 'touchOwnership' });
  assert.equal(h.session.touchOwned, true);
  socket.receive({ ...secondEnable, type: 'touchOwnership', enabled: false });
  assert.equal(h.session.touchOwned, false, 'Android can revoke ownership');
  assert.equal(h.session.touchRequested, false);
  h.session.close();
});

test('reconfiguration and disconnect clear acknowledged and pending touch ownership', async () => {
  const h = harness();
  const socket = await h.ready();
  h.decoders[0].emit();
  ownTouch(h.session, socket);
  const oldRequest = { type: 'touchOwnership', enabled: true, streamId: 1, requestId: 1 };
  socket.receive({ ...CONFIG, streamId: 2 });
  assert.equal(h.session.touchRequested, false);
  assert.equal(h.session.touchOwned, false);
  assert.equal(h.session.touchPending, false);
  socket.receive(oldRequest);
  await Promise.resolve();
  h.decoders.at(-1).emit();
  socket.receive(oldRequest);
  assert.equal(h.session.touchOwned, false);
  h.session.setTouchOwnership(true);
  assert.equal(socket.sent.at(-1).streamId, 2);
  assert.equal(socket.sent.at(-1).requestId, 2);
  h.session.close();
  assert.equal(h.session.touchPending, false);
  assert.equal(h.session.currentTouchRequestId, null);
  assert.equal(h.session.touchOwned, false);
});

test('malformed ownership acknowledgments fail closed', async () => {
  for (const change of [{ enabled: 'true' }, { streamId: 0 }, { streamId: undefined },
    { requestId: undefined }, { requestId: -1 }, { requestId: '1' }, { requestId: Number.MAX_SAFE_INTEGER + 1 }]) {
    const h = harness();
    const socket = await h.ready();
    h.decoders[0].emit();
    h.session.setTouchOwnership(true);
    socket.receive({ type: 'touchOwnership', enabled: true, streamId: 1, requestId: 1, ...change });
    assert.equal(h.session.closed, true);
    assert.equal(h.session.touchOwned, false);
  }
});
