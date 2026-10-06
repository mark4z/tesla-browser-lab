import { Contacts, fitRect, mapPointer } from './core.mjs?v=android-approval-v2';
import { BrowserSession } from './session.mjs?v=android-approval-v2';

const byId = id => document.getElementById(id);
const form = byId('connection');
const ip = byId('ip');
const port = byId('port');
const parked = byId('parked');
const touch = byId('touch');
const touchStatus = byId('touch-status');
const connect = byId('connect');
const disconnect = byId('disconnect');
const canvas = byId('video');
const viewport = byId('viewport');
const placeholder = byId('placeholder');
const status = byId('status');
const indicator = byId('indicator');
const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
const contacts = new Contacts();
let pendingFrame = null;
let drawRequest = null;
let moveRequest = null;
let videoWidth = 0;
let videoHeight = 0;
let live = false;

byId('origin').textContent = location.protocol === 'https:' ? location.origin : 'an HTTPS website origin';
// Restored form state must never count as a fresh safety/control choice.
parked.checked = touch.checked = false;

function compatibilityError() {
  if (!isSecureContext || location.protocol !== 'https:') return 'Open this viewer over HTTPS. Insecure pages cannot connect.';
  if (window.top !== window.self) return 'Open this viewer directly in its own browser tab.';
  if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function' || !context) return 'This browser does not provide the required WebCodecs video decoder and canvas.';
  // LNA has no reliable synchronous feature probe. Known old Chromium/WebView
  // builds are blocked here; the browser enforces its actual permission policy.
  const chromium = /(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent);
  if (!chromium || Number(chromium[1]) < 147 || /; wv\)/.test(navigator.userAgent)) return 'Use Chrome 147 or later with WebCodecs and Local Network Access. This browser is unsupported.';
  return null;
}

const blocked = compatibilityError();
const session = new BrowserSession({ WebSocket, VideoDecoder: window.VideoDecoder,
  EncodedVideoChunk: window.EncodedVideoChunk, onState: setState, onFrame: queueFrame, onTouchOwnership: setTouchState });

function updateControls() {
  const active = !session.closed;
  connect.disabled = Boolean(blocked) || active || !parked.checked;
  disconnect.disabled = !active;
  ip.disabled = port.disabled = active;
  touch.disabled = !live || !parked.checked || active === false || !window.PointerEvent;
}

function setState(state, text) {
  live = state === 'live';
  if (!live) {
    releaseContacts();
    if (session.touchRequested || session.touchOwned) {
      session.setTouchOwnership(false);
      if (session.closed) return;
    }
    touch.checked = false;
    canvas.classList.remove('touch-enabled');
    clearPicture();
  }
  status.textContent = text;
  indicator.dataset.state = state;
  updateControls();
}

function setTouchState({ enabled, requested, pending }) {
  if (!enabled) releaseContacts();
  touch.checked = requested;
  canvas.classList.toggle('touch-enabled', enabled && live && parked.checked);
  touchStatus.textContent = pending
    ? (requested ? 'Waiting for Android to enable touch…' : 'Releasing touch control…')
    : (enabled ? 'Touch control active' : 'Touch control off');
  updateControls();
}

function clearPicture() {
  if (drawRequest !== null) cancelAnimationFrame(drawRequest);
  drawRequest = null;
  if (pendingFrame) pendingFrame.close();
  pendingFrame = null;
  videoWidth = videoHeight = 0;
  context?.clearRect(0, 0, canvas.width, canvas.height);
  placeholder.hidden = false;
}

function queueFrame(frame) {
  if (document.visibilityState !== 'visible' || session.closed) { frame.close(); return; }
  if (pendingFrame) pendingFrame.close();
  pendingFrame = frame;
  if (drawRequest === null) drawRequest = requestAnimationFrame(drawFrame);
}

function drawFrame() {
  drawRequest = null;
  const frame = pendingFrame;
  pendingFrame = null;
  if (!frame) return;
  try {
    if (!live || document.visibilityState !== 'visible') return;
    if (videoWidth !== frame.displayWidth || videoHeight !== frame.displayHeight) releaseContacts();
    videoWidth = frame.displayWidth;
    videoHeight = frame.displayHeight;
    const bounds = canvas.getBoundingClientRect();
    // Cap backing pixels on high-DPI devices without changing hit-test geometry.
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(bounds.width * ratio));
    const height = Math.max(1, Math.round(bounds.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const rect = fitRect(width, height, videoWidth, videoHeight);
    if (!rect) return;
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);
    context.drawImage(frame, rect.x, rect.y, rect.width, rect.height);
    placeholder.hidden = true;
  } catch {
    session.close('This browser could not display the video.', true);
  } finally {
    frame.close();
  }
}

function flushContacts() {
  if (moveRequest !== null) cancelAnimationFrame(moveRequest);
  moveRequest = null;
  session.sendContacts(contacts.snapshot());
}

function releaseContacts() {
  if (moveRequest !== null) cancelAnimationFrame(moveRequest);
  moveRequest = null;
  const captured = contacts.pointerIds;
  const hadContacts = contacts.size > 0;
  contacts.clear();
  if (hadContacts) session.sendContacts([]);
  for (const pointerId of captured) {
    if (canvas.hasPointerCapture?.(pointerId)) canvas.releasePointerCapture(pointerId);
  }
}

function point(event, clamp = false) {
  const bounds = canvas.getBoundingClientRect();
  // Use the actual drawn bitmap, including while CSS resizes it between frames.
  // Re-fitting directly to the new CSS bounds would misidentify the black bars.
  return mapPointer((event.clientX - bounds.left) * canvas.width / bounds.width,
    (event.clientY - bounds.top) * canvas.height / bounds.height,
    { left: 0, top: 0, width: canvas.width, height: canvas.height }, videoWidth, videoHeight, clamp);
}

canvas.addEventListener('pointerdown', event => {
  if (!session.touchOwned || !touch.checked || !live || !parked.checked || (event.pointerType === 'mouse' && event.button !== 0)) return;
  const coordinate = point(event);
  if (!coordinate || !contacts.down(event.pointerId, coordinate)) return;
  event.preventDefault();
  try { canvas.setPointerCapture(event.pointerId); }
  catch { contacts.up(event.pointerId); return; }
  flushContacts();
});

canvas.addEventListener('pointermove', event => {
  if (!contacts.has(event.pointerId)) return;
  event.preventDefault();
  if (event.pointerType === 'mouse' && event.buttons === 0) { finishPointer(event); return; }
  if (contacts.move(event.pointerId, point(event, true)) && moveRequest === null) moveRequest = requestAnimationFrame(flushContacts);
});

function finishPointer(event) {
  if (!contacts.up(event.pointerId)) return;
  event.preventDefault();
  // Up/cancel sends the surviving contacts immediately, including an empty final
  // snapshot. Native pointer IDs never become reordered CarPlay contact slots.
  flushContacts();
  if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, finishPointer);
canvas.addEventListener('contextmenu', event => { if (session.touchOwned) event.preventDefault(); });

touch.addEventListener('change', () => {
  if (!live || !parked.checked) touch.checked = false;
  releaseContacts();
  if (!session.setTouchOwnership(touch.checked)) touch.checked = false;
  canvas.classList.toggle('touch-enabled', session.touchOwned);
});
parked.addEventListener('change', () => {
  if (!parked.checked) { releaseContacts(); session.close('Disconnected. Park safely before connecting again.'); }
  updateControls();
});
disconnect.addEventListener('click', () => { releaseContacts(); session.close(); });
form.addEventListener('submit', event => {
  event.preventDefault();
  if (blocked || !parked.checked || !session.closed || document.visibilityState !== 'visible') return;
  try {
    touch.checked = false;
    session.connect(ip.value, port.value);
  } catch (error) {
    status.textContent = error.message;
    indicator.dataset.state = 'error';
    updateControls();
  }
});

function leavePage() {
  releaseContacts();
  session.close('Disconnected because this page is no longer visible. Click Connect to request approval again.');
  parked.checked = touch.checked = false;
  updateControls();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') leavePage(); });
window.addEventListener('pagehide', leavePage);
window.addEventListener('blur', releaseContacts);
window.addEventListener('pageshow', event => { if (event.persisted) leavePage(); });
// Changing the picture bounds mid-gesture must not leave pressed contacts behind.
if (window.ResizeObserver) new ResizeObserver(releaseContacts).observe(viewport);
else window.addEventListener('resize', releaseContacts);

status.textContent = blocked || 'Ready. Confirm you are parked, then enter the bridge IP and port to request Android approval.';
indicator.dataset.state = blocked ? 'error' : 'closed';
updateControls();

