import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAudioPlayer } from '../audio.mjs';
import { validAudioSdp, validAudioCandidate, preferOpusStereo, localIceAddress } from '../audio-protocol.mjs';
import { audioEnvironment, audioSdp, candidate, deferred, flush } from './audio-fixtures.mjs';

const count = (env, type) => env.signals.filter(signal => signal.type === type).length;

test('gesture creates one recvonly peer with no ICE servers; no audio capture or PCM pipeline', async () => {
  const env = audioEnvironment(); const { player, peers, audios } = env;
  assert.equal(peers.length, 0); assert.equal(player.handlePacket(new ArrayBuffer(36)), false);
  assert.equal(await player.enableFromGesture(), true); await player.enableFromGesture();
  assert.equal(peers.length, 1); assert.deepEqual(peers[0].config.iceServers, []);
  assert.equal(peers[0].transceiver.kind, 'audio'); assert.equal(peers[0].transceiver.direction, 'recvonly');
  assert.deepEqual(peers[0].codecs, [{ mimeType: 'audio/opus' }]);
  assert.equal(audios[0].plays, 1); assert.equal(audios[0].muted, false);
  assert.deepEqual(env.modes, [{ enabled: true, requestId: 1 }]);
  assert.equal(player.pending, true); assert.equal(player.ready, false); assert.equal(player.enabled, false);
  player.dispose(); assert.equal(peers[0].closed, true); assert.equal(audios[0].srcObject, null);
  assert.equal(env.timers.size, 0);
});

test('secure context and WebRTC availability gate creation without sending a route request', async () => {
  for (const missing of [{ secure: false }, { PeerConnection: null }, { MediaStream: null }]) {
    const env = audioEnvironment(); const player = new BrowserAudioPlayer({ ...env.dependencies, ...missing });
    assert.equal(await player.enableFromGesture(), false); assert.equal(env.peers.length, 0); assert.equal(env.modes.length, 0);
    assert.match(env.states.at(-1).message, /secure WebRTC/);
  }
});

test('ready requires answered SDP, live audio track, connected ICE, RTP progression and resolved playback', async () => {
  const playback = deferred(), env = audioEnvironment({ playback });
  await env.player.enableFromGesture(); await env.offer();
  assert.equal(count(env, 'audioAnswer'), 1); assert.equal(count(env, 'audioReady'), 0);
  const peer = env.peers[0]; peer.emitTrack(); peer.packets = 8; await env.tick();
  peer.packets = 9; await env.tick(); assert.equal(count(env, 'audioReady'), 0);
  peer.connect(); assert.equal(count(env, 'audioReady'), 0);
  playback.resolve(); await flush();
  assert.equal(count(env, 'audioReady'), 1); assert.equal(env.player.enabled, false); assert.equal(env.player.pending, true);
  assert.equal(env.signals.at(-1).epoch, 1); assert.equal(env.signals.at(-1).requestId, 1);
  env.message('audioState', { enabled: true });
  assert.equal(env.player.enabled, true); assert.equal(env.player.pending, false);
  assert.match(env.states.at(-1).message, /Android output is muted/);
  peer.connect(); await env.tick(); assert.equal(count(env, 'audioReady'), 1);
  env.player.dispose();
});

test('constant, missing or invalid packet counters cannot establish readiness', async () => {
  const env = audioEnvironment(); await env.player.enableFromGesture(); await env.offer();
  env.peers[0].connect(); env.peers[0].emitTrack();
  for (const packets of [undefined, NaN, -1, 0, 0, 0]) { env.peers[0].packets = packets; await env.tick(); }
  assert.equal(count(env, 'audioReady'), 0); assert.equal(env.player.enabled, false); env.player.dispose();
});

test('premature and legacy route acknowledgments fail closed with no PCM fallback', async () => {
  for (const legacy of [{}, { transport: undefined }, { requestId: undefined }]) {
    const env = audioEnvironment(); await env.player.enableFromGesture();
    env.message('audioState', { enabled: true, ...legacy });
    assert.equal(env.player.pending, false); assert.equal(env.player.enabled, false);
    assert.equal(env.modes.at(-1).enabled, false); assert.match(env.states.at(-1).message, /Update both/);
  }
  const env = audioEnvironment(); await env.player.enableFromGesture(); await env.offer();
  env.message('audioState', { enabled: true }); assert.match(env.states.at(-1).message, /Premature/);
  const pcm = audioEnvironment(); await pcm.player.enableFromGesture(); pcm.player.handlePacket(new ArrayBuffer(36));
  assert.equal(pcm.player.peer, null); assert.equal(pcm.modes.at(-1).enabled, false);
});

test('signaling admits exactly one audio-only DTLS Opus section and bounded host candidates', () => {
  assert.equal(validAudioSdp(audioSdp('sendonly'), 'sendonly'), true);
  for (const bad of [audioSdp('sendrecv'), audioSdp('sendonly') + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n',
    audioSdp('sendonly').replace('opus/48000/2', 'PCMU/8000'), audioSdp('sendonly').replace('UDP/TLS/RTP/SAVPF', 'RTP/AVP'),
    audioSdp('sendonly').replace('a=fingerprint:sha-256', 'a=ignored:sha-256'), audioSdp('sendonly') + 'x'.repeat(6001),
    audioSdp('sendonly') + 'a=candidate:1 1 udp 1 8.8.8.8 4000 typ relay\r\n']) assert.equal(validAudioSdp(bad, 'sendonly'), false);
  assert.equal(validAudioCandidate(candidate), true); assert.equal(validAudioCandidate({ ...candidate, candidate: '' }), false);
  for (const bad of [{ ...candidate, candidate: candidate.candidate.replace('typ host', 'typ relay') },
    { ...candidate, candidate: 'x'.repeat(1025) }, { ...candidate, sdpMLineIndex: 1 }, { ...candidate, sdpMid: null },
    { ...candidate, candidate: candidate.candidate + '\r\na=sendrecv' }]) assert.equal(validAudioCandidate(bad), false);
});

test('remote candidates may precede the offer but are added only after matching remote SDP', async () => {
  const remote = deferred(), env = audioEnvironment({ remote }); await env.player.enableFromGesture();
  env.message('audioIce', { ...candidate, epoch: 2 }); env.message('audioIce', candidate);
  assert.equal(env.peers[0].candidates.length, 0); await env.offer();
  assert.equal(env.peers[0].candidates.length, 0); remote.resolve(); await flush();
  assert.deepEqual(env.peers[0].candidates, [candidate]);
  env.peers[0].onicecandidate({ candidate }); assert.equal(count(env, 'audioIce'), 1);
  env.player.dispose();
});

test('candidate floods and malformed offers restore native without unbounded queues', async () => {
  for (const outgoing of [false, true]) {
    const env = audioEnvironment(); await env.player.enableFromGesture(); if (outgoing) await env.offer();
    const callback = env.peers[0].onicecandidate;
    for (let i = 0; i < 10000; i++) outgoing ? callback({ candidate }) : env.message('audioIce', candidate);
    assert.equal(env.player.pending, false); assert.equal(env.player.remoteCandidates.length, 0);
    assert.ok(count(env, 'audioIce') <= 32); assert.equal(env.modes.at(-1).enabled, false);
  }
  const env = audioEnvironment(); await env.player.enableFromGesture(); await env.offer({ sdp: 'bad' });
  assert.equal(env.player.peer, null);
});

test('rejected or send-capable local SDP cannot be answered', async () => {
  const env = audioEnvironment({ answerSdp: audioSdp('sendrecv') });
  await env.player.enableFromGesture(); await env.offer(); assert.equal(count(env, 'audioAnswer'), 0); assert.equal(env.player.peer, null);
});

test('delayed offer/answer/local-description callbacks cannot revive cancelled or replacement routes', async () => {
  for (const step of ['remote', 'answer', 'local']) {
    const delay = deferred(), env = audioEnvironment({ [step]: delay });
    await env.player.enableFromGesture(); await env.offer(); const old = env.peers[0];
    env.player.disable(); await env.player.enableFromGesture(); const current = env.player.activeRequestId;
    delay.resolve(); await flush();
    assert.equal(old.closed, true); assert.equal(count(env, 'audioAnswer'), 0);
    assert.equal(env.player.activeRequestId, current); assert.equal(env.player.pending, true); assert.equal(env.player.ready, false);
    env.player.dispose();
  }
});

test('stale playback promise, ICE callbacks, track events, failures and ACKs cannot affect a new gesture', async () => {
  const playback = deferred(), options = { playback }, env = audioEnvironment(options); await env.player.enableFromGesture(); await env.offer();
  const oldId = env.player.activeRequestId, oldIce = env.peers[0].onicecandidate, oldTrack = env.peers[0].ontrack;
  env.player.disable(); const oldDisable = env.player.activeRequestId; delete options.playback; await env.player.enableFromGesture();
  const currentId = env.player.activeRequestId; oldIce({ candidate });
  const track = { stop() { this.stopped = true; } }; oldTrack({ track }); assert.equal(track.stopped, true);
  env.message('audioState', { enabled: true, requestId: oldId });
  env.message('audioState', { enabled: false, requestId: oldDisable });
  env.message('audioError', { requestId: oldId }); playback.reject(new Error('old')); await flush();
  assert.equal(env.player.enabled, false); assert.equal(env.player.pending, true); assert.equal(count(env, 'audioIce'), 0);
  assert.equal(env.player.activeRequestId, currentId); env.player.dispose();
});

test('reset permits a restarted Android epoch but never auto-enables audio', async () => {
  const env = audioEnvironment(); await env.enable(); env.player.reset();
  assert.equal(env.player.peer, null); assert.equal(env.player.activeRequestId, 0); assert.equal(env.player.enabled, false);
  const modes = env.modes.length; await env.tick(); assert.equal(env.modes.length, modes);
  await env.enable(); assert.equal(env.player.epoch, 1); assert.equal(env.player.enabled, true); env.player.dispose();
});

test('negotiation and acknowledgment deadlines do not extend on duplicate control messages', async () => {
  const env = audioEnvironment(); await env.player.enableFromGesture();
  await env.tick(15000); assert.equal(env.player.pending, false); assert.match(env.states.at(-1).message, /timed out/);
  const ack = audioEnvironment(); await ack.receiving(); const timer = [...ack.timers].find(([, value]) => value.delay === 5000)?.[0];
  await ack.offer(); assert.ok(ack.timers.has(timer)); await ack.tick(5000);
  assert.equal(ack.player.enabled, false); assert.equal(ack.modes.at(-1).enabled, false);
});

test('audioAlive requires ongoing progress; a three-second RTP stall restores native', async () => {
  const env = audioEnvironment(); await env.enable();
  for (let i = 0; i < 4; i++) { env.peers[0].packets++; await env.tick(); }
  assert.equal(count(env, 'audioAlive'), 1);
  for (let i = 0; i < 12; i++) await env.tick();
  assert.equal(count(env, 'audioAlive'), 1); assert.equal(env.player.enabled, false);
  assert.match(env.states.at(-1).message, /stalled/); assert.equal(env.timers.size, 0);
});

test('ICE disconnection, track end, pause, media error, muted output and source counter replacement fail safe', async () => {
  for (const fail of [env => { env.peers[0].iceConnectionState = 'disconnected'; env.peers[0].oniceconnectionstatechange(); },
    env => env.player.track.onended(), env => env.audios[0].onpause(), env => env.audios[0].onerror(),
    async env => { env.audios[0].muted = true; await env.tick(); },
    async env => { env.peers[0].packets = 1; await env.tick(); }]) {
    const env = audioEnvironment(); await env.enable(); await fail(env);
    assert.equal(env.player.enabled, false); assert.equal(env.peers[0].closed, true); assert.equal(env.modes.at(-1).enabled, false);
  }
});

test('matching native disabled state closes the route; old epoch cannot stop current audio', async () => {
  const env = audioEnvironment(); await env.enable();
  env.message('audioState', { enabled: false, epoch: 2 }); assert.equal(env.player.enabled, true);
  env.message('audioState', { enabled: false }); assert.equal(env.player.enabled, false); assert.equal(env.player.peer, null);
});

test('blocked playback, failed send and receiver stats error restore native', async () => {
  const playback = deferred(), env = audioEnvironment({ playback }); await env.player.enableFromGesture(); playback.reject(new Error('blocked')); await flush();
  assert.equal(env.player.pending, false); assert.match(env.states.at(-1).message, /Playback was blocked/);
  const blocked = audioEnvironment({ modeSuccess: false }); assert.equal(await blocked.player.enableFromGesture(), false);
  const signal = audioEnvironment({ signalSuccess: false }); await signal.player.enableFromGesture(); await signal.offer(); assert.equal(signal.player.pending, false);
  const stats = audioEnvironment(); await stats.player.enableFromGesture(); stats.peers[0].getStats = async () => { throw new Error('stats'); };
  await stats.tick(); assert.equal(stats.player.pending, false);
});

test('explicit finite test requests test source and never claims native muting', async () => {
  const env = audioEnvironment(); await env.player.enableFromGesture({ test: true }); await env.receiving();
  assert.equal(env.modes[0].source, 'test'); env.message('audioState', { enabled: true });
  assert.match(env.states.at(-1).message, /Android audio stays on/);
  env.message('audioState', { enabled: false, code: 'test-complete' });
  assert.equal(env.player.peer, null); assert.equal(env.states.at(-1).error, false); assert.match(env.states.at(-1).message, /test finished/);
});

test('default audio timers retain the browser global receiver', async t => {
  const handles = new Set();
  t.mock.method(globalThis, 'setTimeout', function () { assert.equal(this, globalThis); const id = {}; handles.add(id); return id; });
  t.mock.method(globalThis, 'clearTimeout', function (id) { assert.equal(this, globalThis); handles.delete(id); });
  const { setTimer, clearTimer, ...dependencies } = audioEnvironment().dependencies;
  const player = new BrowserAudioPlayer(dependencies); await player.enableFromGesture(); assert.equal(handles.size, 2);
  player.dispose(); assert.equal(handles.size, 0);
});


test('Opus stereo preference preserves existing fmtp, replaces only stereo and is idempotent', () => {
  const plain = audioSdp('recvonly');
  assert.match(preferOpusStereo(plain), /a=fmtp:111 stereo=1\r\n/);
  const existing = plain.replace('a=rtpmap:111 opus/48000/2', 'a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0');
  const result = preferOpusStereo(existing);
  assert.match(result, /a=fmtp:111 minptime=10;useinbandfec=1;sprop-stereo=0;stereo=1/);
  assert.equal(preferOpusStereo(result), result); assert.equal(validAudioSdp(result, 'recvonly'), true);
});


test('ICE addresses allow only local literals or bounded mDNS labels, never public hosts', () => {
  for (const address of ['10.1.2.3', '172.16.0.1', '192.168.1.2', '127.0.0.1', '169.254.1.1', '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fdff::1', '::ffff:192.168.1.2', 'abc-123.local'])
    assert.equal(localIceAddress(address), true, address);
  for (const address of ['8.8.8.8', '172.32.0.1', '0.0.0.0', '192.168.01.2', 'example.com', '-a.local', 'a..local', '::', '2001:4860:4860::8888', 'fec0::1', 'fe80::1%eth0', '::ffff:8.8.8.8'])
    assert.equal(localIceAddress(address), false, address);
});

test('unrelated public and empty local ICE candidates are skipped without failing the route', async () => {
  const env = audioEnvironment(); await env.player.enableFromGesture(); await env.offer();
  env.peers[0].onicecandidate({ candidate: { ...candidate, candidate: candidate.candidate.replace('192.168.1.20', '8.8.8.8') } });
  env.peers[0].onicecandidate({ candidate: { ...candidate, candidate: '' } });
  assert.equal(env.player.pending, true); assert.equal(count(env, 'audioIce'), 0);
  env.peers[0].onicecandidate({ candidate }); assert.equal(count(env, 'audioIce'), 1); env.player.dispose();
});

test('disable identifies its exact route; only a new user gesture advances request ID', async () => {
  const env = audioEnvironment(); await env.player.enableFromGesture(); const first = env.player.activeRequestId;
  env.player.disable(); assert.deepEqual(env.modes.at(-1), { enabled: false, requestId: first });
  await env.player.enableFromGesture(); assert.equal(env.player.activeRequestId, first + 1); env.player.dispose();
});

test('stale pending stats cannot revive or alter a replacement peer', async () => {
  const stats = deferred(), options = { stats }, env = audioEnvironment(options);
  await env.player.enableFromGesture(); const oldPoll = env.player.readStats(env.player.generation);
  env.player.disable(); delete options.stats; await env.player.enableFromGesture();
  const current = env.player.activeRequestId;
  stats.resolve(new Map([['in', { type: 'inbound-rtp', kind: 'audio', packetsReceived: 99 }]]));
  await oldPoll; assert.equal(env.player.activeRequestId, current); assert.equal(env.player.lastPackets, null);
  assert.equal(env.player.pending, true); assert.equal(count(env, 'audioReady'), 0); env.player.dispose();
});


test('read-only diagnostics retain only bounded RTP numbers and candidate types, never addresses or SDP', async () => {
  const env = audioEnvironment(); await env.player.enableFromGesture();
  env.peers[0].getStats = async () => new Map([
    ['in', { type: 'inbound-rtp', kind: 'audio', packetsReceived: 55, jitter: 0.013, concealedSamples: 480, address: 'private.invalid' }],
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: '192.168.1.1' }],
    ['remote', { type: 'remote-candidate', candidateType: 'host', protocol: 'udp', address: '192.168.1.2' }],
  ]);
  await env.tick(); const diagnostics = env.player.getDiagnostics();
  assert.deepEqual(diagnostics, { transport: 'webrtc-opus', state: 'starting', packetsReceived: 55, jitterMs: 13, concealedSamples: 480,
    selectedCandidatePair: { localType: 'host', remoteType: 'host', protocol: 'udp' } });
  diagnostics.selectedCandidatePair.protocol = 'secret'; assert.equal(env.player.getDiagnostics().selectedCandidatePair.protocol, 'udp');
  assert.doesNotMatch(JSON.stringify(diagnostics), /192\.168|private\.invalid|sdp/); env.player.dispose();
});


test('readiness needs a verifiable selected local host ICE pair, not only packet counters', async () => {
  const env = audioEnvironment(); await env.player.enableFromGesture(); await env.offer();
  const peer = env.peers[0]; peer.emitTrack(); peer.connect(); let packets = 1;
  peer.getStats = async () => new Map([['in', { type: 'inbound-rtp', kind: 'audio', packetsReceived: packets++ }]]);
  await env.tick(); await env.tick();
  assert.equal(env.player.pending, true); assert.equal(count(env, 'audioReady'), 0); env.player.dispose();
});

test('public, relay, peer-reflexive, unverified or missing selected ICE addresses cannot activate or retain audio', async () => {
  const changes = [stats => { stats.get('remote').address = '8.8.8.8'; }, stats => { stats.get('local').candidateType = 'relay'; },
    stats => { stats.get('remote').candidateType = 'prflx'; }, stats => { delete stats.get('local').address; },
    stats => { stats.get('remote').address = 'example.com'; }, stats => { stats.get('remote').protocol = 'other'; },
    stats => { stats.delete('remote'); }];
  for (const active of [false, true]) for (const change of changes) {
    const env = audioEnvironment(); if (active) await env.enable(); else { await env.player.enableFromGesture(); await env.offer(); }
    const peer = env.peers[0], original = peer.getStats.bind(peer); peer.packets = 20;
    peer.getStats = async () => { const stats = await original(); change(stats); return stats; };
    await env.tick(); assert.equal(env.player.enabled, false); assert.equal(env.player.pending, false);
    assert.match(env.states.at(-1).message, /local-only/); assert.equal(env.modes.at(-1).enabled, false);
  }
});

test('selected mDNS and local IPv6 candidates can establish verified receive-only audio', async () => {
  const env = audioEnvironment(); await env.player.enableFromGesture(); await env.offer();
  const peer = env.peers[0], original = peer.getStats.bind(peer);
  peer.getStats = async () => { const stats = await original(); if (stats.has('local')) {
    stats.get('local').address = 'receiver-test.local'; stats.get('remote').address = 'fd00::1234'; } return stats; };
  peer.emitTrack(); peer.connect(); peer.packets = 1; await env.tick(); peer.packets = 2; await env.tick();
  assert.equal(count(env, 'audioReady'), 1); env.player.dispose();
});
