import { parseAudioPacket } from './audio-core.mjs?v=browser-av-v3';

/** An explicit user-gesture route. No AudioContext is created on page load or reconnect. */
export class BrowserAudioPlayer {
  constructor({ sendMode, onState = () => {}, Context = globalThis.AudioContext || globalThis.webkitAudioContext,
    WorkletNode = globalThis.AudioWorkletNode, secure = globalThis.isSecureContext,
    moduleUrl = new URL('./audio-worklet.mjs?v=browser-av-v3', import.meta.url).href,
    setTimer = (...args) => globalThis.setTimeout(...args), clearTimer = id => globalThis.clearTimeout(id) } = {}) {
    this.sendMode = sendMode || (() => false); this.onState = onState;
    this.Context = Context; this.WorkletNode = WorkletNode; this.moduleUrl = moduleUrl;
    this.supported = Boolean(secure && Context && WorkletNode);
    this.setTimer = setTimer; this.clearTimer = clearTimer; this.handoffTimer = null;
    this.requestId = 0; this.activeRequestId = 0;
    this.context = null; this.node = null; this.generation = 0; this.epoch = 0;
    this.enabled = false; this.pending = false; this.ready = false; this.disposed = false;
    this.serial = 0; this.inflight = new Map(); this.inflightBytes = 0; this.lastEpoch = 0;
  }
  emit(message, error = false) { this.onState({ enabled: this.enabled, pending: this.pending, ready: this.ready, message, error }); }
  async enableFromGesture() {
    if (this.disposed || this.enabled || this.pending) return false;
    if (!this.supported) { this.emit('Browser audio needs AudioWorklet in a secure browser.', true); return false; }
    const generation = ++this.generation;
    const requestId = this.activeRequestId = ++this.requestId;
    this.pending = true; this.emit('Starting browser audio…');
    let context;
    try {
      context = new this.Context({ latencyHint: 'interactive' });
      this.context = context;
      // Called synchronously from the click: preserve transient activation across module loading.
      const resume = context.resume();
      if (!context.audioWorklet) throw new Error('AudioWorklet is unavailable in this browser.');
      await Promise.all([resume, context.audioWorklet.addModule(this.moduleUrl)]);
      if (generation !== this.generation || this.disposed) { void context.close().catch(() => {}); return false; }
      if (context.state !== 'running') throw new Error('Tap Play audio here again to allow playback.');
      const node = new this.WorkletNode(context, 'diplay-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node = node;
      node.connect(context.destination);
      node.port.onmessage = ({ data }) => {
        if (generation !== this.generation || data?.type !== 'consumed') return;
        const bytes = this.inflight.get(data.serial);
        if (bytes !== undefined) { this.inflightBytes -= bytes; this.inflight.delete(data.serial); }
      };
      node.onprocessorerror = () => { if (generation === this.generation) this.disable('Browser audio stopped; Android audio restored.', true); };
      context.onstatechange = () => {
        if (generation === this.generation && context.state !== 'running')
          this.disable('Browser audio paused; Android audio restored.', true);
      };
      this.ready = true;
      // The native route changes only after worklet setup and a successful resume.
      if (!this.sendMode(true, requestId)) throw new Error('Connect to DiPlay before enabling browser audio.');
      this.handoffTimer = this.setTimer(() => {
        if (generation === this.generation && this.pending)
          this.disable('Audio handoff timed out; Android audio restored.', true);
      }, 5000);
      this.emit('Waiting for Android audio handoff…');
      return true;
    } catch (error) {
      if (generation !== this.generation) { if (context) void context.close().catch(() => {}); return false; }
      this.disable(error?.message || 'Browser audio could not start.', true);
      return false;
    }
  }
  handleMessage(message) {
    if (this.disposed) return;
    if (message.type === 'audioState') {
      if (message.requestId !== undefined && message.requestId !== this.activeRequestId) return;
      if (message.enabled && message.requestId === undefined) return;
      if (!Number.isSafeInteger(message.epoch) || message.epoch < 1 || message.epoch <= this.lastEpoch) return;
      this.lastEpoch = message.epoch;
      if (!message.enabled) {
        this.closeAudio();
        this.emit(message.code === 'audio-source-unavailable' ? 'This Android source cannot export audio.' :
          message.code === 'unsupported-pcm-format' ? 'Unsupported Android PCM format; audio stays on Android.' : 'Audio plays on Android.', Boolean(message.code));
        return;
      }
      if (!this.ready || !this.pending || this.context?.state !== 'running') return;
      this.cancelHandoffTimer();
      this.epoch = message.epoch; this.enabled = true; this.pending = false;
      this.node.port.postMessage({ type: 'reset', epoch: this.epoch });
      this.emit('Audio plays here. Android output is muted.');
    } else if (message.type === 'audioError') {
      this.disable(message.code === 'unsupported-pcm-format' ? 'Unsupported Android PCM format; audio stays on Android.' : 'Browser audio failed; Android audio restored.', true);
    } else if (message.type === 'audioStopped' && this.enabled && message.epoch === this.epoch) {
      if (Number.isSafeInteger(message.streamId) && message.streamId > 0 &&
          Number.isSafeInteger(message.lastSample) && message.lastSample >= 0)
        this.postBounded({ type: 'stop', epoch: this.epoch, streamId: message.streamId, lastSample: message.lastSample }, 64);
    }
  }
  handlePacket(buffer) {
    if (!this.enabled || !this.node || this.context?.state !== 'running') return false;
    const packet = parseAudioPacket(buffer);
    if (!packet) { this.disable('Unsupported or malformed PCM audio; Android audio restored.', true); return false; }
    if (packet.epoch !== this.epoch) return false;
    return this.postBounded({ type: 'pcm', buffer }, buffer.byteLength, [buffer]);
  }
  postBounded(message, bytes, transfer = []) {
    // Both PCM and stop controls consume credits so a stalled MessagePort stays bounded.
    if (!this.node || this.inflight.size >= 8 || this.inflightBytes + bytes > 65536) return false;
    const serial = ++this.serial;
    this.inflight.set(serial, bytes); this.inflightBytes += bytes;
    try { this.node.port.postMessage({ ...message, serial }, transfer); }
    catch (_) { this.disable('Browser audio stopped; Android audio restored.', true); return false; }
    return true;
  }

  disable(message = 'Audio plays on Android.', error = false) {
    const wasRequested = this.pending || this.ready || this.enabled;
    this.closeAudio();
    if (wasRequested) { this.activeRequestId = ++this.requestId; this.sendMode(false, this.activeRequestId); }
    this.emit(message, error);
  }
  reset(message = 'Audio plays on Android.') { this.closeAudio(); this.activeRequestId = 0; this.lastEpoch = 0; this.emit(message); }
  cancelHandoffTimer() {
    if (this.handoffTimer !== null) this.clearTimer(this.handoffTimer);
    this.handoffTimer = null;
  }
  closeAudio() {
    this.cancelHandoffTimer();
    ++this.generation; this.enabled = false; this.pending = false; this.ready = false; this.epoch = 0;
    this.inflight.clear(); this.inflightBytes = 0;
    const node = this.node, context = this.context;
    this.node = null; this.context = null;
    if (node) { node.port.onmessage = null; node.onprocessorerror = null; node.disconnect(); node.port.close?.(); }
    if (context) { context.onstatechange = null; void context.close().catch(() => {}); }
  }
  dispose() { this.disable(); this.disposed = true; }
}
