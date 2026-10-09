#!/usr/bin/env node
// Theme gallery previews: draws the demo office once per theme in <repo>/themes/*.json and writes
// <repo>/themes/previews/<name>.png. Same fixed moment and time zone as app/test/visual.test.mjs,
// so a preview only changes when its theme (or the renderer) does.
//
//   node plugin/viewer/gallery.mjs                 every theme
//   node plugin/viewer/gallery.mjs sakura ocean    only these
//
// Each theme file is a themes.json fragment: { "<name>": { "description", "match", "sign", "colors" } }.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

// the office clock and day are drawn in local time: the time zone is pinned before core loads
process.env.TZ = 'Europe/Istanbul'
const { demoOffice, render, resetOffice, setBotColor, setGeometry, setLanguage, setTheme, setThemes } = await import('./core.mjs')

const here = dirname(fileURLToPath(import.meta.url))
const THEMES_DIR = join(here, '..', '..', 'themes')
const OUT = join(THEMES_DIR, 'previews')
const NOW = new Date(2026, 9, 9, 11, 0, 0).getTime()
// 1320x700 canvas → a 440x233 logical frame, written at 1:1 (pixel art: the README scales it up)
const CANVAS = [1320, 700]

// RGB PNG of the logical frame buffer (0xrrggbb per pixel), best compression: previews are committed
function png({ fb, LW, LH }) {
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
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const only = new Set(process.argv.slice(2))
const files = readdirSync(THEMES_DIR).filter(f => f.endsWith('.json')).sort()
mkdirSync(OUT, { recursive: true })
for (const file of files) {
  const themes = JSON.parse(readFileSync(join(THEMES_DIR, file), 'utf8'))
  for (const name of Object.keys(themes)) {
    if (only.size && !only.has(name)) continue
    setThemes(themes)
    setBotColor(null)
    setLanguage('en')
    setTheme(name)
    resetOffice()
    setGeometry(...CANVAS)
    const path = join(OUT, `${name}.png`)
    writeFileSync(path, png(render(NOW, demoOffice(NOW))))
    console.log(path)
  }
}
