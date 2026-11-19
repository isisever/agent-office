// The office renderer's single source is plugin/viewer/core.mjs; app/src/office/core.mjs is an exact copy
// so it can load from inside the app package (asar). This script copies it (runs automatically before npm start/dist).
// node app/scripts/sync-core.mjs   (or inside app/: node scripts/sync-core.mjs)
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
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

// v3.108 the GUI chat answers Claude Code's permission requests in the app, by the same rules as the plugin's
// auto-approve (contract v3.71): app/src/auto-approve.mjs is plugin/hooks/auto-approve.ts with its types blanked out
// (node:module stripTypeScriptTypes keeps every line and column), under a one-line header. Never edit the copy.
export const AUTO_APPROVE_HEADER = '// Generated from plugin/hooks/auto-approve.ts by app/scripts/sync-core.mjs (contract v3.108): do not edit.\n'
const aaSource = join(app, '..', 'plugin', 'hooks', 'auto-approve.ts')
const aaCopy = join(app, 'src', 'auto-approve.mjs')
let aaText = null
try {
  const { stripTypeScriptTypes } = await import('node:module')
  if (typeof stripTypeScriptTypes !== 'function') console.error('auto-approve.mjs: this Node has no stripTypeScriptTypes (needs 22.13+): the copy was not checked')
  else {
    process.removeAllListeners('warning')   // the "experimental feature" line is no news here
    aaText = AUTO_APPROVE_HEADER + stripTypeScriptTypes(readFileSync(aaSource, 'utf8'))
  }
} catch (e) { console.error('auto-approve.mjs:', e.message) }
let aaSame = false
try { aaSame = aaText === null || readFileSync(aaCopy, 'utf8') === aaText } catch {}
if (!aaSame) {
  writeFileSync(aaCopy, aaText)
  console.log('auto-approve.mjs: plugin/hooks/auto-approve.ts → app/src/auto-approve.mjs')
}
