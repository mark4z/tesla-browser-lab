# Experimental browser CarPlay viewer

Static HTML/CSS/ES modules; no dependencies, telemetry, storage, or automatic
connection. This is a video-and-touch companion to the Android bridge, not a
standalone CarPlay receiver. Audio and microphone remain outside this viewer.

## Deployment and connection

Serve this directory from an **HTTPS origin you control**. The Android bridge
must allow that exact origin (scheme, hostname, and non-default port; no path).
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

1. Park, enable the bridge in DiPlay, and configure this page's allowed origin.
2. Connect both devices to the same trusted private LAN.
3. Enter the displayed `ws://<RFC1918 IPv4>:<port>/carplay` endpoint and ephemeral
   pairing token. Neither is accepted from URL parameters. No scan/discovery runs.
4. Confirm parked use and click **Connect display**. Personally decide whether to
   allow the browser's local-network permission. The page does not grant it.
5. Video starts only for this explicit connection. Enable touch separately if
   wanted; up to two contacts match the existing CarPlay HID mapper.

The LAN link is **unencrypted**, including the pairing token and screen contents.
Use only a trusted network. Do not expose the bridge to the internet. The viewer
does not persist the token, retain it in the input after connecting, or log raw
network data. JavaScript cannot promise cryptographic erasure of strings held by
the browser. HTTPS secures page delivery, not the local transport.

Hide/leave the page, lock the screen, uncheck parked use, or click Disconnect to
close the session. Touch is released on pointer cancel/lost capture, focus loss,
video reconfiguration, and resize. On reconnect, re-enter the token and explicitly
enable touch again. The checkbox is a user declaration, not a vehicle-speed sensor.

## Wire protocol

One WebSocket client to `/carplay`; client sends authentication as its first text
message, never in the URL or subprotocol:

```json
{"type":"auth","token":"<ephemeral token from Android>"}
```

The server replies `{"type":"authenticated"}`. While no stream is available it
may send `{"type":"status","code":"waiting"}` or code `disconnected`.
These clear decoded video but keep the authenticated socket waiting for config.
A generic `{"type":"error"}` closes the session; arbitrary server strings are
never rendered or logged.

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

Touch snapshots are `{"type":"touch","streamId":1,"contacts":[{"id":0,"x":0.5,"y":0.5}]}`.
The identifier must match the current video configuration. The server rejects
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
configuration, letterbox geometry, stable contacts, authentication gating,
timeouts, codec negotiation races, backpressure, recovery, and explicit reconnect.
They use synthetic bytes and test tokens only. Real HTTPS-to-LAN browser permission,
hardware AVC/HEVC decoding, physical two-finger gestures, background suspension,
and CarPlay hardware integration still require a parked-device test.
