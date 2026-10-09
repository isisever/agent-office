#!/usr/bin/env node
// Agent Office: shows Claude Code agents in a full-screen, room-divided 8-bit pixel-art office.
// Written for terminals with the kitty graphics protocol (Ghostty, kitty, WezTerm); no dependencies.
// The drawing itself lives in ./core.mjs (shared with the Agent Office app); this file reads the
// settings, themes and session files, encodes PNGs and drives the terminal.
//
//   node office.mjs                              live: ~/.claude/agent-office/sessions/*.json
//   node office.mjs --demo                       demo with fake agents
//   node office.mjs --snapshot a.png 1920x1000 [now]   writes one frame as PNG
//   node office.mjs --frames <dir> <W>x<H>       writes changed frames to <dir>/frame.png (plugin band)
//   node office.mjs --below --project <name>     split mode opened by /office: scene + Claude transcript + task line
//     --grow-from <ghostty terminal id>          shrinks the terminal below to --terminal-rows rows (14);
//                                                Ghostty only: in kitty and WezTerm /office sizes the split itself
//     --project <name>                           only show sessions of this project; picks its theme
//     --theme <name>                             force a theme (classic, or any name from themes.json)
//
// Type a task on the bottom line and press Enter to send it to the open Claude Code session.
// Ctrl-C quits, Ctrl-T toggles demo mode.
//
// Language: Turkish when the first non-empty of LC_ALL, LC_MESSAGES, LANG starts with "tr",
// English otherwise (see STRINGS). ~/.claude/agent-office/settings.json can override it:
//   { "language": "tr" | "en" | "auto", "forgetMinutes": 5, "botColor": "#3fb6a8" }   // forgetMinutes: delivered bots stay 1-60 min
//
// Themes: every project gets its own palette generated from its folder name (wall sign = folder
// name, title = "<FOLDER NAME> OFFICE"). The plain "classic" theme is used when there is no project.
// Add or override themes in ~/.claude/agent-office/themes.json:
//   {
//     "acme": {
//       "match": "acme",            // case-insensitive substring of the project folder name
//       "title": "ACME HQ",         // optional; default "<SIGN> OFFICE"
//       "sign": "ACME",             // optional; text on the wall sign
//       "colors": { "accent": "#ff8800", "frame": "#101820" }   // any key of C in core.mjs, "#rrggbb"
//     }
//   }

import { execFile } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { FRAME_MS, demoOffice, render, resetOffice, setBotColor, setGeometry, setLanguage, setPartyMinutes, setTheme, setThemes, themeColors, themeInfo } from './core.mjs'

const { deflateSync } = zlib
// zlib.crc32 needs Node 20.15+; plain-JS fallback for older Node
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 =
  zlib.crc32 ??
  (buf => {
    let c = 0xffffffff
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  })

const ROOT = join(homedir(), '.claude', 'agent-office')
const SESSIONS = join(ROOT, 'sessions')
const INBOX = join(ROOT, 'inbox')
// settings.json: { "language": "tr" | "en" | "auto", "forgetMinutes": 1-60 }; missing or invalid → defaults
// (same rules as the plugin's hooks/register.tsx readSettings, so both sides agree)
const SETTINGS = (() => {
  let raw
  try {
    raw = JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8'))
  } catch {}
  const s = raw !== null && typeof raw === 'object' ? raw : {}
  const language = s.language === 'tr' || s.language === 'en' ? s.language : undefined
  const minutes = typeof s.forgetMinutes === 'number' && Number.isFinite(s.forgetMinutes) ? s.forgetMinutes : 5
  const botColor = /^#[0-9a-f]{6}$/i.test(s.botColor ?? '') ? parseInt(s.botColor.slice(1), 16) : null
  return { language, forgetMinutes: Math.min(60, Math.max(1, minutes)), botColor }
})()
const LIVE_MS = 3 * 60 * 1000

// ---------- dil (i18n) ----------
// settings.json "language" if set, else Turkish if the first non-empty of LC_ALL, LC_MESSAGES, LANG starts with "tr", otherwise English.
// Ofisin içindeki yazılar core.mjs'te (setLanguage); burada yalnız terminal satırları.
const LOCALE = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG].find(v => v) ?? ''
const LANG = SETTINGS.language ?? (/^tr/i.test(LOCALE) ? 'tr' : 'en')
const STRINGS = {
  tr: {
    demoProject: 'gösteri',
    noSession: 'açık oturum yok',
    statusRight: (working, delivered, clock) => `${working} çalışıyor · ${delivered} teslim · ${clock} `,
    hintBelow: "Görevi yaz, Enter ile Claude'a gönder · onay isterse Claude terminaline bak · Ctrl-C çıkış",
    hint: 'Görevi yaz, Enter ile müdüre gönder · Ctrl-C çıkış · Ctrl-T gösteri',
    prompt: ' › Görev: ',
    feedEmpty: "Claude'un akışı burada görünecek.",
    demoNoSend: 'Gösteri modunda görev gönderilmez (Ctrl-T ile kapat).',
    noSessionFound: 'Açık bir Claude Code oturumu bulunamadı.',
    sent: task => `✓ Müdüre iletildi: ${task}`,
    needTerminal: 'Agent Ofis bir terminalde çalışmalı (kitty grafik protokolü, ör. Ghostty).',
    themesBroken: (path, error) => `⚠ ${path} okunamadı, varsayılan temalar kullanılıyor: ${error}`,
  },
  en: {
    demoProject: 'demo',
    noSession: 'no open session',
    statusRight: (working, delivered, clock) => `${working} working · ${delivered} delivered · ${clock} `,
    hintBelow: 'Type a task, Enter sends it to Claude · if it asks for approval, check the Claude terminal · Ctrl-C quit',
    hint: 'Type a task, Enter sends it to the boss · Ctrl-C quit · Ctrl-T demo',
    prompt: ' › Task: ',
    feedEmpty: "Claude's transcript will appear here.",
    demoNoSend: 'Tasks are not sent in demo mode (Ctrl-T to turn it off).',
    noSessionFound: 'No open Claude Code session found.',
    sent: task => `✓ Sent to the boss: ${task}`,
    needTerminal: 'Agent Office must run in a terminal (kitty graphics protocol, e.g. Ghostty).',
    themesBroken: (path, error) => `⚠ Could not read ${path}, using the default themes: ${error}`,
  },
}
const T = STRINGS[LANG]

// ---------- çizim ayarları ----------
// çekirdek: dil, bot rengi, parti süresi (unutma süresinden 30 sn kısa, bot dosyadan silinmeden çıkıp gitsin)
setLanguage(LANG)
if (SETTINGS.botColor !== null) setBotColor('#' + SETTINGS.botColor.toString(16).padStart(6, '0'))
setPartyMinutes(SETTINGS.forgetMinutes - 0.5)
setTheme(argValue('--theme') ?? '')

// ---------- temalar ----------
// Tema proje adına (çalışma dizini) göre seçilir; eşleşen tema yoksa proje adından otomatik
// üretilir. Proje yoksa classic (kırmızı-ahşap). themes.json biçimi dosya başında.
// bozuk themes.json ofisi durdurmaz; hata themesWarning'e yazılır ve kullanıcıya gösterilir
// (--snapshot/--frames: stderr, terminal modu: alt satırda kısa bir uyarı). Dosya yoksa sessiz.
const THEMES_FILE = join(ROOT, 'themes.json')
let themesWarning = ''
try {
  const extra = JSON.parse(readFileSync(THEMES_FILE, 'utf8'))
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('expected an object of themes')
  setThemes(extra)
} catch (err) {
  if (err?.code !== 'ENOENT') themesWarning = T.themesBroken(THEMES_FILE.replace(homedir(), '~'), err?.message ?? String(err))
}

// son çizilen kare ({ fb, LW, LH, S }) ve temanın renkleri (terminal satırları için)
let shot = null
let C = themeColors()

// --project verildiyse tema ondan seçilir (veri başka projeden olsa bile)
function draw(now, data) {
  shot = render(now, data, { project: argValue('--project') })
  C = themeColors()
  return shot
}

const slugOf = p => String(p ?? '').replace(/[^\w.-]/g, '_')
const ONLY_PROJECT = argValue('--project') ? slugOf(argValue('--project')) : ''

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i > 0 ? process.argv[i + 1] : undefined
}

// ---------- veri ----------
let cached = { at: 0, data: null }

// "BUGÜN n TESLİM": yerel takvim gününde doneAt'i olan teslimler, biten oturumlar dahil.
// Kanca teslim edilen işçiyi 5 dk sonra dosyadan siler; görülen teslimler bu yüzden
// today.json'da gün anahtarıyla saklanır: { "2026-10-09": { "<oturum>/<işçi>": "<proje>" } }.
// Yalnız bugünün anahtarı tutulur; birden çok görüntüleyici yazarken kayıtlar birleştirilir.
const TODAY_FILE = join(ROOT, 'today.json')
let tally = { day: '', entries: {} }

function dayKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function readTally(day) {
  try {
    const entries = JSON.parse(readFileSync(TODAY_FILE, 'utf8'))?.[day]
    return entries && typeof entries === 'object' ? entries : {}
  } catch {
    return {}
  }
}

// bugünün teslimlerini kaydeder; yeni kayıt varsa dosyayla birleştirip yazar
function recordDeliveries(day, seen) {
  if (tally.day !== day) tally = { day, entries: readTally(day) }
  const fresh = Object.keys(seen).filter(k => !(k in tally.entries))
  if (!fresh.length) return tally.entries
  tally.entries = { ...readTally(day), ...tally.entries, ...seen }
  try {
    mkdirSync(ROOT, { recursive: true })
    const tmp = `${TODAY_FILE}.${process.pid}`
    writeFileSync(tmp, JSON.stringify({ [day]: tally.entries }))
    renameSync(tmp, TODAY_FILE)
  } catch {}
  return tally.entries
}

function loadOffice(now) {
  if (cached.data && now - cached.at < 250) return cached.data
  const data = { workers: [], shells: [], delivered: 0, isBossBusy: false, isBossAsking: false, project: '', sessionId: '', isDemo: false }
  let files = []
  try {
    files = readdirSync(SESSIONS).filter(f => f.endsWith('.json'))
  } catch {
    files = []
  }
  const day = dayKey(now)
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const seen = {}
  let newest = 0
  for (const f of files) {
    let s
    try {
      // bugün ve son LIVE_MS içinde değişmemiş dosyalar ne canlıdır ne de bugünün teslimini taşır
      if (statSync(join(SESSIONS, f)).mtimeMs < Math.min(midnight, now - LIVE_MS)) continue
      s = JSON.parse(readFileSync(join(SESSIONS, f), 'utf8'))
    } catch {
      continue
    }
    if (!s) continue
    const sessionId = f.replace(/\.json$/, '')
    for (const w of s.workers ?? []) {
      if (w?.doneAt != null && w.id != null && dayKey(w.doneAt) === day) seen[`${sessionId}/${w.id}`] = slugOf(s.project)
    }
    // kancanın kalıcı günlük kaydı: unutulan işçiler, görüntüleyici kapalıyken yapılan teslimler
    if (s.stats?.today?.date === day) for (const id of s.stats.today.ids ?? []) seen[`${sessionId}/${id}`] = slugOf(s.project)
    if (s.endedAt || now - (s.updatedAt ?? 0) > LIVE_MS) continue
    // --project verildiyse ofis yalnız o projenin oturumlarını gösterir
    if (ONLY_PROJECT && slugOf(s.project) !== ONLY_PROJECT) continue
    data.workers.push(...(s.workers ?? []))
    // sunucu odası: çalışan arka plan kabukları ve forgetMinutes içinde bitenler (uygulamayla aynı kural)
    for (const sh of Array.isArray(s.shells) ? s.shells : [])
      if (sh && (sh.endAt == null || now - sh.endAt <= SETTINGS.forgetMinutes * 60000)) data.shells.push(sh)
    data.isBossBusy ||= Boolean(s.stats?.isBossBusy)
    data.isBossAsking ||= s.stats?.waiting?.kind === 'permission'
    if (s.updatedAt > newest) {
      newest = s.updatedAt
      data.project = s.project ?? ''
      data.sessionId = sessionId
    }
  }
  data.shells.sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0))
  const entries = recordDeliveries(day, seen)
  data.delivered = Object.values(entries).filter(project => !ONLY_PROJECT || project === ONLY_PROJECT).length
  cached = { at: now, data }
  return data
}

// ---------- görüntü kodlama ----------
function encodeRGB({ fb, LW, LH, S }) {
  const W = LW * S
  const H = LH * S
  const out = Buffer.allocUnsafe(W * H * 3)
  const rowBytes = W * 3
  for (let y = 0; y < LH; y++) {
    const base = y * S * rowBytes
    let o = base
    for (let x = 0; x < LW; x++) {
      const c = fb[y * LW + x]
      const r = (c >> 16) & 255
      const g = (c >> 8) & 255
      const b = c & 255
      for (let k = 0; k < S; k++) {
        out[o++] = r
        out[o++] = g
        out[o++] = b
      }
    }
    for (let k = 1; k < S; k++) out.copyWithin(base + k * rowBytes, base, base + rowBytes)
  }
  return { rgb: out, W, H }
}

function writePng(path) {
  const { rgb, W, H } = encodeRGB(shot)
  const raw = Buffer.alloc((W * 3 + 1) * H)
  for (let y = 0; y < H; y++) rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3)
  const chunk = (type, body) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const tb = Buffer.concat([Buffer.from(type), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(tb))
    return Buffer.concat([len, tb, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  writeFileSync(
    path,
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
  )
}

const args = process.argv.slice(2)

// görüntü modlarında bozuk themes.json uyarısı stderr'e (terminal modu: alt satırda, bkz. notice)
if (themesWarning && (args[0] === '--snapshot' || args[0] === '--frames')) console.error(themesWarning)

if (args[0] === '--snapshot') {
  const [w, h] = (args[2] ?? '1920x1000').split('x').map(Number)
  setGeometry(w, h)
  const now = Number(args[3] ?? Date.now())
  draw(now, demoOffice(now))
  writePng(args[1] ?? 'office.png')
  process.exit(0)
}

// --frames <klasör> <G>x<Y>: Claude Code eklentisi için. Terminale çizmez; değişen her kareyi
// <klasör>/frame.png'ye (yarım yazılmış dosya okunmasın diye ad değiştirerek) yazar ve stdout'a
// "frame <no> <vurgu> <çerçeve> <başlık>" satırı basar. Boyut değişince eklenti süreci yeniden
// başlatır; Claude Code kapanırsa (üst süreç değişir) kendiliğinden çıkar.
const isFrames = args[0] === '--frames'
if (isFrames) {
  const dir = args[1]
  const [w, h] = (args[2] ?? '1200x400').split('x').map(Number)
  mkdirSync(dir, { recursive: true })
  setGeometry(w, h)
  let gen = 0
  let last = null
  const hex = c => c.toString(16).padStart(6, '0')
  const parent = process.ppid
  process.stdout.on('error', () => process.exit(0))
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0)
    const now = Date.now()
    const { fb } = draw(now, args.includes('--demo') ? demoOffice(now) : loadOffice(now))
    if (last && last.length === fb.length && last.every((v, i) => v === fb[i])) return
    last = fb.slice()
    gen++
    const tmp = join(dir, `.frame-${gen}.png`)
    writePng(tmp)
    renameSync(tmp, join(dir, 'frame.png'))
    process.stdout.write(`frame ${gen} ${hex(C.accent)} ${hex(C.frame)} ${themeInfo().title}\n`)
  }, 200)
}

// ---------- terminal ----------
const out = process.stdout
let isDemo = args.includes('--demo')
let term = null // { pxW, pxH, cols, rows, cellW, cellH }
let imageId = 1
let lastFrame = null
let lastStatus = ''
let input = ''
// bozuk themes.json varsa açılışta alt satırda kısa süre uyarı gösterilir
let notice = themesWarning ? { text: themesWarning, until: Date.now() + 15000, isWarn: true } : { text: '', until: 0 }
let reported = {}
let shownTheme = ''
// --below: Claude terminali altta birkaç satıra iner (izin onayları için); ofis penceresi
// sahneyi, Claude'un akışını (oturum kaydından) ve görev satırını kendi içinde gösterir.
const isBelow = args.includes('--below')
const growFrom = argValue('--grow-from')
const TERMINAL_ROWS = Number(argValue('--terminal-rows') ?? 14)
const PROJECTS = join(homedir(), '.claude', 'projects')
let feed = { sessionId: '', file: '', size: -1, at: 0, items: [] }
let grow = growFrom ? { total: 0, tries: 0, rows: 0, points: 0, ptsPerRow: 0 } : null

const rgb = c => `${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`
const fg = c => `\x1b[38;2;${rgb(c)}m`
const bg = c => `\x1b[48;2;${rgb(c)}m`

function currentData(now) {
  return isDemo ? demoOffice(now) : loadOffice(now)
}

function sendImage() {
  const { rgb: pixels, W, H } = encodeRGB(shot)
  const data = deflateSync(pixels, { level: 1 }).toString('base64')
  const prev = imageId
  imageId = imageId === 1 ? 2 : 1
  // resmi ortala: satır/sütun + hücre içi piksel kaydırma
  const offX = Math.max(0, Math.floor((term.pxW - W) / 2))
  const offY = Math.max(0, Math.floor((term.imgH - H) / 2))
  const col = Math.floor(offX / term.cellW) + 1
  const row = Math.floor(offY / term.cellH) + 2
  let s = `\x1b[${row};${col}H`
  for (let i = 0; i < data.length; i += 4096) {
    const more = i + 4096 < data.length ? 1 : 0
    const ctrl =
      i === 0
        ? `a=T,f=24,o=z,s=${W},v=${H},i=${imageId},p=1,q=2,C=1,X=${offX % term.cellW},Y=${offY % term.cellH},z=-1,m=${more}`
        : `m=${more}`
    s += `\x1b_G${ctrl};${data.slice(i, i + 4096)}\x1b\\`
  }
  s += `\x1b_Ga=d,d=I,i=${prev},q=2\x1b\\`
  out.write(s)
}

// ---------- Claude akışı (oturum kaydı) ----------
function transcriptOf(sessionId) {
  try {
    for (const dir of readdirSync(PROJECTS)) {
      const file = join(PROJECTS, dir, `${sessionId}.jsonl`)
      if (existsSync(file)) return file
    }
  } catch {}
  return ''
}

function toolLine(block) {
  const input = block.input ?? {}
  const arg = input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.url ?? input.query ?? input.prompt ?? ''
  return `${block.name}${arg ? ': ' + String(arg).replace(/\s+/g, ' ') : ''}`
}

function userLine(text) {
  const cmd = /<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([^<]*)<\/command-args>)?/.exec(text)
  if (cmd) return `${cmd[1]} ${cmd[2] ?? ''}`.trim()
  if (text.startsWith('<')) return ''
  return text.replace(/\s+/g, ' ').trim()
}

// kaydın son ~256 KB'ını okur; değişmediyse eskisini döner
function loadFeed(sessionId, now) {
  if (!sessionId) return []
  if (feed.sessionId !== sessionId) feed = { sessionId, file: transcriptOf(sessionId), size: -1, at: 0, items: [] }
  if (!feed.file || now - feed.at < 700) return feed.items
  feed.at = now
  let size = 0
  try {
    size = statSync(feed.file).size
  } catch {
    return feed.items
  }
  if (size === feed.size) return feed.items
  feed.size = size
  const length = Math.min(size, 256 * 1024)
  const buf = Buffer.alloc(length)
  const fd = openSync(feed.file, 'r')
  try {
    readSync(fd, buf, 0, length, size - length)
  } finally {
    closeSync(fd)
  }
  const items = []
  for (const row of buf.toString('utf8').split('\n').slice(size > length ? 1 : 0)) {
    let d
    try {
      d = JSON.parse(row)
    } catch {
      continue
    }
    if (d.isSidechain || d.isMeta) continue
    const content = d.message?.content
    if (d.type === 'user' && typeof content === 'string') {
      const line = userLine(content)
      if (line) items.push({ kind: 'user', text: line })
    } else if (d.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) items.push({ kind: 'text', text: block.text.trim() })
        else if (block.type === 'tool_use') items.push({ kind: 'tool', text: toolLine(block) })
      }
    }
  }
  feed.items = items.slice(-120)
  return feed.items
}

// akışı satırlara böler; en yeni satırlar altta
function feedRows(items, cols, count) {
  const width = Math.max(10, cols - 4)
  const lines = []
  for (const item of items) {
    const mark = { user: '› ', text: '● ', tool: '  ⎿ ' }[item.kind]
    const color = { user: C.accent, text: C.statusText, tool: C.dim }[item.kind]
    const parts = item.kind === 'tool' ? [item.text] : item.text.split('\n').filter(l => l.trim())
    parts.forEach((part, p) => {
      const chars = [...part]
      const lead = p === 0 ? mark : ' '.repeat([...mark].length)
      const room = width - [...lead].length
      for (let i = 0; i < chars.length || i === 0; i += room) {
        lines.push({ color, isBold: item.kind === 'user', text: (i === 0 ? lead : ' '.repeat([...lead].length)) + chars.slice(i, i + room).join('') })
        if (item.kind === 'tool') break // araç satırı tek satır
      }
    })
  }
  return lines.slice(-count)
}

function feedHeight(rows) {
  return Math.max(5, Math.min(18, Math.round(rows * 0.32)))
}

function statusLines(now, data) {
  const cols = term.cols
  const working = data.workers.filter(w => w.doneAt == null).length
  const clockText = new Date(now).toTimeString().slice(0, 5)
  const name = data.project || (data.isDemo ? T.demoProject : T.noSession)
  const title = themeInfo().title
  const left = ` ${title}  ${name}`
  const right = T.statusRight(working, data.delivered, clockText)
  const pad = Math.max(1, cols - [...left].length - [...right].length)
  const top = `\x1b[1;1H${bg(C.frame)}${fg(C.accent)}\x1b[1m ${title}\x1b[22m${fg(C.dim)}  ${name}${' '.repeat(pad)}${fg(0xe8e6e3)}${right}\x1b[0m`
  const idle = isBelow ? T.hintBelow : T.hint
  const hint = notice.until > now ? notice.text : idle
  const prompt = T.prompt
  const room = Math.max(4, cols - [...prompt].length - 2)
  const shown = [...input].slice(-room).join('')
  const line1 = `\x1b[${term.rows - 1};1H${bg(C.statusBg)}${fg(C.accent)}\x1b[1m${prompt}\x1b[22m${fg(C.statusText)}${shown}${fg(C.accent)}▌\x1b[0m${bg(C.statusBg)}\x1b[K\x1b[0m`
  const line2 = `\x1b[${term.rows};1H${bg(C.frame)}${fg(notice.until > now ? (notice.isWarn ? C.yellow : C.good) : C.dim)} ${[...hint].slice(0, cols - 2).join('')}\x1b[K\x1b[0m`
  if (!isBelow) return top + line1 + line2
  // Claude'un akışı: görev satırının hemen üstünde, temanın renginde
  const height = feedHeight(term.rows)
  const first = term.rows - 2 - height
  const rule = `\x1b[${first};1H${bg(C.frame)}${fg(C.accent)}${'─'.repeat(cols)}\x1b[0m`
  const lines = feedRows(loadFeed(data.sessionId, now), cols, height)
  let body = ''
  for (let i = 0; i < height; i++) {
    const line = lines[i - (height - lines.length)]
    const textPart = line ? `${fg(line.color)}${line.isBold ? '\x1b[1m' : ''} ${line.text}\x1b[22m` : ''
    body += `\x1b[${first + 1 + i};1H${bg(C.statusBg)}${textPart}${bg(C.statusBg)}\x1b[K\x1b[0m`
  }
  if (!lines.length) body += `\x1b[${first + 1};1H${bg(C.statusBg)}${fg(C.dim)} ${T.feedEmpty}\x1b[0m`
  return top + rule + body + line1 + line2
}

function frame() {
  if (!term) return
  const now = Date.now()
  const data = currentData(now)
  const { fb } = draw(now, data)
  if (shownTheme !== themeInfo().name) {
    shownTheme = themeInfo().name
    out.write(`\x1b]11;#${C.frame.toString(16).padStart(6, '0')}\x1b\\`)
  }
  const status = statusLines(now, data)
  if (status !== lastStatus) {
    lastStatus = status
    out.write(status)
  }
  if (lastFrame && lastFrame.length === fb.length && lastFrame.every((v, i) => v === fb[i])) return
  lastFrame = fb.slice()
  sendImage()
}

function applyGeometry(pxW, pxH, cols, rows) {
  const cellW = pxW / cols
  const cellH = pxH / rows
  term = { pxW, pxH, cols, rows, cellW, cellH, imgH: Math.floor(cellH * (rows - 3 - (isBelow ? feedHeight(rows) + 1 : 0))) }
  setGeometry(pxW, term.imgH)
  lastFrame = null
  lastStatus = ''
  out.write(`${bg(C.frame)}\x1b[2J\x1b_Ga=d,d=A,q=2\x1b\\`)
  frame()
  growOffice()
}

// /office bölmeyi yarı yarıya açar; alttaki Claude terminalini TERMINAL_ROWS satıra indirmek
// için ayracı aşağı iter. Punto/satır oranı ilk denemede ölçülür, sonraki adım onunla düzeltilir.
function growOffice() {
  if (!grow) return
  if (grow.points && term.rows > grow.rows) grow.ptsPerRow = grow.points / (term.rows - grow.rows)
  if (!grow.total) grow.total = term.rows * 2
  const missing = grow.total - TERMINAL_ROWS - term.rows
  if (missing <= 0 || grow.tries >= 5) {
    grow = null
    return
  }
  grow.tries += 1
  grow.rows = term.rows
  grow.points = Math.max(8, Math.round(missing * (grow.ptsPerRow || term.cellH / 2)))
  const script = `tell application "Ghostty" to perform action "resize_split:down,${grow.points}" on terminal id "${growFrom}"`
  execFile('/usr/bin/osascript', ['-e', script], error => {
    if (error) grow = null
  })
}

function askGeometry() {
  out.write('\x1b[14t\x1b[18t')
  setTimeout(() => {
    if (term) return
    const cols = out.columns || 120
    const rows = out.rows || 40
    applyGeometry(cols * 9, rows * 19, cols, rows)
  }, 600)
}

function submitTask() {
  const textToSend = input.trim()
  input = ''
  if (!textToSend) return
  const data = loadOffice(Date.now())
  if (isDemo || !data.sessionId) {
    notice = { text: isDemo ? T.demoNoSend : T.noSessionFound, until: Date.now() + 4000 }
    return
  }
  mkdirSync(INBOX, { recursive: true })
  appendFileSync(join(INBOX, `${data.sessionId}.jsonl`), JSON.stringify({ at: Date.now(), text: textToSend }) + '\n')
  notice = { text: T.sent(textToSend), until: Date.now() + 5000 }
}

function onInput(chunk) {
  let s = chunk.toString('utf8')
  let m
  while ((m = /\x1b\[(4|8);(\d+);(\d+)t/.exec(s))) {
    s = s.slice(0, m.index) + s.slice(m.index + m[0].length)
    if (m[1] === '4') reported.px = [Number(m[3]), Number(m[2])]
    else reported.cells = [Number(m[3]), Number(m[2])]
  }
  if (reported.px && reported.cells) {
    const [w, h] = reported.px
    const [cols, rows] = reported.cells
    reported = {}
    applyGeometry(w, h, cols, rows)
  }
  s = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1bO./g, '')
  for (const ch of s) {
    if (ch === '\x03') quit()
    else if (ch === '\x14') {
      isDemo = !isDemo
      resetOffice()
    } else if (ch === '\r' || ch === '\n') submitTask()
    else if (ch === '\x7f' || ch === '\b') input = [...input].slice(0, -1).join('')
    else if (ch === '\x1b') input = ''
    else if (ch === '\x15') input = ''
    else if (ch >= ' ') input += ch
  }
  lastStatus = ''
}

function quit() {
  out.write('\x1b_Ga=d,d=A,q=2\x1b\\\x1b]111\x1b\\\x1b[0m\x1b[2J\x1b[?25h\x1b[?1049l')
  process.exit(0)
}

// terminal modu (kare modunda terminale hiç dokunulmaz)
if (!isFrames) {
  if (!out.isTTY) {
    console.error(T.needTerminal)
    process.exit(1)
  }
  out.write(`\x1b[?1049h\x1b[?25l\x1b]11;#${C.frame.toString(16).padStart(6, '0')}\x1b\\`)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', onInput)
  process.on('SIGWINCH', () => {
    term = null
    askGeometry()
  })
  process.on('SIGTERM', quit)
  process.on('SIGHUP', quit)
  askGeometry()
  setInterval(frame, FRAME_MS)
}
