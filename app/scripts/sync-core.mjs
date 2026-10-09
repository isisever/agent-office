// The office renderer's single source is plugin/viewer/core.mjs; app/src/office/core.mjs is an exact copy
// so it can load from inside the app package (asar). This script copies it (runs automatically before npm start/dist).
// node app/scripts/sync-core.mjs   (or inside app/: node scripts/sync-core.mjs)
import { copyFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(app, '..', 'plugin', 'viewer', 'core.mjs')
const copy = join(app, 'src', 'office', 'core.mjs')

let isSame = false
try {
  isSame = readFileSync(copy).equals(readFileSync(source))
} catch {}
if (!isSame) {
  copyFileSync(source, copy)
  console.log('core.mjs: plugin/viewer/core.mjs → app/src/office/core.mjs')
}
