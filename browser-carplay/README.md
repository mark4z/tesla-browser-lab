# Experimental browser CarPlay viewer

Static HTML/CSS/ES modules; no dependencies, telemetry, storage, or automatic
connection. This is a video, touch, and optional audio companion to the Android bridge, not a
standalone CarPlay receiver. Browser microphone uplink is not included.

## Deployment and connection

The Android bridge pins the exact HTTPS origin **https://mark4z.github.io**.
The published viewer is https://mark4z.github.io/tesla-browser-lab/browser-carplay/.
Other origins are rejected; deployment elsewhere requires a separately reviewed
source change, not an input field or security fallback.
This source change does not publish the page. Do not add `upgrade-insecure-requests`
to the hosting policy: the deliberately local `ws://` link uses Chrome's Local
Network Access exemption, not a public TLS endpoint. Hosting may set an explicit
`frame-ancestors 'none'` CSP response header in addition to the page's top-level
guard (that directive cannot be enforced through a meta element).

Use Chrome 147+ with WebCodecs and Local Network Access support. Chrome's
[WebSocket launch notes](https://groups.google.com/a/chromium.org/g/blink-dev/c/O6GMKt44Ups)
describe the permission-gated exemption for explicit local IP addresses. Browser
policy, rollouts, decoder availability, and embedded/in-car browser limitations
can still prevent a connection. The viewer does not disable security checks or
offer an HTTP/codec-library workaround. HEVC support is device-dependent.

1. Park and enable the bridge in DiPlay on the trusted private Wi-Fi interface.
2. Connect both devices to the same trusted private LAN.
3. Enter the displayed private IPv4 address and port (1–65535) in separate fields.
   The destination is always `ws://<RFC1918 IPv4>:<port>/carplay`; no URL, token,
   hostname, alternate path, URL parameters, or scan/discovery is accepted.
4. Confirm parked use and click **Connect display**. Personally decide whether to
   allow the browser's local-network permission. The page does not grant it.
5. Within 30 seconds, tap **Accept** in the Android connection prompt. Each
   connection requires a fresh decision; there is no remembered browser grant.
6. Video starts only after Android accepts. Enable touch separately if wanted;
   it stays inactive until Android acknowledges ownership. Up to two contacts
   match the existing CarPlay HID mapper.

Click **Play audio here** after approval to move sound to the browser. A successful
user-gesture WebRTC audio start is required. **Test audio (3 seconds)** can check a short synthetic downlink after approval, even without a CarPlay source; it never mutes Android. Stopping browser audio, hiding the page,
or disconnecting returns playback to Android.

The LAN WebSocket is **unencrypted**, including video, audio signaling, and touch
controls. Audio media uses WebRTC DTLS-SRTP encryption, but its signaling still
depends on the trusted LAN and Android approval. Use only a trusted network. Do not expose the bridge to the internet. The viewer has no
pairing credentials, persistent approvals, or raw network-data logging. HTTPS
secures page delivery, not the local transport.

Hide/leave the page, lock the screen, uncheck parked use, or click Disconnect to
close the session. Touch is released on pointer cancel/lost capture, focus loss,
video reconfiguration, and resize. On reconnect, click Connect, accept again on
Android, and explicitly enable touch again. The checkbox is a user declaration,
not a vehicle-speed sensor.

## Connection diagnostics and LAN checks

The visible **Connection diagnostics** panel shows page scheme, secure-context
status, and the actual connection target’s `ws://` transport separately. HTTPS
protects this page’s delivery; it does not encrypt video, audio signaling, or
controls on the plaintext LAN WebSocket. Audio media is separately protected by
WebRTC DTLS-SRTP. These labels describe transport, not a browser
permission verdict or a promise that a connection will work.

Every valid, user-initiated Connect starts a fresh in-memory timeline:

1. **Connect requested**: endpoint validation passed and the attempt began.
2. **WebSocket opened**: the browser reported a successful WebSocket handshake.
3. **Android approval pending**: protocol-v2 `approvalPending` was received.
4. **Approved on Android**: the required approval handshake completed.
5. **First video decoded**: a usable video decoder output arrived. This marks
   decoding, not a guarantee that a canvas draw or audio playback succeeded.
6. **Connection ended**: includes the numeric CloseEvent code if one was observed.
   Local cancellation, timeout, or early failure may have no close event code.

Elapsed times are measured from Connect with a monotonic clock. The panel retains
at most these six milestones for the latest attempt, including after disconnect.
Recovery does not append per-frame entries, and a new Connect replaces the previous
attempt. There are no raw server reasons, private IPs, tokens, SDP, media payloads,
console logs, persistence, or diagnostic uploads. A close code identifies an
observation, not a root cause: for example, **1006** means an abnormal closure with
no normal close frame, not proof of a specific permission, origin, or LAN failure.

To check the route independently, while parked manually navigate to the HTTP
health URL shown by the diagnostic APK, for example
`http://192.168.1.20:8765/health`. A successful response identifying
`service=diplay-browser`, `protocol=2`, and `build=connection-diag-v1` shows that
this browser reached that APK’s LAN HTTP endpoint. It does **not** prove that the
HTTPS viewer has Local Network Access permission, that `/carplay` can complete a
WebSocket handshake, or that the Android approval flow succeeded. Confirm the
address matches the APK; do not bypass browser security or certificate warnings.

The viewer never fetches, preflights, embeds, or auto-opens that HTTP endpoint from
this HTTPS page. Such a cross-scheme fetch can be blocked as mixed content and
must not be mistaken for a failed LAN route. Navigating away disconnects an active
session; return to the HTTPS viewer and explicitly Connect again. An unavailable
health endpoint alone can also mean an older APK; inspect the APK’s version and
status rather than inferring a permission failure.

## Wire protocol

One WebSocket client to `/carplay`. Protocol **v2** replaces token authentication
with an explicit Android consent prompt. The first client text message is:

```json
{"type":"requestApproval","version":2}
```

The server must first reply `{"type":"approvalPending","version":2}`, then only
after the user taps Accept on Android send `{"type":"authenticated","version":2}`.
No video, config, keyframe request, touch ownership request, or touch packet is
accepted before the authenticated acknowledgment. The viewer closes if approval
has not completed within 30 seconds of its request. Repeated pending messages
cannot extend this deadline. Disconnect cancels the request; reconnect always
requires another explicit click and Android approval.

Reject, timeout, and protocol mismatch use `{ "type":"error", "version":2,
"code":"approvalRejected" }`, with `approvalTimeout` or `upgradeRequired` as the
other codes. The server can instead close with WebSocket code 1008 and one of
those exact reasons. The viewer maps only those constants to fixed safe text;
arbitrary error strings or close reasons are never displayed or logged. Numeric
close codes and the lifecycle phase remain available for troubleshooting.
Unversioned, legacy, mismatched, or out-of-order handshakes fail closed and advise
installing the latest DiPlay APK and reloading this viewer together.

While no stream is available, an approved connection may receive
`{"type":"status","code":"waiting"}` or code `disconnected`. These clear video
and touch ownership but keep the approved socket waiting for config. Other errors
close the session. There is no automatic reconnect.

When video is available, send e.g.:

```json
{"type":"config","streamId":1,"codec":"avc1.64001f","width":1280,"height":720}
```

`streamId` is a mandatory positive integer no greater than JavaScript's
`Number.MAX_SAFE_INTEGER`. The bridge advances it on media replacement,
reconfiguration, and stream inactivity. The viewer keeps it separate from the
WebCodecs configuration and clears it immediately on configuration replacement,
waiting/inactive status, or disconnect. Stale asynchronous codec probes cannot
restore an earlier identifier.

The codec is derived from the actual stream. AVC (`avc1`/`avc3`) and HEVC
(`hvc1`/`hev1`) are probed using `VideoDecoder.isConfigSupported`. Dimensions are
bounded to 4096 per axis. `description` **must be absent**: this protocol uses
Annex B, not length-prefixed AVC/HEVC configuration records. Each binary WebSocket
message contains one complete encoded access unit:

| Byte offset | Meaning |
| --- | --- |
| 0 | 1 = keyframe; 2 = delta frame |
| 1–8 | unsigned 64-bit, big-endian monotonic receipt timestamp in microseconds |
| 9 onward | Annex B access unit, with start codes |

The Android bridge uses monotonic frame-receipt time because the existing sink does
not expose source presentation timestamps; audio sync and B-frame reordering are not
asserted in this phase. Payload is capped at 4 MiB. A keyframe must contain all relevant parameter sets
(AVC SPS/PPS; HEVC VPS/SPS/PPS) and the random-access picture. See the
[AVC](https://www.w3.org/TR/webcodecs-avc-codec-registration/) and
[HEVC](https://www.w3.org/TR/webcodecs-hevc-codec-registration/) WebCodecs registrations.

Client sends `{"type":"requestKeyframe"}` on configuration, overload, or decode
error (at most once/second). The decoder queue is bounded to four encoded chunks;
overload discards dependent deltas and lets submitted work drain, then replaces
the decoder at a fresh keyframe. There is no application-level encoded-frame
backlog. Decoder errors have bounded retries; recovery with no usable output
for ten seconds closes the session. Transient saturation does not itself spend
the decoder-error retry budget. One pending decoded frame is kept for the next paint;
superseded, stale, rendered, and cancelled frames are closed. Browser/network
WebSocket buffers are outside JavaScript's control; the server must also bound
its output queue.

Touch ownership is a separate, explicit opt-in for the current video stream:

```json
{"type":"setTouchOwnership","enabled":true,"streamId":1,"requestId":1}
```

The checkbox requests ownership; it does **not** immediately enable browser
pointer control. Only the matching acknowledgment enables touch:

```json
{"type":"touchOwnership","enabled":true,"streamId":1,"requestId":1}
```

`requestId` is a positive safe integer, monotonically increasing for the lifetime
of the page session object. The acknowledgment must match both the latest
`requestId` and current `streamId`. Delayed or unsolicited enables cannot restore
control, including rapid uncheck/recheck. An `enabled:false` acknowledgment for
the current request revokes ownership. Unchecking sends a new explicit
`setTouchOwnership` with `enabled:false` and disables pointer control immediately.
Configuration replacement and decoder recovery clear active ownership, pending
requests, and held contacts, but preserve the user’s touch choice on the same
approved connection. Once fresh video is available, a new ownership request must
receive a matching acknowledgment before touch resumes. Identical configs do not
create a new stream generation. Inactive status and real disconnect clear both
ownership and the user’s choice; a fresh opt-in is then required.

Touch snapshots are `{"type":"touch","streamId":1,"contacts":[{"id":0,"x":0.5,"y":0.5}]}`.
The identifier must match the current video configuration, and the viewer must
hold acknowledged touch ownership. The server rejects
stale or missing identifiers, even for empty releases, and releases native
contacts itself during media reconfiguration. This prevents in-flight gestures
from controlling a replacement CarPlay stream over the same WebSocket.
IDs are stable CarPlay slots 0/1 for each pointer's lifetime. Coordinates are
normalized 0–1 against the actual displayed video rectangle, accounting for black
bars and canvas/CSS scaling. Down in a black bar is ignored; captured moves outside
the picture clamp to the edge. Up/cancel immediately sends only surviving contacts,
including `[]` for final release. The bridge must synthesize releases and clear
all native contacts if the connection closes. Slow outbound control links close
instead of accumulating stale moves or dropping a release.

## Optional WebRTC/Opus browser audio

Audio remains on Android by default. A click on **Play audio here** creates one
`RTCPeerConnection` with `iceServers: []`, a receive-only audio transceiver, and an
unmuted audio element. Its `play()` call starts synchronously inside the gesture.
There is no browser microphone request, capture API, recording, AudioWorklet,
WebSocket PCM transport, custom jitter buffer, or automatic audio reconnect.
WebRTC supplies Opus decoding, packet-loss concealment, and jitter handling.
The existing AVC/HEVC WebCodecs video path is unchanged and separately timed.
No end-to-end latency or A/V synchronization guarantee is made.

Audio signaling travels only over the approved protocol-v2 WebSocket:

```json
{"type":"audioMode","enabled":true,"requestId":1,"transport":"webrtc-opus"}
{"type":"audioOffer","requestId":1,"epoch":2,"transport":"webrtc-opus","sdp":"..."}
{"type":"audioAnswer","requestId":1,"epoch":2,"transport":"webrtc-opus","sdp":"..."}
{"type":"audioIce","requestId":1,"epoch":2,"transport":"webrtc-opus","candidate":"candidate:...","sdpMid":"0","sdpMLineIndex":0}
{"type":"audioReady","requestId":1,"epoch":2,"transport":"webrtc-opus"}
{"type":"audioState","enabled":true,"requestId":1,"epoch":2,"transport":"webrtc-opus"}
{"type":"audioAlive","requestId":1,"epoch":2,"transport":"webrtc-opus"}
{"type":"audioMode","enabled":false,"requestId":1,"transport":"webrtc-opus"}
```

Android offers exactly one send-only DTLS/Opus audio section. The browser answers
receive-only, requests Opus `stereo=1`, and never creates a video/data/microphone
track. ICE is host-only: RFC1918 IPv4, loopback/link-local, IPv6 ULA/link-local, or
bounded `.local` mDNS names. Public-interface candidates are not signaled. No
STUN/TURN server or internet relay is configured. Both endpoints need a mutually
reachable trusted local network; client isolation, firewalls, mDNS, and browser
policy can prevent ICE connectivity. There is no insecure transport fallback.

`requestId` advances on each user-initiated audio attempt. A disable refers to that
same attempt. Android assigns a positive route `epoch`; offer/answer, trickle ICE,
readiness, liveness, and state must match the current request and epoch. ICE arriving
before its offer is bounded and held until remote SDP is accepted. Delayed promises,
old callbacks, and stale acknowledgments cannot revive or stop a newer route.
SDP is ASCII and at most 6,000 characters; candidates are at most 1,024 characters,
with at most 32 candidates in each direction and 64 incoming controls per attempt.

The browser sends `audioReady` only when it has answered the offer, ICE is connected,
a live audio track exists, the audio element's playback promise succeeded, and
inbound audio RTP packets increased across successive stats polls, and the selected
ICE pair is verified as host-to-host with local literal or mDNS addresses. Missing
or privacy-redacted addresses cannot establish this local-only proof; audio stays
on Android with an explanation rather than weakening the check. Android keeps
native output on until its own peer is connected and this matching readiness is
accepted, then confirms `audioState enabled:true`. A pre-readiness enabled ACK or
legacy PCM audio request/response fails closed with APK/viewer upgrade guidance.
No fallback to the old PCM WebSocket pipeline is attempted.

Negotiation has a 15-second deadline; a ready browser waits at most five seconds
for Android's acknowledgment. While active, the browser sends `audioAlive` at most
once per second, only with new RTP progress. A three-second RTP stall, paused/muted
output, ended track, failed/disconnected ICE, explicit stop, or tab hide returns
playback to Android. Android also has a four-second liveness watchdog in case the
browser's timers are suspended. Disconnect/source replacement closes the route.
Video-only recovery does not alter a healthy audio route. New sockets need fresh
Android approval and a new audio-button click.

**Test audio (3 seconds)** sends the same enable with `"source":"test"`. It works
after Android approval without active CarPlay media. Android emits a finite quiet
440 Hz test tone through the same WebRTC/Opus route, never mutes native playback,
and closes with `audioState enabled:false` / `code:"test-complete"`. The browser
shows this as a completed test. It is never launched automatically.

For parked manual validation:

1. Connect and approve Android, then run **Test audio (3 seconds)**. Confirm the
   tone and automatic return to native mode; verify Android stayed audible.
2. Start CarPlay music and choose **Play audio here**. Verify native output is
   muted only after the browser starts receiving; listen for correct stereo.
3. Test stop/start, visibility changes, Wi-Fi loss, source replacement, and a
   stalled browser. Confirm Android resumes and no stale audio is replayed.
4. Exercise navigation/prompt mixing and longer playback alongside unchanged
   HEVC video. Real output quality, loss behavior, latency, and A/V timing require
   the intended browser/Android/accessory hardware; unit tests do not establish them.

A bounded read-only snapshot can be retrieved in the console with:

```js
(await import('./viewer.mjs?v=webrtc-audio-v1')).getAudioDiagnostics()
```

It includes packet count, jitter in milliseconds, concealed sample count, and
selected candidate-pair types/protocol when the browser supplies those stats.
It never exposes IP addresses, SDP, raw candidate strings, tokens, or media.
Missing stats are `null`, not proof that ICE failed. Counters remain only in page
memory, reset for the next attempt, and are neither logged nor uploaded.

## Validation

From the repository root, with Node 20+:

```sh
node --test site/browser-carplay/tests/*.test.mjs
node --check site/browser-carplay/viewer.mjs
node --check site/browser-carplay/session.mjs
node --check site/browser-carplay/diagnostics.mjs
node --check site/browser-carplay/audio.mjs
node --check site/browser-carplay/audio-protocol.mjs
```

The dependency-free tests exercise strict endpoint validation, framing, codec
configuration, letterbox geometry, stable contacts, approval/version gating,
rejection/expiry, stale touch acknowledgments, timeouts, codec negotiation races,
backpressure, recovery, and explicit reconnect. Diagnostic tests cover exact
milestone times, pre-open failure, rejection, timeout, received-versus-local close
codes, deduplication across video recovery, stale callbacks, privacy-safe output,
bounded retention, new-attempt reset, and absence of automatic HTTP health probes.
Audio tests cover readiness ordering, Opus stereo negotiation, local ICE/size/count
bounds, legacy fail-closed behavior, delayed promises, repeated/cancelled gestures,
RTP liveness, explicit test tone signaling, privacy-safe stats, and native fallback.
They use synthetic bytes and identifiers only. Real HTTPS-to-LAN browser permission,
hardware AVC/HEVC decoding, physical two-finger gestures, background suspension,
and CarPlay hardware integration still require a parked-device test.
