// App icon: the boss bot at its desk, 32×32 pixel art, with the macOS rounded-square mask.
// node scripts/make-icon.mjs → build/icon.png (1024) and build/icon.icns (via iconutil)
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = join(root, 'build')

const C = {
  wall: 0x3a2533, wallLo: 0x2e1d29, trim: 0x5a3846,
  ol: 0x1d1310, body: 0x3fb6a8, bodyHi: 0x6fd6c9, shade: 0x2b8a7f, eye: 0x1a1a1a,
  tie: 0x2a3a6a, tieKnot: 0x1d2a50,
  desk: 0x9a6a44, deskHi: 0xb8875c, deskLo: 0x7a5034, deskDark: 0x5e3c27,
  plate: 0xd9b25a, plateLo: 0xa8843a,
  paper: 0xf3ead8, paperLo: 0xcfc3a8, mug: 0xf3ead8, coffee: 0x5a3a28,
  lights: [0xff5f8f, 0xffd166, 0x5fd3c7, 0x9d7bff, 0x7bd88f],
  wire: 0x1d1310,
}

// 32×32 scene
const N = 32
const grid = new Uint32Array(N * N)
const rect = (x, y, w, h, c) => {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < N && j < N) grid[j * N + i] = c
}
const px = (x, y, c) => rect(x, y, 1, 1, c)

// wall: darkens toward the bottom, skirting board
rect(0, 0, N, 22, C.wall)
rect(0, 14, N, 8, C.wallLo)
rect(0, 21, N, 1, C.trim)
// party lights: a hanging wire and coloured bulbs
for (let x = 0; x < N; x++) px(x, 3 + (Math.abs((x % 8) - 4) > 2 ? 0 : 1), C.wire)
for (let k = 0, x = 2; x < N; x += 4, k++) {
  const y = 4 + (Math.abs((x % 8) - 4) > 2 ? 0 : 1)
  rect(x, y, 2, 2, C.lights[k % C.lights.length])
}

// boss bot (arms resting on the desk)
const parts = [[9, 9, 14, 13], [6, 15, 3, 3], [23, 15, 3, 3]]
for (const [x, y, w, h] of parts) rect(x - 1, y - 1, w + 2, h + 2, C.ol)
for (const [x, y, w, h] of parts) rect(x, y, w, h, C.body)
rect(10, 9, 12, 1, C.bodyHi)
rect(9, 20, 14, 2, C.shade)
rect(12, 12, 1, 2, C.eye)
rect(19, 12, 1, 2, C.eye)
rect(15, 19, 2, 2, C.tie)

// desk
rect(0, 21, N, 1, C.ol)
rect(0, 22, N, 2, C.deskHi)
rect(0, 24, N, 8, C.desk)
rect(0, 30, N, 2, C.deskLo)
rect(0, 24, N, 1, C.deskLo)
// name plate
rect(11, 26, 10, 3, C.ol)
rect(12, 26, 8, 2, C.plate)
rect(12, 28, 8, 1, C.plateLo)
// stack of papers (right) and coffee (left)
rect(24, 17, 6, 5, C.ol)
rect(25, 17, 4, 1, C.paper)
rect(25, 18, 4, 1, C.paperLo)
rect(25, 19, 4, 1, C.paper)
rect(25, 20, 4, 1, C.paperLo)
rect(2, 18, 4, 4, C.ol)
rect(3, 18, 2, 3, C.mug)
rect(3, 18, 2, 1, C.coffee)
px(5, 19, C.mug)

// onto a 1024 canvas: an 832 px rounded-square (superellipse) mask, centred
const S = 1024
const CELL = 26
const OFF = (S - N * CELL) / 2
const R = (N * CELL) / 2
const rgba = Buffer.alloc(S * S * 4)
const inside = (x, y) => Math.abs((x - S / 2) / R) ** 5 + Math.abs((y - S / 2) / R) ** 5 <= 1
for (let y = 0; y < S; y++)
  for (let x = 0; x < S; x++) {
    // 4×4 supersampling for the edges
    let cover = 0
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) cover++
    if (!cover) continue
    const gx = Math.min(N - 1, Math.max(0, Math.floor((x - OFF) / CELL)))
    const gy = Math.min(N - 1, Math.max(0, Math.floor((y - OFF) / CELL)))
    const c = grid[gy * N + gx]
    const o = (y * S + x) * 4
    rgba[o] = (c >> 16) & 255
    rgba[o + 1] = (c >> 8) & 255
    rgba[o + 2] = c & 255
    rgba[o + 3] = Math.round((cover / 16) * 255)
  }

function png(w, h, data) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  const chunk = (type, body) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const tb = Buffer.concat([Buffer.from(type), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(tb))
    return Buffer.concat([len, tb, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

mkdirSync(out, { recursive: true })
const master = join(out, 'icon.png')
writeFileSync(master, png(S, S, rgba))

// .icns: iconutil only on macOS; otherwise the PNG is enough (electron-builder converts it)
const set = join(out, 'icon.iconset')
try {
  rmSync(set, { recursive: true, force: true })
  mkdirSync(set)
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2]) {
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
      execFileSync('sips', ['-z', String(size * scale), String(size * scale), master, '--out', join(set, name)], { stdio: 'ignore' })
    }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(out, 'icon.icns')])
  console.log('build/icon.png ve build/icon.icns yazıldı')
} catch (e) {
  console.log(`build/icon.png yazıldı (.icns üretilemedi: ${e.message})`)
} finally {
  rmSync(set, { recursive: true, force: true })
}
