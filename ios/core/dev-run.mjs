// Plays the phone (the worklet's own controller.js and ctl-client.js) under Node, against a desktop Agent Office.
//   node dev-run.mjs '<agentoffice://pair?... URL>'   pair with the desktop showing that QR, then type HQ turns on stdin
//   node dev-run.mjs --selftest                        a desktop Link (app/src/link.js) and the phone on a local testnet
// Lines typed on stdin become HQ turns (ctl-hq); "/reports" asks for the reports. Use a dev profile of Agent Office
// (AGENT_OFFICE_USER_DATA), never your real one: the pairing is real.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const Hyperswarm = require('hyperswarm');
const DHT = require('hyperdht');
const { createController } = require('./controller.js');

const stamp = () => new Date().toISOString().slice(11, 23);
const print = (m) => console.log(`${stamp()} ${m.t === 'recv' ? `recv ${m.msg.t}` : m.t} ${JSON.stringify(m.t === 'recv' ? m.msg : m).slice(0, 400)}`);

async function phone(url, { bootstrap, onOut = () => {} } = {}) {
  const ctl = createController({ Hyperswarm, DHT, crypto, bootstrap, out: (m) => { print(m); onOut(m); } });
  await ctl.command({ t: 'init', name: 'dev phone' });
  ctl.command({ t: 'pair', url });
  return ctl;
}

const arg = process.argv[2];
if (arg === '--selftest') {
  const createTestnet = require('hyperdht/testnet');
  const { Link } = require('../../app/src/link.js');
  const W = require('../../app/src/link-wire.js');
  const testnet = await createTestnet(3);
  const desk = new Link({ keyPair: DHT.keyPair(), name: 'dev desk', bootstrap: testnet.bootstrap, confirmPair: () => true, log: () => {} });
  desk.on('ctl-hq', ({ text, reply }) => { console.log(`${stamp()} [desk] HQ turn: ${text}`); reply('queued'); });
  desk.publish({ projects: [{ id: 'p1', name: 'Alpha', engine: 'claude', status: 'idle', working: 0, delivered: 0, attention: null }], workers: [], delivered: 0 });
  const { code } = await desk.invite({ kind: 'controller' });
  const finish = async (ok) => { console.log(ok ? 'SELFTEST PASS' : 'SELFTEST FAIL'); await desk.destroy(); await testnet.destroy(); process.exit(ok ? 0 : 1); };
  setTimeout(() => finish(false), 90_000).unref();
  let ctl = null;
  ctl = await phone(W.pairUrl({ code, name: desk.name, pub: desk.pub }), { bootstrap: testnet.bootstrap, onOut: (m) => {
    if (m.t === 'recv' && m.msg.t === 'ctl-view') ctl.command({ t: 'send', msg: { t: 'ctl-hq', id: 'dev1', text: 'hello from the phone' } });
    if (m.t === 'recv' && m.msg.t === 'ctl-hq-status') finish(m.msg.status === 'queued');
  } });
} else if (arg && arg.startsWith('agentoffice://')) {
  const ctl = await phone(arg);
  let n = 0;
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    const msg = text === '/reports' ? { t: 'ctl-reports', id: `r${++n}`, limit: 5 } : { t: 'ctl-hq', id: `dev${Date.now().toString(36)}${++n}`, text };
    ctl.command({ t: 'send', msg });
  });
} else {
  console.log("usage: node dev-run.mjs '<agentoffice://pair?... URL>' | --selftest");
  process.exit(2);
}
