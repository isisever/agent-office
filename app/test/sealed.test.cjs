'use strict';
// v3.102 purpose binding of every safeStorage file (src/sealed.js): a file sealed for one use is refused by every
// other reader, headerless files of before migrate once by shape, and the link start table keeps its rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../src/sealed.js');
const MS = require('../src/mcp-servers.js');
const C = require('../src/link-core.js');
const { Link } = require('../src/link.js');

// one fake keychain for every store, as in the app: what one use encrypts, any other use can decrypt
const safe = {
  isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain',
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => { const t = String(b); if (!t.startsWith('enc:')) throw new Error('not encrypted'); return Buffer.from(t.slice(4), 'base64').toString(); },
};
const sealer = S.sealer(safe);
const plain = (file) => safe.decryptString(fs.readFileSync(file));
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sealed-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const PA = 'a1'.repeat(32), PB = 'b2'.repeat(32);
const KEYS = { publicKey: '11'.repeat(32), secretKey: '22'.repeat(64), secrets: { [PA]: 'cd'.repeat(32) }, own: [PA], ownV: C.OWN_VERSION };
const RECORD = { v: C.OWN_VERSION, own: [PA], paused: [] };
const SERVER = { id: 'm-1', name: 'notion', type: 'http', url: 'https://n.example', scope: 'all' };
const mcpStore = (ud) => MS.tokenStore(path.join(ud, 'mcp-tokens'), safe, S.PURPOSE.MCP_TOKEN);
const oldStore = (ud) => MS.tokenStore(path.join(ud, 'connector-tokens'), safe, S.PURPOSE.CONNECTOR_TOKEN);
const mailStore = (ud) => MS.tokenStore(path.join(ud, 'mail-secrets'), safe, S.PURPOSE.MAIL_SECRET);

function linkWorld(t, dir) {
  const realSwarm = Link.prototype.ensureSwarm;
  Link.prototype.ensureSwarm = function () { return null; };   // no network
  const realError = console.error;
  console.error = () => {};
  t.after(() => { Link.prototype.ensureSwarm = realSwarm; console.error = realError; });
  const { setupLink } = require('../src/link-host.js');
  const f = (name) => path.join(dir, 'link', name);
  const boot = () => {
    const w = { notices: [], handlers: {} };
    w.host = setupLink({
      app: { getPath: () => dir, getVersion: () => '0.24.0' }, safeStorage: safe,
      ipcMain: { handle: (ch, fn) => { w.handlers[ch] = fn; } }, send: () => {}, notify: (title) => { w.notices.push(title); }, T: (k, v) => (v ? `${k}${JSON.stringify(v)}` : k),
      loginOf: () => 'in', reportsDir: path.join(dir, 'r'), projects: () => [], tabState: () => 'gone', type: () => {},
    });
    w.host.devices();
    w.link = w.host.link();
    w.own = () => [PA, PB].map((p) => C.isOwn(w.link.devices, w.link.secrets, p));
    return w;
  };
  const events = (name) => (fs.existsSync(f('commands.log')) ? fs.readFileSync(f('commands.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.event === name) : []);
  const keys = () => JSON.parse(sealer.open(S.PURPOSE.LINK_KEYS, fs.readFileSync(f('keys.bin'))));
  const rec = () => JSON.parse(sealer.open(S.PURPOSE.LINK_OWN, fs.readFileSync(f('own.bin'))));
  /** Two paired devices, both own, through the v3.101 migration of an older version's files (no header, no marker). */
  const pairTwo = async () => {
    let w = boot();
    await w.host.destroy();
    const base = keys();
    delete base.own; delete base.ownV;
    fs.writeFileSync(f('keys.bin'), safe.encryptString(JSON.stringify({ ...base, secrets: { [PA]: 'cd'.repeat(32), [PB]: 'ef'.repeat(32) } })));
    fs.writeFileSync(f('devices.json'), JSON.stringify({ name: 'Me', devices: [{ pub: PA, name: 'Studio', addedAt: 1 }, { pub: PB, name: 'Mini', addedAt: 1 }] }));
    for (const n of ['own.bin', 'own.bin.ao1', 'keys.bin.ao1']) fs.rmSync(f(n), { force: true });
    w = boot();
    assert.deepEqual(w.own(), [true, true]);
    return w;
  };
  const snap = () => Object.fromEntries(['keys.bin', 'own.bin', 'devices.json'].map((n) => [n, fs.readFileSync(f(n))]));
  const put = (files) => { for (const [n, b] of Object.entries(files)) fs.writeFileSync(f(n), b); };
  return { f, boot, events, keys, rec, pairTwo, snap, put };
}

test('sealed: the header names the purpose; another purpose or no header is refused; a headerless text counts only by shape', () => {
  assert.equal(S.wrap('mcp-token', 'abc'), 'ao1:mcp-token\nabc');
  assert.deepEqual(S.unwrap('mcp-token', 'ao1:mcp-token\nabc'), { state: 'ok', payload: 'abc' });
  assert.deepEqual(S.unwrap('mcp-token', 'ao1:mail-secret\nabc'), { state: 'purpose' });
  assert.deepEqual(S.unwrap('mcp-token', 'abc'), { state: 'legacy', payload: 'abc' });
  assert.deepEqual(S.unwrap('mcp-token', 'ao1:mcp-tokenabc'), { state: 'legacy', payload: 'ao1:mcp-tokenabc' });
  assert.deepEqual(S.unwrap('mcp-token', 'ao1:mcp-token-2\nabc'), { state: 'purpose' });   // a longer name is another purpose
  for (const bad of ['', 'Mcp', 'a b', 'a\nb', 'x'.repeat(41), undefined]) assert.throws(() => S.header(bad));
  assert.equal(new Set(Object.values(S.PURPOSE)).size, Object.keys(S.PURPOSE).length);   // one purpose per kind
  const bytes = sealer.seal('link-keys', JSON.stringify(KEYS));
  assert.equal(sealer.open('link-keys', bytes), JSON.stringify(KEYS));
  for (const p of ['link-own', 'mcp-token', 'connector-token', 'mail-secret']) assert.equal(sealer.open(p, bytes), null);
  assert.equal(sealer.open('link-keys', safe.encryptString(JSON.stringify(KEYS))), null);   // no header
  assert.throws(() => sealer.open('link-keys', Buffer.from('garbage')));   // does not decrypt: says nothing about the file
  assert.deepEqual(sealer.openLegacy('link-keys', safe.encryptString(JSON.stringify(KEYS)), S.linkKeysText), { payload: JSON.stringify(KEYS), legacy: true });
  assert.equal(sealer.openLegacy('link-keys', safe.encryptString(JSON.stringify(RECORD)), S.linkKeysText), null);
  assert.equal(sealer.openLegacy('link-own', safe.encryptString(JSON.stringify(KEYS)), S.ownRecordText), null);
  assert.equal(sealer.openLegacy('link-own', sealer.seal('mcp-token', JSON.stringify(RECORD)), S.ownRecordText), null);   // a header never takes the legacy path
  assert.equal(S.linkKeysText('tok-123'), false);
  assert.equal(S.ownRecordText('{"v":1,"own":"all","paused":[]}'), false);
  assert.equal(S.isLinkKeys({ ...KEYS, secretKey: 'zz' }), false);
});

test('sealed: a token is one line without control characters, of a sane length, and never a JSON structure', () => {
  for (const ok of ['tok-123', 'a b c', 'p@ss w\u00f6rd {x}', '123456', 'true', '"quoted"', '{not json', 'x'.repeat(S.TOKEN_MAX)]) assert.equal(S.tokenProblem(ok), null, ok.slice(0, 20));
  assert.equal(S.tokenProblem('a\nb'), 'control');
  assert.equal(S.tokenProblem('a\rb'), 'control');
  assert.equal(S.tokenProblem('a\u0000b'), 'control');
  assert.equal(S.tokenProblem('a\u2028b'), 'control');
  assert.equal(S.tokenProblem('x'.repeat(S.TOKEN_MAX + 1)), 'length');
  assert.equal(S.tokenProblem(JSON.stringify(KEYS)), 'structured');
  assert.equal(S.tokenProblem(JSON.stringify(RECORD)), 'structured');
  assert.equal(S.tokenProblem(' [1]'), 'structured');
  assert.equal(S.tokenProblem(null), 'type');
});

test('token store: a link keys file copied into it is refused and never reaches serverConfig', (t) => {
  const ud = tmp(t);
  const store = mcpStore(ud);
  assert.equal(store.save('other', 'tok-other'), true);   // the store is in use (its migration is done)
  const target = path.join(ud, 'mcp-tokens', 'm-1.bin');
  const configs = () => JSON.stringify(MS.appConfigs([SERVER], 'p1', (id) => mcpStore(ud).load(id)));
  // the sealed keys file of v3.102, the sealed own record, and a keys file of before (no header)
  for (const bytes of [sealer.seal(S.PURPOSE.LINK_KEYS, JSON.stringify(KEYS)), sealer.seal(S.PURPOSE.LINK_OWN, JSON.stringify(RECORD)), safe.encryptString(JSON.stringify(KEYS))]) {
    fs.writeFileSync(target, bytes);
    assert.deepEqual(mcpStore(ud).read('m-1'), { token: '', failed: true });
    assert.equal(mcpStore(ud).load('m-1'), '');
    assert.deepEqual(JSON.parse(configs()), { notion: { type: 'http', url: 'https://n.example' } });   // no Authorization header at all
    assert.ok(!configs().includes(KEYS.secretKey) && !configs().includes('cd'.repeat(32)));
    assert.deepEqual(fs.readFileSync(target), bytes);   // kept as it is, never rewritten with this store's header
  }
  // the same headerless keys file in a store that was never migrated: its shape is not a token's
  const ud2 = tmp(t);
  fs.mkdirSync(path.join(ud2, 'mcp-tokens'));
  fs.writeFileSync(path.join(ud2, 'mcp-tokens', 'm-1.bin'), safe.encryptString(JSON.stringify(KEYS)));
  assert.deepEqual(mcpStore(ud2).read('m-1'), { token: '', failed: true });
  assert.equal(plain(path.join(ud2, 'mcp-tokens', 'm-1.bin')), JSON.stringify(KEYS));
  assert.deepEqual(MS.appConfigs([SERVER], 'p1', (id) => mcpStore(ud2).load(id)), { notion: { type: 'http', url: 'https://n.example' } });
  // a real token still arrives as the bearer header
  assert.equal(mcpStore(ud).save('m-1', 'tok-real'), true);
  assert.equal(MS.appConfigs([SERVER], 'p1', (id) => mcpStore(ud).load(id)).notion.headers.Authorization, 'Bearer tok-real');
  assert.deepEqual(MS.serverConfig(SERVER, mcpStore(ud).load('m-1')).headers, { Authorization: 'Bearer tok-real' });
});

test('token store: headerless files migrate once and are refused afterwards; another store\'s file is refused', (t) => {
  const ud = tmp(t), dir = path.join(ud, 'mcp-tokens');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.bin'), safe.encryptString('tok-a'));
  fs.writeFileSync(path.join(dir, 'b.bin'), safe.encryptString('tok-b'));
  fs.writeFileSync(path.join(dir, 'j.bin'), safe.encryptString(JSON.stringify(RECORD)));   // not the shape of a token
  assert.deepEqual(mcpStore(ud).read('a'), { token: 'tok-a', failed: false });
  assert.equal(plain(path.join(dir, 'a.bin')), 'ao1:mcp-token\ntok-a');
  assert.equal(plain(path.join(dir, 'b.bin')), 'ao1:mcp-token\ntok-b');   // the whole store at once
  assert.equal(plain(path.join(dir, 'j.bin')), JSON.stringify(RECORD));
  assert.ok(fs.existsSync(path.join(dir, '.ao1')));
  assert.deepEqual(mcpStore(ud).ids().sort(), ['a', 'b', 'j']);   // the marker is not an id
  assert.deepEqual(mcpStore(ud).read('b'), { token: 'tok-b', failed: false });
  assert.deepEqual(mcpStore(ud).read('j'), { token: '', failed: true });
  // after the migration a headerless file is refused, also one that looks like a token
  fs.writeFileSync(path.join(dir, 'c.bin'), safe.encryptString('tok-c'));
  assert.deepEqual(mcpStore(ud).read('c'), { token: '', failed: true });
  assert.equal(plain(path.join(dir, 'c.bin')), 'tok-c');
  // a mail secret moved into the MCP store (and back the other way): each store takes only its own
  assert.equal(mailStore(ud).save('acc', 'mail-password'), true);
  fs.copyFileSync(path.join(ud, 'mail-secrets', 'acc.bin'), path.join(dir, 'm.bin'));
  assert.deepEqual(mcpStore(ud).read('m'), { token: '', failed: true });
  fs.copyFileSync(path.join(dir, 'a.bin'), path.join(ud, 'mail-secrets', 'x.bin'));
  assert.deepEqual(mailStore(ud).read('x'), { token: '', failed: true });
  assert.deepEqual(mailStore(ud).read('acc'), { token: 'mail-password', failed: false });
  fs.copyFileSync(path.join(dir, 'a.bin'), path.join(ud, 'connector-tokens-a.bin'));
  fs.mkdirSync(path.join(ud, 'connector-tokens'));
  fs.copyFileSync(path.join(dir, 'a.bin'), path.join(ud, 'connector-tokens', 'a.bin'));
  assert.deepEqual(oldStore(ud).read('a'), { token: '', failed: true });
  // a locked keychain: nothing is migrated and no marker is written, so the next start retries
  const ud3 = tmp(t), dir3 = path.join(ud3, 'mcp-tokens');
  fs.mkdirSync(dir3);
  fs.writeFileSync(path.join(dir3, 'a.bin'), safe.encryptString('tok-a'));
  const locked = MS.tokenStore(dir3, { ...safe, decryptString: () => { throw new Error('locked'); } }, S.PURPOSE.MCP_TOKEN);
  assert.deepEqual(locked.read('a'), { token: '', failed: true });
  assert.equal(fs.existsSync(path.join(dir3, '.ao1')), false);
  assert.deepEqual(mcpStore(ud3).read('a'), { token: 'tok-a', failed: false });
  assert.throws(() => MS.tokenStore(dir3, safe));   // no store without a purpose
});

test('token store: what is not a token is neither saved nor handed out; a plain-text JSON never becomes a sealed file', (t) => {
  const ud = tmp(t);
  const store = mcpStore(ud);
  for (const bad of ['a\nb', 'tok\u0000', 'x'.repeat(S.TOKEN_MAX + 1), JSON.stringify(RECORD), JSON.stringify(KEYS)]) assert.equal(store.save('m-1', bad), false);
  assert.equal(store.has('m-1'), false);
  // a sealed file of this very purpose with a JSON payload (written by something else): still no bearer token
  fs.mkdirSync(path.join(ud, 'mcp-tokens'), { recursive: true });
  fs.writeFileSync(path.join(ud, 'mcp-tokens', 'm-1.bin'), sealer.seal(S.PURPOSE.MCP_TOKEN, JSON.stringify(KEYS)));
  assert.deepEqual(mcpStore(ud).read('m-1'), { token: '', failed: true });
  // the v3.43 store read as plain text at start: a JSON blob there is not moved, so it is never sealed
  const servers = [{ id: 'c-p1', name: 'notion', type: 'http', url: 'https://n.example', scope: 'p1' }, { id: 'c-p2', name: 'x', type: 'http', url: 'https://x.example', scope: 'p2' }];
  fs.mkdirSync(path.join(ud, 'connector-tokens'));
  fs.writeFileSync(path.join(ud, 'connector-tokens', 'p1.txt'), JSON.stringify(RECORD));
  fs.writeFileSync(path.join(ud, 'connector-tokens', 'p2.txt'), 'tok-two\n{"v":1}');
  assert.deepEqual(oldStore(ud).read('p1'), { token: '', failed: true });
  assert.deepEqual(MS.settleTokens(servers, oldStore(ud), mcpStore(ud), { sweep: false }), { moved: 0, failed: 2, dropped: 0, removed: 0 });
  assert.equal(fs.existsSync(path.join(ud, 'mcp-tokens', 'c-p1.bin')), false);
  assert.equal(fs.existsSync(path.join(ud, 'mcp-tokens', 'c-p2.bin')), false);
  // a real one moves, and what it becomes carries the token header
  fs.writeFileSync(path.join(ud, 'connector-tokens', 'p1.txt'), 'tok-one');
  assert.equal(MS.settleTokens(servers, oldStore(ud), mcpStore(ud), { sweep: false }).moved, 1);
  assert.equal(plain(path.join(ud, 'mcp-tokens', 'c-p1.bin')), 'ao1:mcp-token\ntok-one');
});

test('token store: never through a symbolic link, and a store folder that is a link to the link folder does nothing', { skip: process.platform === 'win32' }, (t) => {
  const ud = tmp(t), linkDir = path.join(ud, 'link');
  fs.mkdirSync(linkDir);
  const keysBytes = sealer.seal(S.PURPOSE.LINK_KEYS, JSON.stringify(KEYS));
  fs.writeFileSync(path.join(linkDir, 'keys.bin'), keysBytes);
  fs.writeFileSync(path.join(linkDir, 'own.bin'), sealer.seal(S.PURPOSE.LINK_OWN, JSON.stringify(RECORD)));
  // the whole store folder points at the link folder: the start sweep would otherwise delete keys.bin and own.bin
  fs.symlinkSync(linkDir, path.join(ud, 'mcp-tokens'));
  const store = mcpStore(ud);
  assert.deepEqual([store.ids(), store.has('keys'), store.read('keys'), store.save('keys', 'tok')], [[], false, { token: '', failed: true }, false]);
  store.remove('keys');
  assert.equal(MS.settleTokens([], oldStore(ud), store, { sweep: true }).removed, 0);
  assert.deepEqual(fs.readdirSync(linkDir).sort(), ['keys.bin', 'own.bin']);
  assert.deepEqual(fs.readFileSync(path.join(linkDir, 'keys.bin')), keysBytes);
  // one file of a real store is a link to the keys file: not read, and a save replaces the link, not its target
  fs.rmSync(path.join(ud, 'mcp-tokens'));
  fs.mkdirSync(path.join(ud, 'mcp-tokens'));
  fs.symlinkSync(path.join(linkDir, 'keys.bin'), path.join(ud, 'mcp-tokens', 'm-1.bin'));
  assert.deepEqual(mcpStore(ud).read('m-1'), { token: '', failed: true });
  assert.equal(mcpStore(ud).save('m-1', 'tok-real'), true);
  assert.equal(fs.lstatSync(path.join(ud, 'mcp-tokens', 'm-1.bin')).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(path.join(linkDir, 'keys.bin')), keysBytes);
  assert.deepEqual(mcpStore(ud).read('m-1'), { token: 'tok-real', failed: false });
  // ids are one safe segment under the store's own folder
  assert.equal(mcpStore(ud).save('../link/keys', 'tok-x'), true);
  assert.ok(fs.existsSync(path.join(ud, 'mcp-tokens', '___link_keys.bin')));
  assert.deepEqual(fs.readFileSync(path.join(linkDir, 'keys.bin')), keysBytes);
});

test('link: a token-sealed file copied to own.bin pauses every device, copied to keys.bin fails the link closed', async (t) => {
  const dir = tmp(t);
  const L = linkWorld(t, dir);
  let w = await L.pairTwo();
  await w.host.destroy();
  const good = L.snap();
  // the write path of the finding: a text of the attacker's choosing, sealed by the token store, moved over the link files
  assert.equal(mcpStore(dir).save('evil', JSON.stringify({ v: C.OWN_VERSION, own: [PA, PB], paused: [] })), false);   // not even sealed
  assert.equal(mcpStore(dir).save('evil', 'tok-evil'), true);
  const tokenFile = path.join(dir, 'mcp-tokens', 'evil.bin');
  for (const bytes of [fs.readFileSync(tokenFile), sealer.seal(S.PURPOSE.MCP_TOKEN, JSON.stringify({ v: C.OWN_VERSION, own: [PA, PB], paused: [] })), sealer.seal(S.PURPOSE.LINK_KEYS, JSON.stringify(L.keys()))]) {
    L.put(good);
    fs.writeFileSync(L.f('own.bin'), bytes);
    const before = L.events('own-record-unreadable').length;
    w = L.boot();
    assert.deepEqual([w.own(), L.events('own-record-unreadable').length - before, L.events('own-migration').length], [[false, false], 1, 1]);
    assert.deepEqual(L.rec(), { v: C.OWN_VERSION, own: [], paused: [PA, PB] });   // sealed again, with its own header
    await w.host.destroy();
  }
  for (const bytes of [fs.readFileSync(tokenFile), sealer.seal(S.PURPOSE.MCP_TOKEN, JSON.stringify(L.keys())), sealer.seal(S.PURPOSE.LINK_OWN, JSON.stringify(L.keys()))]) {
    L.put(good);
    fs.writeFileSync(L.f('keys.bin'), bytes);
    w = L.boot();
    assert.equal(w.link, null);
    assert.deepEqual(fs.readFileSync(L.f('keys.bin')), bytes);   // nothing is written over it
    assert.deepEqual(fs.readFileSync(L.f('own.bin')), good['own.bin']);
    await w.host.destroy();
  }
  L.put(good);
  w = L.boot();
  assert.deepEqual(w.own(), [true, true]);
  await w.host.destroy();
});

test('link: headerless keys and own files migrate once by shape, then are refused; a cross-kind headerless file is refused', async (t) => {
  const dir = tmp(t);
  const L = linkWorld(t, dir);
  let w = await L.pairTwo();
  await w.host.destroy();
  const keysJson = JSON.stringify(L.keys()), recJson = JSON.stringify(L.rec());
  const legacy = () => { fs.writeFileSync(L.f('keys.bin'), safe.encryptString(keysJson)); fs.writeFileSync(L.f('own.bin'), safe.encryptString(recJson)); };
  const unmark = () => { for (const n of ['keys.bin.ao1', 'own.bin.ao1']) fs.rmSync(L.f(n), { force: true }); };
  // the files of a version before v3.102 (v3.101 markers inside, no purpose header, no `.ao1`): taken once, sealed again
  legacy(); unmark();
  w = L.boot();
  assert.deepEqual([w.own(), L.events('own-migration').length, L.events('own-record-unreadable').length], [[true, true], 1, 0]);
  assert.equal(plain(L.f('keys.bin')).startsWith('ao1:link-keys\n'), true);
  assert.equal(plain(L.f('own.bin')).startsWith('ao1:link-own\n'), true);
  assert.ok(fs.existsSync(L.f('keys.bin.ao1')) && fs.existsSync(L.f('own.bin.ao1')));
  await w.host.destroy();
  const good = L.snap();
  // afterwards a headerless own record reads as unreadable (all paused) and a headerless keys file fails the link closed
  fs.writeFileSync(L.f('own.bin'), safe.encryptString(recJson));
  w = L.boot();
  assert.deepEqual([w.own(), L.events('own-record-unreadable').length], [[false, false], 1]);
  await w.host.destroy();
  L.put(good);
  fs.writeFileSync(L.f('keys.bin'), safe.encryptString(keysJson));
  w = L.boot();
  assert.equal(w.link, null);
  await w.host.destroy();
  // shape validation on the migration path: an own record is no keys file, a keys file (or a token) is no own record
  L.put(good); unmark();
  fs.writeFileSync(L.f('keys.bin'), safe.encryptString(recJson));
  w = L.boot();
  assert.equal(w.link, null);
  await w.host.destroy();
  for (const text of [keysJson, 'tok-123', JSON.stringify({ v: C.OWN_VERSION, own: 'all', paused: [] })]) {
    L.put(good); unmark();
    fs.writeFileSync(L.f('own.bin'), safe.encryptString(text));
    const before = L.events('own-record-unreadable').length;
    w = L.boot();
    assert.deepEqual([w.own(), L.events('own-record-unreadable').length - before], [[false, false], 1]);
    await w.host.destroy();
  }
  // a keys file that parses but is not the schema (no secret key) is refused as well, header or not
  L.put(good);
  fs.writeFileSync(L.f('keys.bin'), sealer.seal(S.PURPOSE.LINK_KEYS, JSON.stringify({ publicKey: KEYS.publicKey, own: [PA, PB], ownV: C.OWN_VERSION })));
  w = L.boot();
  assert.equal(w.link, null);
  await w.host.destroy();
});

test('link: sealed files are never read or written through a symbolic link', { skip: process.platform === 'win32' }, async (t) => {
  const dir = tmp(t);
  const L = linkWorld(t, dir);
  let w = await L.pairTwo();
  await w.host.destroy();
  const good = L.snap();
  // own.bin is a link to a file elsewhere that holds a perfectly valid record: unreadable, all paused, and the save
  // that follows replaces the link instead of writing through it
  const elsewhere = path.join(dir, 'elsewhere.bin');
  fs.writeFileSync(elsewhere, good['own.bin']);
  fs.rmSync(L.f('own.bin'));
  fs.symlinkSync(elsewhere, L.f('own.bin'));
  w = L.boot();
  assert.deepEqual(w.own(), [false, false]);
  assert.equal(fs.lstatSync(L.f('own.bin')).isSymbolicLink(), false);
  assert.deepEqual(fs.readFileSync(elsewhere), good['own.bin']);
  await w.host.destroy();
  // keys.bin as a link: the link fails closed
  L.put({ 'own.bin': good['own.bin'] });
  fs.writeFileSync(elsewhere, good['keys.bin']);
  fs.rmSync(L.f('keys.bin'));
  fs.symlinkSync(elsewhere, L.f('keys.bin'));
  w = L.boot();
  assert.equal(w.link, null);
  await w.host.destroy();
  // the link folder itself as a link to a token store: nothing starts
  const dir2 = tmp(t);
  fs.mkdirSync(path.join(dir2, 'mcp-tokens'));
  fs.symlinkSync(path.join(dir2, 'mcp-tokens'), path.join(dir2, 'link'));
  const L2 = linkWorld(t, dir2);
  w = L2.boot();
  assert.equal(w.link, null);
  assert.deepEqual(fs.readdirSync(path.join(dir2, 'mcp-tokens')), []);
  await w.host.destroy();
});

test('v3.101 start table: marker + missing record; a crash between the two writes, in each order; old copies of both files', async (t) => {
  const dir = tmp(t);
  const L = linkWorld(t, dir);
  let w = await L.pairTwo();
  const bothOwn = L.snap();                               // state A: Studio and Mini own
  await w.handlers['link:setPaused'](null, PA, true);
  const studioPaused = L.snap();                          // state B: Studio paused
  assert.deepEqual([L.rec().own, L.rec().paused, L.keys().own], [[PB], [PA], [PB]]);
  await w.host.destroy();

  // marker + missing record: the keys file's sealed set, and the record is written again; nothing migrates
  fs.rmSync(L.f('own.bin'));
  w = L.boot();
  assert.deepEqual([w.own(), L.rec(), L.events('own-migration').length, L.events('own-restored').length, w.notices], [[false, true], { v: C.OWN_VERSION, own: [PB], paused: [PA] }, 1, 0, []]);
  await w.host.destroy();
  // ... also with the record's seal marker gone: a missing record is still not a reason to migrate
  fs.rmSync(L.f('own.bin')); fs.rmSync(L.f('own.bin.ao1'));
  w = L.boot();
  assert.deepEqual([w.own(), L.events('own-migration').length], [[false, true], 1]);
  await w.host.destroy();

  // a crash between the two writes of a save (own.bin first, then keys.bin):
  // pausing Studio, the record is new and the keys file old → own only when both say so: paused
  L.put({ 'own.bin': studioPaused['own.bin'], 'keys.bin': bothOwn['keys.bin'], 'devices.json': bothOwn['devices.json'] });
  w = L.boot();
  assert.deepEqual([w.own(), L.events('own-migration').length, L.events('own-record-unreadable').length], [[false, true], 1, 0]);
  await w.host.destroy();
  // resuming Studio, the record is new and the keys file old → still paused (the resume did not finish)
  L.put({ 'own.bin': bothOwn['own.bin'], 'keys.bin': studioPaused['keys.bin'], 'devices.json': studioPaused['devices.json'] });
  w = L.boot();
  assert.deepEqual(w.own(), [false, true]);
  await w.host.destroy();
  // the other order (the keys file new, the record old), for both actions: paused as well
  for (const devices of [bothOwn['devices.json'], studioPaused['devices.json']]) {
    L.put({ 'own.bin': bothOwn['own.bin'], 'keys.bin': studioPaused['keys.bin'], 'devices.json': devices });
    w = L.boot();
    assert.deepEqual(w.own(), [false, true]);
    await w.host.destroy();
    L.put({ 'own.bin': studioPaused['own.bin'], 'keys.bin': bothOwn['keys.bin'], 'devices.json': devices });
    w = L.boot();
    assert.deepEqual(w.own(), [false, true]);
    await w.host.destroy();
  }
  // no row above ran the migration again or told the person anything
  assert.deepEqual([L.events('own-migration').length, L.events('own-record-unreadable').length], [1, 0]);

  // the documented limit: older copies of BOTH sealed files (a backup) bring the older own state back
  L.put(studioPaused);
  w = L.boot();
  assert.deepEqual(w.own(), [false, true]);
  await w.handlers['link:remove'](null, PB);              // Mini is removed: its secret leaves the keys file
  assert.equal(Object.keys(L.keys().secrets).includes(PB), false);
  await w.host.destroy();
  const afterRemove = L.snap();
  // without such a backup a removed device cannot come back: devices.json is a plain file and adds no secret
  fs.writeFileSync(L.f('devices.json'), bothOwn['devices.json']);
  w = L.boot();
  assert.deepEqual(w.own(), [false, false]);
  assert.equal(C.mayCommand(w.link.devices, w.link.secrets, PB), false);
  await w.host.destroy();
  // one old file alone is not enough either
  L.put({ ...afterRemove, 'devices.json': bothOwn['devices.json'], 'own.bin': bothOwn['own.bin'] });
  w = L.boot();
  assert.deepEqual(w.own(), [false, false]);
  await w.host.destroy();
  // with the backup of both (and the plain device list) the paused device is own again and the removed one is back
  L.put(bothOwn);
  w = L.boot();
  assert.deepEqual(w.own(), [true, true]);
  assert.deepEqual([L.events('own-migration').length, w.notices], [1, []]);
  await w.host.destroy();
});
