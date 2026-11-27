// v3.121 phone controller: link-wire golden vectors (the desktop's pairing bytes must never change) and a phone
// (ios/core/ctl-client.js, the worklet's own code) pairing with a desktop Link on a local hyperdht testnet.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const C = require('../src/link-core.js');
const W = require('../src/link-wire.js');

test('link-wire keeps the pairing bytes of earlier builds (golden vectors)', () => {
  const code = 'acid-tree-moon-salt-king';
  const s = C.pairSecrets(code);
  assert.equal(C.hex(s.topic), '61016c49c1161d5ecded496418dbe0f961e44a1c4ed2b7766635d3cfd1d98c86');
  assert.equal(C.hex(s.key), 'bbc04ced8417f80b3d4975f123dbb231473a39d320e363a7ed42c1e518c4244d');
  const a = '11'.repeat(32); const b = '22'.repeat(32);
  assert.equal(C.pairProof(s.key, 'joiner', a, b), 'a1bfc22802c2963d6feeb331c19567449d9e60c5d831a5d68ad52415116a8de6');
  assert.equal(C.pairProof(s.key, 'ok', b, a), '05548545d58034ef8ccfb4e1afc2844f1fdbedc8d839a50b75efe3aec050ff65');
  assert.ok(C.proofOk(s.key, 'ok', b, a, '05548545d58034ef8ccfb4e1afc2844f1fdbedc8d839a50b75efe3aec050ff65'));
  assert.equal(C.hex(C.pairTopic('ab'.repeat(32))), '47694cbf052660efac1b4ee300aea3fa35b05fe9d9ff6a8bf43b13601c01a7f0');
  assert.equal(C.makeCode(() => Buffer.from([0, 1, 254, 255, 128])), 'acid-aged-roof-room-grin');
  assert.equal(C.encode({ t: 'pair-hello', name: 'Mac ü', proof: 'x' }), '{"t":"pair-hello","name":"Mac ü","proof":"x"}\n');
  assert.deepEqual(C.validatePair({ t: 'pair-hello', name: 'Mac', proof: 'x' }), { t: 'pair-hello', name: 'Mac', proof: 'x' });   // no kind: unchanged
  // a sha256-only wire built on any crypto gives the same proof
  const w = W.createWire(crypto);
  assert.equal(w.pairProof(s.key, 'joiner', a, b), C.pairProof(s.key, 'joiner', a, b));
});

test('ctl-* messages are validated with size limits', () => {
  assert.equal(W.validateCtl({ t: 'ctl-hq', id: 'x', text: 'a'.repeat(W.MAX_COMMAND * 4 + 1) }), null);
  assert.equal(W.validateCtl({ t: 'ctl-hq', id: 'bad id', text: 'hi' }), null);
  assert.deepEqual(W.validateCtl({ t: 'ctl-hq', id: 'a1', text: 'hi', extra: 1 }), { t: 'ctl-hq', id: 'a1', text: 'hi' });
  assert.equal(W.validateCtl({ t: 'ctl-view', seq: 1, view: { projects: Array.from({ length: 51 }, (_, i) => ({ id: `p${i}`, status: 'idle' })) } }), null);
  assert.equal(W.validateCtl({ t: 'ctl-reports', id: 'r', reports: Array.from({ length: 21 }, () => ({ id: 'a', at: 1 })) }), null);
  assert.equal(W.validateCtl({ t: 'ctl-reports', id: 'r', reports: [{ id: 'a', at: 1, summary: 'x'.repeat(9000) }] }).reports[0].summary.length, W.CTL_REPORT_TEXT);
  assert.equal(W.validateCtl({ t: 'ctl-event', seq: 1, event: { project: 'hq', status: 'nope', at: 1 } }), null);
  assert.equal(W.validateCtl({ t: 'proj-op', id: 'x' }), null);   // nothing else is a controller message
  const url = W.pairUrl({ code: 'acid-aged-also-area-army', name: 'Mac ü', pub: 'ab'.repeat(32) });
  assert.deepEqual(W.parsePairUrl(url), { code: 'acid-aged-also-area-army', name: 'Mac ü', pub: 'ab'.repeat(32), caps: ['ctl'] });
  assert.equal(W.parsePairUrl(url.replace('caps=ctl', 'caps=x')), null);
});

test('controllers are sealed apart and never count as offices', () => {
  const ctl = { pub: 'cc'.repeat(32), name: 'Phone', kind: 'controller', own: true, ctl: true };
  const mac = { pub: 'dd'.repeat(32), name: 'Mac', own: true };
  const secrets = { [ctl.pub]: 'ee'.repeat(32), [mac.pub]: 'ff'.repeat(32) };
  const sealed = C.sealOwn([ctl, mac], [ctl.pub, mac.pub], [ctl.pub]);
  assert.equal(sealed[0].own, false);   // a controller is never own, even when devices.json and the own set say so
  assert.ok(C.isController(sealed, secrets, ctl.pub));
  assert.ok(!C.mayCommand(sealed, secrets, ctl.pub) && !C.mayManage(sealed, secrets, ctl.pub) && !C.maySessions(sealed, secrets, ctl.pub));
  assert.ok(!C.isPaused(sealed, ctl.pub));
  assert.deepEqual(C.offices(sealed).map((d) => d.name), ['Mac']);
  assert.deepEqual(C.ownKeys(sealed), [mac.pub]);
  assert.deepEqual(C.ctlKeys(sealed), [ctl.pub]);
  assert.ok(!C.isController(C.sealOwn([ctl], [], []), secrets, ctl.pub));   // not in the sealed ctl set: inert
});

test('integration: a phone pairs by QR URL, reads ctl-view and types an HQ turn', { timeout: 90000 }, async (t) => {
  let Hyperswarm; let createTestnet; let CtlClient;
  try { Hyperswarm = require('hyperswarm'); createTestnet = require('hyperdht/testnet'); ({ CtlClient } = require('../../ios/core/ctl-client.js')); } catch { t.skip('hyperswarm or ios/core not available'); return; }
  const { Link } = require('../src/link.js');
  const testnet = await createTestnet(3);
  t.after(() => testnet.destroy());
  const kp = () => require('hyperdht').keyPair();
  const desk = new Link({ keyPair: kp(), name: 'Desk', bootstrap: testnet.bootstrap, confirmPair: () => true, log: () => {} });
  t.after(() => desk.destroy());
  const typed = [];
  desk.on('ctl-hq', ({ text, reply }) => { typed.push(text); reply('queued'); });
  desk.publish({ projects: [{ id: 'p1', name: 'Alpha', engine: 'claude', status: 'working', working: 1, delivered: 0, attention: null }], workers: [], delivered: 0 });
  const { code } = await desk.invite({ kind: 'controller' });
  const v = desk.view();
  assert.equal(v.pairing.kind, 'controller');
  const url = W.pairUrl({ code, name: v.name, pub: v.pairing.pub });
  const events = [];
  const phone = new CtlClient({ Hyperswarm, crypto, keyPair: kp(), name: 'iPhone', bootstrap: testnet.bootstrap, onEvent: (e) => events.push(e) });
  t.after(() => phone.destroy());
  const paired = await phone.pair(url);
  assert.equal(paired.pub, desk.pub);
  const until = async (f) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f()); };
  await until(() => phone.view);
  assert.equal(phone.view.projects[0].name, 'Alpha');
  const after = desk.view();
  assert.equal(after.phones.length, 1);
  assert.equal(after.devices.length, 0);   // never a remote office
  assert.equal(after.remotes.length, 0);
  const st = await phone.hq('status please');
  assert.equal(st.status, 'queued');
  assert.deepEqual(typed, ['status please']);
  phone.write({ t: 'cmd', id: 'x1', project: 'p1', text: 'rm -rf' });   // an office command from a controller is dropped
  desk.setCtlHq('working');
  await until(() => events.some((e) => e.t === 'ctl-event' && e.event.project === 'hq'));
  await desk.remove(desk.view().phones[0].id);
  assert.equal(desk.view().phones.length, 0);
});
