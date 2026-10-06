# Experimental browser CarPlay viewer

Static HTML/CSS/ES modules; no dependencies, telemetry, storage, or automatic
connection. This is a video-and-touch companion to the Android bridge, not a
standalone CarPlay receiver. Audio and microphone remain outside this viewer.

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

The LAN link is **unencrypted**, including video and touch controls. Use only a
trusted network. Do not expose the bridge to the internet. The viewer has no
pairing credentials, persistent approvals, or raw network-data logging. HTTPS
secures page delivery, not the local transport.

Hide/leave the page, lock the screen, uncheck parked use, or click Disconnect to
close the session. Touch is released on pointer cancel/lost capture, focus loss,
video reconfiguration, and resize. On reconnect, click Connect, accept again on
Android, and explicitly enable touch again. The checkbox is a user declaration,
not a vehicle-speed sensor.

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
overload resets the decoder and discards deltas until a keyframe. There is no
application-level encoded-frame backlog. Repeated decoder recovery without any
output closes the session. One pending decoded frame is kept for the next paint;
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
Configuration replacement, inactive status, and disconnect clear ownership and
pending requests. Decoder recovery also disables the checkbox and releases
ownership. A fresh opt-in is required to resume control.

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

## Validation

From the repository root, with Node 20+:

```sh
node --test site/browser-carplay/tests/*.test.mjs
node --check site/browser-carplay/viewer.mjs
node --check site/browser-carplay/session.mjs
```

The dependency-free tests exercise strict endpoint validation, framing, codec
configuration, letterbox geometry, stable contacts, approval/version gating,
rejection/expiry, stale touch acknowledgments, timeouts, codec negotiation races, backpressure, recovery, and explicit reconnect.
They use synthetic bytes and identifiers only. Real HTTPS-to-LAN browser permission,
hardware AVC/HEVC decoding, physical two-finger gestures, background suspension,
and CarPlay hardware integration still require a parked-device test.
