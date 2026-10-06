import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM/WebCodecs stubs exercise the actual page module's event wiring.
// This supplements (not replaces) a real browser/hardware acceptance test.
test('viewer requires explicit connection/touch and releases frames/contacts on interrupted flows', async () => {
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, handler) { const handlers = this.listeners.get(name) || []; handlers.push(handler); this.listeners.set(name, handlers); }
    dispatch(name, data = {}) { for (const handler of this.listeners.get(name) || []) handler({ preventDefault() {}, ...data }); }
  }
  const draws = [], captured = new Set();
  class Element extends Events {
    constructor() {
      super(); this.value = ''; this.disabled = false; this.checked = false; this.hidden = false; this.textContent = '';
      this.dataset = {}; this.width = 1280; this.height = 720;
      this.bounds = { left: 0, top: 0, width: 1000, height: 1000 };
      this.classes = new Set();
      this.classList = { remove: name => this.classes.delete(name),
        toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    }
    getContext() { return { clearRect() {}, fillRect() {}, drawImage: (...args) => draws.push(args) }; }
    getBoundingClientRect() { return this.bounds; }
    setPointerCapture(id) { captured.add(id); }
    hasPointerCapture(id) { return captured.has(id); }
    releasePointerCapture(id) { captured.delete(id); this.dispatch('lostpointercapture', { pointerId: id }); }
  }
  const elements = Object.fromEntries(['connection', 'endpoint', 'token', 'parked', 'touch', 'connect', 'disconnect',
    'video', 'viewport', 'placeholder', 'status', 'indicator', 'origin'].map(id => [id, new Element()]));
  elements.parked.checked = true;
  elements.touch.checked = true;
  elements.token.value = 'restored-form-value';
  const document = Object.assign(new Events(), { visibilityState: 'visible', getElementById: id => elements[id] });
  const sockets = [], decoders = [], raf = new Map();
  let rafId = 0;
  class Socket {
    constructor() { this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    send(text) { this.sent.push(JSON.parse(text)); }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    close() { this.readyState = 3; }
  }
  class Decoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor(callbacks) { Object.assign(this, callbacks); this.state = 'unconfigured'; decoders.push(this); }
    configure() { this.state = 'configured'; }
    close() { this.state = 'closed'; }
    emit() {
      const frame = { displayWidth: 1920, displayHeight: 1080, closes: 0, close() { this.closes++; } };
      this.output(frame); return frame;
    }
  }
  const window = Object.assign(new Events(), { VideoDecoder: Decoder, EncodedVideoChunk: class {}, PointerEvent: class {}, ResizeObserver: class { observe() {} } });
  window.top = window.self = window;
  Object.assign(globalThis, { document, window, location: { protocol: 'https:', origin: 'https://viewer.example' }, isSecureContext: true,
    VideoDecoder: Decoder, EncodedVideoChunk: window.EncodedVideoChunk, WebSocket: Socket, ResizeObserver: window.ResizeObserver,
    devicePixelRatio: 1,
    requestAnimationFrame: callback => { raf.set(++rafId, callback); return rafId; }, cancelAnimationFrame: id => raf.delete(id) });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Chrome/154.0.0.0' } });
  const paint = () => { const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(callback => callback()); };
  const pointer = (pointerId, clientX = 500, clientY = 500) => ({ pointerId, clientX, clientY, pointerType: 'touch', buttons: 1 });
  await import('../viewer.mjs?ui-test');

  assert.equal(sockets.length, 0, 'page load must not connect');
  assert.equal(elements.parked.checked, false, 'restored parked state is not fresh consent');
  assert.equal(elements.touch.checked, false);
  assert.equal(elements.token.value, '');
  assert.equal(elements.connect.disabled, true);
  assert.equal(elements.origin.textContent, 'https://viewer.example');
  elements.connection.dispatch('submit');
  assert.equal(sockets.length, 0);

  elements.parked.checked = true;
  elements.parked.dispatch('change');
  elements.endpoint.value = 'ws://192.168.1.20:8765/carplay';
  elements.token.value = 'synthetic-ui-token';
  elements.connection.dispatch('submit');
  elements.connection.dispatch('submit');
  assert.equal(sockets.length, 1, 'repeated submit cannot duplicate connection');
  assert.equal(elements.token.value, '');
  assert.equal(elements.endpoint.disabled, true);
  const socket = sockets[0];
  socket.open();
  assert.deepEqual(socket.sent, [{ type: 'auth', token: 'synthetic-ui-token' }]);
  socket.receive({ type: 'authenticated' });
  socket.receive({ type: 'config', streamId: 1, codec: 'avc1.64001f', width: 1920, height: 1080 });
  await Promise.resolve();
  const superseded = decoders[0].emit();
  const rendered = decoders[0].emit();
  assert.equal(superseded.closes, 1);
  assert.equal(rendered.closes, 0);
  paint();
  assert.equal(rendered.closes, 1);
  assert.equal(draws.length, 1);
  assert.equal(elements.placeholder.hidden, true);
  assert.equal(elements.touch.checked, false);
  elements.video.dispatch('pointerdown', pointer(100));
  assert.equal(socket.sent.some(m => m.type === 'touch'), false, 'video must not implicitly enable touch');

  elements.touch.checked = true;
  elements.touch.dispatch('change');
  elements.video.dispatch('pointerdown', pointer(100, 500, 100));
  assert.equal(socket.sent.some(m => m.type === 'touch'), false, 'black bars are not touch targets');
  elements.video.dispatch('pointerdown', pointer(100, 250, 500));
  elements.video.dispatch('pointerdown', pointer(200, 750, 500));
  assert.deepEqual(socket.sent.at(-1).contacts, [{ id: 0, x: .25, y: .5 }, { id: 1, x: .75, y: .5 }]);
  assert.equal(socket.sent.at(-1).streamId, 1);
  elements.video.dispatch('pointerdown', pointer(300));
  assert.equal(socket.sent.at(-1).contacts.length, 2, 'extra contact is ignored');
  elements.video.dispatch('pointerup', pointer(100));
  assert.deepEqual(socket.sent.at(-1).contacts, [{ id: 1, x: .75, y: .5 }]);
  elements.video.dispatch('pointermove', pointer(200, 2000, 2000));
  paint();
  assert.deepEqual(socket.sent.at(-1).contacts, [{ id: 1, x: 1, y: 1 }]);
  elements.video.dispatch('pointercancel', pointer(200));
  assert.deepEqual(socket.sent.at(-1).contacts, []);
  assert.equal(captured.size, 0);

  // CSS can stretch the previous bitmap between paints. Hit testing must follow
  // that actual picture, not assume it has already been fitted to the new size.
  elements.video.bounds = { left: 40, top: 20, width: 1000, height: 500 };
  elements.video.dispatch('pointerdown', pointer(350, 540, 70));
  assert.deepEqual(socket.sent.at(-1).contacts, [], 'the stretched bitmap still has black bars');
  elements.video.dispatch('pointerdown', pointer(350, 540, 270));
  assert.deepEqual(socket.sent.at(-1).contacts, [{ id: 0, x: .5, y: .5 }]);
  elements.video.dispatch('lostpointercapture', pointer(350));
  assert.deepEqual(socket.sent.at(-1).contacts, []);
  elements.video.bounds = { left: 0, top: 0, width: 1000, height: 1000 };

  elements.video.dispatch('pointerdown', pointer(400));
  window.dispatch('blur');
  assert.deepEqual(socket.sent.at(-1).contacts, []);
  assert.equal(captured.size, 0);
  const cancelled = decoders[0].emit();
  document.visibilityState = 'hidden';
  document.dispatch('visibilitychange');
  assert.equal(cancelled.closes, 1, 'pending frame is closed on hide');
  assert.equal(socket.readyState, 3);
  assert.equal(elements.placeholder.hidden, false);
  assert.equal(elements.parked.checked, false);
  assert.equal(elements.touch.checked, false);
  assert.equal(elements.touch.disabled, true);
  assert.equal(elements.token.value, '');
  document.visibilityState = 'visible';
  document.dispatch('visibilitychange');
  window.dispatch('pageshow', { persisted: true });
  assert.equal(sockets.length, 1, 'returning to the page must never reconnect');

  elements.parked.checked = true;
  elements.parked.dispatch('change');
  elements.token.value = 'synthetic-reconnect-token';
  elements.connection.dispatch('submit');
  assert.equal(sockets.length, 2);
  assert.equal(elements.touch.checked, false);
  elements.disconnect.dispatch('click');
  elements.disconnect.dispatch('click');
  assert.equal(sockets[1].readyState, 3);
});
