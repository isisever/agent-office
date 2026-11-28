// The phone controller behind an IPC of newline-JSON frames (each at most 64 KB), shared by worklet.js (Swift over
// Bare.IPC) and dev-run.mjs (stdin/stdout under Node). The Swift side keeps the key seed and the paired record in the
// keychain and hands them back at init.
//   In:  {t:'init', name?, seed?, paired?} {t:'pair', url} {t:'send', msg} {t:'suspend'} {t:'resume'} {t:'forget'}
//   Out: {t:'ready', pub, seed} {t:'status', state} {t:'paired', paired} {t:'recv', msg} {t:'log', line} {t:'fatal', error}
'use strict';
const W = require('../../app/src/link-wire.js');
const { CtlClient } = require('./ctl-client.js');

// what the phone may send through {t:'send'}: an HQ turn, a reports request, reading a session, and (ctl2) the project
// screen, sending a message, answering an approval and stopping a turn
// an old desktop drops a connection after 20 invalid messages, so these go only to a desktop whose hello advertised 'ctl2'
const CTL2_ONLY = new Set(['ctl-proj', 'ctl-send', 'ctl-answer', 'ctl-stop']);
const SENDABLE = new Set(['ctl-hq', 'ctl-reports', 'sess-open', 'sess-keep', 'sess-close', 'ctl-proj', 'ctl-send', 'ctl-answer', 'ctl-stop']);
const isId = (s) => typeof s === 'string' && s.length > 0 && s.length <= 64;
const isHex = (s, n) => typeof s === 'string' && s.length === n * 2 && /^[0-9a-f]+$/.test(s);

/**
 * @param {{ Hyperswarm: any, DHT: any, crypto: any, out: (m: any) => void, bootstrap?: any[] }} o
 * @returns {{ push: (chunk: any) => boolean, command: (m: any) => Promise<void>, destroy: () => Promise<void> }}
 */
function createController(o) {
  let client = null;
  let state = { name: 'iPhone', seed: '', paired: null };
  const emit = (m) => { if (W.encode(m)) o.out(m); else o.out({ t: 'log', line: `dropped an oversized ${m.t} frame` }); };
  const log = (line) => emit({ t: 'log', line });
  const status = (s) => emit({ t: 'status', state: s });

  function onEvent(e) {
    if (e.t === 'online' || e.t === 'offline') return status(e.t);
    emit({ t: 'recv', msg: e });
  }
  async function start() {
    if (client) await client.destroy().catch(() => {});
    const seed = isHex(state.seed, 32) ? W.fromHex(state.seed) : o.crypto.randomBytes(32);
    state.seed = W.toHex(seed);
    const keyPair = o.DHT.keyPair(seed);
    client = new CtlClient({ Hyperswarm: o.Hyperswarm, crypto: o.crypto, keyPair, name: state.name, bootstrap: o.bootstrap, paired: state.paired, onEvent });
    emit({ t: 'ready', pub: W.hex(keyPair.publicKey), seed: state.seed });
    if (state.paired) { status('connecting'); client.connect(); } else status('unpaired');
  }

  async function command(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'init') {
      const p = m.paired;
      state = { name: W.deviceName(m.name, 'iPhone'), seed: isHex(m.seed, 32) ? m.seed : '',
        paired: p && isHex(p.pub, 32) && isHex(p.secret, 32) ? { pub: p.pub, secret: p.secret, name: W.deviceName(p.name, 'Agent Office') } : null };
      return start();
    }
    if (!client) return log(`${m.t} before init`);
    if (m.t === 'pair') {
      status('pairing');
      try {
        state.paired = await client.pair(m.url);
        emit({ t: 'paired', paired: state.paired });
      } catch (e) { status('unpaired'); log(`pair failed: ${e.message}`); }
    } else if (m.t === 'send') {
      const msg = m.msg;
      if (!msg || !SENDABLE.has(msg.t) || (msg.t === 'sess-open' && (!isId(msg.project) || (msg.sid !== undefined && !isId(msg.sid))))) return log(`refused to send ${msg?.t}`);
      if (msg.t.startsWith('ctl-') && !W.validateCtl(msg)) return log(`malformed ${msg.t}`);
      if (CTL2_ONLY.has(msg.t) && !client.peerCaps?.includes('ctl2')) {   // v3.178: not sent; the app shows "Update Agent Office on your Mac"
        log(`${msg.t} not sent: the desktop has no ctl2`);
        return emit({ t: 'recv', msg: { t: 'mac-outdated', of: msg.t } });
      }
      client.write(msg);
    } else if (m.t === 'suspend') {
      await client.swarm.suspend?.().catch?.(() => {});
      status('suspended');
    } else if (m.t === 'resume') {
      await client.swarm.resume?.().catch?.(() => {});
      status(client.conn ? 'online' : 'connecting');
    } else if (m.t === 'forget') {
      state.paired = null;
      await start();
    }
  }

  const reader = new W.LineReader((m) => { command(m).catch((e) => emit({ t: 'fatal', error: String(e?.stack || e) })); });
  return {
    push: (chunk) => reader.push(chunk),   // false: a frame over 64 KB (the caller drops the rest)
    command,
    destroy: async () => { if (client) await client.destroy().catch(() => {}); client = null; },
  };
}

module.exports = { createController, SENDABLE, CTL2_ONLY };
