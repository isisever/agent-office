// Visual regression test for the office drawing: node app/test/visual.test.mjs
// Fixed scenarios are drawn at a fixed time; each frame's digest (of the logical pixel buffer)
// is compared with the one in visual-snapshots.json. On a mismatch the drawn frame is written as a PNG and its path printed.
// If the change is intentional: UPDATE_SNAPSHOTS=1 node app/test/visual.test.mjs (then look at the PNGs and commit).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { demoOffice, render, resetOffice, setBotColor, setGeometry, setLanguage, setTheme, setThemes } from '../src/office/core.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FILE = join(here, 'visual-snapshots.json')
const OUT = join(tmpdir(), 'agent-office-visual')
// the office clock and day are drawn in local time: the time zone is fixed so every machine draws the same frame
process.env.TZ = 'Europe/Istanbul'
const NOW = new Date(2026, 9, 9, 11, 0, 0).getTime()
const isUpdate = process.env.UPDATE_SNAPSHOTS === '1'

function png(path, { fb, LW, LH }) {
  const raw = Buffer.alloc((LW * 3 + 1) * LH)
  for (let y = 0; y < LH; y++)
    for (let x = 0; x < LW; x++) {
      const c = fb[y * LW + x]
      const o = y * (LW * 3 + 1) + 1 + x * 3
      raw[o] = (c >> 16) & 255
      raw[o + 1] = (c >> 8) & 255
      raw[o + 2] = c & 255
    }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const tb = Buffer.concat([Buffer.from(type), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(tb))
    return Buffer.concat([len, tb, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(LW, 0)
  ihdr.writeUInt32BE(LH, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

const multi = now => {
  const d = demoOffice(now)
  const names = ['shop-api', 'notes']
  const workers = d.workers.map((w, i) => ({ ...w, project: names[i % 2] }))
  return {
    ...d, workers, isBossBusy: true, isBossAsking: true,
    projects: [
      { name: 'shop-api', working: 2, delivered: 3, isBossBusy: true, waiting: { tool: 'Bash', since: now - 5000 } },
      { name: 'notes', working: 1, delivered: 1, isBossBusy: false, waiting: null },
    ],
    shells: [{ id: 's1', command: 'npm run dev', startAt: now - 60000, status: 'running', project: 'shop-api' }],
  }
}

// the boss's turn ended while two background agents still run: the sign says it waits on its agents
const agentsWaiting = now => ({
  workers: [
    { id: 'a1', type: 'Explore', spawnAt: now - 40000, tool: 'Grep', project: 'shop-api' },
    { id: 'a2', type: 'general-purpose', spawnAt: now - 25000, tool: 'Bash', project: 'shop-api' },
  ],
  delivered: 3, isBossBusy: false, isBossAsking: false, project: 'shop-api', sessionId: '',
  projects: [{ name: 'shop-api', working: 2, delivered: 3, isBossBusy: false, waiting: null }],
})

// [name, language, theme, data]
const CASES = [
  ['demo-tr', 'tr', 'classic', demoOffice],
  ['demo-en', 'en', 'classic', demoOffice],
  ['forest-tr', 'tr', 'forest', demoOffice],
  ['multi-asking-en', 'en', 'classic', multi],
  ['agents-waiting-en', 'en', 'classic', agentsWaiting],
  ['agents-waiting-tr', 'tr', 'classic', agentsWaiting],
]

const stored = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}
const next = {}
const failed = []
mkdirSync(OUT, { recursive: true })
for (const [name, lang, theme, data] of CASES) {
  setThemes({})
  setBotColor(null)
  setLanguage(lang)
  setTheme(theme)
  resetOffice()
  setGeometry(1320, 700)
  const frame = render(NOW, data(NOW))
  const hash = createHash('sha256').update(Buffer.from(frame.fb.buffer, frame.fb.byteOffset, frame.fb.byteLength)).digest('hex').slice(0, 16)
  next[name] = hash
  if (!isUpdate && stored[name] !== hash) {
    const path = join(OUT, `${name}.png`)
    png(path, frame)
    failed.push(`${name}: ${stored[name] ?? '(kayıt yok)'} → ${hash}, çizilen: ${path}`)
  }
}

if (isUpdate) {
  writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n')
  for (const [name, lang, theme, data] of CASES) {
    setThemes({}); setBotColor(null); setLanguage(lang); setTheme(theme); resetOffice(); setGeometry(1320, 700)
    png(join(OUT, `${name}.png`), render(NOW, data(NOW)))
  }
  console.log(`güncellendi: ${FILE}\nPNG'ler: ${OUT}`)
} else {
  assert.deepEqual(failed, [], `Ofis çizimi değişti:\n${failed.join('\n')}\nBilerek yapıldıysa: UPDATE_SNAPSHOTS=1 node app/test/visual.test.mjs`)
  console.log('ok', Object.keys(next).length, 'görüntü')
}
