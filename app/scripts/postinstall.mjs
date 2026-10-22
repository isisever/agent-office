// After npm install (once install-app-deps has prepared node-pty for Electron):
// 1) node-pty is rebuilt with the quit-crash define (scripts/node-pty-patch.cjs): on macOS for arm64 and x64 into
//    prebuilds/darwin-<arch>, on Linux for this machine's arch; Windows is unchanged. Only what is not patched yet is
//    rebuilt. A binding.gyp that the patch no longer fits fails the install (upstream changed node-pty: the patch
//    must be updated). A failed rebuild (no compiler, no network for the headers) only warns: the app still runs
//    with the unpatched module and its guarded callbacks, and every package build retries strictly (before-pack.cjs).
// 2) macOS: node-pty 1.1's prebuilt spawn-helper sometimes ships without the executable bit.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const NP = createRequire(import.meta.url)('./node-pty-patch.cjs')
const appDir = fileURLToPath(new URL('..', import.meta.url))
const ptyDir = join(appDir, 'node_modules', 'node-pty')

if (existsSync(ptyDir) && (process.platform === 'darwin' || process.platform === 'linux')) {
  NP.patchBindingGyp(ptyDir)   // throws when the layout changed
  for (const arch of process.platform === 'darwin' ? ['arm64', 'x64'] : [process.arch]) {
    try { NP.ensurePatched({ appDir, arch }) } catch (e) {
      console.error(`node-pty ${process.platform}-${arch}: rebuild with ${NP.DEFINE} skipped (${e.message}); the package build will retry it`)
    }
  }
}

// macOS spawn-helper bit
const prebuilds = join(ptyDir, 'prebuilds')
if (process.platform === 'darwin' && existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds).filter((d) => d.startsWith('darwin-'))) {
    try { chmodSync(join(prebuilds, dir, 'spawn-helper'), 0o755) } catch {}
  }
}
