// After npm install (once install-app-deps has prepared node-pty for Electron):
// 1) macOS: node-pty 1.1's shipped prebuild carries the defect of microsoft/node-pty#904/#951 — its exit
//    ThreadSafeFunction makes Napi calls while the Node environment is tearing down, and without the compile-time
//    guard node-addon-api turns the napi_pending_exception into an uncaught C++ throw → abort (the SIGABRT on
//    quit). binding.gyp is patched once with NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS and node-pty is rebuilt for
//    Electron, marked by .agent-office-swallow in build/Release so a later install rebuilds only after upstream
//    code changed the built module again. Other platforms keep what install-app-deps built (Linux builds from
//    source; Windows ships a ConPTY prebuild — the same defect there is a follow-up).
// 2) macOS: node-pty 1.1's prebuilt spawn-helper sometimes ships without the executable bit.
// Never breaks the install: any failure here falls back to what install-app-deps produced.
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const ptyDir = join(appDir, 'node_modules', 'node-pty')
const DEFINE = 'NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS'

try {
  if (process.platform === 'darwin' && existsSync(ptyDir)) {
    // the patch, next to the node_addon_api_except dependency (once, idempotent)
    const gyp = join(ptyDir, 'binding.gyp')
    let text = readFileSync(gyp, 'utf8')
    if (!text.includes(DEFINE)) {
      text = text.replace(
        "'target_defaults': {",
        `'target_defaults': {\n    'defines': [ '${DEFINE}' ],`)
      writeFileSync(gyp, text)
    }
    // the rebuild: only when the built pty.node was made without the patch (no marker beside it, or the module is
    // newer than the marker, which means install-app-deps has just rebuilt without knowing about the patch)
    const node = join(ptyDir, 'build', 'Release', 'pty.node')
    const marker = join(ptyDir, 'build', 'Release', '.agent-office-swallow')
    const mtime = (f) => { try { return statSync(f).mtimeMs } catch { return 0 } }
    if (!existsSync(node) || !existsSync(marker) || mtime(node) > mtime(marker)) {
      execFileSync(join(appDir, 'node_modules', '.bin', 'electron-rebuild'), ['-f', '-w', 'node-pty'], { cwd: appDir, stdio: 'inherit' })
      writeFileSync(marker, `${DEFINE}\n`)
    }
  }
} catch (e) {
  // install still works: the app runs with what install-app-deps built; every onData/onExit callback stays guarded
  rmSync(join(ptyDir, 'build', 'Release', '.agent-office-swallow'), { force: true })
  console.error('node-pty rebuild atlandı:', e.message)
}

// macOS spawn-helper bit (unchanged)
const prebuilds = fileURLToPath(new URL('../node_modules/node-pty/prebuilds', import.meta.url))
if (process.platform === 'darwin' && existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds).filter((d) => d.startsWith('darwin-'))) {
    try { chmodSync(join(prebuilds, dir, 'spawn-helper'), 0o755) } catch {}
  }
}
