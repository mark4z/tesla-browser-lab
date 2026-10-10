# Tesla Browser Lab

A standalone browser capability test for H.264, HEVC, WebCodecs, and local touch input. Use only while safely parked. This is an independent tool, not an official Tesla product.

The page uses same-origin synthetic video samples. Reports stay in the browser unless you copy or download them. No camera, microphone, location, or vehicle API access is requested.

## GitHub Pages

Publish from the `main` branch and `/(root)` in Settings → Pages.

The six-second video samples are 1280×720 at 60 fps, with no audio track. Test results do not establish hardware decoding, sustained mirroring performance, or end-to-end latency.


## Live screen geometry (v1.2 SCREEN)

The root page measures screen and available area (CSS pixels), inner/client viewport, DPR, visual viewport (size, scale and offsets), fullscreen and orientation. Measurements refresh on load, resize, visual viewport resize/scroll, fullscreen and orientation changes. Copy and TXT export resample immediately; the TXT report includes all geometry fields as a JSON object, version and UTC sample timestamp. No video/audio test is needed.

CSS × DPR estimates are rounded and are **not verified native LCD resolution**. The page cannot measure millimeters, CarPlay source resolution, or diagnose the cause of large icons. Unavailable or non-finite values are reported as null (unavailable in the UI). Existing media and touch tests are unchanged.

Run geometry tests with `node --test tests/screen.test.cjs` (Node 18+).

## Manual fullscreen test (v1.3 FULLSCREEN)

Parked confirmation gates manual entry. The click calls the standard or WebKit request API synchronously. Actual fullscreen element state confirms entry/exit; a resolved Promise alone does not. Error events, rejected Promises, external exits, pending duplicate clicks and a 5-second unconfirmed result are handled. Exit remains possible after unchecking parked confirmation. Geometry is sampled before each request and 300 ms after state/viewport changes; this is a best-effort settled snapshot, not a guarantee of native panel dimensions. TXT includes capabilities, last 20 attempts, and last 40 events. No automatic fullscreen entry, driving restriction bypass, media test, or permission prompt is added.

Run `node --test tests/*.test.cjs`.
