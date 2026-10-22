// node-pty built with NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS (the quit-time SIGABRT fix), per platform and arch.
//
// node-pty 1.1's exit ThreadSafeFunction makes Napi calls while the Node environment is tearing down
// (microsoft/node-pty#904/#951); without that compile-time define node-addon-api turns the napi_pending_exception
// into an uncaught C++ throw, and the process aborts on quit. So binding.gyp gets the define and node-pty is rebuilt
// for Electron:
// - macOS, for BOTH arm64 and x64 (the release ships both): each build's pty.node and spawn-helper replace
//   prebuilds/darwin-<arch>/, and build/ is removed. node-pty's loader tries build/Release before
//   prebuilds/<platform>-<arch>, so a host-arch build/ left behind would shadow the arch-matched patched file
//   (and on the other arch fail to dlopen, falling back to an unpatched prebuild).
// - Linux: node-pty has no prebuilds there and is compiled from source; it is rebuilt with the define in place and
//   build/Release stays (that is where the loader finds it).
// - Windows: unchanged. It ships node-pty's ConPTY prebuild, a different native code path; the same fix there is a
//   follow-up.
// A marker (.agent-office-swallow.json in node-pty's folder, excluded from the package) records the sha256 of each
// patched binary, so a reinstall of node-pty (which brings the unpatched files back) is detected and rebuilt.
//
// Used by scripts/postinstall.mjs (dev installs) and scripts/before-pack.cjs (every package build, strict).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const DEFINE = 'NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS';
const ANCHOR = "'target_defaults': {";
const MARKER = '.agent-office-swallow.json';
/** Mach-O names that `lipo -archs` prints, per Node arch */
const MACHO = { arm64: 'arm64', x64: 'x86_64' };

/** Adds the define to binding.gyp (idempotent). Throws when the patch does not apply: upstream changed the file. */
function patchBindingGyp(/** @type {string} */ ptyDir) {
  const gyp = path.join(ptyDir, 'binding.gyp');
  let text = fs.readFileSync(gyp, 'utf8');
  if (text.includes(DEFINE)) return false;
  if (!text.includes(ANCHOR)) throw new Error(`node-pty binding.gyp layout changed (no ${ANCHOR}): the ${DEFINE} patch does not apply`);
  text = text.replace(ANCHOR, `${ANCHOR}\n    'defines': [ '${DEFINE}' ],`);
  if (!text.includes(DEFINE)) throw new Error(`node-pty binding.gyp: the ${DEFINE} patch did not apply`);
  fs.writeFileSync(gyp, text);
  return true;
}

/** Where the loader finds the native module for this platform/arch. */
function binaryDir(/** @type {string} */ ptyDir, /** @type {string} */ platform, /** @type {string} */ arch) {
  return platform === 'darwin' ? path.join(ptyDir, 'prebuilds', `darwin-${arch}`) : path.join(ptyDir, 'build', 'Release');
}

const sha = (/** @type {string} */ f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function readMarker(/** @type {string} */ ptyDir) {
  try { return JSON.parse(fs.readFileSync(path.join(ptyDir, MARKER), 'utf8')) || {}; } catch { return {}; }
}

/** True when the binary the loader will pick for platform/arch is the one this script built with the define. */
function isPatched(/** @type {string} */ ptyDir, /** @type {string} */ platform, /** @type {string} */ arch) {
  const node = path.join(binaryDir(ptyDir, platform, arch), 'pty.node');
  if (!fs.existsSync(node)) return false;
  if (platform === 'darwin' && fs.existsSync(path.join(ptyDir, 'build'))) return false;   // build/ would shadow it
  return readMarker(ptyDir)[`${platform}-${arch}`] === sha(node);
}

/** The Mach-O archs of a file (`lipo -archs`), e.g. ['arm64']. */
function machoArchs(/** @type {string} */ file) {
  return execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/);
}

/**
 * Rebuilds node-pty with the define for one platform/arch and puts the result where the loader finds it.
 * @param {{ appDir: string, platform?: string, arch: string, exec?: typeof execFileSync, archsOf?: (f: string) => string[], log?: (s: string) => void }} o
 */
function buildPatched({ appDir, platform = process.platform, arch, exec = execFileSync, archsOf = machoArchs, log = console.log }) {
  if (platform !== 'darwin' && platform !== 'linux') return false;
  if (platform === 'darwin' && !MACHO[/** @type {'arm64' | 'x64'} */ (arch)]) throw new Error(`node-pty patch: unsupported macOS arch ${arch}`);
  const ptyDir = path.join(appDir, 'node_modules', 'node-pty');
  patchBindingGyp(ptyDir);
  const build = path.join(ptyDir, 'build');
  // macOS falls back to the prebuilds if the rebuild fails, so a stale build/ goes first; Linux has no prebuilds:
  // its current build/ stays until the rebuild replaces it (-f forces the rebuild anyway)
  if (platform === 'darwin') fs.rmSync(build, { recursive: true, force: true });
  // node-gyp/electron-rebuild leftovers outside build/: bin/<platform-arch-abi>/ (electron-rebuild's copy of the
  // module) and node-addon-api/*.mk (gyp output of the dependency targets); removed below when this build made them
  const strays = ['bin', 'node-addon-api'].map((d) => path.join(ptyDir, d)).filter((d) => !fs.existsSync(d));
  log(`node-pty: rebuilding for Electron ${platform}-${arch} with ${DEFINE}`);
  exec(path.join(appDir, 'node_modules', '.bin', 'electron-rebuild'), ['-f', '-w', 'node-pty', '--arch', arch], { cwd: appDir, stdio: 'inherit' });
  // the define must have reached the compiler, not only binding.gyp
  const mk = path.join(build, 'pty.target.mk');
  if (!fs.existsSync(mk) || !fs.readFileSync(mk, 'utf8').includes(DEFINE)) throw new Error(`node-pty rebuild for ${arch}: ${DEFINE} is not in build/pty.target.mk`);
  const out = path.join(build, 'Release');
  const target = binaryDir(ptyDir, platform, arch);
  if (platform === 'darwin') {
    const want = MACHO[/** @type {'arm64' | 'x64'} */ (arch)];
    for (const f of ['pty.node', 'spawn-helper']) {
      const got = archsOf(path.join(out, f));
      if (got.length !== 1 || got[0] !== want) throw new Error(`node-pty rebuild for ${arch}: ${f} is ${got.join(' ')}, not ${want}`);
    }
    fs.mkdirSync(target, { recursive: true });
    for (const f of ['pty.node', 'spawn-helper']) fs.copyFileSync(path.join(out, f), path.join(target, f));
    fs.chmodSync(path.join(target, 'spawn-helper'), 0o755);
    fs.rmSync(build, { recursive: true, force: true });
  }
  for (const d of strays) fs.rmSync(d, { recursive: true, force: true });
  const marker = readMarker(ptyDir);
  marker[`${platform}-${arch}`] = sha(path.join(target, 'pty.node'));
  fs.writeFileSync(path.join(ptyDir, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  return true;
}

/** Builds only what is not patched yet. On macOS a leftover build/ (from install-app-deps) is removed first: it
 *  would shadow the prebuilds. */
function ensurePatched(/** @type {Parameters<typeof buildPatched>[0]} */ o) {
  const platform = o.platform || process.platform;
  const ptyDir = path.join(o.appDir, 'node_modules', 'node-pty');
  if (platform === 'darwin') fs.rmSync(path.join(ptyDir, 'build'), { recursive: true, force: true });
  if (isPatched(ptyDir, platform, o.arch)) return false;
  return buildPatched(o);
}

module.exports = { DEFINE, MARKER, patchBindingGyp, isPatched, buildPatched, ensurePatched, binaryDir, machoArchs };
