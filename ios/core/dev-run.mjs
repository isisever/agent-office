// Runs the worklet's link logic (spike.js) under Node, so it can be tried without a phone.
//   node dev-run.mjs <code | agentoffice://pair URI>   join as the phone would
//   node dev-run.mjs --invite                           act as a desktop inviter with the real app/src/link-core.js
//   node dev-run.mjs --selftest                         both in one process; exits 0 once both proofs check out
// Never point this at your real Agent Office: use a dev profile (AGENT_OFFICE_USER_DATA) or --invite.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createSpike } = require('./spike.js');
const Hyperswarm = require('hyperswarm');
const C = require(path.join(here, '..', '..', 'app', 'src', 'link-core.js'));

const stamp = () => new Date().toISOString().slice(11, 23);

async function invite(code = C.makeCode(), onProof = () => {}) {
  const swarm = new Hyperswarm();
  const ours = C.hex(swarm.keyPair.publicKey);
  const { topic, key } = C.pairSecrets(code);
  console.log(`${stamp()} [inviter] code: ${code}`);
  console.log(`${stamp()} [inviter] topic ${topic.toString('hex').slice(0, 16)}... (Node crypto, link-core)`);
  swarm.on('connection', (conn) => {
    const remote = C.hex(conn.remotePublicKey);
    console.log(`${stamp()} [inviter] peer ${remote}`);
    conn.write(C.encode({ t: 'pair-hello', name: 'dev inviter', proof: C.pairProof(key, 'inviter', ours, remote) }));
    const reader = new C.LineReader((m) => {
      const ok = m.t === 'pair-hello' && C.proofOk(key, 'joiner', remote, ours, m.proof);
      console.log(`${stamp()} [inviter] ${m.t} from "${m.name}": joiner proof ${ok ? 'OK' : 'BAD'}`);
      if (ok) onProof();
    });
    conn.on('data', (d) => { try { reader.push(d); } catch (e) { console.log(`${stamp()} [inviter] ${e.message}`); } });
    conn.on('error', () => {});
  });
  await swarm.join(topic, { server: true, client: false }).flushed();
  console.log(`${stamp()} [inviter] announced`);
  return { swarm, code };
}

async function join(input, onLog = () => {}) {
  const spike = createSpike({
    log: (line) => { console.log(`${stamp()} [joiner] ${line}`); onLog(line); },
    status: (s) => console.log(`${stamp()} [joiner] status ${s}`),
  });
  await spike.connect(input);
  return spike;
}

const arg = process.argv[2];
if (arg === '--invite') {
  await invite();
} else if (arg === '--selftest') {
  let inviterOk = false;
  let joinerOk = false;
  const done = async (ok) => { console.log(ok ? 'SELFTEST PASS' : 'SELFTEST FAIL (timeout)'); process.exit(ok ? 0 : 1); };
  setTimeout(() => done(false), 90_000).unref();
  const inv = await invite(undefined, () => { inviterOk = true; if (joinerOk) done(true); });
  await join(`agentoffice://pair?v=1&c=${inv.code}&n=dev`, (line) => {
    if (/inviter proof OK/.test(line)) { joinerOk = true; if (inviterOk) done(true); }
  });
} else if (arg) {
  await join(process.argv.slice(2).join(' '));
} else {
  console.log('usage: node dev-run.mjs <code> | --invite | --selftest');
  process.exit(2);
}
