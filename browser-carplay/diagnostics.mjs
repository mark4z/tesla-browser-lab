// Local, bounded connection milestones only. Never accept payloads, URLs,
// server close reasons, tokens, SDP, audio, or video in the diagnostic record.
const STAGES = Object.freeze({
  connect: 'Connect requested',
  wsOpen: 'WebSocket opened',
  approvalPending: 'Android approval pending',
  approved: 'Approved on Android',
  firstVideo: 'First video decoded',
  closed: 'Connection ended',
});
export const MAX_DIAGNOSTIC_EVENTS = Object.keys(STAGES).length;

export function safeCloseCode(code) {
  return Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : null;
}

export function transportCaption({ protocol, secureContext, transport = null }) {
  const page = protocol === 'https:' ? 'HTTPS' : protocol === 'http:' ? 'HTTP' : 'other scheme';
  const secure = secureContext === true ? 'yes' : 'no';
  const link = transport === 'ws:' ? 'ws:// (plaintext LAN WebSocket)'
    : transport === 'wss:' ? 'wss:// (TLS WebSocket)' : 'not attempted';
  return `Page: ${page}. Secure context: ${secure}. WebSocket transport: ${link}. HTTPS page delivery does not encrypt a ws:// LAN link.`;
}

export function milestoneText(event) {
  const elapsed = Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0 ? event.elapsedMs : 0;
  const label = Object.hasOwn(STAGES, event.stage) ? STAGES[event.stage] : 'Unknown stage';
  const code = safeCloseCode(event.closeCode);
  const detail = event.stage === 'closed'
    ? (code === null ? ' (no close event code observed)' : ` (WebSocket code ${code})`) : '';
  return `+${(elapsed / 1000).toFixed(1)}s · ${label}${detail}`;
}

export class ConnectionDiagnostics {
  constructor({ now = () => performance.now(), onUpdate = () => {} } = {}) {
    Object.assign(this, { now, onUpdate });
    this.attempt = 0;
    this.startedAt = null;
    this.transport = null;
    this.events = [];
  }

  start(transport) {
    this.attempt = Math.min(this.attempt + 1, Number.MAX_SAFE_INTEGER);
    this.startedAt = this.now();
    this.transport = ['ws:', 'wss:'].includes(transport) ? transport : null;
    this.events = [{ stage: 'connect', elapsedMs: 0 }];
    this.notify();
  }

  mark(stage, closeCode = null) {
    if (this.startedAt === null || !Object.hasOwn(STAGES, stage) ||
        this.events.some(event => event.stage === stage || event.stage === 'closed') ||
        this.events.length >= MAX_DIAGNOSTIC_EVENTS) return;
    const elapsed = this.now() - this.startedAt;
    const previous = this.events.at(-1).elapsedMs;
    const elapsedMs = Number.isFinite(elapsed)
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(previous, 0, Math.round(elapsed))) : previous;
    const event = { stage, elapsedMs };
    if (stage === 'closed') event.closeCode = safeCloseCode(closeCode);
    this.events.push(event);
    this.notify();
  }

  snapshot() {
    return { attempt: this.attempt, transport: this.transport, events: this.events.map(event => ({ ...event })) };
  }

  notify() {
    // Optional diagnostic UI must never interrupt session teardown or consent.
    try { this.onUpdate(this.snapshot()); } catch { /* No raw diagnostic logging. */ }
  }
}
