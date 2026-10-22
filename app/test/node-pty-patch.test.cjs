// The quit-time SIGABRT fix: node --test app/test/node-pty-patch.test.cjs
// scripts/node-pty-patch.cjs + scripts/before-pack.cjs (with a fake electron-rebuild) and src/pty-guard.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const NP = require('../scripts/node-pty-patch.cjs');
const beforePack = require('../scripts/before-pack.cjs');
const PG = require('../src/pty-guard.js');

const GYP = "{\n  'target_defaults': {\n    'dependencies': [ 'node_addon_api_except' ],\n  },\n  'targets': []\n}\n";

/** a fake app folder with node-pty 1.1's layout: binding.gyp and the unpatched darwin prebuilds */
function fakeApp() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-patch-'));
  const pty = path.join(appDir, 'node_modules', 'node-pty');
  for (const a of ['arm64', 'x64']) {
    fs.mkdirSync(path.join(pty, 'prebuilds', `darwin-${a}`), { recursive: true });
    fs.writeFileSync(path.join(pty, 'prebuilds', `darwin-${a}`, 'pty.node'), `upstream ${a}`);
    fs.writeFileSync(path.join(pty, 'prebuilds', `darwin-${a}`, 'spawn-helper'), `upstream helper ${a}`);
  }
  fs.writeFileSync(path.join(pty, 'binding.gyp'), GYP);
  return { appDir, pty };
}
/** a fake electron-rebuild: compiles "with" whatever binding.gyp says, for the --arch it is given */
function fakeRebuild(pty, { define = true, calls = [] } = {}) {
  return (/** @type {string} */ _bin, /** @type {string[]} */ args) => {
    const arch = args[args.indexOf('--arch') + 1];
    calls.push(arch);
    const gypHas = fs.readFileSync(path.join(pty, 'binding.gyp'), 'utf8').includes(NP.DEFINE);
    fs.mkdirSync(path.join(pty, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(pty, 'build', 'pty.target.mk'), define && gypHas ? `DEFS_Release := '-D${NP.DEFINE}'` : 'DEFS_Release :=');
    fs.writeFileSync(path.join(pty, 'build', 'Release', 'pty.node'), `patched ${arch}`);
    fs.writeFileSync(path.join(pty, 'build', 'Release', 'spawn-helper'), `patched helper ${arch}`);
    fs.mkdirSync(path.join(pty, 'bin', `darwin-${arch}-149`), { recursive: true });
    fs.mkdirSync(path.join(pty, 'node-addon-api'), { recursive: true });
    return '';
  };
}
const machoOf = (/** @type {string} */ f) => [fs.readFileSync(f, 'utf8').endsWith('x64') ? 'x86_64' : 'arm64'];

test('binding.gyp: the define is added once; a changed layout throws instead of passing silently', () => {
  const { pty } = fakeApp();
  assert.equal(NP.patchBindingGyp(pty), true);
  const once = fs.readFileSync(path.join(pty, 'binding.gyp'), 'utf8');
  assert.match(once, new RegExp(`'defines': \\[ '${NP.DEFINE}' \\]`));
  assert.equal(NP.patchBindingGyp(pty), false);
  assert.equal(fs.readFileSync(path.join(pty, 'binding.gyp'), 'utf8'), once);
  fs.writeFileSync(path.join(pty, 'binding.gyp'), "{ 'targets': [] }");
  assert.throws(() => NP.patchBindingGyp(pty), /layout changed/);
});

test('macOS: both arches are built into prebuilds/darwin-<arch>, build/ and stray gyp output are removed', () => {
  const { appDir, pty } = fakeApp();
  const calls = [];
  for (const arch of ['arm64', 'x64']) NP.buildPatched({ appDir, platform: 'darwin', arch, exec: fakeRebuild(pty, { calls }), archsOf: machoOf, log: () => {} });
  assert.deepEqual(calls, ['arm64', 'x64']);
  for (const a of ['arm64', 'x64']) {
    assert.equal(fs.readFileSync(path.join(pty, 'prebuilds', `darwin-${a}`, 'pty.node'), 'utf8'), `patched ${a}`);
    assert.equal(fs.readFileSync(path.join(pty, 'prebuilds', `darwin-${a}`, 'spawn-helper'), 'utf8'), `patched helper ${a}`);
    assert.equal(NP.isPatched(pty, 'darwin', a), true);
  }
  for (const d of ['build', 'bin', 'node-addon-api']) assert.equal(fs.existsSync(path.join(pty, d)), false, d);
});

test('macOS: a rebuild without the define in pty.target.mk, or for the wrong arch, throws and marks nothing', () => {
  const { appDir, pty } = fakeApp();
  assert.throws(() => NP.buildPatched({ appDir, platform: 'darwin', arch: 'x64', exec: fakeRebuild(pty, { define: false }), archsOf: machoOf, log: () => {} }), /not in build\/pty.target.mk/);
  assert.equal(NP.isPatched(pty, 'darwin', 'x64'), false);
  assert.throws(() => NP.buildPatched({ appDir, platform: 'darwin', arch: 'x64', exec: fakeRebuild(pty), archsOf: () => ['arm64'], log: () => {} }), /is arm64, not x86_64/);
  assert.equal(fs.readFileSync(path.join(pty, 'prebuilds', 'darwin-x64', 'pty.node'), 'utf8'), 'upstream x64');
  assert.equal(NP.isPatched(pty, 'darwin', 'x64'), false);
});

test('macOS: a reinstalled (unpatched) prebuild or a leftover build/ counts as unpatched; ensurePatched rebuilds only that', () => {
  const { appDir, pty } = fakeApp();
  const opts = (arch, calls) => ({ appDir, platform: 'darwin', arch, exec: fakeRebuild(pty, { calls }), archsOf: machoOf, log: () => {} });
  for (const a of ['arm64', 'x64']) NP.ensurePatched(opts(a, []));
  fs.writeFileSync(path.join(pty, 'prebuilds', 'darwin-x64', 'pty.node'), 'upstream x64');
  assert.equal(NP.isPatched(pty, 'darwin', 'x64'), false);
  fs.mkdirSync(path.join(pty, 'build', 'Release'), { recursive: true });   // what install-app-deps may leave
  assert.equal(NP.isPatched(pty, 'darwin', 'arm64'), false);
  const calls = [];
  for (const a of ['arm64', 'x64']) NP.ensurePatched(opts(a, calls));
  assert.deepEqual(calls, ['x64']);
  assert.equal(NP.isPatched(pty, 'darwin', 'arm64'), true);
  assert.equal(NP.isPatched(pty, 'darwin', 'x64'), true);
});

test('Linux: rebuilt with the define, build/Release stays where the loader finds it; Windows is left alone', () => {
  const { appDir, pty } = fakeApp();
  NP.buildPatched({ appDir, platform: 'linux', arch: 'x64', exec: fakeRebuild(pty), log: () => {} });
  assert.equal(fs.readFileSync(path.join(pty, 'build', 'Release', 'pty.node'), 'utf8'), 'patched x64');
  assert.equal(NP.isPatched(pty, 'linux', 'x64'), true);
  const calls = [];
  assert.equal(NP.buildPatched({ appDir, platform: 'win32', arch: 'x64', exec: fakeRebuild(pty, { calls }), log: () => {} }), false);
  assert.deepEqual(calls, []);
});

test('beforePack: the packed arch is ensured, strictly; Windows and unknown arches', async () => {
  const { appDir, pty } = fakeApp();
  const seen = [];
  const ensure = (o) => { seen.push(`${o.platform}-${o.arch}`); NP.ensurePatched({ ...o, exec: fakeRebuild(pty), archsOf: machoOf, log: () => {} }); };
  await beforePack({ electronPlatformName: 'darwin', arch: 1 }, { appDir, ensure });
  await beforePack({ electronPlatformName: 'darwin', arch: 3 }, { appDir, ensure });
  await beforePack({ electronPlatformName: 'win32', arch: 1 }, { appDir, ensure });
  assert.deepEqual(seen, ['darwin-x64', 'darwin-arm64']);
  await assert.rejects(beforePack({ electronPlatformName: 'darwin', arch: 4 }, { appDir, ensure }), /cannot pack/);
  // an ensure that leaves the module unpatched fails the package build
  fs.writeFileSync(path.join(pty, 'prebuilds', 'darwin-x64', 'pty.node'), 'upstream x64');
  await assert.rejects(beforePack({ electronPlatformName: 'darwin', arch: 1 }, { appDir, ensure: () => {} }), /not built with/);
});

test('package.json: beforePack is wired and the marker is not packaged', () => {
  const build = require('../package.json').build;
  assert.equal(build.beforePack, './scripts/before-pack.cjs');
  assert.ok(build.files.includes(`!node_modules/node-pty/${NP.MARKER}`));
});

test('pty guard: callbacks are muted while quitting and a throw is caught', () => {
  let quitting = false;
  const G = PG.createGuard(() => quitting);
  const got = [];
  const f = G.guarded((x) => { if (x === 'boom') throw new Error('boom'); got.push(x); });
  const err = console.error; console.error = () => {};
  try { f('a'); assert.doesNotThrow(() => f('boom')); quitting = true; f('b'); } finally { console.error = err; }
  assert.deepEqual(got, ['a']);
});

test('pty guard: release disposes every held listener once', () => {
  const G = PG.createGuard(() => false);
  const t = {};
  let n = 0;
  const d = () => ({ dispose: () => { n++; } });
  G.hold(t, d(), d());
  G.hold(t, d(), undefined);
  G.release(t);
  G.release(t);
  assert.equal(n, 3);
});

test('pty guard: waitGone ends when the pids are reaped, or at the cap', async () => {
  const gone = new Set();
  const pids = [11, 12];
  setTimeout(() => { gone.add(11); gone.add(12); }, 30);
  assert.equal(await PG.waitGone(pids, { timeoutMs: 1000, stepMs: 5, isAlive: (p) => !gone.has(p) }), true);
  assert.deepEqual(pids, []);
  const stuck = [13];
  const t0 = Date.now();
  assert.equal(await PG.waitGone(stuck, { timeoutMs: 60, stepMs: 5, isAlive: () => true }), false);
  assert.ok(Date.now() - t0 < 500);
  assert.deepEqual(stuck, [13]);
});
