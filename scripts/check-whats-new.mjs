// Release check (README "Releasing"): node scripts/check-whats-new.mjs <version> [--dir <folder>]
// app/whats-new/<version>.json must exist and be valid (app/src/whats-new.js validateManifest: every item has en and
// tr texts, and "Try it" uses a known action id). Exit 0 when it is, 1 with the problems listed when it is not, 2 on
// bad arguments. scripts/release.mjs runs it in step 1 (Checks).
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const WN = createRequire(import.meta.url)(join(ROOT, 'app', 'src', 'whats-new.js'))

const args = process.argv.slice(2)
const dirAt = args.indexOf('--dir')
const dir = dirAt >= 0 ? resolve(process.cwd(), args[dirAt + 1] || '') : join(ROOT, 'app', 'whats-new')
const version = args.filter((a, i) => !a.startsWith('--') && !(dirAt >= 0 && i === dirAt + 1))[0]?.replace(/^v/, '')
if (!version || !WN.parseVersion(version)) {
  console.error('usage: node scripts/check-whats-new.mjs <version, e.g. 0.22.44> [--dir <folder>]')
  process.exit(2)
}
const { manifest, errors } = WN.readManifest(dir, version)
if (manifest) {
  console.log(`ok: app/whats-new/${version}.json (${manifest.items.length} item${manifest.items.length === 1 ? '' : 's'})`)
} else {
  console.error(`What's new for ${version} is missing or invalid (${join(dir, `${version}.json`)}):`)
  for (const e of errors) console.error(`  - ${e}`)
  console.error('Add app/whats-new/<version>.json (see README "Releasing") and commit it before releasing.')
  process.exit(1)
}
