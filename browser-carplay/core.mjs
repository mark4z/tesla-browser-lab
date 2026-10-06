// Pure protocol and coordinate helpers. No network, storage, or browser side effects.
// CarPlay's existing HID touch mapper exposes two stable contact slots.
export const MAX_CONTACTS = 2;
export const MAX_VIDEO_PACKET_BYTES = 4 * 1024 * 1024 + 9;
export const MAX_DECODE_QUEUE = 4;

export function parseEndpoint(value) {
  const match = /^ws:\/\/((?:\d{1,3}\.){3}\d{1,3}):([1-9]\d{0,4})\/carplay$/.exec(value.trim());
  if (!match) throw new Error('Enter the exact ws://private-IPv4:port/carplay address shown by DiPlay.');
  const octets = match[1].split('.');
  if (octets.some(part => Number(part) > 255 || String(Number(part)) !== part)) {
    throw new Error('Use an ordinary dotted private IPv4 address.');
  }
  const [a, b] = octets.map(Number);
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) {
    throw new Error('Only private LAN addresses (10.x, 172.16–31.x, or 192.168.x) are allowed.');
  }
  if (Number(match[2]) > 65535) throw new Error('The endpoint port must be between 1 and 65535.');
  return `ws://${match[1]}:${match[2]}/carplay`;
}

export function parseConfig(message) {
  const avc = /^avc[13]\.[0-9a-fA-F]{6}$/;
  const hevc = /^(?:hvc1|hev1)\.[A-C]?\d{1,2}\.[0-9a-fA-F]{1,8}\.[LH]\d{1,3}(?:\.[0-9a-fA-F]{1,2}){0,6}$/;
  if (!message || message.type !== 'config' || typeof message.codec !== 'string' ||
      !(avc.test(message.codec) || hevc.test(message.codec))) {
    throw new Error('The bridge sent an unsupported video configuration.');
  }
  if (![message.width, message.height].every(n => Number.isInteger(n) && n > 0 && n <= 4096)) {
    throw new Error('The bridge sent invalid video dimensions.');
  }
  if (!Number.isSafeInteger(message.streamId) || message.streamId <= 0) {
    throw new Error('The bridge sent an invalid video stream identifier.');
  }
  // Presence changes WebCodecs to length-prefixed AVC/HEVC. This protocol is Annex B only.
  if (Object.hasOwn(message, 'description')) throw new Error('Annex B video must omit decoder description.');
  return {
    codec: message.codec,
    codedWidth: message.width,
    codedHeight: message.height,
    optimizeForLatency: true,
  };
}

export function parseVideoPacket(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 13 || buffer.byteLength > MAX_VIDEO_PACKET_BYTES) {
    throw new Error('Invalid video packet size.');
  }
  const view = new DataView(buffer);
  const kind = view.getUint8(0);
  if (kind !== 1 && kind !== 2) throw new Error('Unknown video packet type.');
  const timestamp = view.getBigUint64(1, false);
  if (timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid video timestamp.');
  const data = new Uint8Array(buffer, 9);
  if (!(data[0] === 0 && data[1] === 0 && (data[2] === 1 || (data[2] === 0 && data[3] === 1)))) {
    throw new Error('Expected an Annex B access unit.');
  }
  return { type: kind === 1 ? 'key' : 'delta', timestamp: Number(timestamp), data };
}

export function fitRect(containerWidth, containerHeight, videoWidth, videoHeight) {
  if (![containerWidth, containerHeight, videoWidth, videoHeight].every(n => Number.isFinite(n) && n > 0)) return null;
  const scale = Math.min(containerWidth / videoWidth, containerHeight / videoHeight);
  const width = Math.min(containerWidth, videoWidth * scale);
  const height = Math.min(containerHeight, videoHeight * scale);
  return { x: (containerWidth - width) / 2, y: (containerHeight - height) / 2, width, height };
}

// Hit-test the same fitted rectangle used by drawImage. Down in black bars is ignored;
// a captured gesture moving outside the picture is clamped to its nearest edge.
export function mapPointer(clientX, clientY, bounds, videoWidth, videoHeight, clamp = false) {
  if (![clientX, clientY, bounds.left, bounds.top].every(Number.isFinite)) return null;
  const rect = fitRect(bounds.width, bounds.height, videoWidth, videoHeight);
  if (!rect) return null;
  const x = (clientX - bounds.left - rect.x) / rect.width;
  const y = (clientY - bounds.top - rect.y) / rect.height;
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

export class Contacts {
  #contacts = new Map();

  has(pointerId) { return this.#contacts.has(pointerId); }
  get size() { return this.#contacts.size; }
  get pointerIds() { return [...this.#contacts.keys()]; }

  down(pointerId, point) {
    if (this.has(pointerId) || this.size >= MAX_CONTACTS || !validPoint(point)) return false;
    const used = new Set([...this.#contacts.values()].map(contact => contact.id));
    let id = 0;
    while (used.has(id)) id += 1;
    this.#contacts.set(pointerId, { id, ...point });
    return true;
  }

  move(pointerId, point) {
    if (!this.has(pointerId) || !validPoint(point)) return false;
    this.#contacts.set(pointerId, { id: this.#contacts.get(pointerId).id, ...point });
    return true;
  }

  up(pointerId) { return this.#contacts.delete(pointerId); }
  clear() { this.#contacts.clear(); }
  snapshot() { return [...this.#contacts.values()].map(c => ({ ...c })).sort((a, b) => a.id - b.id); }
}

function validPoint(point) {
  return point && [point.x, point.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1);
}
