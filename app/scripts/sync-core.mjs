// Ofis çizicisinin tek kaynağı plugin/viewer/core.mjs; uygulama paketinin (asar) içinden yüklenebilsin diye
// app/src/office/core.mjs onun birebir kopyasıdır. Bu betik kopyalar (npm start/dist öncesi kendiliğinden çalışır).
// node app/scripts/sync-core.mjs   (ya da app/ içinde: node scripts/sync-core.mjs)
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
