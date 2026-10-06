// PCM envelope v1: big-endian metadata, signed 16-bit little-endian interleaved samples.
export const AUDIO_KIND = 3;
export const AUDIO_HEADER_BYTES = 36;
export const AUDIO_MAX_FRAMES = 4096;
export const AUDIO_MAX_STREAMS = 8;

export function parseAudioPacket(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < AUDIO_HEADER_BYTES || buffer.byteLength > 16420) return null;
  const view = new DataView(buffer);
  const channels = view.getUint8(3), epoch = view.getUint32(4), streamId = view.getUint32(8);
  const sampleRate = view.getUint32(12), frames = view.getUint32(24), gain = view.getFloat32(28);
  const firstSample = view.getUint32(16) * 0x100000000 + view.getUint32(20);
  if (view.getUint8(0) !== AUDIO_KIND || view.getUint8(1) !== 1 || view.getUint8(2) !== 1 ||
      ![1, 2].includes(channels) || epoch < 1 || epoch > 0x7fffffff || streamId < 1 ||
      sampleRate < 8000 || sampleRate > 192000 || frames < 1 || frames > AUDIO_MAX_FRAMES ||
      !Number.isSafeInteger(firstSample + frames) || !Number.isFinite(gain) || gain < 0 || gain > 1 ||
      (view.getUint8(32) & ~1) !== 0 || view.getUint8(33) || view.getUint8(34) || view.getUint8(35) ||
      buffer.byteLength !== AUDIO_HEADER_BYTES + frames * channels * 2) return null;
  return { buffer, view, epoch, streamId, sampleRate, channels, firstSample, frames, gain,
    discontinuity: Boolean(view.getUint8(32) & 1) };
}

class PcmStream {
  constructor(packet, outputRate) {
    this.rate = packet.sampleRate; this.channels = packet.channels; this.outputRate = outputRate;
    this.capacity = Math.ceil(this.rate * 0.16);
    this.left = new Float32Array(this.capacity); this.right = new Float32Array(this.capacity);
    this.read = 0; this.count = 0; this.phase = 0; this.expected = null;
    this.ready = false; this.waited = 0; this.silent = 0; this.end = null;
  }
  clear() { this.read = 0; this.count = 0; this.phase = 0; this.ready = false; this.waited = 0; }
  push(packet) {
    let start = 0;
    if (this.end !== null && packet.firstSample >= this.end) return;
    if (packet.discontinuity || (this.expected !== null && packet.firstSample > this.expected)) this.clear();
    if (this.expected !== null && packet.firstSample < this.expected) start = this.expected - packet.firstSample;
    let end = packet.frames;
    if (this.end !== null) end = Math.min(end, this.end - packet.firstSample);
    if (start >= end) return; // Duplicate or an already-ended stream.
    this.expected = packet.firstSample + end;
    if (end - start > this.capacity) start = end - this.capacity;
    const added = end - start;
    if (this.count + added > this.capacity) {
      // Keep recent samples; never build seconds of latency under a fast producer.
      const drop = this.count + added - this.capacity;
      this.read = (this.read + drop) % this.capacity; this.count -= drop; this.phase = 0;
    }
    for (let frame = start; frame < end; frame++) {
      const index = (this.read + this.count++) % this.capacity;
      const at = AUDIO_HEADER_BYTES + frame * this.channels * 2;
      this.left[index] = packet.view.getInt16(at, true) / 32768 * packet.gain;
      this.right[index] = this.channels === 2 ? packet.view.getInt16(at + 2, true) / 32768 * packet.gain : this.left[index];
    }
    this.silent = 0;
  }
  render(left, right) {
    if (!this.ready) {
      this.waited += left.length;
      this.ready = this.count >= this.rate * 0.025 || (this.count > 0 &&
        (this.waited >= this.outputRate * 0.04 || this.end !== null));
      if (!this.ready) { this.silent += left.length; return; }
    }
    const step = this.rate / this.outputRate;
    for (let i = 0; i < left.length; i++) {
      if (!this.count) { this.ready = false; this.waited = 0; this.phase = 0; this.silent += left.length - i; break; }
      const next = (this.read + (this.count > 1 ? 1 : 0)) % this.capacity;
      left[i] += this.left[this.read] * (1 - this.phase) + this.left[next] * this.phase;
      right[i] += this.right[this.read] * (1 - this.phase) + this.right[next] * this.phase;
      this.phase += step;
      const advance = Math.min(this.count, Math.floor(this.phase));
      this.read = (this.read + advance) % this.capacity; this.count -= advance; this.phase -= advance;
    }
  }
}

/** Small deterministic mixer shared by the worklet and Node fixture tests. No timers or browser globals. */
export class PcmMixer {
  constructor(outputRate = 48000) {
    if (!Number.isFinite(outputRate) || outputRate < 8000 || outputRate > 192000) throw new Error('Unsupported output sample rate');
    this.outputRate = outputRate; this.epoch = 0; this.streams = new Map(); this.ends = new Map();
  }
  reset(epoch = 0) { this.epoch = epoch; this.streams.clear(); this.ends.clear(); }
  push(buffer) {
    const packet = parseAudioPacket(buffer);
    if (!packet || !this.epoch || packet.epoch !== this.epoch) return false;
    const end = this.ends.get(packet.streamId);
    if (end !== undefined && packet.firstSample >= end) return false;
    let stream = this.streams.get(packet.streamId);
    if (!stream || stream.rate !== packet.sampleRate || stream.channels !== packet.channels) {
      if (!stream && this.streams.size >= AUDIO_MAX_STREAMS) return false;
      stream = new PcmStream(packet, this.outputRate);
      if (end !== undefined) stream.end = end;
      this.streams.set(packet.streamId, stream);
    }
    stream.push(packet); return true;
  }
  stop(epoch, streamId, lastSample) {
    if (epoch !== this.epoch || !Number.isSafeInteger(streamId) || streamId < 1 ||
        !Number.isSafeInteger(lastSample) || lastSample < 0) return;
    // Preserve tail PCM when a prioritized stop message overtakes its binary packets.
    this.ends.set(streamId, lastSample);
    if (this.ends.size > 128) this.ends.delete(this.ends.keys().next().value);
    const stream = this.streams.get(streamId); if (stream) stream.end = lastSample;
  }
  render(left, right) {
    left.fill(0); right.fill(0);
    for (const [id, stream] of this.streams) {
      stream.render(left, right);
      if (stream.silent > this.outputRate * 2) this.streams.delete(id);
    }
    for (let i = 0; i < left.length; i++) {
      left[i] = Math.max(-1, Math.min(1, left[i])); right[i] = Math.max(-1, Math.min(1, right[i]));
    }
  }
  get queuedFrames() { return [...this.streams.values()].reduce((sum, stream) => sum + stream.count, 0); }
}
