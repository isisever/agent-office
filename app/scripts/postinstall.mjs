// npm install sonrası (install-app-deps node-pty'yi Electron için hazırladıktan sonra).
// macOS: node-pty 1.1'in önceden derlenmiş spawn-helper'ı bazen çalıştırılabilir bit'i olmadan gelir.
// Linux: önceden derlenmiş node-pty yok, install-app-deps kaynaktan derler; burada yapılacak bir şey yok.
// Hiçbir durumda kurulumu bozmaz.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const prebuilds = fileURLToPath(new URL('../node_modules/node-pty/prebuilds', import.meta.url))
if (process.platform === 'darwin' && existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds).filter((d) => d.startsWith('darwin-'))) {
    try { chmodSync(join(prebuilds, dir, 'spawn-helper'), 0o755) } catch {}
  }
}
