// The iOS worklet's crypto shim (ios/core/crypto-shim.js, on sodium-native) must give byte-for-byte the same
// results as Node crypto for everything link-core uses, and ios/core/pair.js must match link-core's pairing.
// Needs `npm install` in ios/core: without it every test here is skipped (CI stays green).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const Module = require('node:module');

const CORE = path.join(__dirname, '..', '..', 'ios', 'core');
let shim = null;
let pair = null;
try { shim = require(path.join(CORE, 'crypto-shim.js')); pair = require(path.join(CORE, 'pair.js')); } catch { /* ios/core deps not installed */ }
const skip = shim ? false : 'ios/core dependencies not installed (npm install in ios/core)';
const LINK_CORE = path.join(__dirname, '..', 'src', 'link-core.js');
const real = require(LINK_CORE);

// link-core loaded a second time with require('crypto') answered by the shim
function linkCoreOnShim() {
  const origLoad = Module._load;
  delete require.cache[require.resolve(LINK_CORE)];
  Module._load = function (request, ...rest) {
    return request === 'crypto' || request === 'node:crypto' ? shim : origLoad.call(this, request, ...rest);
  };
  try { return require(LINK_CORE); } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve(LINK_CORE)];
    require(LINK_CORE);
  }
}
const onShim = linkCoreOnShim();

const CODES = ['acid-aged-also-area-army', 'tree-toad-tile-tide-tent', 'jazz-kite-moon-reef-silk'];
const PUB_A = 'a1'.repeat(32);
const PUB_B = Buffer.from('b2'.repeat(32), 'hex');

test('sha256 and HMAC-SHA256 match Node crypto', { skip }, () => {
  const inputs = ['', 'abc', 'x'.repeat(1000), Buffer.from([0, 1, 2, 255])];
  for (const d of inputs) {
    assert.deepEqual(shim.createHash('sha256').update(d).digest(), crypto.createHash('sha256').update(d).digest());
    for (const key of [Buffer.alloc(32, 7), 'k', Buffer.alloc(100, 9)]) {
      assert.equal(shim.createHmac('sha256', key).update(d).digest('hex'), crypto.createHmac('sha256', key).update(d).digest('hex'));
    }
  }
});

test('scrypt matches the RFC 7914 vector and Node crypto', { skip }, () => {
  const rfc = 'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640';
  assert.equal(shim.scryptSync('password', 'NaCl', 64, { N: 1024, r: 8, p: 16 }).toString('hex'), rfc);
  for (const [N, r, p, len] of [[16, 1, 1, 64], [256, 8, 2, 33], [1 << 15, 8, 1, 64]]) {
    const opts = { N, r, p, maxmem: 128 * 1024 * 1024 };
    assert.deepEqual(shim.scryptSync('pw', 'agent-office/link/pair/v1', len, opts), crypto.scryptSync('pw', 'agent-office/link/pair/v1', len, opts));
  }
});

test('randomBytes and timingSafeEqual behave like Node', { skip }, () => {
  assert.equal(shim.randomBytes(5).length, 5);
  assert.notDeepEqual(shim.randomBytes(32), shim.randomBytes(32));
  assert.equal(shim.timingSafeEqual(Buffer.from('abc'), Buffer.from('abc')), true);
  assert.equal(shim.timingSafeEqual(Buffer.from('abc'), Buffer.from('abd')), false);
  assert.throws(() => shim.timingSafeEqual(Buffer.from('a'), Buffer.from('ab')));
});

test('link-core pairing functions give the same bytes on the shim as on Node crypto', { skip }, () => {
  for (const code of CODES) {
    const t0 = Date.now();
    const a = real.pairSecrets(code);
    const t1 = Date.now();
    const b = onShim.pairSecrets(code);
    const t2 = Date.now();
    test.diagnostic?.(`${code}: node scrypt ${t1 - t0} ms, shim scrypt ${t2 - t1} ms`);
    assert.equal(Buffer.from(b.topic).toString('hex'), Buffer.from(a.topic).toString('hex'));
    assert.equal(Buffer.from(b.key).toString('hex'), Buffer.from(a.key).toString('hex'));
    for (const role of ['inviter', 'joiner']) {
      const proof = real.pairProof(a.key, role, PUB_A, PUB_B);
      assert.equal(onShim.pairProof(b.key, role, PUB_A, PUB_B), proof);
      assert.equal(onShim.proofOk(b.key, role, PUB_A, PUB_B, proof), true);
      assert.equal(onShim.proofOk(b.key, role, PUB_B, PUB_A, proof), false);
    }
    const secret = Buffer.from(a.key).toString('hex');
    assert.deepEqual(Buffer.from(onShim.pairTopic(secret)), real.pairTopic(secret));
  }
  const fixed = (n) => Buffer.from([0, 63, 128, 200, 255].slice(0, n));
  assert.equal(onShim.makeCode(fixed), real.makeCode(fixed));
});

test('ios/core/pair.js matches link-core', { skip }, () => {
  assert.deepEqual(pair.WORDS, real.WORDS);
  for (const code of CODES) {
    const a = real.pairSecrets(code);
    const b = pair.pairSecrets(code);
    assert.equal(Buffer.from(b.topic).toString('hex'), Buffer.from(a.topic).toString('hex'));
    assert.equal(Buffer.from(b.key).toString('hex'), Buffer.from(a.key).toString('hex'));
    assert.equal(pair.pairProof(b.key, 'inviter', PUB_A, PUB_B), real.pairProof(a.key, 'inviter', PUB_A, PUB_B));
    const secret = Buffer.from(a.key).toString('hex');
    assert.equal(Buffer.from(pair.pairTopic(secret)).toString('hex'), real.pairTopic(secret).toString('hex'));
  }
  assert.equal(pair.codeFromInput('agentoffice://pair?v=1&c=ACID%20aged-also-area-army&n=Mac'), 'acid-aged-also-area-army');
  assert.equal(pair.codeFromInput('Acid Aged Also Area Army'), real.normalizeCode('Acid Aged Also Area Army'));
  assert.equal(pair.codeFromInput('nope'), null);
});

// v3.121 the native ROMix (ios/core/addons/scrypt-ll/romix.c), built here as a tiny CLI with the host C compiler, gives
// byte-for-byte Node's scryptSync for the pairing parameters, plugged into the shim exactly as the worklet does.
test('native ROMix (scrypt-ll) matches Node scryptSync for the pairing parameters', { skip, timeout: 120000 }, (t) => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = path.join(CORE, 'addons', 'scrypt-ll');
  const exe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'romix-')), 'romix-cli');
  try { execFileSync('cc', ['-O2', '-o', exe, path.join(dir, 'romix-cli.c'), path.join(dir, 'romix.c')], { stdio: 'ignore' }); } catch { t.skip('no C compiler'); return; }
  const romix = (block, r, N) => {
    const out = spawnSync(exe, { input: `${r} ${N} ${Buffer.from(block).toString('hex')}\n`, encoding: 'utf8', maxBuffer: 1 << 20 });
    assert.equal(out.status, 0);
    block.set(Buffer.from(out.stdout.trim(), 'hex'));
  };
  shim.setRomix(romix);
  try {
    const rfc = 'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640';
    assert.equal(Buffer.from(shim.scryptSync('password', 'NaCl', 64, { N: 1024, r: 8, p: 16 })).toString('hex'), rfc);
    for (const code of ['acid-aged-also-area-army', 'tail-tank-team-tent-tide']) {
      const t0 = Date.now();
      const got = shim.scryptSync(code, 'agent-office/link/pair/v1', 64, { N: 1 << 15, r: 8, p: 1 });
      const t1 = Date.now();
      assert.deepEqual(Buffer.from(got), crypto.scryptSync(code, 'agent-office/link/pair/v1', 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
      t.diagnostic?.(`${code}: shim with native ROMix (CLI, incl. process start) ${t1 - t0} ms`);
    }
  } finally { shim.setRomix(null); }
});

test('scryptSync rejects bad parameters like Node (stricter for zero r or p), before taking memory', { skip }, () => {
  const bad = [
    [64, { N: 1000, r: 8, p: 1 }], [64, { N: 1, r: 8, p: 1 }], [64, { N: 1024, r: 0, p: 1 }], [64, { N: 1024, r: 1.5, p: 1 }],
    [64, { N: 1024, r: 8, p: 0 }], [64, { N: 1024, r: 8, p: -1 }], [-1, { N: 1024, r: 8, p: 1 }], [1.5, { N: 1024, r: 8, p: 1 }],
    ['64', { N: 1024, r: 8, p: 1 }], [64, { N: 1024, r: 8, p: 1, maxmem: -1 }], [64, { N: 1 << 15, r: 8, p: 1, maxmem: 1 << 20 }],
    [64, { N: 1 << 20, r: 8, p: 1, maxmem: 2 ** 40 }],   // within maxmem, but above the native ROMix cap (N * r <= 2^22)
  ];
  for (const [keylen, opts] of bad) {
    assert.throws(() => shim.scryptSync('pw', 'salt', keylen, opts), RangeError, JSON.stringify([keylen, opts]));
  }
  assert.equal(shim.scryptSync('pw', 'salt', 0, { N: 16, r: 1, p: 1 }).length, 0);
});

test('native ROMix (scrypt-ll) refuses bad N, r and N * r above the cap without allocating', { skip }, (t) => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = path.join(CORE, 'addons', 'scrypt-ll');
  const exe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'romix-')), 'romix-cli');
  try { execFileSync('cc', ['-O2', '-o', exe, path.join(dir, 'romix-cli.c'), path.join(dir, 'romix.c')], { stdio: 'ignore' }); } catch { t.skip('no C compiler'); return; }
  const run = (r, N) => spawnSync(exe, { input: `${r} ${N} ${'00'.repeat(128 * r)}\n`, encoding: 'utf8' }).status;
  assert.equal(run(1, 16), 0);
  assert.equal(run(1, 1000), 3);          // not a power of two
  assert.equal(run(1, 1), 3);             // N < 2
  assert.equal(run(8, 1 << 20), 3);       // N * r = 2^23 > 2^22
  assert.equal(run(64, 1 << 17), 3);      // N * r = 2^23
});
