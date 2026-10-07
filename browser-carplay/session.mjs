import { MAX_DECODE_QUEUE, parseConfig, parseEndpoint, parseVideoPacket } from './core.mjs?v=browser-av-v3';
import { ConnectionDiagnostics } from './diagnostics.mjs?v=connection-diag-v1';

export const PROTOCOL_VERSION = 2;
const UPGRADE_ADVICE = 'Install the latest DiPlay APK and reload the updated browser viewer; both must support Android approval (protocol v2).';

const APPROVAL_ERRORS = {
  approvalRejected: 'The connection was rejected on Android. Click Connect to request approval again.',
  approvalTimeout: 'Approval timed out. Click Connect to try again and accept the prompt on Android.',
  upgradeRequired: UPGRADE_ADVICE,
};

// One explicit connection. Dependencies are injectable so lifecycle and decode
// backpressure are tested without a network, browser, or real accessory identity.
export class BrowserSession {
  constructor({ WebSocket, VideoDecoder, EncodedVideoChunk, onState, onFrame,
    onTouchOwnership = () => {}, onAudioMessage = () => {}, onAudioPacket = () => {}, onAudioReset = () => {}, onDiagnostics = () => {},
    now = () => performance.now(),
    // Window timers require their host receiver, not this BrowserSession.
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = id => globalThis.clearTimeout(id) }) {
    Object.assign(this, { WebSocket, VideoDecoder, EncodedVideoChunk, onState, onFrame, onTouchOwnership, onAudioMessage, onAudioPacket, onAudioReset, now, setTimer, clearTimer });
    this.diagnostics = new ConnectionDiagnostics({ now, onUpdate: onDiagnostics });
    this.socket = null;
    this.decoder = null;
    this.config = null;
    this.streamId = null;
    this.configVersion = 0;
    this.decoderVersion = 0;
    this.authenticated = false;
    this.approvalPending = false;
    this.touchRequested = false;
    this.touchOwned = false;
    this.touchPending = false;
    this.touchRequestId = 0;
    this.currentTouchRequestId = null;
    this.streaming = false;
    this.needsKeyframe = true;
    this.lastKeyframeRequest = -Infinity;
    this.timeout = null;
    this.videoTimeout = null;
    this.closed = true;
    this.consecutiveRecoveries = 0;
    this.backpressured = false;
  }

  connect(ip, port) {
    if (!this.closed) throw new Error('Disconnect the current session first.');
    const endpoint = parseEndpoint(ip, port);
    this.closed = false;
    this.authenticated = false;
    this.approvalPending = false;
    this.streaming = false;
    this.lastKeyframeRequest = -Infinity;
    this.consecutiveRecoveries = 0;
    // parseEndpoint constructs the exact transport used below; retain its scheme
    // only, never the private address or a full endpoint in diagnostics.
    this.diagnostics.start(endpoint.startsWith('ws:') ? 'ws:' : null);
    this.reportState('connecting', 'Connecting. Allow local-network access only if you trust this network.');
    let socket;
    try {
      socket = new this.WebSocket(endpoint);
    } catch {
      this.close('The browser blocked this connection. Use HTTPS and Chrome 147+ with local-network permission.', true);
      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    const current = () => !this.closed && this.socket === socket;
    // This includes time for the browser's user-mediated LAN permission prompt.
    this.armTimeout(60000, 'Connection timed out. Check local-network permission and the bridge IP and port.');
    socket.onopen = () => {
      if (!current()) return;
      socket.onopen = null;
      this.diagnostics.mark('wsOpen');
      try {
        socket.send(JSON.stringify({ type: 'requestApproval', version: PROTOCOL_VERSION }));
      } catch {
        this.close('Could not request approval from the Android bridge.', true);
        return;
      }
      this.reportState('requestingApproval', 'Requesting approval. Look for the connection prompt in DiPlay on Android…');
      this.armTimeout(30000, `Approval timed out. Click Connect to try again and accept the prompt on Android. If no prompt appears, ${UPGRADE_ADVICE}`);
    };
    socket.onmessage = event => {
      if (!current()) return;
      if (typeof event.data === 'string') this.receiveText(event.data);
      else this.receiveVideo(event.data);
    };
    socket.onerror = () => {
      // A CloseEvent normally follows error and carries the useful numeric code.
      // Bound the wait for implementations that never deliver that event.
      if (current()) this.armTimeout(1000,
        `Connection failed (${this.phaseLabel()}; no close code). Check the LAN permission, IP and port, and allowed website origin in DiPlay.`);
    };
    socket.onclose = event => {
      if (!current()) return;
      let message = event.code === 1008
        ? 'The bridge rejected this session. Check the Android approval prompt, allowed origin, and parked-use settings.'
        : 'The bridge disconnected. Click Connect when you are ready to request approval again.';
      // Only map exact protocol constants; never interpolate arbitrary reasons.
      if (event.code === 1008 && typeof event.reason === 'string' && Object.hasOwn(APPROVAL_ERRORS, event.reason)) message = APPROVAL_ERRORS[event.reason];
      else if (!this.authenticated) message += ` ${UPGRADE_ADVICE}`;
      const code = Number.isInteger(event.code) && event.code >= 1000 && event.code <= 4999
        ? String(event.code) : 'unknown';
      this.close(`${message} (WebSocket ${code}; ${this.phaseLabel()}.)`, event.code !== 1000, event.code);
    };
  }

  reportState(state, message) {
    this.phase = state;
    this.onState(state, message);
  }

  phaseLabel() {
    return ({ connecting: 'before approval', requestingApproval: 'requesting Android approval', approvalPending: 'awaiting Android approval',
      configuring: 'checking video codec', waiting: 'waiting for video',
      live: 'streaming video', recovering: 'recovering video' })[this.phase] || 'session active';
  }

  armTimeout(delay, message) {
    this.clearTimer(this.timeout);
    this.timeout = this.setTimer(() => this.close(message, true), delay);
  }

  receiveText(text) {
    if (this.closed) return;
    // Do not display/log arbitrary bridge messages or payloads.
    if (text.length > 16384) { this.close('The bridge sent an oversized control message.', true); return; }
    let message;
    try { message = JSON.parse(text); } catch { this.close('The bridge sent an invalid control message.', true); return; }
    if (!message || typeof message !== 'object') { this.close('The bridge sent an invalid control message.', true); return; }
    if (message.type === 'error') {
      const messageText = message.version !== PROTOCOL_VERSION ? UPGRADE_ADVICE
        : (typeof message.code === 'string' && Object.hasOwn(APPROVAL_ERRORS, message.code) ? APPROVAL_ERRORS[message.code]
          : (!this.authenticated ? UPGRADE_ADVICE : 'The bridge could not continue this session. Check its status in DiPlay.'));
      this.close(messageText, true);
      return;
    }
    if (!this.authenticated) {
      if (message.version !== PROTOCOL_VERSION) { this.close(UPGRADE_ADVICE, true); return; }
      if (message.type === 'approvalPending' && this.phase === 'requestingApproval' && !this.approvalPending) {
        this.approvalPending = true;
        this.diagnostics.mark('approvalPending');
        // Do not restart the deadline: repeated messages cannot extend approval.
        this.reportState('approvalPending', 'Waiting for approval. Tap Accept in DiPlay on Android within 30 seconds.');
      } else if (message.type === 'authenticated' && this.approvalPending) {
        this.authenticated = true;
        this.approvalPending = false;
        this.clearTimer(this.timeout);
        this.timeout = null;
        this.diagnostics.mark('approved');
        this.reportState('waiting', 'Approved on Android. Waiting for CarPlay video…');
      } else {
        this.close(`The bridge did not complete the Android approval handshake. ${UPGRADE_ADVICE}`, true);
      }
      return;
    }
    if (message.type === 'config') {
      void this.configure(message);
    } else if (message.type === 'touchOwnership') {
      if (typeof message.enabled !== 'boolean' || !Number.isSafeInteger(message.streamId) || message.streamId <= 0 ||
          !Number.isSafeInteger(message.requestId) || message.requestId <= 0) {
        this.close('The bridge sent an invalid touch ownership acknowledgment.', true);
        return;
      }
      // A delayed acknowledgment must never authorize a replacement stream.
      if (message.streamId !== this.streamId || message.requestId !== this.currentTouchRequestId) return;
      if (message.enabled && !this.touchRequested) return;
      this.touchOwned = message.enabled;
      this.touchPending = false;
      if (!message.enabled) this.touchRequested = false;
      this.reportTouchOwnership();
    } else if (['audioState', 'audioStopped', 'audioError'].includes(message.type)) {
      this.onAudioMessage(message);
    } else if (message.type === 'status' && ['waiting', 'disconnected'].includes(message.code)) {
      this.clearDecoder();
      this.reportState('waiting', 'Approved on Android. Waiting for CarPlay video…');
    } else {
      this.close('The bridge sent an unexpected control message.', true);
    }
  }

  async configure(message) {
    this.clearDecoder({ preserveTouchIntent: true });
    if (this.closed) return;
    const version = this.configVersion;
    this.reportState('configuring', 'Checking support for the bridge’s video codec…');
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
      this.reportState('waiting', 'Ready for video. Waiting for a complete keyframe…');
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
    this.backpressured = false;
    this.decoder = new this.VideoDecoder({
      output: frame => {
        if (this.closed || version !== this.decoderVersion) { frame.close(); return; }
        // Output queued before a lost dependency cannot revive touch or stale video.
        if (this.backpressured) { frame.close(); return; }
        this.consecutiveRecoveries = 0;
        this.clearTimer(this.videoTimeout);
        this.videoTimeout = null;
        if (!this.streaming) {
          this.streaming = true;
          this.diagnostics.mark('firstVideo');
          this.reportState('live', 'Live display. Touch control is optional.');
          if (this.touchRequested && !this.touchOwned && !this.touchPending) this.setTouchOwnership(true);
        }
        if (this.closed || version !== this.decoderVersion) { frame.close(); return; }
        try { this.onFrame(frame); } catch { frame.close(); this.close('The browser could not draw the video frame.', true); }
      },
      error: () => {
        if (!this.closed && version === this.decoderVersion) this.recover();
      },
    });
    this.decoder.configure(this.config);
  }

  receiveVideo(data) {
    if (this.closed) return;
    if (!this.authenticated) { this.close(`The bridge sent video before Android approval. ${UPGRADE_ADVICE}`, true); return; }
    if (data instanceof ArrayBuffer && data.byteLength > 0 && new Uint8Array(data, 0, 1)[0] === 3) {
      this.onAudioPacket(data);
      return;
    }
    let chunk;
    try { chunk = parseVideoPacket(data); } catch { this.close('The bridge sent an invalid video packet.', true); return; }
    // No encoded-frame array or pending async work per frame. Frames arriving during
    // codec negotiation are discarded; the fresh keyframe request repairs the gap.
    if (!this.decoder || this.decoder.state !== 'configured') return;
    if (this.decoder.decodeQueueSize >= MAX_DECODE_QUEUE) {
      // A 60fps burst may fill the small decode queue before any output callback.
      // Do not repeatedly destroy that in-flight work: drop dependent packets,
      // drain the old decoder, and replace it only at a complete keyframe.
      if (!this.backpressured) {
        this.backpressured = true;
        this.needsKeyframe = true;
        this.streaming = false;
        this.suspendTouch(true);
        if (this.closed) return;
        this.armVideoRecoveryDeadline();
        this.reportState('recovering', 'Video decoder backlog. Waiting for a fresh keyframe…');
      }
      this.requestKeyframe();
      return;
    }
    if (this.backpressured) {
      if (chunk.type !== 'key') { this.requestKeyframe(); return; }
      try { this.makeDecoder(); }
      catch { this.close('The browser could not restart its video decoder.', true); return; }
    }
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
    this.suspendTouch(true);
    if (this.closed) return;
    this.armVideoRecoveryDeadline();
    try {
      this.makeDecoder();
      this.reportState('recovering', 'Resynchronizing video. Waiting for a fresh keyframe…');
      this.requestKeyframe();
    } catch {
      this.close('The browser could not restart its video decoder.', true);
    }
  }

  armVideoRecoveryDeadline() {
    // Do not extend this deadline on another overflow, keyframe or decoder reset.
    // Only usable output clears it, so a genuinely stalled decoder stays bounded.
    if (this.videoTimeout !== null) return;
    this.videoTimeout = this.setTimer(() => this.close(
      'The video decoder produced no recovered output for 10 seconds. Try a lower frame rate or resolution, then reconnect.', true), 10000);
  }

  requestKeyframe() {
    if (!this.authenticated || this.now() - this.lastKeyframeRequest < 1000) return;
    if (this.send({ type: 'requestKeyframe' })) this.lastKeyframeRequest = this.now();
  }

  reportTouchOwnership() {
    this.onTouchOwnership({ enabled: this.touchOwned, requested: this.touchRequested, pending: this.touchPending });
  }

  setTouchOwnership(enabled) {
    if (typeof enabled !== 'boolean' || !this.authenticated || this.closed) return false;
    // The user's opt-out must work while an asynchronous config probe has no ID.
    if (!enabled && this.streamId === null) {
      this.touchRequested = this.touchOwned = this.touchPending = false;
      this.currentTouchRequestId = null;
      this.reportTouchOwnership();
      return true;
    }
    if (this.streamId === null || (enabled && !this.streaming)) return false;
    // Disable locally before writing to the socket, including if that write fails.
    if (!Number.isSafeInteger(this.touchRequestId + 1)) { this.close('Touch request limit reached. Reopen this page to reconnect.', true); return false; }
    this.currentTouchRequestId = ++this.touchRequestId;
    this.touchRequested = enabled;
    this.touchOwned = false;
    this.touchPending = true;
    this.reportTouchOwnership();
    const sent = this.send({ type: 'setTouchOwnership', enabled, streamId: this.streamId, requestId: this.currentTouchRequestId });
    if (!sent) {
      this.touchRequested = this.touchOwned = this.touchPending = false;
      this.currentTouchRequestId = null;
      this.reportTouchOwnership();
    }
    return sent;
  }

  sendContacts(contacts) {
    // A contact snapshot belongs to exactly one media generation. The server
    // releases contacts during reconfiguration; a release without a current ID
    // must not be relabeled and applied to a replacement stream.
    if (!this.authenticated || !this.touchOwned || !this.touchRequested || this.streamId === null || (contacts.length > 0 && !this.streaming)) return false;
    return this.send({ type: 'touch', streamId: this.streamId, contacts });
  }

  send(message) {
    if (this.closed || !this.authenticated || !this.socket || this.socket.readyState !== 1) return false;
    // Never build a queue of stale control/touch messages on a slow local link.
    if (this.socket.bufferedAmount > 16384) {
      this.close('The local link is too slow. Disconnected to release touch controls.', true);
      return false;
    }
    try { this.socket.send(JSON.stringify(message)); return true; }
    catch { this.close('The local bridge connection was lost.', true); return false; }
  }

  setAudioEnabled(enabled, requestId) {
    return typeof enabled === 'boolean' && Number.isSafeInteger(requestId) && requestId > 0 &&
      this.send({ type: 'audioMode', enabled, requestId });
  }

  suspendTouch(preserveIntent) {
    const requested = preserveIntent && this.touchRequested;
    const needsRelease = this.touchRequested || this.touchOwned || this.touchPending;
    const streamId = this.streamId;
    this.touchRequested = requested;
    this.touchOwned = this.touchPending = false;
    this.currentTouchRequestId = null;
    this.reportTouchOwnership();
    if (!this.closed && needsRelease && streamId !== null) {
      if (!Number.isSafeInteger(this.touchRequestId + 1)) {
        this.close('Touch request limit reached. Reopen this page to reconnect.', true);
        return;
      }
      // Do not make this release ACK current: it must neither clear saved intent
      // nor authorize input. The next enable gets a strictly newer request ID.
      this.send({ type: 'setTouchOwnership', enabled: false, streamId, requestId: ++this.touchRequestId });
    }
  }

  clearDecoder({ preserveTouchIntent = false } = {}) {
    this.suspendTouch(preserveTouchIntent);
    if (!preserveTouchIntent) {
      this.clearTimer(this.videoTimeout);
      this.videoTimeout = null;
    }
    this.configVersion += 1;
    this.decoderVersion += 1;
    this.streaming = false;
    this.needsKeyframe = true;
    this.backpressured = false;
    this.config = null;
    this.streamId = null;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
  }

  close(message = 'Disconnected. Click Connect to request approval again.', error = false, closeCode = null) {
    if (this.closed) return;
    // Closing the WebSocket also releases all contacts server-side, including if a
    // final empty contact message cannot get through a failing connection.
    this.closed = true;
    this.diagnostics.mark('closed', closeCode);
    this.authenticated = false;
    this.approvalPending = false;
    this.clearTimer(this.timeout);
    this.timeout = null;
    this.clearDecoder();
    this.onAudioReset();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      if (socket.readyState < 2) socket.close(1000, 'Viewer disconnected');
    }
    this.onState(error ? 'error' : 'closed', message);
  }
}
