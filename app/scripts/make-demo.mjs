// The README's demo GIF: a ~10 s live scene drawn with the shared office renderer (src/office/core.mjs).
// node app/scripts/make-demo.mjs → plugin/docs/demo.gif (needs ffmpeg; override with FFMPEG=/path/ffmpeg)
// Three projects: workers arrive, work, deliver to the boss and go to the party; a server runs in the background,
// midway the boss's sign says NEEDS YOU for a while. Frames are written as PNGs to a temp folder, ffmpeg makes the GIF.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { render, resetOffice, setBotColor, setGeometry, setLanguage, setTheme, setThemes } from '../src/office/core.mjs'

const app = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(app, '..', 'plugin', 'docs', 'demo.gif')
const FFMPEG = process.env.FFMPEG || (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg')
// clock and day are drawn in local time: the same GIF on every machine
process.env.TZ = 'Europe/Istanbul'
const T0 = new Date(2026, 9, 9, 11, 0, 0).getTime() // start of the recording
const FPS = 12
const SECONDS = 10
const WARMUP_S = 45 // party and seat state builds up frame by frame: drawn silently before recording
const SCALE = 2 // logical pixels → GIF pixels (400×242 → 800×484)

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

// ---------- script (seconds from the start of the recording) ----------
const s = sec => T0 + sec * 1000
// [id, project, kind, arrival, delivery (none: still working), succeeded, tools]
const CAST = [
  ['w1', 'shop-api', 'Explore', -44, -30, true, ['Grep', 'Read']],
  ['w2', 'notes', 'general-purpose', -42, -26, true, ['Edit', 'Bash']],
  ['w3', 'docs-site', 'Plan', -40, -22, true, ['Read', 'WebFetch']],
  ['w12', 'notes', 'Explore', -38, -16, true, ['Grep', 'Read']],
  ['w13', 'shop-api', 'Plan', -36, -12, true, ['Read', 'Glob']],
  ['w14', 'docs-site', 'Explore', -34, -8, true, ['Grep', 'Read']],
  ['w4', 'shop-api', 'code-reviewer', -30, 1.2, true, ['Read', 'Grep', 'Read']],
  ['w5', 'notes', 'Explore', -26, null, true, ['Glob', 'Grep', 'Read', 'Grep']],
  ['w6', 'docs-site', 'general-purpose', -24, 3.8, false, ['Bash', 'Edit', 'Bash']],
  ['w7', 'shop-api', 'general-purpose', -20, null, true, ['Edit', 'Bash', 'Write', 'Bash']],
  ['w8', 'notes', 'Plan', -18, 6.4, true, ['Read', 'WebSearch', 'Read']],
  ['w9', 'shop-api', 'Explore', 0.3, null, true, ['Glob', 'Read', 'Grep']],
  ['w10', 'docs-site', 'code-reviewer', 2.6, null, true, ['Read', 'Grep']],
  ['w11', 'notes', 'general-purpose', 5.2, null, true, ['Bash', 'Edit']],
]
const PROJECTS = ['shop-api', 'notes', 'docs-site']
const BASE_DELIVERED = { 'shop-api': 5, notes: 3, 'docs-site': 2 } // today's deliveries from earlier sessions
const ASK = [s(5.5), s(8)] // shop-api waits for approval of a Bash call

function officeAt(now) {
  const workers = []
  for (const [id, project, type, spawn, done, isOk, tools] of CAST) {
    const spawnAt = s(spawn)
    if (spawnAt > now) continue
    const doneAt = done != null && s(done) <= now ? s(done) : undefined
    const tool = tools[Math.floor((now - spawnAt) / 2600) % tools.length]
    workers.push({ id, project, type, description: type, spawnAt, doneAt, isOk, tool })
  }
  const isAsking = now >= ASK[0] && now < ASK[1]
  const projects = PROJECTS.map(name => {
    const mine = workers.filter(w => w.project === name)
    const working = mine.filter(w => w.doneAt == null).length
    return {
      name,
      working,
      delivered: BASE_DELIVERED[name] + mine.filter(w => w.doneAt != null).length,
      isBossBusy: working > 0 || name === 'shop-api',
      waiting: isAsking && name === 'shop-api' ? { tool: 'Bash', since: ASK[0] } : null,
    }
  })
  const shells = [
    { id: 'sh1', command: 'npm run dev', startAt: s(-120), status: 'running', project: 'shop-api' },
    { id: 'sh2', command: 'pytest -q', startAt: s(-40), endAt: s(-12), exitCode: 0, status: 'completed', project: 'notes' },
  ]
  if (now >= s(3)) shells.push({ id: 'sh3', command: 'hugo server', startAt: s(3), status: 'running', project: 'docs-site' })
  return {
    workers,
    delivered: projects.reduce((n, p) => n + p.delivered, 0),
    isBossBusy: true,
    isBossAsking: isAsking,
    projects,
    shells,
    project: 'shop-api',
    sessionId: '',
  }
}

// ---------- frames ----------
setThemes({})
setBotColor(null)
setLanguage('en')
setTheme('classic')
resetOffice()
const { LW, LH } = setGeometry(800, 484)
for (let t = T0 - WARMUP_S * 1000; t < T0; t += 110) render(t, officeAt(t))

const dir = mkdtempSync(join(tmpdir(), 'agent-office-demo-'))
const count = FPS * SECONDS
for (let i = 0; i < count; i++) {
  const now = T0 + Math.round((i * 1000) / FPS)
  png(join(dir, `frame-${String(i).padStart(4, '0')}.png`), render(now, officeAt(now)))
}

mkdirSync(dirname(OUT), { recursive: true })
// one palette for all frames; no dithering: pixel art stays flat colour
const filter = `scale=${LW * SCALE}:${LH * SCALE}:flags=neighbor,split[a][b];[a]palettegen=max_colors=96:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`
execFileSync(FFMPEG, ['-v', 'error', '-y', '-framerate', String(FPS), '-i', join(dir, 'frame-%04d.png'), '-vf', filter, '-loop', '0', OUT], { stdio: 'inherit' })
if (process.env.KEEP_FRAMES) console.log(`kareler: ${dir}`)
else rmSync(dir, { recursive: true, force: true })
console.log(`${OUT}: ${count} kare, ${SECONDS} sn, ${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`)
