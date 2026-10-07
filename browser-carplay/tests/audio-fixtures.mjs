import { BrowserAudioPlayer } from '../audio.mjs';

export const audioSdp = direction => [
  'v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=mid:0', `a=${direction}`,
  'a=rtcp-mux', 'a=ice-ufrag:test', 'a=ice-pwd:testpasswordtestpassword', 'a=setup:actpass',
  `a=fingerprint:sha-256 ${Array(32).fill('AB').join(':')}`, 'a=rtpmap:111 opus/48000/2', '',
].join('\r\n');
export const candidate = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.20 4444 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0 };
export const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

export function audioEnvironment(options = {}) {
  const peers = [], audios = [], states = [], modes = [], signals = [], timers = new Map();
  let nextTimer = 0, time = 0;
  class MediaStream {
    constructor() { this.tracks = []; }
    addTrack(track) { this.tracks.push(track); }
    getTracks() { return this.tracks; }
  }
  class PeerConnection {
    constructor(config) {
      this.config = config; this.iceConnectionState = 'new'; this.connectionState = 'new'; this.candidates = [];
      this.packets = undefined; this.closed = false; peers.push(this);
    }
    addTransceiver(kind, config) { this.transceiver = { kind, ...config, setCodecPreferences: codecs => { this.codecs = codecs; } }; return this.transceiver; }
    async setRemoteDescription(description) { this.remoteDescription = description; await options.remote?.promise; }
    async createAnswer() { await options.answer?.promise; return { type: 'answer', sdp: options.answerSdp ?? audioSdp('recvonly') }; }
    async setLocalDescription(description) { this.localDescription = description; await options.local?.promise; }
    async addIceCandidate(value) { this.candidates.push(value); await options.candidate?.promise; }
    async getStats() {
      if (options.stats) return options.stats.promise;
      return new Map(this.packets === undefined ? [] : [
        ['in', { type: 'inbound-rtp', kind: 'audio', packetsReceived: this.packets }],
        ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
        ['pair', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' }],
        ['local', { type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: '192.168.1.10' }],
        ['remote', { type: 'remote-candidate', candidateType: 'host', protocol: 'udp', address: '192.168.1.20' }],
      ]);
    }
    close() { this.closed = true; this.iceConnectionState = this.connectionState = 'closed'; }
    connect() { this.iceConnectionState = this.connectionState = 'connected'; this.oniceconnectionstatechange?.(); }
    emitTrack(kind = 'audio') {
      const track = { kind, readyState: 'live', stops: 0, stop() { this.stops++; this.readyState = 'ended'; } };
      this.ontrack?.({ track }); return track;
    }
  }
  function createAudio() {
    const audio = { paused: true, plays: 0, pauses: 0, play() {
      this.plays++;
      return (options.playback?.promise ?? Promise.resolve()).then(() => { this.paused = false; });
    }, pause() { this.pauses++; this.paused = true; } };
    audios.push(audio); return audio;
  }
  const dependencies = { PeerConnection, MediaStream, createAudio, secure: true,
    Receiver: { getCapabilities: () => ({ codecs: [{ mimeType: 'audio/opus' }, { mimeType: 'audio/PCMU' }] }) },
    sendMode: (enabled, requestId, source) => { modes.push({ enabled, requestId, ...(source ? { source } : {}) }); return options.modeSuccess !== false; },
    sendSignal: message => { signals.push(message); return options.signalSuccess !== false; },
    onState: state => states.push(state), now: () => time,
    setTimer: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; }, clearTimer: id => timers.delete(id) };
  const player = new BrowserAudioPlayer(dependencies);
  const message = (type, fields = {}) => player.handleMessage({ type, transport: 'webrtc-opus', requestId: player.activeRequestId, epoch: player.epoch || 1, ...fields });
  const tick = async (delay = 250) => {
    time += delay;
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    if (entry) { timers.delete(entry[0]); entry[1].callback(); await flush(); }
  };
  const offer = async (fields = {}) => { message('audioOffer', { sdp: audioSdp('sendonly'), ...fields }); await flush(); };
  const receiving = async () => {
    await player.enableFromGesture(); await offer();
    peers.at(-1).emitTrack(); peers.at(-1).connect();
    peers.at(-1).packets = 10; await tick(); peers.at(-1).packets = 11; await tick();
  };
  const enable = async () => { await receiving(); message('audioState', { enabled: true }); };
  return { player, peers, audios, states, modes, signals, timers, dependencies, message, tick, offer, receiving, enable,
    advance: amount => { time += amount; } };
}
