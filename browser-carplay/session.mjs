import { MAX_DECODE_QUEUE, parseConfig, parseEndpoint, parseVideoPacket } from './core.mjs';

// One explicit connection. Dependencies are injectable so lifecycle and decode
// backpressure are tested without a network, browser, or real accessory identity.
export class BrowserSession {
  constructor({ WebSocket, VideoDecoder, EncodedVideoChunk, onState, onFrame,
    now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { WebSocket, VideoDecoder, EncodedVideoChunk, onState, onFrame, now, setTimer, clearTimer });
    this.socket = null;
    this.decoder = null;
    this.config = null;
    this.streamId = null;
    this.configVersion = 0;
    this.decoderVersion = 0;
    this.authenticated = false;
    this.streaming = false;
    this.needsKeyframe = true;
    this.lastKeyframeRequest = -Infinity;
    this.timeout = null;
    this.closed = true;
    this.consecutiveRecoveries = 0;
  }

  connect(endpoint, token) {
    if (!this.closed) throw new Error('Disconnect the current session first.');
    endpoint = parseEndpoint(endpoint);
    if (typeof token !== 'string' || !token.trim() || token.length > 256) throw new Error('Enter the temporary pairing token shown in DiPlay.');
    this.closed = false;
    this.authenticated = false;
    this.streaming = false;
    this.lastKeyframeRequest = -Infinity;
    this.consecutiveRecoveries = 0;
    this.onState('connecting', 'Connecting. Allow local-network access only if you trust this network.');
    let socket;
    try {
      socket = new this.WebSocket(endpoint);
    } catch {
      token = '';
      this.close('The browser blocked this connection. Use HTTPS and Chrome 147+ with local-network permission.', true);
      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    const current = () => !this.closed && this.socket === socket;
    // This includes time for the browser's user-mediated LAN permission prompt.
    this.armTimeout(60000, 'Connection timed out. Check local-network permission and the bridge endpoint.');
    socket.onopen = () => {
      if (!current()) { token = ''; return; }
      try {
        socket.send(JSON.stringify({ type: 'auth', token }));
      } catch {
        this.close('Could not authenticate the bridge connection.', true);
        return;
      } finally {
        token = '';
        socket.onopen = null;
      }
      this.onState('authenticating', 'Connected to the bridge. Checking the temporary pairing token…');
      this.armTimeout(10000, 'Pairing timed out. Check the token and allowed website origin in DiPlay.');
    };
    socket.onmessage = event => {
      if (!current()) return;
      if (typeof event.data === 'string') this.receiveText(event.data);
      else this.receiveVideo(event.data);
    };
    socket.onerror = () => {
      if (current()) this.close('Connection failed. Check the LAN permission, endpoint, and allowed website origin in DiPlay.', true);
    };
    socket.onclose = event => {
      token = '';
      if (!current()) return;
      const message = event.code === 1008
        ? 'The bridge rejected this session. Check the temporary token, allowed origin, and parked-use settings.'
        : 'The bridge disconnected. Re-enter the token and click Connect when you are ready.';
      this.close(message, event.code !== 1000);
    };
  }

  armTimeout(delay, message) {
    this.clearTimer(this.timeout);
    this.timeout = this.setTimer(() => this.close(message, true), delay);
  }

  receiveText(text) {
    // Do not display/log arbitrary bridge messages or payloads.
    if (text.length > 16384) { this.close('The bridge sent an oversized control message.', true); return; }
    let message;
    try { message = JSON.parse(text); } catch { this.close('The bridge sent an invalid control message.', true); return; }
    if (!message || typeof message !== 'object') { this.close('The bridge sent an invalid control message.', true); return; }
    if (message.type === 'authenticated' && !this.authenticated) {
      this.authenticated = true;
      this.clearTimer(this.timeout);
      this.timeout = null;
      this.onState('waiting', 'Paired. Waiting for CarPlay video on the Android bridge…');
    } else if (message.type === 'config' && this.authenticated) {
      void this.configure(message);
    } else if (message.type === 'error') {
      this.close('The bridge could not continue this session. Check its status in DiPlay.', true);
    } else if (message.type === 'status' && this.authenticated && ['waiting', 'disconnected'].includes(message.code)) {
      this.clearDecoder();
      this.onState('waiting', 'Paired. Waiting for CarPlay video on the Android bridge…');
    } else {
      this.close('The bridge sent an unexpected control message.', true);
    }
  }

  async configure(message) {
    this.clearDecoder();
    const version = this.configVersion;
    this.onState('configuring', 'Checking support for the bridge’s video codec…');
    try {
      const config = parseConfig(message);
      const streamId = message.streamId;
      const result = await this.VideoDecoder.isConfigSupported(config);
      if (this.closed || version !== this.configVersion) return;
      if (!result.supported) {
        this.close('This browser cannot decode the bridge’s video codec. Use a compatible browser/device or select H.264 in DiPlay.', true);
        return;
      }
      this.config = config;
      this.streamId = streamId;
      this.makeDecoder();
      this.onState('waiting', 'Ready for video. Waiting for a complete keyframe…');
      this.requestKeyframe();
    } catch {
      if (!this.closed && version === this.configVersion) this.close('The bridge’s video configuration is unsupported or invalid.', true);
    }
  }

  makeDecoder() {
    const version = ++this.decoderVersion;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.needsKeyframe = true;
    this.streaming = false;
    this.decoder = new this.VideoDecoder({
      output: frame => {
        if (this.closed || version !== this.decoderVersion) { frame.close(); return; }
        this.consecutiveRecoveries = 0;
        if (!this.streaming) {
          this.streaming = true;
          this.onState('live', 'Live display. Touch control is optional and starts off.');
        }
        try { this.onFrame(frame); } catch { frame.close(); this.close('The browser could not draw the video frame.', true); }
      },
      error: () => {
        if (!this.closed && version === this.decoderVersion) this.recover();
      },
    });
    this.decoder.configure(this.config);
  }

  receiveVideo(data) {
    if (!this.authenticated) { this.close('The bridge sent video before authentication.', true); return; }
    let chunk;
    try { chunk = parseVideoPacket(data); } catch { this.close('The bridge sent an invalid video packet.', true); return; }
    // No encoded-frame array or pending async work per frame. Frames arriving during
    // codec negotiation are discarded; the fresh keyframe request repairs the gap.
    if (!this.decoder || this.decoder.state !== 'configured') return;
    if (this.decoder.decodeQueueSize >= MAX_DECODE_QUEUE) this.recover();
    if (!this.decoder || this.closed) return;
    if (this.needsKeyframe && chunk.type !== 'key') { this.requestKeyframe(); return; }
    try {
      this.decoder.decode(new this.EncodedVideoChunk(chunk));
      this.needsKeyframe = false;
    } catch {
      this.recover();
    }
  }

  recover() {
    if (this.closed || !this.config) return;
    if (++this.consecutiveRecoveries > 3) {
      this.close('Video could not recover. Try a lower resolution or H.264 in DiPlay, then reconnect.', true);
      return;
    }
    try {
      this.makeDecoder();
      this.onState('recovering', 'Resynchronizing video. Waiting for a fresh keyframe…');
      this.requestKeyframe();
    } catch {
      this.close('The browser could not restart its video decoder.', true);
    }
  }

  requestKeyframe() {
    if (!this.authenticated || this.now() - this.lastKeyframeRequest < 1000) return;
    if (this.send({ type: 'requestKeyframe' })) this.lastKeyframeRequest = this.now();
  }

  sendContacts(contacts) {
    // A contact snapshot belongs to exactly one media generation. The server
    // releases contacts during reconfiguration; a release without a current ID
    // must not be relabeled and applied to a replacement stream.
    if (!this.authenticated || this.streamId === null || (contacts.length > 0 && !this.streaming)) return false;
    return this.send({ type: 'touch', streamId: this.streamId, contacts });
  }

  send(message) {
    if (this.closed || !this.socket || this.socket.readyState !== 1) return false;
    // Never build a queue of stale control/touch messages on a slow local link.
    if (this.socket.bufferedAmount > 16384) {
      this.close('The local link is too slow. Disconnected to release touch controls.', true);
      return false;
    }
    try { this.socket.send(JSON.stringify(message)); return true; }
    catch { this.close('The local bridge connection was lost.', true); return false; }
  }

  clearDecoder() {
    this.configVersion += 1;
    this.decoderVersion += 1;
    this.streaming = false;
    this.needsKeyframe = true;
    this.config = null;
    this.streamId = null;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
  }

  close(message = 'Disconnected. Re-enter the token to reconnect.', error = false) {
    if (this.closed) return;
    // Closing the WebSocket also releases all contacts server-side, including if a
    // final empty contact message cannot get through a failing connection.
    this.closed = true;
    this.authenticated = false;
    this.clearTimer(this.timeout);
    this.timeout = null;
    this.clearDecoder();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      if (socket.readyState < 2) socket.close(1000, 'Viewer disconnected');
    }
    this.onState(error ? 'error' : 'closed', message);
  }
}
