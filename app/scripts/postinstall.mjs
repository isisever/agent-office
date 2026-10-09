// After npm install (once install-app-deps has prepared node-pty for Electron).
// macOS: node-pty 1.1's prebuilt spawn-helper sometimes ships without the executable bit.
// Linux: no prebuilt node-pty, install-app-deps builds from source; nothing to do here.
// Never breaks the install.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const prebuilds = fileURLToPath(new URL('../node_modules/node-pty/prebuilds', import.meta.url))
if (process.platform === 'darwin' && existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds).filter((d) => d.startsWith('darwin-'))) {
    try { chmodSync(join(prebuilds, dir, 'spawn-helper'), 0o755) } catch {}
  }
}
