import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAudioPacket, PcmMixer } from '../audio-core.mjs';
import { BrowserAudioPlayer } from '../audio.mjs';

function packet({ epoch = 1, streamId = 1, rate = 48000, channels = 2, first = 0,
  frames = 2048, gain = 1, sample = (frame, channel) => channel ? -8192 : 16384 } = {}) {
  const buffer = new ArrayBuffer(36 + frames * channels * 2), view = new DataView(buffer);
  [3, 1, 1, channels].forEach((byte, index) => view.setUint8(index, byte));
  view.setUint32(4, epoch); view.setUint32(8, streamId); view.setUint32(12, rate);
  view.setUint32(16, Math.floor(first / 0x100000000)); view.setUint32(20, first >>> 0);
  view.setUint32(24, frames); view.setFloat32(28, gain);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++)
    view.setInt16(36 + (frame * channels + channel) * 2, sample(frame, channel), true);
  return buffer;
}
const render = (mixer, frames = 128) => {
  const left = new Float32Array(frames), right = new Float32Array(frames); mixer.render(left, right); return [left, right];
};

test('PCM fixtures preserve signed little-endian stereo, metadata endianness and focus gain', () => {
  const input = packet({ epoch: 517, streamId: 0x10203, first: 0x100000001, gain: 0.2 });
  const parsed = parseAudioPacket(input);
  assert.equal(parsed.epoch, 517); assert.equal(parsed.streamId, 0x10203); assert.equal(parsed.firstSample, 0x100000001);
  const mixer = new PcmMixer(); mixer.reset(517); assert.equal(mixer.push(input), true);
  const [left, right] = render(mixer);
  assert.ok(Math.abs(left[31] - 0.1) < 1e-6); assert.ok(Math.abs(right[31] + 0.05) < 1e-6);
});

test('PCM envelope rejects unknown encoding, malformed size, impossible formats, timestamps and gain', () => {
  for (const [offset, value, kind] of [[0, 2, 'u8'], [1, 4, 'u8'], [2, 3, 'u8'], [3, 6, 'u8'],
    [4, 0, 'u32'], [12, 0, 'u32'], [16, 0xffffffff, 'u32'], [24, 5000, 'u32'],
    [28, NaN, 'f32'], [28, -1, 'f32'], [32, 2, 'u8'], [35, 1, 'u8']]) {
    const input = packet(), view = new DataView(input);
    if (kind === 'u8') view.setUint8(offset, value); else if (kind === 'f32') view.setFloat32(offset, value); else view.setUint32(offset, value);
    assert.equal(parseAudioPacket(input), null, `invalid ${kind}@${offset}`);
  }
  assert.equal(parseAudioPacket(packet().slice(0, -2)), null);
});

test('media and navigation mix independently, mono duplicates, saturation is bounded', () => {
  const mixer = new PcmMixer(); mixer.reset(1);
  mixer.push(packet({ streamId: 1, sample: () => 16384 }));
  mixer.push(packet({ streamId: 2, channels: 1, sample: () => 8192 }));
  const [left, right] = render(mixer); assert.equal(left[0], .75); assert.equal(right[0], .75);
  mixer.push(packet({ streamId: 3, channels: 1, sample: () => 32767 }));
  assert.equal(render(mixer)[0][0], 1);
});

test('44100 Hz fixture is linearly resampled to 48000 Hz without channel swap', () => {
  const mixer = new PcmMixer(48000); mixer.reset(1);
  mixer.push(packet({ rate: 44100, sample: (frame, channel) => channel ? -frame * 8 : frame * 8 }));
  const [left, right] = render(mixer, 100);
  assert.ok(Math.abs(left[99] - 99 * 44100 / 48000 * 8 / 32768) < 1e-6);
  assert.equal(left[99], -right[99]);
});

test('overflow, sample gaps, duplicates and old generations cannot create growing latency or replay', () => {
  const mixer = new PcmMixer(); mixer.reset(9);
  assert.equal(mixer.push(packet({ epoch: 8 })), false);
  for (let i = 0; i < 100; i++) mixer.push(packet({ epoch: 9, first: i * 2048 }));
  assert.ok(mixer.queuedFrames <= 48000 * .16);
  const before = mixer.queuedFrames;
  mixer.push(packet({ epoch: 9, first: 99 * 2048 })); assert.equal(mixer.queuedFrames, before);
  mixer.push(packet({ epoch: 9, first: 300000, sample: () => -16384 }));
  assert.equal(mixer.queuedFrames, 2048); assert.equal(render(mixer)[0][0], -.5);
  mixer.reset(10); assert.equal(mixer.queuedFrames, 0); assert.equal(mixer.push(packet({ epoch: 9 })), false);
  assert.ok(render(mixer)[0].every(value => value === 0));
});

test('stop arriving before PCM permits its short tail, then rejects post-end audio; stream count is bounded', () => {
  const mixer = new PcmMixer(); mixer.reset(1);
  mixer.stop(1, 1, 12); mixer.push(packet({ frames: 12, channels: 1 }));
  const [left] = render(mixer); assert.equal(left[0], .5); assert.equal(left[11], .5); assert.equal(left[12], 0);
  assert.equal(mixer.push(packet({ first: 12 })), false);
  for (let id = 2; id <= 100; id++) mixer.push(packet({ streamId: id }));
  assert.equal(mixer.streams.size, 8);
});

function environment({ delayedModule = false, resumeState = 'running' } = {}) {
  const contexts = [], nodes = [], sent = [], states = [], requests = [], timers = new Map();
  let nextTimer = 0;
  let resolveModule;
  class Context {
    constructor() {
      contexts.push(this); this.state = 'suspended'; this.closed = 0; this.destination = {};
      this.audioWorklet = { addModule: () => delayedModule ? new Promise(resolve => { resolveModule = resolve; }) : Promise.resolve() };
    }
    resume() { this.state = resumeState; return Promise.resolve(); }
    close() { this.closed++; this.state = 'closed'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; this.onstatechange?.(); }
  }
  class WorkletNode {
    constructor() { nodes.push(this); this.messages = []; this.port = { postMessage: data => this.messages.push(data), close() {} }; }
    connect() {} disconnect() { this.disconnected = true; }
  }
  const player = new BrowserAudioPlayer({ Context, WorkletNode, secure: true,
    sendMode: (enabled, requestId) => { sent.push(enabled); requests.push({enabled, requestId}); return true; }, onState: state => states.push(state),
    setTimer: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimer: id => timers.delete(id) });
  return { player, contexts, nodes, sent, states, requests, timers, resolve: () => resolveModule?.() };
}

test('audio does not start before gesture or before worklet readiness; server acknowledgement gates packets', async () => {
  const env = environment({ delayedModule: true }); const { player, sent, contexts } = env;
  assert.equal(contexts.length, 0); assert.equal(player.handlePacket(packet()), false);
  const enabling = player.enableFromGesture(); assert.equal(contexts.length, 1); assert.deepEqual(sent, []);
  env.resolve(); assert.equal(await enabling, true); assert.deepEqual(sent, [true]); assert.equal(player.pending, true);
  assert.equal(player.handlePacket(packet()), false);
  player.handleMessage({ type: 'audioState', enabled: true, epoch: 1, requestId: 1 });
  assert.equal(player.enabled, true); assert.equal(player.handlePacket(packet()), true);
  player.disable(); assert.deepEqual(sent, [true, false]); assert.equal(player.enabled, false); assert.equal(contexts[0].state, 'closed');
});

test('cancelling module loading or resetting the socket cannot resurrect stale audio', async () => {
  const env = environment({ delayedModule: true });
  const enabling = env.player.enableFromGesture(); env.player.disable(); env.resolve();
  assert.equal(await enabling, false); assert.deepEqual(env.sent, [false]); assert.equal(env.player.ready, false);
  env.player.handleMessage({ type: 'audioState', enabled: true, epoch: 4, requestId: 1 });
  assert.equal(env.player.enabled, false); assert.deepEqual(env.sent, [false]);
  env.player.reset(); assert.equal(env.states.at(-1).enabled, false);
});

test('suspension, gesture refusal and malformed PCM restore Android; repeated enable is idempotent', async () => {
  const env = environment(); await env.player.enableFromGesture(); await env.player.enableFromGesture();
  assert.equal(env.contexts.length, 1); env.player.handleMessage({ type: 'audioState', enabled: true, epoch: 1, requestId: 1 });
  env.contexts[0].suspend(); assert.deepEqual(env.sent, [true, false]); assert.equal(env.player.enabled, false);
  const refused = environment({ resumeState: 'suspended' }); assert.equal(await refused.player.enableFromGesture(), false);
  assert.ok(!refused.sent.includes(true)); assert.equal(refused.states.at(-1).error, true);
  const malformed = environment(); await malformed.player.enableFromGesture();
  malformed.player.handleMessage({ type: 'audioState', enabled: true, epoch: 1, requestId: 1 });
  malformed.player.handlePacket(new ArrayBuffer(2)); assert.deepEqual(malformed.sent, [true, false]);
});

test('worklet MessagePort memory and old epoch packets are bounded even if the worklet stalls', async () => {
  const { player, nodes } = environment(); await player.enableFromGesture();
  player.handleMessage({ type: 'audioState', enabled: true, epoch: 5, requestId: 1 });
  assert.equal(player.handlePacket(packet({ epoch: 4 })), false);
  for (let i = 0; i < 100; i++) player.handlePacket(packet({ epoch: 5, first: i * 2048 }));
  assert.ok(player.inflightBytes <= 65536); assert.ok(player.inflight.size <= 8);
  const firstSerial = player.inflight.keys().next().value;
  nodes[0].port.onmessage({ data: { type: 'consumed', serial: firstSerial } });
  assert.equal(player.handlePacket(packet({ epoch: 5, first: 100 * 2048 })), true);
  player.reset(); assert.equal(player.inflightBytes, 0);
  await player.enableFromGesture(); player.handleMessage({ type: 'audioState', enabled: true, epoch: 1, requestId: player.activeRequestId });
  assert.equal(player.enabled, true, 'a restarted Android process may reset epoch after socket reset');
  player.dispose();
});


test('old enable/disable replies cannot alter a newer gesture and unanswered handoff times out', async () => {
  const env = environment(); const { player } = env;
  await player.enableFromGesture(); const oldEnable = player.activeRequestId;
  player.disable(); const oldDisable = player.activeRequestId;
  await player.enableFromGesture(); const current = player.activeRequestId;
  player.handleMessage({ type: 'audioState', enabled: false, epoch: 2, requestId: oldDisable });
  player.handleMessage({ type: 'audioState', enabled: true, epoch: 1, requestId: oldEnable });
  player.handleMessage({ type: 'audioState', enabled: false, epoch: 2, requestId: oldEnable, code: 'unsupported-pcm-format' });
  assert.equal(player.pending, true); assert.equal(player.ready, true); assert.equal(player.enabled, false);
  player.handleMessage({ type: 'audioState', enabled: true, epoch: 3, requestId: current });
  assert.equal(player.enabled, true); assert.equal(env.timers.size, 0);
  player.disable(); await player.enableFromGesture();
  const timeout = [...env.timers.values()][0]; timeout();
  assert.equal(player.pending, false); assert.equal(player.enabled, false);
  assert.match(env.states.at(-1).message, /timed out/); assert.equal(env.sent.at(-1), false);
});


test('stop controls share bounded MessagePort credits with PCM when worklet stalls', async () => {
  const { player, nodes } = environment(); await player.enableFromGesture();
  player.handleMessage({ type: 'audioState', enabled: true, epoch: 1, requestId: 1 });
  for (let id = 1; id <= 10000; id++)
    player.handleMessage({ type: 'audioStopped', epoch: 1, streamId: id, lastSample: 200 });
  assert.equal(player.inflight.size, 8); assert.equal(player.inflightBytes, 512);
  assert.equal(nodes[0].messages.filter(message => message.type === 'stop').length, 8);
  player.dispose();
});

test('default audio timers retain the browser global receiver', async () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const timerHandles = new Set();
  globalThis.setTimeout = function () { assert.equal(this, globalThis); const id = {}; timerHandles.add(id); return id; };
  globalThis.clearTimeout = function (id) { assert.equal(this, globalThis); timerHandles.delete(id); };
  try {
    const env = environment();
    const player = new BrowserAudioPlayer({ Context: env.player.Context, WorkletNode: env.player.WorkletNode,
      secure: true, sendMode: () => true });
    await player.enableFromGesture(); assert.equal(timerHandles.size, 1);
    player.disable(); assert.equal(timerHandles.size, 0);
  } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});
