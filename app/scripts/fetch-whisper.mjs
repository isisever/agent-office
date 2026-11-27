#!/usr/bin/env node
// Voice input (contract v3.119): puts whisper.cpp's `whisper-server` for one platform into
// app/vendor/whisper/<os>-<arch>/, where electron-builder's extraResources picks it up (Resources/whisper in the app).
//
//   node app/scripts/fetch-whisper.mjs                 # this machine's platform and arch
//   node app/scripts/fetch-whisper.mjs --os mac --arch x64
//
// Everything is pinned:
// - Windows x64 and Linux x64: the official release asset of tag WHISPER_TAG, checked against its sha256.
// - macOS arm64 / x64: there is no official macOS command-line asset, so the pinned tag is cloned, its commit checked
//   against WHISPER_COMMIT and whisper-server built with Metal (embedded shader library), static, no SDL. Needs
//   cmake and Xcode's command-line tools.
// Nothing here runs a shell: every child process gets an argument list.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WHISPER_TAG = 'b5907';
export const WHISPER_COMMIT = '5eaee0cc9024eb9e9a99469199920c8b7f5cb9ec';
const REPO = 'https://github.com/ggml-org/whisper.cpp';
/** Official prebuilt assets of WHISPER_TAG (sha256 from the GitHub release's asset digests). */
export const ASSETS = {
  'win-x64': { name: `whisper-bin-x64.zip`, sha256: 'ecca07b277d943e9b9f4712856a144b857271a6b333104e511e1988e80db582b' },
  'linux-x64': { name: `whisper-bin-ubuntu-x64.tar.gz`, sha256: 'a6199027fe5b4239c84171d2bca4c0ff44ec86a515494d5a39b237b212d429bd' },
};

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');

const osName = (p) => ({ darwin: 'mac', win32: 'win', linux: 'linux' })[p] || p;
function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function findFile(dir, base) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, base); if (f) return f; } else if (e.name === base) return p;
  }
  return null;
}

/** Copies whisper-server and the libraries next to it (the Windows and Linux assets ship .dll / .so files). */
function copyBinDir(serverPath, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const dir = path.dirname(serverPath);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    if (e.name === path.basename(serverPath) || /\.(dll|so(\.\d+)*|dylib)$/.test(e.name)) {
      fs.copyFileSync(path.join(dir, e.name), path.join(dest, e.name));
    }
  }
  fs.chmodSync(path.join(dest, path.basename(serverPath)), 0o755);
}

async function fetchAsset(key, dest) {
  const a = ASSETS[key];
  const url = `${REPO}/releases/download/${WHISPER_TAG}/${a.name}`;
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sum = createHash('sha256').update(buf).digest('hex');
  if (sum !== a.sha256) throw new Error(`sha256 mismatch for ${a.name}: ${sum}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-asset-'));
  try {
    const file = path.join(work, a.name);
    fs.writeFileSync(file, buf);
    const out = path.join(work, 'x');
    fs.mkdirSync(out);
    execFileSync('tar', ['-xf', file, '-C', out], { stdio: 'inherit' });
    const exe = key.startsWith('win') ? 'whisper-server.exe' : 'whisper-server';
    const server = findFile(out, exe);
    if (!server) throw new Error(`${exe} is not in ${a.name}`);
    copyBinDir(server, dest);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function buildMac(arch, dest) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-src-'));
  try {
    const src = path.join(work, 'whisper.cpp');
    execFileSync('git', ['clone', '--depth', '1', '--branch', WHISPER_TAG, `${REPO}.git`, src], { stdio: 'inherit' });
    const head = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== WHISPER_COMMIT) throw new Error(`tag ${WHISPER_TAG} is ${head}, expected ${WHISPER_COMMIT}`);
    const build = path.join(src, 'build');
    execFileSync('cmake', ['-S', src, '-B', build,
      '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF',
      `-DCMAKE_OSX_ARCHITECTURES=${arch === 'x64' ? 'x86_64' : 'arm64'}`, '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0',
      '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON', '-DGGML_NATIVE=OFF',
      '-DWHISPER_BUILD_EXAMPLES=ON', '-DWHISPER_BUILD_SERVER=ON', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_SDL2=OFF',
    ], { stdio: 'inherit' });
    execFileSync('cmake', ['--build', build, '--config', 'Release', '--target', 'whisper-server', '-j', String(os.cpus().length)], { stdio: 'inherit' });
    const server = findFile(path.join(build, 'bin'), 'whisper-server');
    if (!server) throw new Error('the build made no whisper-server');
    copyBinDir(server, dest);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const o = argOf('os', osName(process.platform));
  const arch = argOf('arch', process.arch);
  const key = `${o}-${arch}`;
  const dest = path.join(appDir, 'vendor', 'whisper', key);
  if (o === 'mac') buildMac(arch, dest);
  else if (ASSETS[key]) await fetchAsset(key, dest);
  else throw new Error(`no whisper-server source for ${key} (supported: mac-arm64, mac-x64, ${Object.keys(ASSETS).join(', ')})`);
  for (const f of fs.readdirSync(dest)) console.log(`${path.join(dest, f)}  ${fs.statSync(path.join(dest, f)).size} bytes`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
}
