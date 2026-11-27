// The phone's pairing state machine (ios/core/ctl-client.js) against a fake swarm: expiry, a bad proof and a second
// scan each end the attempt at once, with the retry stopped and the code's topic left.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const W = require('../src/link-wire.js');

let CtlClient = null;
try { ({ CtlClient } = require('../../ios/core/ctl-client.js')); } catch { /* ios/core not present */ }
const skip = CtlClient ? false : 'ios/core not available';

class FakeSwarm extends EventEmitter {
  constructor() { super(); this.joined = []; this.left = []; this.refreshes = 0; }
  join(topic) { this.joined.push(Buffer.from(topic).toString('hex')); return { refresh: () => { this.refreshes++; return Promise.resolve(); } }; }
  leave(topic) { this.left.push(Buffer.from(topic).toString('hex')); return Promise.resolve(); }
  destroy() { return Promise.resolve(); }
}
const keyPair = () => ({ publicKey: crypto.randomBytes(32), secretKey: crypto.randomBytes(64) });
const deskPub = 'd'.repeat(64);
const url = (code) => W.pairUrl({ code, name: 'Desk', pub: deskPub });
function client() {
  let swarm = null;
  const Hyperswarm = function Hyperswarm() { swarm = new FakeSwarm(); return swarm; };
  const c = new CtlClient({ Hyperswarm, crypto, keyPair: keyPair(), name: 'iPhone' });
  return { c, swarm: /** @type {FakeSwarm} */ (/** @type {unknown} */ (swarm)) };
}

test('an expired pairing stops its retry and leaves the topic', { skip }, async () => {
  const { c, swarm } = client();
  const p = c.pair(url('acid-aged-also-area-army'), { ttlMs: 30 });
  await assert.rejects(p, /expired/);
  assert.equal(c.pairing, null);
  assert.deepEqual(swarm.left, swarm.joined);
  const n = swarm.refreshes;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(swarm.refreshes, n);   // no retry runs after the end
});

test('a pair-hello with a bad proof rejects the pairing at once', { skip }, async () => {
  const { c, swarm } = client();
  const p = c.pair(url('acid-aged-also-area-army'), { ttlMs: 60000 });
  const conn = Object.assign(new EventEmitter(), { remotePublicKey: Buffer.from(deskPub, 'hex'), destroyed: false, written: [],
    write(x) { this.written.push(x); }, destroy() { this.destroyed = true; } });
  swarm.emit('connection', conn);
  const wrongKey = W.createWire(crypto).pairSecrets('tail-tank-team-tent-tide').key;
  const proof = W.createWire(crypto).pairProof(wrongKey, 'inviter', deskPub, c.pub);
  conn.emit('data', Buffer.from(W.encode({ t: 'pair-hello', name: 'Desk', proof, kind: 'controller' })));
  await assert.rejects(p, /bad-proof/);
  assert.equal(conn.destroyed, true);
  assert.equal(conn.written.length, 0);   // the phone never proved the code to it
  assert.equal(c.pairing, null);
  assert.equal(swarm.left.length, 1);
});

test('a second pair() cancels the first', { skip }, async () => {
  const { c, swarm } = client();
  const first = c.pair(url('acid-aged-also-area-army'), { ttlMs: 60000 });
  const second = c.pair(url('army-area-also-aged-acid'), { ttlMs: 60000 });
  await assert.rejects(first, /cancelled/);
  assert.equal(swarm.left[0], swarm.joined[0]);
  assert.equal(c.pairing?.code, 'army-area-also-aged-acid');
  c.cancelPair();
  await assert.rejects(second, /cancelled/);
  assert.equal(c.pairing, null);
  assert.equal(swarm.left.length, 2);
});
