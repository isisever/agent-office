// The spike's link logic, shared by the Bare worklet (worklet.js) and the Node runner (dev-run.mjs): start a
// Hyperswarm, take a pairing code, join the pairing topic exactly as link-core's joiner does, and log the DHT
// bootstrap, the topic join and every peer (remote Noise key, the inviter's pair-hello proof).
'use strict';
const Hyperswarm = require('hyperswarm');
const b4a = require('b4a');
const pair = require('./pair');

const MAX_FRAME = 64 * 1024;

function createSpike({ log = () => {}, status = () => {}, name = 'Agent Office Remote (spike)' } = {}) {
  let swarm = null;
  let pairing = null;   // { code, key, topic, discovery, retry }
  const since = Date.now();
  const ms = () => `${Date.now() - since} ms`;

  async function start() {
    if (swarm) return swarm;
    status('starting');
    log('DHT bootstrapping');
    swarm = new Hyperswarm();
    swarm.on('connection', onConnection);
    await swarm.dht.ready();
    const pub = b4a.toString(swarm.keyPair.publicKey, 'hex');
    log(`DHT ready after ${ms()} (our Noise key ${pub.slice(0, 16)}..., firewalled=${swarm.dht.firewalled}, host=${swarm.dht.host ?? '?'}:${swarm.dht.port ?? '?'})`);
    status('dht-ready');
    return swarm;
  }

  async function connect(input) {
    const code = pair.codeFromInput(input);
    if (!code) { log('not a pairing code (5 words or an agentoffice://pair URI)'); return false; }
    await start();
    await leave();
    const t0 = Date.now();
    const { topic, key } = pair.pairSecrets(code);
    log(`pair topic ${b4a.toString(topic, 'hex').slice(0, 16)}... (scrypt ${Date.now() - t0} ms)`);
    const discovery = swarm.join(topic, { server: false, client: true });
    // like link.js: the joiner looks again every few seconds, the inviter may announce after our first lookup
    const retry = setInterval(() => discovery.refresh().catch(() => {}), 3000);
    pairing = { code, key, topic, discovery, retry };
    status('joining');
    await discovery.flushed();
    log(`topic joined (lookup flushed after ${Date.now() - t0} ms)`);
    return true;
  }

  async function leave() {
    const p = pairing;
    pairing = null;
    if (!p) return;
    clearInterval(p.retry);
    await swarm.leave(p.topic).catch(() => {});
  }

  function onConnection(conn, info) {
    const remote = b4a.toString(conn.remotePublicKey, 'hex');
    const ours = b4a.toString(swarm.keyPair.publicKey, 'hex');
    log(`peer connected: remote Noise key ${remote} (${info?.client ? 'we dialed' : 'they dialed'}, ${conn.rawStream?.remoteHost ?? '?'})`);
    status('peer');
    let buf = '';
    conn.on('data', (chunk) => {
      buf += b4a.toString(chunk, 'utf8');
      if (buf.length > MAX_FRAME) { log('frame too long, closing'); conn.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { log('bad frame'); continue; }
        if (m.t === 'pair-hello' && pairing) {
          const ok = pair.proofOk(pairing.key, 'inviter', remote, ours, m.proof);
          log(`pair-hello from "${String(m.name).slice(0, 40)}": inviter proof ${ok ? 'OK' : 'BAD'}`);
          if (ok) conn.write(JSON.stringify({ t: 'pair-hello', name, proof: pair.pairProof(pairing.key, 'joiner', ours, remote) }) + '\n');
        } else {
          log(`message ${String(m.t).slice(0, 20)}`);
        }
      }
    });
    conn.on('error', (err) => log(`peer error: ${err.message}`));
    conn.on('close', () => log(`peer closed ${remote.slice(0, 16)}...`));
  }

  function suspend() { log('suspend'); return swarm?.suspend?.(); }
  function resume() { log('resume'); return swarm?.resume?.(); }
  async function destroy() { await leave(); await swarm?.destroy(); swarm = null; status('stopped'); }

  return { start, connect, leave, suspend, resume, destroy, get swarm() { return swarm; } };
}

module.exports = { createSpike };
