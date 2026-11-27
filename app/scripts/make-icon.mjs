// App icon: the boss bot at its desk, inside the macOS rounded-square mask.
//
//   node scripts/make-icon.mjs [--variant legacy|A|B|C]
//     → build/icon.png (1024), build/icon.ico (Windows, 16–256) and build/icon.icns (via iconutil)
//   node scripts/make-icon.mjs --variant A --preview --out <dir>
//     → <dir>/A-{1024,128,64,32,16}.png only (build/ is left alone)
//   node scripts/make-icon.mjs --sheet --out <dir>
//     → previews of A, B and C plus <dir>/sheet.png (256/64/16 px on a light and a dark strip)
//
// Variants:
//   legacy  the original 32×32 pixel-art scene with the teal bot (default)
//   A       flat, modern terracotta bot behind a dark desk on cream
//   B       the same bot on a dark warm-brown background with a cream desk
//   C       refined 64×64 pixel art in terracotta on dark brown
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const S = 1024

// ---------- arguments ----------
const argv = process.argv.slice(2)
const opt = name => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const flag = name => argv.includes(name)
const variant = opt('--variant') ?? 'B'
const outDir = resolve(opt('--out') ?? join(root, 'build'))

// ---------- colours ----------
const hex = c => [(c >> 16) & 255, (c >> 8) & 255, c & 255]
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = t => t * t * (3 - 2 * t)

// ---------- pixel-art grid renderer (legacy and C) ----------
function pixelGrid(n) {
  const grid = new Uint32Array(n * n)
  const rect = (x, y, w, h, c) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < n && j < n) grid[j * n + i] = c
  }
  return { n, grid, rect, px: (x, y, c) => rect(x, y, 1, 1, c) }
}
// Scale a grid onto the 1024 canvas, centred, each cell `cell` px wide.
function gridToRgb({ n, grid }, cell) {
  const rgb = new Float32Array(S * S * 3)
  const off = (S - n * cell) / 2
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const gx = Math.min(n - 1, Math.max(0, Math.floor((x - off) / cell)))
      const gy = Math.min(n - 1, Math.max(0, Math.floor((y - off) / cell)))
      const c = grid[gy * n + gx]
      const o = (y * S + x) * 3
      rgb[o] = (c >> 16) & 255
      rgb[o + 1] = (c >> 8) & 255
      rgb[o + 2] = c & 255
    }
  return rgb
}

function drawLegacy() {
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
  const N = 32
  const g = pixelGrid(N)
  const { rect, px } = g
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
  return { rgb: gridToRgb(g, 26), radius: 416, shadow: false }
}

// Variant C: the same scene redrawn on a 64×64 grid in a warm palette, with fewer props and cleaner shapes.
function drawPixelC() {
  const C = {
    wall: 0x3b2a23, wallLo: 0x31221d, halo: 0x46322a, haloIn: 0x503a30,
    ol: 0x1e1411, body: 0xdf7a4b, bodyHi: 0xf19c6c, bodyLo: 0xb85a34,
    eye: 0x1e1411, glint: 0xffe7d1, mouth: 0x8e3f22,
    tie: 0x4b2622, tieHi: 0x6a3530, ball: 0xffc46b, ballHi: 0xffe2a8,
    deskTop: 0xf0e2ca, deskFront: 0xd9c3a0, deskLo: 0xbca37f, deskEdge: 0xfaf1e2,
    plate: 0xf2b13d, plateLo: 0xc98a24,
    mug: 0xf6ede0, mugLo: 0xd8cbb7, coffee: 0x5a3a28, paper: 0xffffff, paperLo: 0xe3d5c0,
  }
  const N = 64
  const g = pixelGrid(N)
  const { rect, px } = g
  // wall with a soft stepped halo behind the bot
  rect(0, 0, N, N, C.wall)
  rect(0, 30, N, 14, C.wallLo)
  rect(10, 6, 44, 38, C.halo)
  rect(8, 8, 48, 34, C.halo)
  rect(14, 9, 36, 35, C.haloIn)
  rect(12, 11, 40, 33, C.haloIn)
  // rounded rect helper with a 1-cell outline and 2-step corners
  const blob = (x, y, w, h, fill) => {
    rect(x - 1, y + 1, w + 2, h - 2, C.ol)
    rect(x + 1, y - 1, w - 2, h + 2, C.ol)
    rect(x, y, w, h, C.ol)
    rect(x, y + 2, w, h - 4, fill)
    rect(x + 2, y, w - 4, h, fill)
    rect(x + 1, y + 1, w - 2, h - 2, fill)
  }
  // antenna
  rect(31, 8, 2, 5, C.ol)
  blob(29, 4, 6, 5, C.ball)
  rect(30, 5, 2, 1, C.ballHi)
  // head and torso
  blob(15, 13, 34, 33, C.body)
  rect(18, 14, 28, 2, C.bodyHi)
  rect(16, 17, 2, 18, C.bodyHi)
  rect(17, 39, 30, 6, C.bodyLo)
  // square eyes with a glint
  rect(22, 22, 5, 6, C.eye)
  rect(37, 22, 5, 6, C.eye)
  rect(23, 23, 2, 2, C.glint)
  rect(38, 23, 2, 2, C.glint)
  // small smile
  rect(29, 32, 6, 1, C.mouth)
  px(28, 31, C.mouth)
  px(35, 31, C.mouth)
  // tie
  rect(30, 36, 4, 2, C.ol)
  rect(31, 36, 2, 1, C.tieHi)
  rect(29, 38, 6, 6, C.ol)
  rect(30, 38, 4, 5, C.tie)
  rect(31, 38, 1, 4, C.tieHi)
  // arms resting on the desk
  blob(11, 38, 8, 7, C.body)
  blob(45, 38, 8, 7, C.body)
  rect(12, 39, 5, 1, C.bodyHi)
  rect(46, 39, 5, 1, C.bodyHi)
  // coffee mug (left) and papers (right), standing on the desk
  rect(3, 35, 6, 9, C.ol)
  rect(4, 36, 4, 7, C.mug)
  rect(4, 36, 4, 1, C.coffee)
  rect(4, 41, 4, 2, C.mugLo)
  rect(9, 37, 2, 5, C.ol)
  px(9, 38, C.mug); px(9, 39, C.mug); px(9, 40, C.mug)
  rect(54, 37, 7, 7, C.ol)
  for (let k = 0; k < 3; k++) {
    rect(55, 38 + k * 2, 5, 1, C.paper)
    rect(55, 39 + k * 2, 5, 1, C.paperLo)
  }
  // desk: light edge, top surface, front, name plate
  rect(0, 44, N, 1, C.ol)
  rect(0, 45, N, 1, C.deskEdge)
  rect(0, 46, N, 4, C.deskTop)
  rect(0, 50, N, 1, C.deskLo)
  rect(0, 51, N, 13, C.deskFront)
  rect(0, 60, N, 4, C.deskLo)
  rect(23, 53, 18, 5, C.ol)
  rect(24, 54, 16, 3, C.plate)
  rect(24, 56, 16, 1, C.plateLo)
  // 64 cells × 13 px = 832 px
  return { rgb: gridToRgb(g, 13), radius: 416, shadow: true }
}

// ---------- vector renderer (A and B) ----------
// Shapes are signed distance functions; coverage at a pixel centre comes from the distance, which gives
// clean anti-aliasing at 1024 px without supersampling. `blur` widens the edge for soft shadows and glows.
const sdRoundRect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - hw + r
  const qy = Math.abs(y - cy) - hh + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const sdCircle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r
// Convex polygon (clockwise in screen space): the max of the distances to each edge line.
const sdPolygon = pts => {
  const edges = pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length]
    const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy)
    return [p[0], p[1], dy / len, -dx / len]
  })
  return (x, y) => {
    let d = -Infinity
    for (const [px, py, nx, ny] of edges) d = Math.max(d, (x - px) * nx + (y - py) * ny)
    return d
  }
}
const sdSubtract = (a, b) => (x, y) => Math.max(a(x, y), -b(x, y))

function vectorCanvas() {
  const rgb = new Float32Array(S * S * 3)
  // paint: [r,g,b] or (x, y) => [r,g,b]
  const fill = (sd, box, paint, { alpha = 1, blur = 1 } = {}) => {
    const pad = Math.ceil(blur) + 1
    const x0 = Math.max(0, Math.floor(box[0] - pad)), y0 = Math.max(0, Math.floor(box[1] - pad))
    const x1 = Math.min(S, Math.ceil(box[2] + pad)), y1 = Math.min(S, Math.ceil(box[3] + pad))
    const fn = typeof paint === 'function'
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const d = sd(x + 0.5, y + 0.5)
        let a = blur <= 1 ? clamp01(0.5 - d) : smooth(clamp01(0.5 - d / blur))
        a *= alpha
        if (a <= 0) continue
        const c = fn ? paint(x + 0.5, y + 0.5) : paint
        const o = (y * S + x) * 3
        rgb[o] += (c[0] - rgb[o]) * a
        rgb[o + 1] += (c[1] - rgb[o + 1]) * a
        rgb[o + 2] += (c[2] - rgb[o + 2]) * a
      }
  }
  return { rgb, fill }
}
const vgrad = (y0, c0, y1, c1) => (x, y) => mix(c0, c1, clamp01((y - y0) / (y1 - y0)))

// Flat modern bot. The canvas is 1024; the rounded square spans 100…924 (824 px).
function drawFlat(theme) {
  const T = Object.fromEntries(Object.entries(theme).map(([k, v]) => [k, typeof v === 'number' ? hex(v) : v]))
  const { rgb, fill } = vectorCanvas()
  const all = [0, 0, S, S]
  const ink = T.ink

  // background and a warm glow behind the bot
  fill(() => -1, all, vgrad(100, T.bgTop, 924, T.bgBottom))
  if (T.glow) fill(sdCircle(512, 430, 250), [0, 0, S, S], T.glow, { alpha: theme.glowAlpha, blur: 420 })

  // soft shadow of the bot on the wall
  fill(sdRoundRect(512, 504, 236, 214, 104), [250, 260, 774, 760], ink, { alpha: theme.wallShadow, blur: 70 })

  // antenna
  fill(sdRoundRect(512, 248, 13, 40, 13), [495, 205, 529, 292], T.bodyDark)
  fill(sdCircle(512, 204, 36), [466, 160, 558, 250], T.ball, { alpha: theme.ballGlow, blur: 90 })
  fill(sdCircle(512, 204, 36), [466, 160, 558, 250], vgrad(168, T.ballHi, 240, T.ball))

  // head and torso in one rounded block, lighter at the top
  const body = sdRoundRect(512, 494, 236, 212, 108)
  fill(body, [272, 278, 752, 710], vgrad(282, T.bodyTop, 706, T.bodyBottom))
  // a faint sheen along the top edge
  fill(sdSubtract(body, sdRoundRect(512, 512, 236, 212, 108)), [272, 278, 752, 334], T.sheen, { alpha: 0.35 })

  // square eyes with a pixel glint, and a small smile
  for (const ex of [420, 604]) {
    fill(sdRoundRect(ex, 462, 38, 42, 12), [ex - 42, 416, ex + 42, 508], T.eye)
    fill(sdRoundRect(ex - 14, 443, 12, 12, 3), [ex - 28, 430, ex, 456], T.glint)
  }
  const smile = sdSubtract(sdCircle(512, 530, 46), sdCircle(512, 512, 50))
  fill((x, y) => Math.max(smile(x, y), 544 - y), [460, 544, 564, 584], T.eye)

  // tie: knot and blade
  fill(sdRoundRect(512, 618, 24, 15, 6), [486, 600, 538, 636], T.tie)
  fill(sdPolygon([[490, 632], [534, 632], [548, 690], [476, 690]]), [470, 628, 554, 694], T.tie)

  // desk: lighter top surface, then the front
  fill(sdRoundRect(512, 720, 520, 42, 20), [-10, 675, 1034, 765], T.deskTop)
  fill(() => -1, [0, 742, S, S], vgrad(742, T.deskFront, 924, T.deskBottom))
  fill(sdRoundRect(512, 746, 520, 4, 4), [-10, 740, 1034, 752], ink, { alpha: 0.18, blur: 6 })

  // name plate on the desk front
  fill(sdRoundRect(512, 840, 108, 32, 12), [400, 804, 624, 876], ink, { alpha: 0.25, blur: 14 })
  fill(sdRoundRect(512, 834, 108, 32, 12), [402, 800, 622, 868], vgrad(802, T.plateHi, 866, T.plate))

  // arms resting on the desk, with a soft contact shadow
  for (const ax of [292, 732]) {
    fill(sdRoundRect(ax, 718, 60, 38, 34), [ax - 76, 670, ax + 76, 770], ink, { alpha: 0.3, blur: 22 })
    fill(sdRoundRect(ax, 700, 58, 40, 36), [ax - 60, 658, ax + 60, 742], vgrad(662, T.bodyTop, 740, T.bodyBottom))
  }

  // coffee mug (left), standing on the desk
  fill(sdSubtract(sdCircle(210, 642, 24), sdCircle(210, 642, 12)), [180, 614, 238, 670], T.mug)
  fill(sdRoundRect(170, 644, 36, 48, 12), [132, 594, 208, 694], T.mug)
  fill(sdRoundRect(170, 606, 28, 8, 6), [140, 596, 200, 616], T.coffee)

  // papers (right): a small stack lying on the desk top
  for (let k = 0; k < 3; k++) {
    const y = 700 - k * 16
    const x = 850 + (k % 2) * 6
    fill(sdRoundRect(x, y + 4, 58, 9, 4), [784, y - 10, 920, y + 18], ink, { alpha: 0.2, blur: 6 })
    fill(sdRoundRect(x, y, 58, 9, 4), [786, y - 12, 918, y + 12], T.paper)
  }
  return { rgb, radius: 412, shadow: true }
}

const THEMES = {
  // cream wall, dark walnut desk
  A: {
    bgTop: 0xfbf3e6, bgBottom: 0xf1e1c9, ink: 0x2a1a14, wallShadow: 0.12,
    glow: null, glowAlpha: 0,
    bodyTop: 0xee9364, bodyBottom: 0xcc6238, bodyDark: 0xb4552f, sheen: 0xffc9a8,
    eye: 0x2a1a14, glint: 0xfff1e3, tie: 0x4a2723,
    ball: 0xf0a03c, ballHi: 0xffd08a, ballGlow: 0,
    deskTop: 0x5c3d30, deskFront: 0x47302a, deskBottom: 0x3a2722,
    plate: 0xe0962f, plateHi: 0xf6bd5c,
    mug: 0x47302a, coffee: 0x2a1a14, paper: 0xfffaf2,
  },
  // dark warm-brown wall with a glow, cream desk
  B: {
    bgTop: 0x3d2a22, bgBottom: 0x21160f, ink: 0x0f0906, wallShadow: 0.35,
    glow: 0xe07a4a, glowAlpha: 0.32,
    bodyTop: 0xf09a69, bodyBottom: 0xcf6539, bodyDark: 0xb4552f, sheen: 0xffd2b5,
    eye: 0x2a1a14, glint: 0xfff1e3, tie: 0x4a2723,
    ball: 0xffb54d, ballHi: 0xffe0a6, ballGlow: 0.55,
    deskTop: 0xf6ead6, deskFront: 0xe4d1b2, deskBottom: 0xcdb48f,
    plate: 0xd9862a, plateHi: 0xf2ac4e,
    mug: 0xf6ead6, coffee: 0x5a3a28, paper: 0xffffff,
  },
}

// ---------- mask, shadow, output ----------
// Rounded square (superellipse n=5) of the given radius, centred, 4×4 supersampled at the edge.
// With `shadow`, a soft drop shadow sits under the shape in the margin, as macOS icon templates do.
function finish({ rgb, radius: R, shadow }) {
  const rgba = Buffer.alloc(S * S * 4)
  const inside = (x, y) => Math.abs((x - S / 2) / R) ** 5 + Math.abs((y - S / 2) / R) ** 5 <= 1
  const shadowAt = (x, y) => {
    const v = Math.abs((x - S / 2) / R) ** 5 + Math.abs((y - S / 2 - 12) / R) ** 5
    const d = (v ** 0.2 - 1) * R // approximate distance outside the shape
    return 0.22 * smooth(clamp01(1 - d / 28))
  }
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let cover = 0
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) cover++
      const m = cover / 16
      const s = shadow ? shadowAt(x + 0.5, y + 0.5) : 0
      const a = m + s * (1 - m)
      if (a <= 0) continue
      const o = (y * S + x) * 4
      const i = (y * S + x) * 3
      // shadow is black, so only the shape contributes colour
      rgba[o] = Math.round((rgb[i] * m) / a)
      rgba[o + 1] = Math.round((rgb[i + 1] * m) / a)
      rgba[o + 2] = Math.round((rgb[i + 2] * m) / a)
      rgba[o + 3] = Math.round(a * 255)
    }
  return rgba
}

function render(v) {
  if (v === 'legacy') return finish(drawLegacy())
  if (v === 'A' || v === 'B') return finish(drawFlat(THEMES[v]))
  if (v === 'C') return finish(drawPixelC())
  throw new Error(`unknown variant: ${v} (expected legacy, A, B or C)`)
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

// Box-filtered (alpha-weighted) downscale of a 1024 master; size must divide 1024.
function downscale(rgba, size) {
  const k = S / size
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let j = y * k; j < (y + 1) * k; j++)
        for (let i = x * k; i < (x + 1) * k; i++) {
          const o = (j * S + i) * 4
          const al = rgba[o + 3]
          r += rgba[o] * al; g += rgba[o + 1] * al; b += rgba[o + 2] * al; a += al
        }
      const o = (y * size + x) * 4
      if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a) }
      out[o + 3] = Math.round(a / (k * k))
    }
  return out
}

function bmp(size, data) {
  const head = Buffer.alloc(40)
  head.writeUInt32LE(40, 0)
  head.writeInt32LE(size, 4)
  head.writeInt32LE(size * 2, 8) // XOR image + AND mask
  head.writeUInt16LE(1, 12)
  head.writeUInt16LE(32, 14)
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4
      const d = ((size - 1 - y) * size + x) * 4 // bottom-up, BGRA
      pixels[d] = data[s + 2]; pixels[d + 1] = data[s + 1]; pixels[d + 2] = data[s]; pixels[d + 3] = data[s + 3]
    }
  const mask = Buffer.alloc((((size + 31) >> 5) << 2) * size) // all 0: alpha decides
  return Buffer.concat([head, pixels, mask])
}

// Full build: icon.png, icon.ico and icon.icns in outDir.
function writeBuild(rgba) {
  mkdirSync(outDir, { recursive: true })
  const master = join(outDir, 'icon.png')
  writeFileSync(master, png(S, S, rgba))

  // .ico (Windows: the executable, the installer and the taskbar). 256 is stored as PNG, the small ones as
  // 32-bit BMPs, which every Windows tool (NSIS included) reads. 24 and 48 do not divide 1024, so they are
  // box-filtered from the nearest larger exact size.
  const exact = size => downscale(rgba, size)
  const sized = size => {
    if (S % size === 0) return exact(size)
    const big = 2 ** Math.ceil(Math.log2(size))
    return resample(exact(big), big, size)
  }
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images = sizes.map(size => (size === 256 ? png(size, size, sized(size)) : bmp(size, sized(size))))
  const dir = Buffer.alloc(6 + 16 * sizes.length)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(sizes.length, 4)
  let at = dir.length
  sizes.forEach((size, n) => {
    const e = 6 + 16 * n
    dir[e] = size % 256 // 0 means 256
    dir[e + 1] = size % 256
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(images[n].length, e + 8)
    dir.writeUInt32LE(at, e + 12)
    at += images[n].length
  })
  writeFileSync(join(outDir, 'icon.ico'), Buffer.concat([dir, ...images]))

  // .icns: iconutil only on macOS; otherwise the PNG is enough (electron-builder converts it)
  const set = join(outDir, 'icon.iconset')
  try {
    rmSync(set, { recursive: true, force: true })
    mkdirSync(set)
    for (const size of [16, 32, 128, 256, 512])
      for (const scale of [1, 2]) {
        const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
        const px = size * scale
        writeFileSync(join(set, name), png(px, px, downscale(rgba, px)))
      }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', join(outDir, 'icon.icns')])
    console.log(`${variant}: icon.png, icon.ico and icon.icns written to ${outDir}`)
  } catch (e) {
    console.log(`${variant}: icon.png and icon.ico written (.icns could not be built: ${e.message})`)
  } finally {
    rmSync(set, { recursive: true, force: true })
  }
}

// Area resample of a small square RGBA image (used only for the .ico sizes that do not divide 1024).
function resample(src, from, to) {
  const out = Buffer.alloc(to * to * 4)
  const k = from / to
  for (let y = 0; y < to; y++)
    for (let x = 0; x < to; x++) {
      let r = 0, g = 0, b = 0, a = 0, w = 0
      for (let j = Math.floor(y * k); j < Math.ceil((y + 1) * k); j++)
        for (let i = Math.floor(x * k); i < Math.ceil((x + 1) * k); i++) {
          const wy = Math.min(j + 1, (y + 1) * k) - Math.max(j, y * k)
          const wx = Math.min(i + 1, (x + 1) * k) - Math.max(i, x * k)
          const ww = wx * wy, o = (j * from + i) * 4, al = src[o + 3] * ww
          r += src[o] * al; g += src[o + 1] * al; b += src[o + 2] * al; a += al; w += ww
        }
      const o = (y * to + x) * 4
      if (a) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a) }
      out[o + 3] = Math.round(a / w)
    }
  return out
}

const PREVIEW_SIZES = [128, 64, 32, 16]
function writePreview(v, rgba) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `${v}-1024.png`), png(S, S, rgba))
  for (const size of PREVIEW_SIZES) writeFileSync(join(outDir, `${v}-${size}.png`), png(size, size, downscale(rgba, size)))
  console.log(`${v}: previews written to ${outDir}`)
}

// Contact sheet: each variant at 256, 64 and 16 px on a light and a dark strip, labelled A, B, C.
function writeSheet(masters) {
  const GLYPHS = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  }
  const sizes = [256, 64, 16]
  const gap = 32
  const cellW = gap + sizes.reduce((s, z) => s + z + gap, 0)
  const labelH = 64
  const stripH = labelH + 256 + gap
  const names = Object.keys(masters)
  const W = cellW * names.length
  const H = stripH * 2
  const img = Buffer.alloc(W * H * 4)
  const strips = [[0xf5, 0xf3, 0xf0], [0x1e, 0x1c, 0x1b]]
  strips.forEach((bg, s) => {
    for (let y = s * stripH; y < (s + 1) * stripH; y++)
      for (let x = 0; x < W; x++) img.set([...bg, 255], (y * W + x) * 4)
  })
  const blit = (src, size, ox, oy) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const s = (y * size + x) * 4, d = ((oy + y) * W + ox + x) * 4, a = src[s + 3] / 255
        for (let c = 0; c < 3; c++) img[d + c] = Math.round(img[d + c] * (1 - a) + src[s + c] * a)
      }
  }
  strips.forEach((bg, s) => {
    const ink = s === 0 ? [0x3a, 0x30, 0x2a] : [0xe8, 0xe0, 0xd8]
    names.forEach((v, n) => {
      const x0 = n * cellW, y0 = s * stripH
      const glyph = GLYPHS[v] ?? []
      glyph.forEach((row, gy) =>
        [...row].forEach((bit, gx) => {
          if (bit !== '1') return
          for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) img.set([...ink, 255], ((y0 + 24 + gy * 5 + y) * W + x0 + gap + gx * 5 + x) * 4)
        }),
      )
      let x = x0 + gap
      for (const size of sizes) {
        const small = size === S ? masters[v] : downscale(masters[v], size)
        blit(small, size, x, y0 + labelH + (256 - size) / 2)
        x += size + gap
      }
    })
  })
  writeFileSync(join(outDir, 'sheet.png'), png(W, H, img))
  console.log(`sheet.png written to ${outDir}`)
}

if (flag('--sheet')) {
  const masters = {}
  for (const v of ['A', 'B', 'C']) writePreview(v, (masters[v] = render(v)))
  writeSheet(masters)
} else if (flag('--preview')) {
  writePreview(variant, render(variant))
} else {
  writeBuild(render(variant))
}
