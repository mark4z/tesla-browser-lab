import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConnectionDiagnostics, MAX_DIAGNOSTIC_EVENTS, milestoneText, safeCloseCode, transportCaption } from '../diagnostics.mjs';

test('bounded milestone recorder discards untrusted labels, repeated stages, and stale entries', () => {
  let now = 1000;
  const diagnostics = new ConnectionDiagnostics({ now: () => now });
  diagnostics.mark('approved');
  assert.equal(diagnostics.snapshot().events.length, 0);
  diagnostics.start('ws:');
  now += 250;
  diagnostics.mark('wsOpen');
  for (let i = 0; i < 10000; i++) {
    diagnostics.mark('wsOpen');
    diagnostics.mark('constructor');
    diagnostics.mark('__proto__');
    diagnostics.mark('secret token');
  }
  diagnostics.mark('approvalPending');
  diagnostics.mark('approved');
  diagnostics.mark('firstVideo');
  diagnostics.mark('closed', 1006);
  diagnostics.mark('firstVideo');
  assert.equal(diagnostics.snapshot().events.length, MAX_DIAGNOSTIC_EVENTS);
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /constructor|__proto__|secret/);
  const snapshot = diagnostics.snapshot();
  snapshot.events[0].stage = 'changed externally';
  snapshot.events.push({ stage: 'injected' });
  assert.equal(diagnostics.snapshot().events[0].stage, 'connect');
  assert.equal(diagnostics.snapshot().events.length, MAX_DIAGNOSTIC_EVENTS);
  diagnostics.start('ws://private-ip/secret?token=secret');
  assert.deepEqual(diagnostics.snapshot(), { attempt: 2, transport: null, events: [{ stage: 'connect', elapsedMs: 0 }] });
});

test('elapsed times remain finite and monotonic even if a clock misbehaves', () => {
  let now = 1000;
  const diagnostics = new ConnectionDiagnostics({ now: () => now });
  diagnostics.start('ws:');
  now = 1234.6;
  diagnostics.mark('wsOpen');
  now = 100;
  diagnostics.mark('approvalPending');
  now = Infinity;
  diagnostics.mark('closed', '1006');
  assert.deepEqual(diagnostics.snapshot().events.map(event => event.elapsedMs), [0, 235, 235, 235]);
  assert.equal(diagnostics.snapshot().events.at(-1).closeCode, null);
});

test('only bounded numeric close codes and fixed stage labels enter rendered text', () => {
  for (const code of ['secret', '1006', 999, 5000, Infinity, NaN, {}, null, 1006.1]) {
    assert.equal(safeCloseCode(code), null);
    assert.equal(milestoneText({ stage: 'closed', elapsedMs: 1250, closeCode: code }), '+1.3s · Connection ended (no close event code observed)');
  }
  assert.equal(milestoneText({ stage: 'closed', elapsedMs: 1000, closeCode: 1008 }), '+1.0s · Connection ended (WebSocket code 1008)');
  assert.equal(milestoneText({ stage: '<script>secret</script>', elapsedMs: Infinity }), '+0.0s · Unknown stage');
  assert.equal(milestoneText({ stage: 'constructor', elapsedMs: -10 }), '+0.0s · Unknown stage');
});

test('page security and actual transport are reported independently without echoing arbitrary values', () => {
  assert.match(transportCaption({ protocol: 'https:', secureContext: true, transport: 'ws:' }),
    /Page: HTTPS\. Secure context: yes\. WebSocket transport: ws:\/\/ \(plaintext LAN WebSocket\)/);
  assert.match(transportCaption({ protocol: 'http:', secureContext: false, transport: null }),
    /Page: HTTP\. Secure context: no\. WebSocket transport: not attempted/);
  assert.match(transportCaption({ protocol: 'file:secret', secureContext: true, transport: 'wss:' }), /other scheme.*wss:\/\/ \(TLS WebSocket\)/);
  assert.doesNotMatch(transportCaption({ protocol: 'secret', secureContext: 'secret', transport: 'secret' }), /secret/);
});

test('diagnostic callback failure cannot break connect or disconnect observations', () => {
  const diagnostics = new ConnectionDiagnostics({ now: () => 0, onUpdate: () => { throw new Error('UI unavailable'); } });
  assert.doesNotThrow(() => diagnostics.start('ws:'));
  assert.doesNotThrow(() => diagnostics.mark('closed'));
  assert.equal(diagnostics.snapshot().events.at(-1).stage, 'closed');
});

test('diagnostic guidance remains a manual navigation with no HTTP subresource or automatic probe', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const viewer = readFileSync(new URL('../viewer.mjs', import.meta.url), 'utf8');
  const diagnostics = readFileSync(new URL('../diagnostics.mjs', import.meta.url), 'utf8');
  assert.match(html, /manually enter the HTTP health URL/);
  assert.match(html, /does not prove the HTTPS viewer has local-network permission/);
  assert.match(html, /Do not bypass browser or certificate warnings/);
  assert.doesNotMatch(html, /(?:href|src|action)=["']http:\/\//i);
  assert.doesNotMatch(viewer + diagnostics, /\b(?:fetch|XMLHttpRequest|sendBeacon)\s*\(|\b(?:localStorage|sessionStorage|indexedDB)\b|console\./);
});
