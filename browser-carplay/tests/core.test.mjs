import test from 'node:test';
import assert from 'node:assert/strict';
import { Contacts, fitRect, mapPointer, MAX_CONTACTS, MAX_VIDEO_PACKET_BYTES, parseConfig, parseEndpoint, parseVideoPacket } from '../core.mjs';

test('constructs only RFC1918 IPv4 destinations with a bounded port and fixed path', () => {
  for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.20']) {
    for (const port of ['1', '8765', '65535']) assert.equal(parseEndpoint(` ${host} `, ` ${port} `), `ws://${host}:${port}/carplay`);
  }
  for (const host of [
    '8.8.8.8', '127.0.0.1', '169.254.1.1', '172.15.0.1', '172.32.0.1', '192.169.0.1',
    '192.168.256.1', '192.168.01.1', '0xc0a80101', '3232235777', '192.168.1', 'bridge.local',
    '[fd00::1]', 'ws://192.168.1.20', '192.168.1.20:8765', '192.168.1.20/carplay',
    'user:pass@192.168.1.20', '192.168.1.20?token=synthetic', '192.168.1.20#secret',
    '192.168.1.20/../carplay', '192.168.1.\n20', '', null, 3232235777,
  ]) assert.throws(() => parseEndpoint(host, '8765'), String(host));
  for (const port of ['0', '65536', '08765', '-1', '1.5', '1e3', '+8765', '8765/carplay', '8765?x=1', '8 765', '', null, 8765]) {
    assert.throws(() => parseEndpoint('192.168.1.20', port), String(port));
  }
});

test('AVC and HEVC configs remain Annex B and dimensions are bounded', () => {
  for (const codec of ['avc1.64001F', 'avc3.42E01E', 'hvc1.1.6.L120.90', 'hev1.A2.4.H153.B0']) {
    assert.deepEqual(parseConfig({ type: 'config', streamId: 1, codec, width: 1920, height: 1080 }), {
      codec, codedWidth: 1920, codedHeight: 1080, optimizeForLatency: true,
    });
  }
  for (const changes of [{ width: 0 }, { height: 4097 }, { width: 1.5 }, { width: '1280' }, { height: Infinity },
    { codec: 'vp09.00.10.08' }, { codec: 'avc1.6400' }, { codec: 'hvc1.bad' }, { description: null }, { description: 'AAAA' }]) {
    assert.throws(() => parseConfig({ type: 'config', streamId: 1, codec: 'avc1.64001F', width: 1280, height: 720, ...changes }));
  }
});

test('stream identifiers are mandatory positive safe integers and stay outside decoder configuration', () => {
  const config = { type: 'config', codec: 'avc1.64001F', width: 1280, height: 720 };
  for (const streamId of [undefined, null, 0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseConfig({ ...config, streamId }));
  }
  for (const streamId of [1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(Object.hasOwn(parseConfig({ ...config, streamId }), 'streamId'), false);
  }
});

export function packet(kind = 1, timestamp = 1000000n, nal = [0, 0, 0, 1, 0x65, 0x88]) {
  const buffer = new ArrayBuffer(9 + nal.length);
  const view = new DataView(buffer);
  view.setUint8(0, kind);
  view.setBigUint64(1, timestamp, false);
  new Uint8Array(buffer, 9).set(nal);
  return buffer;
}

test('video envelope uses uint64 big-endian microseconds and a zero-copy Annex B view', () => {
  const buffer = packet(1, 0x010203040506n);
  const chunk = parseVideoPacket(buffer);
  assert.equal(chunk.type, 'key');
  assert.equal(chunk.timestamp, 0x010203040506);
  assert.equal(chunk.data.buffer, buffer);
  assert.deepEqual([...chunk.data], [0, 0, 0, 1, 0x65, 0x88]);
  assert.equal(parseVideoPacket(packet(2, 12n, [0, 0, 1, 0x41])).type, 'delta');
});

test('rejects malformed and unbounded packets', () => {
  for (const value of [new ArrayBuffer(0), new Uint8Array(20), new ArrayBuffer(12),
    new ArrayBuffer(MAX_VIDEO_PACKET_BYTES + 1), packet(3), packet(1, 1n << 63n), packet(1, 1n, [1, 2, 3, 4, 5])]) {
    assert.throws(() => parseVideoPacket(value));
  }
});

test('letterboxing and pillarboxing use exactly the drawn rectangle', () => {
  assert.deepEqual(fitRect(1000, 1000, 1920, 1080), { x: 0, y: 218.75, width: 1000, height: 562.5 });
  assert.deepEqual(fitRect(1000, 500, 500, 500), { x: 250, y: 0, width: 500, height: 500 });
  const bounds = { left: 20, top: 40, width: 1000, height: 1000 };
  assert.deepEqual(mapPointer(520, 540, bounds, 1920, 1080), { x: .5, y: .5 });
  assert.equal(mapPointer(520, 100, bounds, 1920, 1080), null);
  assert.deepEqual(mapPointer(520, 100, bounds, 1920, 1080, true), { x: .5, y: 0 });
  assert.equal(mapPointer(19, 540, bounds, 1920, 1080), null);
  assert.deepEqual(mapPointer(1200, 1100, bounds, 1920, 1080, true), { x: 1, y: 1 });
  assert.equal(fitRect(0, 20, 20, 20), null);
  assert.equal(mapPointer(NaN, 1, bounds, 1, 1), null);
});

test('two touches preserve stable HID slots when first finger lifts', () => {
  const contacts = new Contacts();
  assert.equal(MAX_CONTACTS, 2);
  assert.equal(contacts.down(101, { x: .1, y: .2 }), true);
  assert.equal(contacts.down(909, { x: .8, y: .9 }), true);
  assert.equal(contacts.down(888, { x: .5, y: .5 }), false);
  assert.equal(contacts.down(101, { x: .5, y: .5 }), false);
  assert.equal(contacts.up(101), true);
  assert.deepEqual(contacts.snapshot(), [{ id: 1, x: .8, y: .9 }]);
  contacts.move(909, { x: .7, y: .8 });
  contacts.down(404, { x: .2, y: .3 });
  assert.deepEqual(contacts.snapshot(), [{ id: 0, x: .2, y: .3 }, { id: 1, x: .7, y: .8 }]);
  const copy = contacts.snapshot();
  copy[0].x = 99;
  assert.equal(contacts.snapshot()[0].x, .2);
  contacts.clear();
  assert.deepEqual(contacts.snapshot(), []);
});

test('contacts reject invalid coordinates and unknown pointers', () => {
  const contacts = new Contacts();
  assert.equal(contacts.down(1, { x: NaN, y: .2 }), false);
  assert.equal(contacts.down(1, { x: 1.1, y: .2 }), false);
  assert.equal(contacts.move(1, { x: .1, y: .2 }), false);
  assert.equal(contacts.up(1), false);
  assert.equal(contacts.down(1, { x: 0, y: 1 }), true);
  assert.equal(contacts.move(1, null), false);
});
