#!/usr/bin/env node
// Agent Office: shows Claude Code agents in a full-screen, room-divided 8-bit pixel-art office.
// Written for terminals with the kitty graphics protocol (Ghostty, kitty, WezTerm); no dependencies.
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
//   { "language": "tr" | "en" | "auto", "forgetMinutes": 5 }   // forgetMinutes: delivered bots stay 1-60 min
//
// Themes: every project gets its own palette generated from its folder name (wall sign = folder
// name, title = "<FOLDER NAME> OFFICE"). The plain "classic" theme is used when there is no project.
// Add or override themes in ~/.claude/agent-office/themes.json:
//   {
//     "acme": {
//       "match": "acme",            // case-insensitive substring of the project folder name
//       "title": "ACME HQ",         // optional; default "<SIGN> OFFICE"
//       "sign": "ACME",             // optional; text on the wall sign
//       "colors": { "accent": "#ff8800", "frame": "#101820" }   // any key of C below, "#rrggbb"
//     }
//   }

import { execFile } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'

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
  return { language, forgetMinutes: Math.min(60, Math.max(1, minutes)) }
})()
const SPEED = 40 / 1000 // mantıksal piksel / ms
const HANDOFF_MS = 1500
const SETTLE_MS = 500
const SIT = 4
const LIVE_MS = 3 * 60 * 1000
// teslimden sonra parti alanında kalma süresi; eklentinin unutma süresinden (forgetMinutes, varsayılan 5 dk)
// 30 sn kısa, bot dosyadan silinmeden çıkıp gitsin
const PARTY_MS = SETTINGS.forgetMinutes * 60 * 1000 - 30 * 1000
const BEAT_MS = 420
const FRAME_MS = 110
const DESIGN_W = 330
const DESIGN_H = 200

// ---------- renkler ----------
const C = {
  frame: 0x2b1d1a, ol: 0x3a2a22, wallTop: 0x6e4b3a, wallTopHi: 0x84604a,
  brick: 0xb5654a, brickDark: 0x9c4f3a, mortar: 0xc98b6e,
  cream: 0xf0e2c2, creamStripe: 0xe6d4ae, sage: 0x9cb38f, sageStripe: 0x93aa86,
  panel: 0x7a8090, panelDark: 0x6a7080, wainscot: 0xb58553, wainscotDark: 0x9a6c40,
  checkA: 0xf1e3c6, checkB: 0xdcc59c, woodA: 0xc79a64, woodB: 0xbb8d58, woodSeam: 0x9c7244,
  serverA: 0x5b6170, serverB: 0x525866, carpetA: 0xd9c9a3, carpetB: 0xd1c09a,
  rugRed: 0xa8434f, rugRedIn: 0x8a3340, rugGold: 0xe0b45a, rugCream: 0xe9dcc0, rugBlue: 0x5e7fa8, rugBlueIn: 0x4d6a90,
  book: [0xc0504d, 0x4f81bd, 0x9bbb59, 0xf2c14e, 0x8064a2, 0x3fb6a8, 0x3f8f8a],
  shelf: 0x7a4f30, shelfDark: 0x5a3820, leaf: 0x4fa65a, leafDark: 0x3a8046, leafHi: 0x7cc47f, pot: 0xc0663f, potDark: 0x9a4e2e,
  lampShade: 0xf3d9a0, lampShadeDark: 0xd9b874, lampPole: 0x4a3a30, glow: 0xfff1c4,
  sky: 0x8fd0f2, skyLow: 0xb5e2f7, dusk: 0xf0a35e, duskLow: 0xf7c98a, night: 0x1b2140, nightLow: 0x262d55,
  cloud: 0xffffff, star: 0xfff6c8, moon: 0xf3eccb, glass: 0xe8f4fa,
  deskTop: 0xd8a56a, deskEdge: 0xe9bd85, deskFront: 0xa8743f, deskLeg: 0x6a4425, plate: 0xf3d9b0,
  chair: 0x3b4252, chairHi: 0x535c70, bossChair: 0x6a2c36, bossChairHi: 0x8a4450,
  lid: 0xd6d8de, lidDark: 0xa9adb8, logo: 0x3fb6a8, logoOn: 0xa8f0e6, mug: 0xf4efe6, coffee: 0x6b4226,
  body: 0x3fb6a8, bodyHi: 0x6fd6c9, shade: 0x2b8a7f, eye: 0x1a1a1a, tie: 0x2a3a6a, tieKnot: 0x1d2a50,
  paper: 0xf7f6f0, ink: 0x9a9a9a, bad: 0xe05050, good: 0x3fae55,
  white: 0xffffff, dark: 0x1d1a24, yellow: 0xf2c14e, accent: 0x3fb6a8, dim: 0xb8b0a4,
  chairCream: 0xebdcbc, chairCreamDark: 0xcdb990, chairCushion: 0xa87a52,
  table: 0x8a5a36, tableTop: 0xa8703f, machine: 0x3a3d45, machineHi: 0x5a5e68, red: 0xe5483f, green: 0x5fd068, blue: 0x5aa7e8,
  rack: 0x2a2e38, rackHi: 0x3b404c, cabinet: 0x9aa0aa, cabinetDark: 0x7d838e,
  signGreen: 0x2f5d46, signGreenDark: 0x234736, gold: 0xe8c35a,
  board: 0xf7f7f2, boardFrame: 0xb0b4bc, marker: 0x3b6fd1,
  cooler: 0xdfe8ee, water: 0x7cc3ea, mat: 0x8a6a4a, matDark: 0x6e5238,
  cat: 0x8a8f99, catDark: 0x6c717b, basket: 0xb88a52, basketDark: 0x936a3a, pillow: 0xd98a8a,
  windowFrame: 0xffffff, statusBg: 0x231815, statusText: 0xf3ead8,
  neon: [0xff4fd8, 0x4ff0ff, 0xb6ff4f, 0xffd84f, 0x9b6bff], neonTube: 0xff4fd8, neonGlow: 0xffb3ef,
  mirror: 0xe4e8ef, mirrorDark: 0x8a909c, floorDark: 0x2a2440,
}

// ---------- dil (i18n) ----------
// settings.json "language" if set, else Turkish if the first non-empty of LC_ALL, LC_MESSAGES, LANG starts with "tr", otherwise English.
const LOCALE = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG].find(v => v) ?? ''
const LANG = SETTINGS.language ?? (/^tr/i.test(LOCALE) ? 'tr' : 'en')
const STRINGS = {
  tr: {
    office: 'OFİS',
    boss: 'MÜDÜR',
    working: 'ÇALIŞIYOR',
    waiting: 'BEKLİYOR',
    thinking: 'DÜŞÜNÜYOR',
    today: 'BUGÜN',
    delivered: n => `${n} TESLİM`,
    types: { 'general-purpose': 'GENEL', Explore: 'KEŞİF', Plan: 'PLAN', 'claude-code-guide': 'REHBER' },
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
    office: 'OFFICE',
    boss: 'BOSS',
    working: 'WORKING',
    waiting: 'WAITING',
    thinking: 'THINKING',
    today: 'TODAY',
    delivered: n => `${n} DONE`,
    types: { 'general-purpose': 'GENERAL', Explore: 'EXPLORE', Plan: 'PLAN', 'claude-code-guide': 'GUIDE' },
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

// ---------- temalar ----------
// Tema proje adına (çalışma dizini) göre seçilir; eşleşen tema yoksa proje adından otomatik
// üretilir (projectTheme). Proje yoksa classic (kırmızı-ahşap). themes.json biçimi dosya başında.
const BASE = { ...C }
const THEMES = {
  classic: { sign: 'AGENT', colors: {} },
}
// bozuk themes.json ofisi durdurmaz; hata themesWarning'e yazılır ve kullanıcıya gösterilir
// (--snapshot/--frames: stderr, terminal modu: alt satırda kısa bir uyarı). Dosya yoksa sessiz.
const THEMES_FILE = join(ROOT, 'themes.json')
let themesWarning = ''
try {
  const extra = JSON.parse(readFileSync(THEMES_FILE, 'utf8'))
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('expected an object of themes')
  for (const [name, t] of Object.entries(extra)) {
    const colors = Object.fromEntries(
      Object.entries(t?.colors ?? {}).map(([k, v]) => [k, typeof v === 'string' ? parseInt(v.replace('#', ''), 16) : v]),
    )
    THEMES[name] = { ...THEMES[name], ...t, colors: { ...THEMES[name]?.colors, ...colors } }
  }
} catch (err) {
  if (err?.code !== 'ENOENT') themesWarning = T.themesBroken(THEMES_FILE.replace(homedir(), '~'), err?.message ?? String(err))
}

// başlık verilmemişse "<TABELA> OFİS/OFFICE"
const titleOf = theme => theme.title ?? `${normalize(theme.sign ?? 'AGENT')} ${T.office}`

let THEME = THEMES.classic
let themeName = ''

const slugOf = p => String(p ?? '').replace(/[^\w.-]/g, '_')
const ONLY_PROJECT = argValue('--project') ? slugOf(argValue('--project')) : ''

function themeFor(project) {
  const forced = argValue('--theme')
  if (forced && THEMES[forced]) return forced
  const name = String(project ?? '').toLowerCase()
  for (const [key, t] of Object.entries(THEMES)) if (t.match && name.includes(String(t.match).toLowerCase())) return key
  return name ? `auto:${project}` : 'classic'
}

function hsl(h, s, l) {
  const k = n => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))
  return (f(0) << 16) | (f(8) << 8) | f(4)
}

// eşleşen tema yoksa proje adından kendi temasını üretir: adın tonu duvar, halı, çerçeve, vurgu
function projectTheme(project) {
  const hue = strHash(String(project).toLowerCase()) % 360
  const label = String(project).split('/').filter(Boolean).pop() || 'AGENT'
  return {
    sign: label,
    colors: {
      frame: hsl(hue, 0.35, 0.1), ol: hsl(hue, 0.3, 0.16), wallTop: hsl(hue, 0.35, 0.32), wallTopHi: hsl(hue, 0.35, 0.4),
      brick: hsl(hue, 0.4, 0.48), brickDark: hsl(hue, 0.4, 0.4), mortar: hsl(hue, 0.35, 0.68),
      rugRed: hsl(hue, 0.45, 0.42), rugRedIn: hsl(hue, 0.45, 0.34), bossChair: hsl(hue, 0.4, 0.28), bossChairHi: hsl(hue, 0.4, 0.38),
      accent: hsl(hue, 0.6, 0.55), logo: hsl(hue, 0.6, 0.55), logoOn: hsl(hue, 0.8, 0.8), dim: hsl(hue, 0.15, 0.72),
      signGreen: hsl(hue, 0.35, 0.25), signGreenDark: hsl(hue, 0.35, 0.18),
      windowFrame: hsl(hue, 0.5, 0.88), statusBg: hsl(hue, 0.35, 0.14), statusText: hsl(hue, 0.3, 0.92),
    },
  }
}

// tema değiştiyse renkleri yükler; true dönerse arka plan yeniden çizilmeli
function useTheme(name) {
  if (name === themeName) return false
  themeName = name
  if (name.startsWith('auto:') && !THEMES[name]) THEMES[name] = projectTheme(name.slice(5))
  THEME = THEMES[name]
  Object.assign(C, BASE, THEME.colors)
  return true
}

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i > 0 ? process.argv[i + 1] : undefined
}

// ---------- 3x5 piksel yazı ----------
const FONT = {
  A: '.#.#.####.##.#', B: '##.#.###.#.###.', C: '.###..#..#...##', D: '##.#.##.##.###.', E: '####..##.#..###',
}
const ROWS = {
  A: '.#. #.# ### #.# #.#', B: '##. #.# ##. #.# ##.', C: '.## #.. #.. #.. .##', D: '##. #.# #.# #.# ##.',
  E: '### #.. ##. #.. ###', F: '### #.. ##. #.. #..', G: '.## #.. #.# #.# .##', H: '#.# #.# ### #.# #.#',
  I: '### .#. .#. .#. ###', J: '..# ..# ..# #.# .#.', K: '#.# #.# ##. #.# #.#', L: '#.. #.. #.. #.. ###',
  M: '#.# ### ### #.# #.#', N: '##. #.# #.# #.# #.#', O: '.#. #.# #.# #.# .#.', P: '##. #.# ##. #.. #..',
  Q: '.#. #.# #.# ##. .##', R: '##. #.# ##. #.# #.#', S: '.## #.. .#. ..# ##.', T: '### .#. .#. .#. .#.',
  U: '#.# #.# #.# #.# ###', V: '#.# #.# #.# #.# .#.', W: '#.# #.# ### ### #.#', X: '#.# #.# .#. #.# #.#',
  Y: '#.# #.# .#. .#. .#.', Z: '### ..# .#. #.. ###',
  0: '### #.# #.# #.# ###', 1: '.#. ##. .#. .#. ###', 2: '##. ..# .#. #.. ###', 3: '##. ..# .#. ..# ##.',
  4: '#.# #.# ### ..# ..#', 5: '### #.. ##. ..# ##.', 6: '.## #.. ### #.# ###', 7: '### ..# .#. .#. .#.',
  8: '### #.# ### #.# ###', 9: '### #.# ### ..# ##.',
  '.': '... ... ... ... .#.', ':': '... .#. ... .#. ...', '-': '... ... ### ... ...', '/': '..# ..# .#. #.. #..',
  '!': '.#. .#. .#. ... .#.', '?': '##. ..# .#. ... .#.', '(': '.#. #.. #.. #.. .#.', ')': '.#. ..# ..# ..# .#.',
  '_': '... ... ... ... ###', ',': '... ... ... .#. #..', '+': '... .#. ### .#. ...', '>': '#.. .#. ..# .#. #..',
  "'": '.#. .#. ... ... ...', ' ': '... ... ... ... ...',
  '#': '#.# ### #.# ### #.#', '=': '... ### ... ### ...', '<': '..# .#. #.. .#. ..#', '*': '... #.# .#. #.# ...',
  '%': '#.# ..# .#. #.. #.#', '&': '.#. #.# .#. #.# .##', '@': '### #.# ### #.. .##', '"': '#.# #.# ... ... ...',
  ';': '... .#. ... .#. #..', '[': '##. #.. #.. #.. ##.', ']': '.## ..# ..# ..# .##',
}
for (const k of Object.keys(FONT)) delete FONT[k]
for (const [k, v] of Object.entries(ROWS)) FONT[k] = v.replace(/ /g, '')
const MARKS = {
  Ç: ['C', null, '.#.'], Ş: ['S', null, '.#.'], Ğ: ['G', '###', null], Ü: ['U', '#.#', null],
  Ö: ['O', '#.#', null], İ: ['I', '.#.', null],
}

// büyük harfe çevirir: Türkçede i→İ, ı→I; İngilizcede düz toUpperCase (folder "drive" → DRIVE)
function normalize(str) {
  if (LANG === 'tr') return String(str).replace(/i/g, 'İ').replace(/ı/g, 'I').toLocaleUpperCase('tr-TR')
  return String(str).toUpperCase()
}

// fontta olmayan harf: aksanını at (É→E); yine yoksa '?'
function glyphOf(ch) {
  return FONT[ch] ?? FONT[ch.normalize('NFD')[0]] ?? FONT['?']
}

function textWidth(str) {
  return Math.max(0, [...normalize(str)].length * 4 - 1)
}

function text(str, x, y, color, shadow = null) {
  let cx = Math.round(x)
  for (const ch of normalize(str)) {
    const mark = MARKS[ch]
    const glyph = glyphOf(mark ? mark[0] : ch)
    const paint = (dx, dy) => {
      if (shadow !== null) px(cx + dx + 1, y + dy + 1, shadow)
      px(cx + dx, y + dy, color)
    }
    for (let i = 0; i < 15; i++) if (glyph[i] === '#') paint(i % 3, Math.floor(i / 3))
    if (mark?.[1]) for (let i = 0; i < 3; i++) if (mark[1][i] === '#') paint(i, -2)
    if (mark?.[2]) for (let i = 0; i < 3; i++) if (mark[2][i] === '#') paint(i, 5)
    cx += 4
  }
}

function fit(str, max) {
  const s = [...String(str)]
  return s.length <= max ? s.join('') : s.slice(0, max - 1).join('') + '.'
}

// ---------- çerçeve tamponu ----------
let LW = DESIGN_W
let LH = DESIGN_H
let S = 4
let fb = new Uint32Array(LW * LH)

function px(x, y, c) {
  x |= 0
  y |= 0
  if (x < 0 || y < 0 || x >= LW || y >= LH) return
  fb[y * LW + x] = c
}

function rect(x, y, w, h, c) {
  x = Math.round(x)
  y = Math.round(y)
  const x0 = Math.max(0, x)
  const y0 = Math.max(0, y)
  const x1 = Math.min(LW, x + Math.round(w))
  const y1 = Math.min(LH, y + Math.round(h))
  for (let j = y0; j < y1; j++) fb.fill(c, j * LW + x0, j * LW + x1)
}

// dış çizgili dikdörtgen: referanstaki koyu kontur görünümü
function box(x, y, w, h, c) {
  rect(x - 1, y - 1, w + 2, h + 2, C.ol)
  rect(x, y, w, h, c)
}

function shade(x, y, w, h, f = 0.82) {
  for (let j = Math.max(0, y); j < Math.min(LH, y + h); j++)
    for (let i = Math.max(0, x); i < Math.min(LW, x + w); i++) {
      const c = fb[j * LW + i]
      fb[j * LW + i] = (Math.round(((c >> 16) & 255) * f) << 16) | (Math.round(((c >> 8) & 255) * f) << 8) | Math.round((c & 255) * f)
    }
}

function line(x0, y0, x1, y1, c) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
  for (let i = 0; i <= n; i++) px(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), c)
}

function hash(n) {
  let h = n | 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  return (h ^ (h >>> 16)) >>> 0
}

function strHash(s) {
  let h = 7
  for (let i = 0; i < s.length; i++) h = Math.imul(h, 31) + s.charCodeAt(i)
  return hash(h)
}

// ---------- yerleşim ----------
let L

function computeLayout() {
  const B = 4
  const wallFaceBottom = 26 // üst odaların arka duvarı
  const dividerY = 90 // odalar ile çalışma salonu arasındaki duvar
  const hallFaceTop = 95
  const hallFloorY = 113
  const bossX1 = B + 112
  const serverX0 = LW - B - 96
  const loungeX0 = bossX1 + 4
  const loungeX1 = serverX0 - 4
  const corridorX = 16
  const aisle0 = hallFloorY + 9
  const firstSeat = hallFloorY + 35 // low enough that row-1 labels clear the whiteboard
  const pitchY = 38
  const rows = Math.max(1, Math.min(4, 1 + Math.floor((LH - B - 16 - firstSeat) / pitchY)))
  const pitchX = 40
  const x0 = 34
  const x1 = LW - B - 30
  const cols = Math.max(1, Math.floor((x1 - x0) / pitchX))
  const offX = x0 + (x1 - x0 - cols * pitchX) / 2 + pitchX / 2
  const desks = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) desks.push({ cx: Math.round(offX + c * pitchX), by: firstSeat + r * pitchY, row: r })
  const aisles = []
  for (let r = 0; r < rows; r++) aisles.push(r === 0 ? aisle0 : firstSeat + (r - 1) * pitchY + 19)
  const bottomAisle = LH - B - 4
  const bossDoorX = bossX1 - 22
  const loungeDoorX = Math.round((loungeX0 + loungeX1) / 2)
  const serverDoorX = serverX0 + 22
  const boss = { cx: B + 54, by: 58 }
  // parti alanı: salonun ortasındaki dans pisti; işi biten botlar burada dans eder
  const isWide = loungeX1 - loungeX0 > 90
  const floor = { x: loungeX0 + (isWide ? 20 : 12), y: 54, w: loungeX1 - loungeX0 - (isWide ? 40 : 24), h: 32 }
  const mid = floor.x + floor.w / 2
  const spots = []
  for (const by of [64, 75, 86])
    for (let x = floor.x + 8; x <= floor.x + floor.w - 8; x += 13) if (by > 70 || x < loungeX1 - 40) spots.push([x, by])
  const cost = ([x, y]) => Math.abs(x - mid) + Math.abs(y - 75) * 1.5
  spots.sort((a, b) => cost(a) - cost(b))
  const counterRight = loungeX0 + 6 + Math.min(46, loungeX1 - loungeX0 - 44)
  return {
    B, wallFaceBottom, dividerY, hallFaceTop, hallFloorY, bossX1, serverX0, loungeX0, loungeX1, corridorX,
    aisles, desks, bottomAisle, bossDoorX, loungeDoorX, serverDoorX,
    boss: { ...boss, seat: [boss.cx - 4, boss.by], stand: [boss.cx + 2, 84] },
    door: [-10, bottomAisle],
    lounge: { slots: Math.max(4, Math.floor((loungeX1 - loungeX0 - 30) / 18) * 2) },
    party: { floor, spots, ball: [Math.max(Math.round(mid), counterRight + 8), 38] },
  }
}

// ---------- yollar ----------
function seatInfo(slot) {
  if (slot < L.desks.length) {
    const d = L.desks[slot]
    return { seat: [d.cx - 5, d.by], aisle: L.aisles[d.row], row: d.row, kind: 'desk' }
  }
  const k = (slot - L.desks.length) % L.lounge.slots
  const perRow = L.lounge.slots / 2
  const x = L.loungeX0 + 18 + (k % perRow) * 18
  const y = 70 + Math.floor(k / perRow) * 14
  return { seat: [x, y], aisle: y, row: -1, kind: 'lounge' }
}

function toHallTop(info) {
  if (info.kind === 'lounge') return [[L.loungeDoorX, info.aisle], [L.loungeDoorX, L.aisles[0]]]
  if (info.row === 0) return []
  return [[L.corridorX, info.aisle], [L.corridorX, L.aisles[0]]]
}

// from: partiden kalkan botun pist yeri; null ise giriş kapısından gelir
function pathIn(slot, from = null) {
  const info = seatInfo(slot)
  const { seat, aisle } = info
  if (from) {
    const start = [from, [L.loungeDoorX, from[1]], [L.loungeDoorX, L.aisles[0]]]
    if (info.kind === 'lounge') return [...start, [L.loungeDoorX, aisle], seat]
    if (info.row === 0) return [...start, [seat[0], aisle], seat]
    return [...start, [L.corridorX, L.aisles[0]], [L.corridorX, aisle], [seat[0], aisle], seat]
  }
  const start = [L.door, [L.corridorX, L.bottomAisle]]
  if (info.kind === 'lounge') return [...start, [L.corridorX, L.aisles[0]], [L.loungeDoorX, L.aisles[0]], [L.loungeDoorX, aisle], seat]
  return [...start, [L.corridorX, aisle], [seat[0], aisle], seat]
}

// müdürden parti pistine
function pathToParty(spot) {
  const st = L.boss.stand
  return [st, [L.bossDoorX, st[1]], [L.bossDoorX, L.aisles[0]], [L.loungeDoorX, L.aisles[0]], [L.loungeDoorX, spot[1]], spot]
}

// parti bitince pistten giriş kapısına
function pathFromParty(spot) {
  return [spot, [L.loungeDoorX, spot[1]], [L.loungeDoorX, L.aisles[0]], [L.corridorX, L.aisles[0]], [L.corridorX, L.bottomAisle], L.door]
}

function pathToBoss(slot) {
  const info = seatInfo(slot)
  const head = info.kind === 'desk' ? [info.seat, [info.seat[0], info.aisle]] : [info.seat]
  const st = L.boss.stand
  return [...head, ...toHallTop(info), [L.bossDoorX, L.aisles[0]], [L.bossDoorX, st[1]], st]
}

function pathLength(path) {
  let n = 0
  for (let i = 1; i < path.length; i++)
    n += Math.abs(path[i][0] - path[i - 1][0]) + Math.abs(path[i][1] - path[i - 1][1])
  return n
}

function along(path, dist) {
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1]
    const [bx, by] = path[i]
    const seg = Math.abs(bx - ax) + Math.abs(by - ay)
    if (dist <= seg) {
      const t = seg === 0 ? 1 : dist / seg
      return { x: Math.round(ax + (bx - ax) * t), y: Math.round(ay + (by - ay) * t), look: Math.sign(bx - ax) }
    }
    dist -= seg
  }
  const [x, y] = path[path.length - 1]
  return { x, y, look: 0 }
}

const slots = new Map() // worker id → masa/salon yeri
const entries = new Map() // worker id → partiden kalktığı pist yeri ya da null (kapıdan gelir)
const recruited = new Map() // partideki worker id → yeni bir ajan olarak masaya kalktığı an
const partySpots = new Map() // worker id → { i: pist yeri sırası, isFree: pisti terk etti }

function resetOffice() {
  for (const m of [slots, entries, recruited, partySpots]) m.clear()
}

function partySpotOf(w) {
  let spot = partySpots.get(w.id)
  if (!spot) {
    const used = new Set([...partySpots.values()].filter(s => !s.isFree).map(s => s.i))
    let i = 0
    while (used.has(i)) i++
    spot = { i, isFree: false }
    partySpots.set(w.id, spot)
  }
  const n = L.party.spots.length
  const [x, y] = L.party.spots[spot.i % n]
  return [x + Math.floor(spot.i / n) * 5, y] // pist dolduysa yanına sıkışır
}

function releaseSpot(id) {
  const spot = partySpots.get(id)
  if (spot) spot.isFree = true
}

// bir botun zaman çizelgesi: geliş, teslim, partiye varış, partiden çıkış
function timeline(w, slot) {
  const pin = pathIn(slot, entries.get(w.id) ?? null)
  const inMs = pathLength(pin) / SPEED
  const ready = w.spawnAt + inMs + SETTLE_MS
  const timing = { pin, inMs, ready }
  if (w.doneAt == null) return timing
  const delivered = Math.max(w.doneAt, ready)
  const pb = pathToBoss(slot)
  const bossMs = pathLength(pb) / SPEED
  const spot = partySpotOf(w)
  const pp = pathToParty(spot)
  const arrive = delivered + bossMs + HANDOFF_MS + pathLength(pp) / SPEED
  const leaveAt = recruited.get(w.id) ?? Math.max(arrive, w.doneAt + PARTY_MS)
  return { ...timing, delivered, pb, bossMs, spot, pp, arrive, leaveAt }
}

function poseOf(w, now, slot) {
  const tl = timeline(w, slot)
  const t = now - w.spawnAt
  if (w.doneAt == null || now < tl.delivered) {
    if (t < tl.inMs) return { phase: 'in', ...along(tl.pin, Math.max(0, t) * SPEED) }
    const [x, y] = seatInfo(slot).seat
    return { phase: 'work', x, y, look: 0 }
  }
  const d = now - tl.delivered
  if (d < tl.bossMs) return { phase: 'carry', ...along(tl.pb, d * SPEED) }
  if (d < tl.bossMs + HANDOFF_MS) return { phase: 'hand', x: L.boss.stand[0], y: L.boss.stand[1], look: 0 }
  if (now < tl.arrive) return { phase: 'toParty', ...along(tl.pp, (d - tl.bossMs - HANDOFF_MS) * SPEED) }
  if (now < tl.leaveAt) return { phase: 'party', x: tl.spot[0], y: tl.spot[1], look: 0 }
  // masaya kalkan botu yeni ajan sürdürür; burada kaybolur
  if (!recruited.has(w.id)) {
    const po = pathFromParty(tl.spot)
    const e = now - tl.leaveAt
    if (e < pathLength(po) / SPEED) return { phase: 'out', ...along(po, e * SPEED) }
  }
  releaseSpot(w.id)
  return { phase: 'gone', x: 0, y: 0, look: 0 }
}

// yeni ajan geldiğinde partide biri varsa (en eski gelen) o pistten kalkıp masaya gider
function recruitFor(w, workers) {
  let best = null
  for (const v of workers) {
    if (v === w || v.doneAt == null || !slots.has(v.id) || recruited.has(v.id)) continue
    const { arrive, leaveAt } = timeline(v, slots.get(v.id))
    if (arrive <= w.spawnAt && w.spawnAt < leaveAt && (!best || arrive < best.arrive)) best = { v, arrive }
  }
  if (!best) return null
  const spot = partySpotOf(best.v)
  recruited.set(best.v.id, w.spawnAt)
  return spot
}

function assignSlots(workers, now) {
  const live = new Set(workers.map(w => w.id))
  for (const m of [slots, entries, recruited, partySpots]) for (const id of m.keys()) if (!live.has(id)) m.delete(id)
  for (const w of workers) {
    if (slots.has(w.id)) continue
    entries.set(w.id, recruitFor(w, workers))
    const taken = new Set()
    for (const v of workers) {
      const s = slots.get(v.id)
      if (s === undefined) continue
      const phase = poseOf(v, now, s).phase
      if (phase === 'in' || phase === 'work') taken.add(s)
    }
    let s = 0
    while (taken.has(s)) s++
    slots.set(w.id, s)
  }
}

// ---------- karakter ----------
function bot(cx, by, { pose = 'stand', frame = 0, isBoss = false, look = 0, isBlink = false, hasMug = false } = {}) {
  const bob = pose === 'walk' && frame === 1 ? 1 : 0
  const jump = pose === 'dance' && frame === 1 ? 2 : 0
  const x0 = cx - 8
  const top = by - 12 - bob - jump
  const armY =
    pose === 'type' ? [top + 5 + frame, top + 6 - frame]
    : pose === 'dance' ? (frame ? [top + 1, top + 6] : [top + 6, top + 1])
    : [top + 5, top + 5]
  const legs = [4, 6, 9, 11].map((lx, i) => [x0 + lx, top + 9, 1, pose === 'walk' && i % 2 === frame ? 2 : 3 + bob])
  const parts = [[x0 + 3, top, 10, 9], [x0, armY[0], 3, 2], [x0 + 13, armY[1], 3, 2], ...legs]
  for (const [x, y, w, h] of parts) rect(x - 1, y - 1, w + 2, h + 2, C.ol)
  for (const [x, y, w, h] of parts) rect(x, y, w, h, C.body)
  rect(x0 + 4, top, 8, 1, C.bodyHi)
  rect(x0 + 3, top + 8, 10, 1, C.shade)
  const ex = look > 0 ? 1 : look < 0 ? -1 : 0
  const eyeH = isBlink ? 1 : 2
  rect(x0 + 5 + ex, top + 4 - eyeH, 1, eyeH, C.eye)
  rect(x0 + 10 + ex, top + 4 - eyeH, 1, eyeH, C.eye)
  if (isBoss) {
    rect(x0 + 7, top + 5, 2, 1, C.tieKnot)
    rect(x0 + 7, top + 6, 2, 2, C.tie)
    px(x0 + 7, top + 8, C.tie)
  }
  if (hasMug) {
    box(x0 + 14, armY[1] - 2, 3, 3, C.mug)
    px(x0 + 15, armY[1] - 2, C.coffee)
  }
}

function paper(x, y, isOk) {
  box(x, y, 6, 7, C.paper)
  const ink = isOk ? C.ink : C.bad
  rect(x + 1, y + 1, 4, 1, ink)
  rect(x + 1, y + 3, 4, 1, ink)
  rect(x + 1, y + 5, 2, 1, ink)
}

// ---------- zeminler ve duvarlar ----------
function checker(x0, y0, x1, y1, size, a, b) {
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) px(x, y, (Math.floor(x / size) + Math.floor(y / size)) % 2 ? a : b)
}

function wood(x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) {
    const row = Math.floor((y - y0) / 5)
    for (let x = x0; x < x1; x++) {
      const isSeam = (y - y0) % 5 === 4 || (x + (row % 3) * 13) % 26 === 0
      px(x, y, isSeam ? C.woodSeam : row % 2 ? C.woodA : C.woodB)
    }
  }
}

function brickFace(x0, y0, x1, y1) {
  rect(x0, y0, x1 - x0, y1 - y0, C.mortar)
  for (let y = y0; y < y1; y += 4) {
    const off = ((y - y0) / 4) % 2 ? 4 : 0
    for (let x = x0 - 8 + off; x < x1; x += 8) {
      const bx = Math.max(x0, x)
      const bw = Math.min(x1, x + 7) - bx
      if (bw > 0) rect(bx, y, bw, Math.min(3, y1 - y), (hash(x * 7 + y) % 5 === 0) ? C.brickDark : C.brick)
    }
  }
}

function stripedFace(x0, y0, x1, y1, base, stripe) {
  rect(x0, y0, x1 - x0, y1 - y0, base)
  for (let x = x0 + 2; x < x1; x += 6) rect(x, y0, 2, y1 - y0, stripe)
}

function wainscot(x0, y1, h = 7) {
  return (x1) => {
    rect(x0, y1 - h, x1 - x0, h, C.wainscot)
    rect(x0, y1 - h, x1 - x0, 1, C.wainscotDark)
    for (let x = x0 + 5; x < x1; x += 10) rect(x, y1 - h + 2, 1, h - 3, C.wainscotDark)
  }
}

function wallFace(x0, y0, x1, y1, kind) {
  if (kind === 'brick') brickFace(x0, y0, x1, y1)
  if (kind === 'cream') stripedFace(x0, y0, x1, y1, C.cream, C.creamStripe)
  if (kind === 'sage') stripedFace(x0, y0, x1, y1, C.sage, C.sageStripe)
  if (kind === 'panel') {
    rect(x0, y0, x1 - x0, y1 - y0, C.panel)
    for (let x = x0 + 12; x < x1; x += 14) rect(x, y0, 1, y1 - y0, C.panelDark)
  }
  if (kind !== 'panel') wainscot(x0, y1)(x1)
  rect(x0, y1 - 1, x1 - x0, 1, C.ol)
  shade(x0, y1, x1 - x0, 2, 0.8)
}

// ---------- mobilyalar ----------
function bookshelf(x, y, w, h) {
  box(x, y, w, h, C.shelf)
  rect(x, y, w, 2, C.shelfDark)
  const shelves = Math.max(2, Math.floor((h - 3) / 9))
  for (let s = 0; s < shelves; s++) {
    const sy = y + 3 + s * 9
    rect(x + 1, sy + 7, w - 2, 1, C.shelfDark)
    for (let bx = x + 2; bx < x + w - 2; bx += 3) {
      const hh = hash(bx * 13 + sy)
      if (hh % 7 === 0) continue
      rect(bx, sy + (hh % 3), 2, 7 - (hh % 3), C.book[hh % C.book.length])
    }
  }
  shade(x, y + h + 1, w, 2, 0.75)
}

function plant(x, y, big = false) {
  const w = big ? 10 : 8
  box(x + 1, y + 8, w - 2, 6, C.pot)
  rect(x + 1, y + 12, w - 2, 2, C.potDark)
  const leaves = big
    ? [[x + 3, y - 4, 4, 5], [x - 1, y, 5, 4], [x + 6, y - 1, 5, 4], [x + 1, y + 3, 4, 4], [x + 5, y + 3, 4, 4]]
    : [[x + 2, y - 2, 4, 5], [x - 1, y + 1, 4, 4], [x + 5, y + 1, 4, 4], [x + 2, y + 4, 4, 3]]
  for (const [lx, ly, lw, lh] of leaves) rect(lx - 1, ly - 1, lw + 2, lh + 2, C.ol)
  leaves.forEach(([lx, ly, lw, lh], i) => {
    rect(lx, ly, lw, lh, i % 2 ? C.leafDark : C.leaf)
    px(lx + 1, ly, C.leafHi)
  })
  shade(x, y + 15, w, 2, 0.75)
}

function lamp(x, y, isNight) {
  if (isNight) {
    for (let r = 10; r > 0; r -= 3) shade(x - r + 3, y + 26 - Math.floor(r / 3), r * 2, Math.max(1, Math.floor(r / 2)), 1.06)
  }
  rect(x + 3, y + 8, 2, 18, C.lampPole)
  box(x + 1, y + 26, 6, 2, C.lampPole)
  box(x, y, 8, 8, isNight ? C.glow : C.lampShade)
  rect(x, y + 6, 8, 2, isNight ? C.lampShade : C.lampShadeDark)
}

function rug(x, y, w, h, outer, inner, accent) {
  box(x, y, w, h, outer)
  rect(x + 3, y + 3, w - 6, h - 6, inner)
  for (let i = x + 5; i < x + w - 5; i += 4) {
    px(i, y + 1, accent)
    px(i, y + h - 2, accent)
  }
  rect(x + 5, y + 5, w - 10, 1, accent)
  rect(x + 5, y + h - 6, w - 10, 1, accent)
}

function windowPane(x, y, w, h, now) {
  const date = new Date(now)
  const hour = date.getHours() + date.getMinutes() / 60
  const isNight = hour < 6.5 || hour >= 20
  const isDusk = !isNight && hour >= 17.5
  box(x, y, w, h, C.windowFrame)
  const sky = isNight ? C.night : isDusk ? C.dusk : C.sky
  const low = isNight ? C.nightLow : isDusk ? C.duskLow : C.skyLow
  rect(x + 1, y + 1, w - 2, h - 2, sky)
  rect(x + 1, y + Math.floor(h / 2), w - 2, Math.ceil(h / 2) - 1, low)
  if (isNight) {
    for (let s = 0; s < 4; s++) {
      const hh = hash(x * 31 + s)
      px(x + 2 + (hh % (w - 4)), y + 2 + ((hh >> 5) % (h - 4)), C.star)
    }
  } else {
    const cx = x + 1 + (Math.floor(now / 1100 + x) % (w + 8)) - 6
    for (const [dx, dy, cw] of [[1, 0, 3], [0, 1, 6]])
      for (let k = 0; k < cw; k++) if (cx + dx + k > x && cx + dx + k < x + w - 1) px(cx + dx + k, y + 3 + dy, C.cloud)
  }
  rect(x + Math.floor(w / 2), y + 1, 1, h - 2, C.windowFrame)
  rect(x + 1, y + Math.floor(h / 2) - 1, w - 2, 1, C.windowFrame)
  return isNight
}

function picture(x, y) {
  box(x, y, 16, 12, C.gold)
  rect(x + 1, y + 1, 14, 10, C.rugBlueIn)
  rect(x + 4, y + 3, 8, 6, C.body)
  rect(x + 6, y + 5, 1, 2, C.eye)
  rect(x + 9, y + 5, 1, 2, C.eye)
  rect(x + 2, y + 6, 2, 1, C.body)
  rect(x + 12, y + 6, 2, 1, C.body)
}

function clock(x, y, now) {
  const d = new Date(now)
  box(x, y, 11, 11, C.white)
  const cx = x + 5
  const cy = y + 5
  const ma = (d.getMinutes() / 60) * Math.PI * 2
  const ha = ((d.getHours() % 12) / 12 + d.getMinutes() / 720) * Math.PI * 2
  line(cx, cy, cx + Math.round(Math.sin(ma) * 4), cy - Math.round(Math.cos(ma) * 4), C.ol)
  line(cx, cy, cx + Math.round(Math.sin(ha) * 2.5), cy - Math.round(Math.cos(ha) * 2.5), C.accent)
}

function armchair(x, y) {
  box(x, y, 22, 8, C.chairCreamDark)
  box(x, y + 7, 22, 12, C.chairCream)
  box(x - 2, y + 6, 5, 13, C.chairCreamDark)
  box(x + 19, y + 6, 5, 13, C.chairCreamDark)
  box(x + 5, y + 8, 12, 6, C.chairCushion)
  shade(x - 2, y + 20, 26, 2, 0.75)
}

function counter(x, y, w, now, isBusy) {
  box(x, y, w, 7, C.deskEdge)
  box(x, y + 7, w, 10, C.wainscot)
  for (let i = x + 8; i < x + w; i += 9) rect(i, y + 9, 1, 7, C.wainscotDark)
  // kahve makinesi
  box(x + 3, y - 12, 12, 13, C.machine)
  rect(x + 4, y - 11, 10, 2, C.machineHi)
  px(x + 12, y - 8, isBusy && Math.floor(now / 300) % 2 ? C.green : C.red)
  box(x + 6, y - 3, 5, 3, C.mug)
  // kupalar
  box(x + w - 10, y + 1, 3, 3, C.mug)
  box(x + w - 6, y + 1, 3, 3, C.rugRed)
}

function rack(x, y, now, isBusy, seed) {
  box(x, y, 16, 34, C.rack)
  for (let r = 0; r < 7; r++) {
    rect(x + 1, y + 2 + r * 4, 14, 3, C.rackHi)
    for (let l = 0; l < 3; l++) {
      const h = hash(seed * 97 + r * 7 + l + Math.floor(now / (isBusy ? 180 : 900)))
      px(x + 9 + l * 2, y + 3 + r * 4, h % 3 === 0 ? C.rack : [C.green, C.blue, C.green, C.yellow][h % 4])
    }
  }
  shade(x, y + 35, 16, 2, 0.7)
}

function cabinet(x, y) {
  box(x, y, 14, 22, C.cabinet)
  for (let i = 0; i < 3; i++) {
    rect(x + 1, y + 2 + i * 7, 12, 6, C.cabinetDark)
    rect(x + 5, y + 4 + i * 7, 4, 1, C.white)
  }
  shade(x, y + 23, 14, 2, 0.7)
}

function sign(x, y, label) {
  const w = textWidth(label) + 10
  box(x, y, w, 12, C.signGreen)
  rect(x + 1, y + 1, w - 2, 1, C.signGreenDark)
  rect(x + 1, y + 10, w - 2, 1, C.signGreenDark)
  text(label, x + 5, y + 4, C.gold)
}

function whiteboard(x, y, w, data) {
  box(x, y, w, 15, C.boardFrame)
  rect(x + 1, y + 1, w - 2, 13, C.board)
  text(T.today, x + 3, y + 3, C.marker)
  text(T.delivered(data.delivered), x + 3, y + 9, C.accent)
  for (let i = 0; i < 6; i++) {
    const h = 2 + (hash(i + 99) % 7)
    rect(x + w - 16 + i * 2, y + 13 - h, 1, h, C.marker)
  }
}

function cooler(x, y) {
  box(x, y, 9, 8, C.water)
  rect(x + 2, y + 1, 2, 5, C.glass)
  box(x - 1, y + 8, 11, 13, C.cooler)
  rect(x + 3, y + 12, 3, 2, C.red)
  shade(x - 1, y + 22, 11, 2, 0.75)
}

function catBasket(x, y, now) {
  box(x, y + 4, 22, 9, C.basket)
  rect(x, y + 10, 22, 3, C.basketDark)
  rect(x + 2, y + 3, 18, 5, C.pillow)
  const breath = Math.floor(now / 900) % 2
  box(x + 5, y + 1 - breath, 12, 7 + breath, C.cat)
  rect(x + 6, y + 5, 10, 2, C.catDark)
  box(x + 14, y - 1 - breath, 5, 5, C.cat)
  px(x + 14, y - 3 - breath, C.cat)
  px(x + 18, y - 3 - breath, C.cat)
  rect(x + 15, y + 1 - breath, 3, 1, C.catDark)
  if (Math.floor(now / 1800) % 2) text('Z', x + 20, y - 8 - breath, C.white)
}

function mat(x, y) {
  box(x, y, 12, 18, C.mat)
  for (let i = 0; i < 4; i++) rect(x + 2, y + 2 + i * 4, 8, 2, C.matDark)
}

function chair(cx, by, isBoss) {
  const w = isBoss ? 18 : 14
  box(cx - w / 2, by - 17 - SIT, w, 12, isBoss ? C.bossChair : C.chair)
  rect(cx - w / 2 + 1, by - 16 - SIT, w - 2, 1, isBoss ? C.bossChairHi : C.chairHi)
}

function laptop(x, y, isBusy, now) {
  box(x, y, 11, 8, C.lid)
  rect(x, y + 6, 11, 2, C.lidDark)
  const on = isBusy && Math.floor(now / 350) % 2
  rect(x + 4, y + 2, 3, 3, isBusy ? (on ? C.logoOn : C.logo) : C.lidDark)
}

function desk(d, n, isBusy, now) {
  const { cx, by } = d
  box(cx - 14, by - 5, 28, 5, C.deskTop)
  rect(cx - 14, by - 5, 28, 1, C.deskEdge)
  box(cx - 14, by, 28, 7, C.deskFront)
  rect(cx - 13, by + 8, 2, 2, C.deskLeg)
  rect(cx + 11, by + 8, 2, 2, C.deskLeg)
  const pw = textWidth(String(n)) + 4
  box(cx - Math.floor(pw / 2), by, pw, 7, C.plate)
  text(String(n), cx - Math.floor(pw / 2) + 2, by + 1, C.deskLeg)
  laptop(cx + 1, by - 12, isBusy, now)
  box(cx - 12, by - 8, 3, 3, C.mug)
  shade(cx - 14, by + 8, 28, 2, 0.75)
}

function bossDesk(now, isBusy, stack, lastOk) {
  const { cx, by } = L.boss
  box(cx - 26, by - 6, 52, 6, C.deskTop)
  rect(cx - 26, by - 6, 52, 1, C.deskEdge)
  box(cx - 26, by, 52, 9, C.deskFront)
  for (let i = cx - 22; i < cx + 24; i += 12) rect(i, by + 2, 1, 6, C.wainscotDark)
  box(cx - 10, by + 2, 20, 5, C.gold)
  text(T.boss, cx - Math.floor(textWidth(T.boss) / 2), by + 2, C.deskLeg)
  // büyük monitör
  box(cx + 6, by - 19, 16, 11, C.lid)
  rect(cx + 7, by - 18, 14, 8, isBusy ? 0x1b2a38 : C.lidDark)
  if (isBusy) {
    for (let r = 0; r < 3; r++) {
      const h = hash(r + Math.floor(now / 300))
      rect(cx + 8, by - 17 + r * 3, 3 + (h % 10), 1, [C.green, C.blue, C.yellow, C.logoOn][h % 4])
    }
  }
  rect(cx + 13, by - 8, 2, 2, C.lidDark)
  // evrak tepsisi
  box(cx - 24, by - 9, 11, 3, C.cabinetDark)
  const n = Math.min(stack, 10)
  for (let i = 0; i < n; i++) rect(cx - 23, by - 10 - i, 9, 1, i === n - 1 && !lastOk ? C.bad : i % 2 ? C.paper : 0xe6e6de)
  shade(cx - 26, by + 10, 52, 2, 0.75)
}

function bubbleCheck(x, y, isOk) {
  box(x, y, 11, 8, C.white)
  px(x + 2, y + 9, C.ol)
  px(x + 2, y + 8, C.white)
  const c = isOk ? C.good : C.bad
  if (isOk) {
    line(x + 2, y + 4, x + 4, y + 6, c)
    line(x + 4, y + 6, x + 8, y + 2, c)
  } else {
    line(x + 3, y + 2, x + 7, y + 6, c)
    line(x + 7, y + 2, x + 3, y + 6, c)
  }
}

// ---------- parti ----------
function blend(x, y, c, a) {
  x |= 0
  y |= 0
  if (x < 0 || y < 0 || x >= LW || y >= LH) return
  const o = fb[y * LW + x]
  const mix = s => Math.round(((o >> s) & 255) * (1 - a) + ((c >> s) & 255) * a) << s
  fb[y * LW + x] = mix(16) | mix(8) | mix(0)
}

function danceFloor(now, hasGuests) {
  const { x, y, w, h } = L.party.floor
  box(x, y, w, h, C.floorDark)
  const beat = Math.floor(now / BEAT_MS)
  for (let ty = 0; ty < Math.floor((h - 2) / 6); ty++)
    for (let tx = 0; tx < Math.floor((w - 2) / 6); tx++) {
      const hh = hash(tx * 31 + ty * 17 + (hasGuests ? beat : 0) * 7)
      rect(x + 2 + tx * 6, y + 2 + ty * 6, 5, 5, C.neon[hh % C.neon.length])
      if (!hasGuests || hh % 3 === 0) shade(x + 2 + tx * 6, y + 2 + ty * 6, 5, 5, hasGuests ? 0.55 : 0.4)
    }
}

// tavan ampulleri ve arka duvardaki neon tüp
function partyLights(now) {
  const { loungeX0, loungeX1, B, wallFaceBottom } = L
  const beat = Math.floor(now / BEAT_MS)
  const sag = x => Math.round(Math.abs(Math.sin((x - loungeX0) / 9)) * 2)
  for (let x = loungeX0 + 1; x < loungeX1; x++) px(x, B + 1 + sag(x), C.ol)
  for (let x = loungeX0 + 4, k = 0; x < loungeX1 - 2; x += 7, k++) {
    const isOn = (k + beat) % 3 !== 0
    rect(x, B + 2 + sag(x), 2, 2, isOn ? C.neon[(k + beat) % C.neon.length] : C.mirrorDark)
  }
  const isFlicker = hash(Math.floor(now / 110)) % 29 === 0
  const ny = wallFaceBottom - 3
  for (let x = loungeX0 + 2; x < loungeX1 - 2; x++) {
    blend(x, ny - 1, C.neonTube, isFlicker ? 0.1 : 0.35)
    blend(x, ny + 1, C.neonTube, isFlicker ? 0.1 : 0.35)
    px(x, ny, isFlicker ? C.neonTube : C.neonGlow)
  }
}

function discoBall(now) {
  const [cx, cy] = L.party.ball
  line(cx, 20, cx, cy - 5, C.ol)
  const turn = Math.floor(now / 160)
  for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) if (x * x + y * y <= 26) px(cx + x, cy + y, C.ol)
  for (let y = -4; y <= 4; y++)
    for (let x = -4; x <= 4; x++) {
      if (x * x + y * y > 18) continue
      const isLit = (Math.floor((x + 8 + turn) / 2) + Math.floor((y + 8) / 2)) % 2 === 0
      px(cx + x, cy + y, isLit ? C.mirror : C.mirrorDark)
    }
  const h = hash(turn)
  px(cx - 3 + (h % 7), cy - 3 + ((h >> 4) % 7), C.white)
}

// pistte gezinen renkli spotlar ve toptan inen ışınlar; dansçıları da boyar
function spotlights(now) {
  const { x, y, w, h } = L.party.floor
  const [bx, by] = L.party.ball
  for (let k = 0; k < 3; k++) {
    const sx = x + w / 2 + Math.sin(now / 900 + k * 2.1) * (w / 2 - 6)
    const sy = y + h / 2 + Math.cos(now / 700 + k * 1.7) * (h / 2 - 5)
    const c = C.neon[k]
    const n = Math.max(Math.abs(sx - bx), Math.abs(sy - by), 1)
    for (let i = 6; i <= n; i += 2) blend(bx + ((sx - bx) * i) / n, by + ((sy - by) * i) / n, c, 0.3)
    for (let j = -7; j <= 7; j++)
      for (let i = -9; i <= 9; i++) if ((i * i) / 81 + (j * j) / 49 <= 1) blend(sx + i, sy + j, c, 0.3)
  }
}

function tag(lines, cx, bottom) {
  const w = Math.max(...lines.map(([s]) => textWidth(s))) + 5
  const h = lines.length * 7 + 2
  const x = Math.round(cx - w / 2)
  const y = bottom - h
  box(x, y, w, h, C.dark)
  lines.forEach(([s, c], i) => text(s, x + Math.round((w - textWidth(s)) / 2), y + 2 + i * 7, c))
}

// ---------- arka plan ----------
let background = null
let backgroundKey = ''

function drawBackground() {
  const { B, wallFaceBottom, dividerY, hallFaceTop, hallFloorY, bossX1, serverX0, loungeX0, loungeX1 } = L
  rect(0, 0, LW, LH, C.frame)
  // zeminler
  wood(B, wallFaceBottom, bossX1, dividerY)
  checker(loungeX0, wallFaceBottom, loungeX1, dividerY, 8, C.checkA, C.checkB)
  checker(serverX0 + 4, wallFaceBottom, LW - B, dividerY, 10, C.serverA, C.serverB)
  checker(B, hallFloorY, LW - B, LH - B, 12, C.carpetA, C.carpetB)
  // arka duvar yüzleri
  wallFace(B, B, bossX1, wallFaceBottom, 'brick')
  wallFace(loungeX0, B, loungeX1, wallFaceBottom, 'cream')
  wallFace(serverX0 + 4, B, LW - B, wallFaceBottom, 'panel')
  wallFace(B, hallFaceTop, LW - B, hallFloorY, 'sage')
  // odalar arası duvar ve kapılar
  rect(B, dividerY, LW - 2 * B, hallFaceTop - dividerY, C.wallTop)
  rect(B, dividerY, LW - 2 * B, 1, C.wallTopHi)
  rect(B, hallFaceTop - 1, LW - 2 * B, 1, C.ol)
  for (const dx of [L.bossDoorX, L.loungeDoorX, L.serverDoorX]) {
    wood(dx - 10, dividerY, dx + 10, hallFloorY)
    if (dx === L.loungeDoorX) checker(dx - 10, dividerY, dx + 10, hallFloorY, 8, C.checkA, C.checkB)
    if (dx === L.serverDoorX) checker(dx - 10, dividerY, dx + 10, hallFloorY, 10, C.serverA, C.serverB)
    rect(dx - 12, dividerY, 2, hallFloorY - dividerY, C.ol)
    rect(dx + 10, dividerY, 2, hallFloorY - dividerY, C.ol)
  }
  // dikey duvarlar (üstten görünüş)
  for (const wx of [bossX1, serverX0]) {
    rect(wx, B, 4, hallFaceTop - B, C.wallTop)
    rect(wx, B, 1, hallFaceTop - B, C.wallTopHi)
    rect(wx + 3, B, 1, hallFaceTop - B, C.ol)
  }
  // dış çerçeve ve giriş kapısı
  rect(0, 0, LW, B, C.frame)
  rect(0, LH - B, LW, B, C.frame)
  rect(0, 0, B, LH, C.frame)
  rect(LW - B, 0, B, LH, C.frame)
  rect(0, L.bottomAisle - 17, B, 19, C.carpetB)
  mat(B + 1, L.bottomAisle - 17)

  // müdür odası
  rug(B + 14, 38, 84, 48, C.rugRed, C.rugRedIn, C.rugGold)
  bookshelf(B + 4, 8, 22, 34)
  picture(B + 64, 8)
  plant(B + 98, 26, true)
  catBasket(B + 6, 66, 0)
  // salon (mutfak)
  const signLeft = loungeX1 - loungeX0 > 130 ? loungeX0 + 84 : loungeX0 + 30
  const signRight = loungeX1 - loungeX0 > 110 ? loungeX1 - 30 : loungeX1
  const signLabel = fit(normalize(THEME.sign), 14)
  sign(Math.round((signLeft + signRight) / 2 - (textWidth(signLabel) + 10) / 2), 7, signLabel)
  counter(loungeX0 + 6, 28, Math.min(46, loungeX1 - loungeX0 - 44), 0, false)
  if (loungeX1 - loungeX0 > 130) bookshelf(loungeX0 + 60, 9, 20, 26)
  plant(loungeX1 - 12, 24)
  // sunucu odası
  for (let i = 0; i < Math.floor((LW - B - serverX0 - 24) / 20); i++) rack(serverX0 + 10 + i * 20, 10, 0, false, i)
  cabinet(LW - B - 18, 62)
  // çalışma salonu
  whiteboard(40, hallFaceTop + 2, 58, { delivered: 0 })
  plant(LW - B - 14, hallFloorY + 4, true)
  cooler(LW - B - 16, LH - B - 26)
  plant(B + 2, hallFloorY + 3)
  L.desks.forEach(d => chair(d.cx - 5, d.by, false))
  chair(L.boss.seat[0], L.boss.by, true)
}

// ---------- kare ----------
function shortType(type) {
  return fit(T.types[type] ?? String(type).split(':').pop(), 8)
}

function renderFrame(now, data) {
  useTheme(themeFor(argValue('--project') ?? data.project))
  const key = `${LW}x${LH}:${themeName}`
  if (backgroundKey !== key) {
    fb = new Uint32Array(LW * LH)
    L = computeLayout()
    resetOffice()
    drawBackground()
    background = fb.slice()
    backgroundKey = key
  }
  fb.set(background)

  const workers = [...data.workers].sort((a, b) => a.spawnAt - b.spawnAt)
  assignSlots(workers, now)
  const poses = workers
    .map(w => ({ w, slot: slots.get(w.id), p: poseOf(w, now, slots.get(w.id)) }))
    .filter(({ p }) => p.phase !== 'gone')
  const handed = poses.filter(({ p }) => ['hand', 'toParty', 'party', 'out'].includes(p.phase))
  const pendingDone = poses.filter(({ w, p }) => w.doneAt != null && ['in', 'work', 'carry'].includes(p.phase)).length
  const stack = Math.max(0, data.delivered - pendingDone)
  const hasGuests = poses.some(({ p }) => p.phase === 'party')
  const lastOk = handed[handed.length - 1]?.w.isOk ?? true
  const busySlots = new Set(poses.filter(({ p }) => p.phase === 'work').map(({ slot }) => slot))
  const isBusy = busySlots.size > 0 || data.isBossBusy
  const typeFrame = Math.floor(now / 200) % 2
  const walkFrame = Math.floor(now / 150) % 2

  // canlı dekor
  const { B, bossX1, serverX0, loungeX0, loungeX1, hallFaceTop } = L
  partyLights(now)
  danceFloor(now, hasGuests)
  armchair(loungeX1 - 30, 46)
  const isNight = windowPane(B + 34, 7, 24, 15, now)
  windowPane(loungeX0 + 8, 7, 20, 15, now)
  if (loungeX1 - loungeX0 > 110) windowPane(loungeX1 - 28, 7, 20, 15, now)
  lamp(bossX1 - 14, 30, isNight)
  lamp(loungeX0 + 6, 52, isNight)
  clock(108, hallFaceTop + 3, now)
  whiteboard(40, hallFaceTop + 2, 58, data)
  catBasket(B + 6, 66, now)
  counter(loungeX0 + 6, 28, Math.min(46, loungeX1 - loungeX0 - 44), now, isBusy)
  discoBall(now)
  for (let i = 0; i < Math.floor((LW - B - serverX0 - 24) / 20); i++) rack(serverX0 + 10 + i * 20, 10, now, isBusy, i)
  if (isBusy) {
    const on = Math.floor(now / 400) % 2
    box(serverX0 + 12, 60, 6, 5, on ? C.red : 0x8a2a24)
  } else box(serverX0 + 12, 60, 6, 5, 0x5a3a36)

  const drawables = []
  L.desks.forEach((d, i) => drawables.push({ y: d.by + 0.5, draw: () => desk(d, i + 1, busySlots.has(i), now) }))
  drawables.push({ y: L.boss.by + 0.5, draw: () => bossDesk(now, data.isBossBusy, stack, lastOk) })
  drawables.push({
    y: L.boss.by,
    draw: () =>
      bot(L.boss.seat[0], L.boss.by - SIT, {
        pose: data.isBossBusy ? 'type' : 'stand',
        frame: typeFrame,
        isBoss: true,
        isBlink: now % 4100 < 130,
      }),
  })
  for (const { w, slot, p } of poses) {
    const seed = strHash(w.id)
    const isBlink = (now + seed) % 3700 < 120
    const isOk = w.isOk ?? true
    drawables.push({
      y: p.y,
      draw: () => {
        if (p.phase === 'work') {
          const atDesk = seatInfo(slot).kind === 'desk'
          bot(p.x, p.y - (atDesk ? SIT : 0), {
            pose: atDesk ? 'type' : 'stand',
            frame: (typeFrame + seed) % 2,
            isBlink,
            hasMug: !atDesk,
          })
        } else if (p.phase === 'party') {
          bot(p.x, p.y, { pose: 'dance', frame: (Math.floor(now / BEAT_MS) + seed) % 2, look: seed % 3 - 1, isBlink })
        } else if (p.phase === 'hand') {
          bot(p.x, p.y, { isBlink })
          paper(p.x - 3, p.y - 20, isOk)
        } else {
          bot(p.x, p.y, { pose: 'walk', frame: walkFrame, look: p.look, isBlink })
          if (p.phase === 'carry') paper(p.x + 6, p.y - 9, isOk)
        }
      },
    })
  }
  drawables.sort((a, b) => a.y - b.y).forEach(d => d.draw())
  if (hasGuests) spotlights(now)

  // etiketler en üstte
  for (const { w, slot, p } of poses) {
    if (p.phase !== 'work') continue
    const info = seatInfo(slot)
    const tool = w.tool ? String(w.tool).replace(/^mcp__.*__/, '') : T.thinking
    const cx = info.kind === 'desk' ? L.desks[slot].cx : p.x
    const top = p.y - (info.kind === 'desk' ? 18 : 14)
    tag([[shortType(w.type), C.white], [fit(tool, 8), C.yellow]], cx, top)
  }
  tag([[T.boss, C.accent], [data.isBossBusy ? T.working : T.waiting, C.dim]], L.boss.seat[0], L.boss.by - 19)
  if (poses.some(({ p }) => p.phase === 'hand')) bubbleCheck(L.boss.seat[0] + 14, L.boss.by - 36, lastOk)
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
  const data = { workers: [], delivered: 0, isBossBusy: false, project: '', sessionId: '', isDemo: false }
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
    data.isBossBusy ||= Boolean(s.stats?.isBossBusy)
    if (s.updatedAt > newest) {
      newest = s.updatedAt
      data.project = s.project ?? ''
      data.sessionId = sessionId
    }
  }
  const entries = recordDeliveries(day, seen)
  data.delivered = Object.values(entries).filter(project => !ONLY_PROJECT || project === ONLY_PROJECT).length
  cached = { at: now, data }
  return data
}

const DEMO_TYPES = ['Explore', 'Plan', 'general-purpose', 'code-reviewer', 'Explore', 'general-purpose']
const DEMO_TOOLS = ['Grep', 'Read', 'Bash', 'Edit', 'Glob', 'WebSearch', 'Write', 'WebFetch']
const DEMO_PERIOD = 2300

function demoOffice(now) {
  const workers = []
  const first = Math.floor((now - 50000) / DEMO_PERIOD)
  let done = 0
  for (let k = first; k * DEMO_PERIOD <= now; k++) {
    const spawnAt = k * DEMO_PERIOD
    const h = hash(k)
    const doneAt = spawnAt + 10000 + (h % 14000)
    const isDone = doneAt <= now
    if (isDone) done++
    workers.push({
      id: `demo-${k}`,
      type: DEMO_TYPES[h % DEMO_TYPES.length],
      spawnAt,
      doneAt: isDone ? doneAt : undefined,
      isOk: h % 9 !== 0,
      tool: DEMO_TOOLS[Math.floor((now - spawnAt) / 3000 + (h >>> 5)) % DEMO_TOOLS.length],
    })
  }
  return { workers, delivered: 14 + done, isBossBusy: true, project: T.demoProject, sessionId: '', isDemo: true }
}

// ---------- görüntü kodlama ----------
function encodeRGB() {
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

// ekran pikselleri → ölçek ve mantıksal tuval
function setGeometry(pxW, pxH) {
  S = Math.max(2, Math.round(Math.min(pxW / DESIGN_W, pxH / DESIGN_H)))
  while (S > 2 && (Math.floor(pxW / S) < 300 || Math.floor(pxH / S) < 190)) S--
  LW = Math.floor(pxW / S)
  LH = Math.floor(pxH / S)
}

function writePng(path) {
  const { rgb, W, H } = encodeRGB()
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
  renderFrame(now, demoOffice(now))
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
    renderFrame(now, args.includes('--demo') ? demoOffice(now) : loadOffice(now))
    if (last && last.length === fb.length && last.every((v, i) => v === fb[i])) return
    last = fb.slice()
    gen++
    const tmp = join(dir, `.frame-${gen}.png`)
    writePng(tmp)
    renameSync(tmp, join(dir, 'frame.png'))
    process.stdout.write(`frame ${gen} ${hex(C.accent)} ${hex(C.frame)} ${titleOf(THEME)}\n`)
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
  const { rgb: pixels, W, H } = encodeRGB()
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
  const title = titleOf(THEME)
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
  renderFrame(now, data)
  if (shownTheme !== themeName) {
    shownTheme = themeName
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
