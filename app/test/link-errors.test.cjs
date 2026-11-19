'use strict';
// v3.105 a failing device link says why: one distinct state per cause (set where it fails), logged with e.code and
// e.message to link/commands.log, keys.bin never rewritten on any of them; writePlain retries a transient rename.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../src/sealed.js');
const { Link } = require('../src/link.js');

const good = {
  isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain',
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => { const t = String(b); if (!t.startsWith('enc:')) throw new Error('not encrypted'); return Buffer.from(t.slice(4), 'base64').toString(); },
};
const coded = (code, message) => Object.assign(new Error(message), { code });

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-linkerr-'));
  const realSwarm = Link.prototype.ensureSwarm;
  Link.prototype.ensureSwarm = function () { return null; };   // no network
  const realError = console.error;
  console.error = () => {};
  t.after(() => { Link.prototype.ensureSwarm = realSwarm; console.error = realError; fs.rmSync(dir, { recursive: true, force: true }); });
  const f = (n) => path.join(dir, 'link', n);
  const hosts = [];
  const boot = (safe = good, appOver = {}) => {
    const { setupLink } = require('../src/link-host.js');
    const handlers = {};
    const host = setupLink({
      app: { getPath: () => dir, getVersion: () => '0.24.0', ...appOver }, safeStorage: safe,
      ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, send: () => {}, notify: () => {}, T: (k) => k,
      loginOf: () => 'in', reportsDir: path.join(dir, 'r'), projects: () => [], tabState: () => 'gone', type: () => {},
    });
    hosts.push(host);
    host.devices();   // starts the link
    return { host, handlers, view: handlers['link:get']() };
  };
  t.after(async () => { for (const h of hosts) await h.destroy(); });
  const log = () => (fs.existsSync(f('commands.log')) ? fs.readFileSync(f('commands.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.event === 'link-start-failed') : []);
  /** A healthy first start, then stopped: keys.bin, own.bin and both markers exist. */
  const healthy = async () => { const w = boot(); assert.ok(!w.view.error); await w.host.destroy(); };
  const keysHex = () => JSON.parse(good.decryptString(fs.readFileSync(f('keys.bin'))).split('\n').slice(1).join('\n')).secretKey;
  return { dir, f, boot, log, healthy, keysHex };
}

/** One failed start: the view says `state` (+ `code`), commands.log has exactly one line, no key material in it. */
function expectFailure(w, r, state, code, secret) {
  assert.equal(r.view.error, state);
  assert.equal(r.view.errorCode, code);
  const lines = w.log();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].state, state);
  assert.equal(lines[0].code, code);
  assert.equal(typeof lines[0].message, 'string');
  if (secret) assert.ok(!JSON.stringify(lines).includes(secret));
}
const same = (a, b) => assert.ok(Buffer.compare(a, b) === 0, 'file bytes changed');

test('keys-decrypt: decryptString throws, or returns something that is not text; keys.bin stays as it was', async (t) => {
  const w = world(t);
  await w.healthy();
  const secret = w.keysHex();
  const before = fs.readFileSync(w.f('keys.bin')); const ownBefore = fs.readFileSync(w.f('own.bin'));
  const r = w.boot({ ...good, decryptString: () => { throw coded('ERR_DECRYPT', 'Error while decrypting the ciphertext'); } });
  expectFailure(w, r, 'keys-decrypt', 'ERR_DECRYPT', secret);
  same(fs.readFileSync(w.f('keys.bin')), before); same(fs.readFileSync(w.f('own.bin')), ownBefore);
  fs.rmSync(w.f('commands.log'));
  const g = w.boot({ ...good, decryptString: () => undefined });
  assert.equal(g.view.error, 'keys-decrypt');
  assert.equal(w.log().length, 1);
  same(fs.readFileSync(w.f('keys.bin')), before);
});

test('keys-format: another purpose header, a headered payload that is not JSON, or one failing the shape check', async (t) => {
  const w = world(t);
  await w.healthy();
  const secret = w.keysHex();
  const cases = [S.wrap(S.PURPOSE.MAIL_SECRET, '{}'), S.wrap(S.PURPOSE.LINK_KEYS, '{not json'), S.wrap(S.PURPOSE.LINK_KEYS, JSON.stringify({ publicKey: 'zz', secretKey: 'zz', secrets: {} }))];
  for (const text of cases) {
    fs.writeFileSync(w.f('keys.bin'), good.encryptString(text));
    const before = fs.readFileSync(w.f('keys.bin'));
    fs.rmSync(w.f('commands.log'), { force: true });
    const r = w.boot();
    expectFailure(w, r, 'keys-format', null, secret);
    same(fs.readFileSync(w.f('keys.bin')), before);
    assert.equal(fs.existsSync(w.f('keys.bin.tmp')), false);
  }
});

test('keys-file: keys.bin is not a regular file (a folder here, a symbolic link on POSIX); nothing is replaced', async (t) => {
  const w = world(t);
  await w.healthy();
  fs.rmSync(w.f('keys.bin'));
  fs.mkdirSync(w.f('keys.bin'));
  let r = w.boot();
  expectFailure(w, r, 'keys-file', 'ELOOP');
  assert.ok(fs.lstatSync(w.f('keys.bin')).isDirectory());
  if (process.platform !== 'win32') {
    fs.rmSync(w.f('keys.bin'), { recursive: true }); fs.rmSync(w.f('commands.log'));
    fs.symlinkSync(path.join(w.dir, 'elsewhere'), w.f('keys.bin'));
    r = w.boot();
    expectFailure(w, r, 'keys-file', 'ELOOP');
    assert.ok(fs.lstatSync(w.f('keys.bin')).isSymbolicLink());
  }
});

test('keys-save: a failing write at start (rename EPERM after the retries, or an encrypt error) is keys-save; keys.bin is not touched', async (t) => {
  const w = world(t);
  await w.healthy();
  // a headerless copy of the file (an older version's) makes the start write it again with the header
  const plain = JSON.parse(good.decryptString(fs.readFileSync(w.f('keys.bin'))).split('\n').slice(1).join('\n'));
  delete plain.own; delete plain.ownV;
  fs.writeFileSync(w.f('keys.bin'), good.encryptString(JSON.stringify(plain)));
  for (const n of ['own.bin', 'own.bin.ao1', 'keys.bin.ao1']) fs.rmSync(w.f(n), { force: true });
  const before = fs.readFileSync(w.f('keys.bin'));

  const realRename = fs.renameSync; let calls = 0;
  fs.renameSync = (a, b) => { if (String(a).endsWith('.tmp')) { calls++; throw coded('EPERM', 'operation not permitted'); } return realRename(a, b); };
  let r;
  try { r = w.boot(); } finally { fs.renameSync = realRename; }
  assert.equal(calls, 4);   // the first try and three retries
  expectFailure(w, r, 'keys-save', 'EPERM');
  same(fs.readFileSync(w.f('keys.bin')), before);
  assert.deepEqual(fs.readdirSync(w.f('.')).filter((n) => n.endsWith('.tmp')), []);

  fs.rmSync(w.f('commands.log'));
  const r2 = w.boot({ ...good, encryptString: () => { throw coded('ERR_ENCRYPT', 'cannot encrypt'); } });
  expectFailure(w, r2, 'keys-save', 'ERR_ENCRYPT');
  same(fs.readFileSync(w.f('keys.bin')), before);
});

test('start: any other throw is start; keys.bin is not touched', async (t) => {
  const w = world(t);
  await w.healthy();
  const before = fs.readFileSync(w.f('keys.bin'));
  const r = w.boot(good, { getVersion: () => { throw coded('EWHAT', 'boom'); } });
  expectFailure(w, r, 'start', 'EWHAT');
  same(fs.readFileSync(w.f('keys.bin')), before);
});

test('no-keychain stays as it was and writes no line', async (t) => {
  const w = world(t);
  const r = w.boot({ ...good, isEncryptionAvailable: () => false });
  assert.equal(r.view.error, 'no-keychain');
  assert.equal(w.log().length, 0);
});

test('locales: every state has a one-sentence text in en and tr, and the Details label', () => {
  for (const lang of ['en', 'tr']) {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', `${lang}.json`), 'utf8'));
    for (const k of ['keys-decrypt', 'keys-format', 'keys-file', 'keys-save', 'start', 'no-keychain']) assert.ok(typeof j.devices.error[k] === 'string' && j.devices.error[k].length > 20, `${lang} ${k}`);
    assert.match(j.devices.errorDetails, /\{code\}/);
  }
});

test('writePlain: a transient rename error is retried (100/300/700 ms), then succeeds; other errors are not retried', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-wp-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'x.bin');
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const waits = []; let n = 0;
    S.writePlain(file, `v-${code}`, { ...fs, sleepMs: (ms) => waits.push(ms), renameSync: (a, b) => { if (n++ < 2) throw coded(code, 'busy'); return fs.renameSync(a, b); } });
    assert.equal(fs.readFileSync(file, 'utf8'), `v-${code}`);
    assert.deepEqual(waits, [100, 300]);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  }
  let calls = 0;
  assert.throws(() => S.writePlain(file, 'zz', { ...fs, sleepMs: () => assert.fail('no wait'), renameSync: () => { calls++; throw coded('ENOENT', 'gone'); } }), { code: 'ENOENT' });
  assert.equal(calls, 1);
});

test('writePlain: after 3 retries the error is thrown, the target is unchanged and the temp file is removed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-wp-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'x.bin');
  fs.writeFileSync(file, 'old');
  const waits = []; let calls = 0;
  assert.throws(() => S.writePlain(file, 'new', { ...fs, sleepMs: (ms) => waits.push(ms), renameSync: () => { calls++; throw coded('EBUSY', 'locked'); } }), { code: 'EBUSY' });
  assert.equal(calls, 4);
  assert.deepEqual(waits, [100, 300, 700]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

// --- v3.106 resetting a link whose keys cannot be read ---

const broken = { ...good, decryptString: () => { throw coded('ERR_DECRYPT', 'Error while decrypting the ciphertext'); } };
const asideDirs = (w) => fs.readdirSync(w.f('.')).filter((n) => n.startsWith('unreadable-'));
const resetLines = (w) => fs.readFileSync(w.f('commands.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.event === 'link-reset');

test('reset: in keys-decrypt the files are moved aside unchanged, the name is kept and the next start makes new keys', async (t) => {
  const w = world(t);
  await w.healthy();
  const devs = JSON.parse(fs.readFileSync(w.f('devices.json'), 'utf8'));
  devs.name = 'Desk PC';
  fs.writeFileSync(w.f('devices.json'), JSON.stringify(devs));
  const oldSecret = w.keysHex();
  const names = ['keys.bin', 'keys.bin.ao1', 'own.bin', 'own.bin.ao1', 'devices.json'];
  const before = Object.fromEntries(names.map((n) => [n, fs.readFileSync(w.f(n))]));
  const r = w.boot(broken);
  assert.equal(r.view.error, 'keys-decrypt');
  assert.equal(r.view.canReset, true);
  const res = await r.handlers['link:reset']();
  assert.equal(res.ok, true);
  assert.equal(res.view.error, null);
  assert.equal(res.view.name, 'Desk PC');
  const aside = asideDirs(w);
  assert.deepEqual(aside, [res.folder]);
  for (const n of names) same(fs.readFileSync(path.join(w.f(aside[0]), n)), before[n]);
  assert.notEqual(w.keysHex(), oldSecret);   // a fresh key pair, sealed again with its header and marker
  assert.ok(fs.existsSync(w.f('keys.bin.ao1')) && fs.existsSync(w.f('own.bin')));
  const lines = resetLines(w);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].state, 'keys-decrypt');
  assert.deepEqual([...lines[0].moved].sort(), [...names].sort());
  assert.ok(!JSON.stringify(lines).includes(oldSecret));
  // a later start with a working keychain reads the new keys
  await r.host.destroy();
  const again = w.boot();
  assert.equal(again.view.error, null);
});

test('reset: refused while the link runs, and in states it does not repair; nothing moves', async (t) => {
  const w = world(t);
  const r = w.boot();
  assert.equal(r.view.error, null);
  assert.notEqual(r.view.canReset, true);
  const keys = fs.readFileSync(w.f('keys.bin'));
  const res = await r.handlers['link:reset']();
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-needed');
  same(fs.readFileSync(w.f('keys.bin')), keys);
  assert.deepEqual(asideDirs(w), []);
  await r.host.destroy();
  const nk = w.boot({ ...good, isEncryptionAvailable: () => false });
  assert.equal(nk.view.canReset, false);
  assert.equal((await nk.handlers['link:reset']()).reason, 'not-needed');
  assert.deepEqual(asideDirs(w), []);
});

test('reset: keys-file with keys.bin a folder moves it aside; a symbolic link is moved as the link, its target untouched', async (t) => {
  const w = world(t);
  await w.healthy();
  fs.rmSync(w.f('keys.bin'));
  fs.mkdirSync(w.f('keys.bin'));
  let r = w.boot();
  assert.equal(r.view.error, 'keys-file');
  let res = await r.handlers['link:reset']();
  assert.equal(res.ok, true);
  assert.ok(fs.lstatSync(path.join(w.f(res.folder), 'keys.bin')).isDirectory());
  assert.ok(fs.lstatSync(w.f('keys.bin')).isFile());
  if (process.platform !== 'win32') {
    await r.host.destroy();
    const target = path.join(w.dir, 'elsewhere.bin');
    fs.writeFileSync(target, 'outside');
    fs.rmSync(w.f('keys.bin'));
    fs.symlinkSync(target, w.f('keys.bin'));
    r = w.boot();
    assert.equal(r.view.error, 'keys-file');
    res = await r.handlers['link:reset']();
    assert.equal(res.ok, true);
    assert.ok(fs.lstatSync(path.join(w.f(res.folder), 'keys.bin')).isSymbolicLink());
    assert.equal(fs.readFileSync(target, 'utf8'), 'outside');
  }
});

test('pairing in an unreadable-keys state resets first and continues (Pair with a code and Add device)', async (t) => {
  const w = world(t);
  await w.healthy();
  let r = w.boot(broken);
  assert.equal(r.view.error, 'keys-decrypt');
  const j = await r.handlers['link:join']({}, 'not a code');
  assert.equal(j.resetDone, true);
  assert.equal(j.ok, false);
  assert.equal(j.error, 'bad-code');   // the pairing itself ran: the link is up
  assert.equal(j.view.error, null);
  assert.equal(asideDirs(w).length, 1);
  await r.host.destroy();

  // Add device: the same, with the pairing stubbed (no network)
  fs.writeFileSync(w.f('keys.bin'), good.encryptString(S.wrap(S.PURPOSE.MAIL_SECRET, '{}')));
  const realInvite = Link.prototype.invite;
  Link.prototype.invite = async function () { return { code: 'x', expiresAt: 0 }; };
  t.after(() => { Link.prototype.invite = realInvite; });
  r = w.boot();
  assert.equal(r.view.error, 'keys-format');
  const v = await r.handlers['link:invite']();
  assert.equal(v.resetDone, true);
  assert.equal(v.error, null);
  assert.equal(asideDirs(w).length, 2);
  // a healthy link pairs without a reset
  const v2 = await r.handlers['link:invite']();
  assert.equal(v2.resetDone, undefined);
  assert.equal(asideDirs(w).length, 2);
});

test('locales: the reset texts exist in en and tr', () => {
  for (const lang of ['en', 'tr']) {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', `${lang}.json`), 'utf8'));
    for (const k of ['reset', 'resetConfirm', 'resetDone']) assert.ok(typeof j.devices[k] === 'string' && j.devices[k].length > 5, `${lang} ${k}`);
    assert.match(j.devices.resetFailed, /\{reason\}/);
  }
});
