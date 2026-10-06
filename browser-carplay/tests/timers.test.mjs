import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../session.mjs';

test('default timers retain their browser receiver through connect, approval, close and reconnect', t => {
  // Node timers accept arbitrary receivers; browser Window timers do not.
  // Model that host check so ordinary lifecycle mocks cannot hide this bug.
  const timers = new Map(), sockets = [], states = [];
  let nextId = 0;
  t.mock.method(globalThis, 'setTimeout', function (callback, delay) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    timers.set(++nextId, { callback, delay });
    return nextId;
  });
  t.mock.method(globalThis, 'clearTimeout', function (id) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    timers.delete(id);
  });
  class Socket {
    constructor() { this.readyState = 0; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; }
  }
  const session = new BrowserSession({ WebSocket: Socket, onState: state => states.push(state) });
  const connect = () => session.connect('192.168.1.20', '8765');
  connect();
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 60000);
  sockets[0].readyState = 1;
  sockets[0].onopen();
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 30000);
  session.receiveText('{"type":"approvalPending","version":2}');
  session.receiveText('{"type":"authenticated","version":2}');
  assert.equal(timers.size, 0);
  session.close();
  session.close();
  assert.equal(sockets[0].readyState, 3);
  assert.equal(states.at(-1), 'closed');
  connect();
  session.close();
  assert.equal(timers.size, 0);
  assert.equal(sockets[1].readyState, 3);
  assert.equal(sockets[1].onopen, null);
  connect();
  [...timers.values()][0].callback();
  assert.equal(timers.size, 0);
  assert.equal(sockets[2].readyState, 3);
  assert.equal(states.at(-1), 'error');
});
