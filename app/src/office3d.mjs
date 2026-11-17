// 3D office (contract v3.81): pure, no DOM; shared with the renderer (renderer/office3d.js draws it with WebGL) and
// tested in test/office3d.test.mjs. core.mjs still runs the office (who sits where, who walks, who dances) and
// draws its pixel frame; sceneOf() hands over what that frame showed, and this module builds the same office from
// boxes: x = core's x, z = core's y (toward the camera), y = up, one unit = one logical pixel.

const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]

/** Triangles with a position, normal, colour and an emissive amount per vertex. */
export class Mesh {
  constructor() {
    this.p = []
    this.n = []
    this.c = []
    this.e = []
  }
  get count() {
    return this.p.length / 3
  }
  quad(a, b, c, d, nor, col, emi) {
    for (const v of [a, b, c, a, c, d]) {
      this.p.push(v[0], v[1], v[2])
      this.n.push(nor[0], nor[1], nor[2])
      this.c.push(col[0], col[1], col[2])
      this.e.push(emi)
    }
  }
  /** An axis-aligned box (its bottom face only when it floats). */
  box(x0, y0, z0, x1, y1, z1, hex, emi = 0) {
    const col = rgb(hex)
    const top = col.map((v) => Math.min(1, v * 1.06))
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], top, emi)
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], col, emi)
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], col, emi)
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], col, emi)
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], col, emi)
    if (y0 > 0.01) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], col, emi)
  }
  /** A flat floor tile. */
  tile(x0, z0, x1, z1, hex, y = 0, emi = 0) {
    this.quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], [0, 1, 0], rgb(hex), emi)
  }
}

export const WALL_H = 30   // the rooms' walls
const DIV_H = 9            // the low wall between the rooms and the hall
const BOT_SCALE = 1.35

function checker(m, x0, z0, x1, z1, size, a, b) {
  for (let z = z0, j = 0; z < z1; z += size, j++)
    for (let x = x0, i = 0; x < x1; x += size, i++) m.tile(x, z, Math.min(x + size, x1), Math.min(z + size, z1), (i + j) % 2 ? b : a)
}
function planks(m, x0, z0, x1, z1, C) {
  for (let z = z0, j = 0; z < z1; z += 5, j++) {
    const off = (j % 3) * 9
    for (let x = x0 - off, i = 0; x < x1; x += 26, i++) m.tile(Math.max(x, x0), z, Math.min(x + 25.6, x1), Math.min(z + 4.7, z1), (i + j) % 2 ? C.woodA : C.woodB)
  }
}
function plant(m, x, z, C, big = false) {
  const s = big ? 1.4 : 1
  m.box(x - 3 * s, 0, z - 3 * s, x + 3 * s, 6 * s, z + 3 * s, C.pot)
  for (const [dx, dy, dz, k] of [[0, 9, 0, 0], [-3, 7, 1, 1], [3, 8, -1, 1], [1, 12, 1, 0], [-2, 11, -2, 1]])
    m.box(x + (dx - 2.5) * s, (dy - 2.5) * s, z + (dz - 2.5) * s, x + (dx + 2.5) * s, (dy + 2.5) * s, z + (dz + 2.5) * s, k ? C.leafDark : C.leaf)
}
function windowOn(m, x, w, B, C) {
  m.box(x - 1, 9, B + 2.6, x + w + 1, 25, B + 3.4, C.windowFrame)
  m.box(x, 10, B + 3.2, x + w, 24, B + 3.6, C.sky, 0.8)
  m.box(x + w / 2 - 0.5, 10, B + 3.4, x + w / 2 + 0.5, 24, B + 3.8, C.windowFrame)
}

/** The part that changes only with the size or the theme: floors, walls, furniture. */
export function buildStatic(scene) {
  const { LW, LH, L, C } = scene
  const { B, dividerY, hallFaceTop: hallTop, bossX1, serverX0, loungeX0, loungeX1 } = L
  const m = new Mesh()
  m.box(-6, -3, -6, LW + 6, -0.3, LH + 6, C.frame)
  planks(m, B, B, bossX1, dividerY, C)
  checker(m, loungeX0, B, loungeX1, dividerY, 8, C.checkA, C.checkB)
  checker(m, serverX0 + 4, B, LW - B, dividerY, 10, C.serverA, C.serverB)
  checker(m, B, hallTop, LW - B, LH - B, 12, C.carpetA, C.carpetB)
  for (const [x0, x1] of [[bossX1, loungeX0], [loungeX1, serverX0 + 4]]) m.tile(x0, B, x1, dividerY, C.wallTop, -0.1)
  // back walls, outer walls, a low front edge
  m.box(B, 0, 0, bossX1, WALL_H, B + 2.6, C.brick)
  m.box(loungeX0, 0, 0, loungeX1, WALL_H, B + 2.6, C.cream)
  m.box(serverX0 + 4, 0, 0, LW - B, WALL_H, B + 2.6, C.panel)
  for (const [x0, x1] of [[B, bossX1], [loungeX0, loungeX1]]) m.box(x0, 0, B + 2.6, x1, 7, B + 3.2, C.wainscot)
  m.box(0, 0, 0, B, WALL_H, LH, C.wallTop)
  m.box(LW - B, 0, 0, LW, WALL_H, LH, C.wallTop)
  m.box(B, 0, LH - B, LW - B, 3, LH, C.wallTop)
  m.box(0, WALL_H, 0, LW, WALL_H + 1.5, B, C.wallTop)
  // room walls and the low wall to the hall, with its three doors
  for (const wx of [bossX1, serverX0]) m.box(wx, 0, B, wx + 4, WALL_H, dividerY, C.wallTop)
  let x = B
  for (const d of [L.bossDoorX, L.loungeDoorX, L.serverDoorX]) {
    m.box(x, 0, dividerY, d - 10, DIV_H, hallTop, C.sage)
    m.box(x, DIV_H, dividerY, d - 10, DIV_H + 1, hallTop, C.wallTop)
    x = d + 10
  }
  m.box(x, 0, dividerY, LW - B, DIV_H, hallTop, C.sage)
  m.box(x, DIV_H, dividerY, LW - B, DIV_H + 1, hallTop, C.wallTop)
  // the boss's office
  m.box(B + 14, 0, 38, B + 98, 0.4, 86, C.rugGold)
  m.box(B + 16, 0, 40, B + 96, 0.6, 84, C.rugRed)
  m.box(B + 22, 0, 46, B + 90, 0.8, 78, C.rugRedIn)
  m.box(B + 4, 0, B + 3, B + 26, 34, B + 11, C.shelf)
  for (let r = 0; r < 4; r++)
    for (let i = 0; i < 6; i++) {
      const h = 5 + ((r * 7 + i * 3) % 3)
      m.box(B + 5.5 + i * 3.4, 3 + r * 8, B + 10.6, B + 8.4 + i * 3.4, 3 + r * 8 + h, B + 11.6, C.book[(r * 3 + i) % C.book.length])
    }
  windowOn(m, B + 34, 24, B, C)
  plant(m, B + 102, 20, C, true)
  m.box(bossX1 - 15, 0, 28, bossX1 - 13, 22, 30, C.lampPole)
  m.box(bossX1 - 19, 20, 24, bossX1 - 9, 27, 34, C.lampShade, 0.6)
  const { cx: bx, by: bz } = L.boss
  m.box(bx - 26, 0, bz - 10, bx + 26, 9, bz + 2, C.deskFront)
  m.box(bx - 27, 9, bz - 11, bx + 27, 10.5, bz + 3, C.deskTop)
  m.box(bx - 9, 2, bz + 2, bx + 9, 7, bz + 2.6, C.gold)
  m.box(bx + 4, 10.5, bz - 9, bx + 20, 22, bz - 8, C.lid)
  const sx = L.boss.seat[0]
  m.box(sx - 7, 0, bz - 24, sx + 7, 19, bz - 20, C.bossChair)
  m.box(sx - 7, 0, bz - 20, sx + 7, 6, bz - 13, C.bossChair)
  // the lounge: counter and coffee machine, windows, a plant
  const cx0 = loungeX0 + 6
  const cw = Math.min(46, loungeX1 - loungeX0 - 44)
  m.box(cx0, 0, B + 3, cx0 + cw, 12, B + 14, C.wainscot)
  m.box(cx0 - 0.5, 12, B + 3, cx0 + cw + 0.5, 13.5, B + 14.5, C.deskTop)
  m.box(cx0 + 3, 13.5, B + 4, cx0 + 14, 25, B + 11, C.machine)
  m.box(cx0 + cw - 9, 13.5, B + 8, cx0 + cw - 6, 16.5, B + 11, C.mug)
  if (loungeX1 - loungeX0 > 110) windowOn(m, loungeX1 - 28, 20, B, C)
  windowOn(m, Math.max(cx0 + cw + 6, loungeX0 + 60), 20, B, C)
  plant(m, loungeX1 - 10, 20, C)
  // the server room: racks along the wall, a cabinet
  for (let i = 0; i < Math.floor((LW - B - serverX0 - 24) / 20); i++) {
    const rx = serverX0 + 10 + i * 20
    m.box(rx, 0, B + 3, rx + 16, 34, B + 14, C.rack)
    for (let r = 0; r < 7; r++) m.box(rx + 1, 3 + r * 4.4, B + 14, rx + 15, 6 + r * 4.4, B + 14.4, C.rackHi)
  }
  m.box(LW - B - 18, 0, 62, LW - B - 2, 22, 72, C.cabinet)
  for (let k = 0; k < 3; k++) m.box(LW - B - 14, 4 + k * 6, 72, LW - B - 6, 5 + k * 6, 72.6, C.cabinetDark)
  // the hall: the board on the low wall, plants, the water cooler, desks and chairs
  m.box(40, 1, hallTop, 98, 8, hallTop + 0.8, C.boardFrame)
  m.box(41, 1.6, hallTop + 0.8, 97, 7.4, hallTop + 1.2, C.board, 0.2)
  plant(m, LW - B - 10, hallTop + 10, C, true)
  plant(m, B + 7, hallTop + 9, C)
  m.box(LW - B - 16, 0, LH - B - 14, LW - B - 6, 16, LH - B - 6, C.cooler)
  m.box(LW - B - 15, 16, LH - B - 13, LW - B - 7, 24, LH - B - 7, C.water, 0.3)
  for (const d of L.desks) {
    m.box(d.cx - 14, 0, d.by - 8, d.cx + 14, 7, d.by + 2, C.deskFront)
    m.box(d.cx - 15, 7, d.by - 9, d.cx + 15, 8.4, d.by + 3, C.deskTop)
    m.box(d.cx - 10, 0, d.by - 21, d.cx, 15, d.by - 18, C.chair)
    m.box(d.cx - 10, 0, d.by - 18, d.cx, 5, d.by - 13, C.chair)
    m.box(d.cx - 12, 8.4, d.by - 6, d.cx - 9, 11, d.by - 3, C.mug)
  }
  return m
}

/** A bot: body, eyes toward the camera, arms, legs; seated ones sit lower and type. Its height is returned. */
function bot(m0, b, C) {
  const S = BOT_SCALE
  const seated = Boolean(b.seated)
  const x = b.x
  const z = seated ? b.y - (b.isBoss ? 15 : 13) : b.y
  const lift = b.pose === 'dance' && b.frame === 1 ? 1.5 : 0
  const m = { box: (x0, y0, z0, x1, y1, z1, c, e) => m0.box(x + (x0 - x) * S, y0 * S + lift, z + (z0 - z) * S, x + (x1 - x) * S, y1 * S + lift, z + (z1 - z) * S, c, e) }
  const body = C.body
  const legH = seated ? 0 : 3
  const y0 = seated ? 4 : 0
  if (!seated)
    [-4, -2, 1, 3].forEach((lx, i) => m.box(x + lx - 0.5, 0, z - 1, x + lx + 0.5, legH - (b.pose === 'walk' && i % 2 === b.frame ? 1 : 0), z + 1, body))
  const by = y0 + legH
  m.box(x - 5, by, z - 4, x + 5, by + 9, z + 4, body)
  m.box(x - 4.5, by + 8.2, z - 3.5, x + 4.5, by + 9.2, z + 3.5, C.bodyHi)
  const ex = b.look > 0 ? 1 : b.look < 0 ? -1 : 0
  m.box(x - 3 + ex, by + 4.5, z + 4, x - 2 + ex, by + 6.5, z + 4.5, C.eye)
  m.box(x + 2 + ex, by + 4.5, z + 4, x + 3 + ex, by + 6.5, z + 4.5, C.eye)
  const typing = b.pose === 'type'
  const arm = typing ? b.frame : b.pose === 'dance' ? (b.frame === 2 ? 3 : 0) : 0
  const reach = typing ? 3 : 0
  m.box(x - 7.5, by + 3 + arm, z - 1 + reach, x - 5, by + 5 + arm, z + 1 + reach, body)
  m.box(x + 5, by + 4 - (typing ? arm : 0) + (b.pose === 'dance' ? arm : 0), z - 1 + reach, x + 7.5, by + 6 - (typing ? arm : 0) + (b.pose === 'dance' ? arm : 0), z + 1 + reach, body)
  if (b.isBoss) m.box(x - 1, by + 0.5, z + 4, x + 1, by + 3.5, z + 4.4, C.tie)
  if (b.hasMug) m.box(x + 7.5, by + 3, z, x + 10, by + 6, z + 2.5, C.mug)
  if (b.hat != null) {
    m.box(x - 2.5, by + 9, z - 2.5, x + 2.5, by + 12, z + 2.5, b.hat)
    m.box(x - 1.2, by + 12, z - 1.2, x + 1.2, by + 15, z + 1.2, b.hat)
    m.box(x - 0.8, by + 15, z - 0.8, x + 0.8, by + 16.5, z + 0.8, C.white)
  }
  if (b.paper != null) m.box(x - 3, by + 11, z - 0.5, x + 3, by + 15, z + 0.5, b.paper ? C.paper : C.bad)
  if (b.carry != null) m.box(x + 7, by + 2, z - 2, x + 10, by + 6, z + 2, b.carry ? C.paper : C.bad)
  return { x, z, top: (by + 9) * S + lift + (b.hat != null ? 6 : 0) }
}

/**
 * The part that moves: the dance floor's lights, screens, desk plates, the boss's paper stack and every bot.
 * → { mesh, anchors: Map<bot id, { x, z, top }> } (where each bot stands, for its label and for picking).
 */
export function buildDynamic(scene) {
  const { L, C, now } = scene
  const m = new Mesh()
  const anchors = new Map()
  // dance floor
  const P = L.party
  const neon = [C.neonPink, C.neonCyan, C.neonPurple, C.accent, C.yellow]
  const beat = Math.floor(now / (scene.hot ? 230 : 420))
  m.box(P.fx0, 0, P.fy0, P.fx0 + P.fw, 0.5, P.fy0 + P.fh, C.floorDark)
  for (let j = 0; j < P.rows; j++)
    for (let i = 0; i < P.cols; i++) {
      const on = (i * 7 + j * 13 + beat * 5) % 3 !== 0 && (scene.hot || (i + j + beat) % 4 === 0)
      m.box(P.fx0 + 1 + i * 8, 0.5, P.fy0 + 1 + j * 6, P.fx0 + 8 + i * 8, 0.9, P.fy0 + 6 + j * 6, on ? neon[(i + j + beat) % neon.length] : C.floorDarkHi, on ? 0.85 : 0)
    }
  if (P.ball) {
    const bx = P.ball.x
    m.box(bx - 0.3, 25, P.fy0 - 6.3, bx + 0.3, WALL_H, P.fy0 - 5.7, C.ballDark)
    m.box(bx - 3, 19, P.fy0 - 9, bx + 3, 25, P.fy0 - 3, Math.floor(now / 300) % 2 ? C.ballA : C.ballB, scene.hot ? 0.5 : 0.2)
  }
  if (P.dj) {
    const { x: dx, y: dz } = P.dj
    m.box(dx, 0, dz + 6, dx + 36, 11, dz + 16, C.machine)
    const pump = scene.hot && beat % 2 === 0 ? 1 : 0
    for (const sx of [dx + 1, dx + 28]) m.box(sx, 11, dz + 7, sx + 7, 21 + pump, dz + 14, C.dark)
    for (const [k, tx] of [[0, dx + 11], [1, dx + 20]]) m.box(tx, 11, dz + 8, tx + 5, 11.6, dz + 13, k ? C.red : C.blue, 0.5)
  }
  // server LEDs (they blink faster while anyone works)
  const busy = scene.isBossBusy || scene.desks.some((d) => d.busy)
  for (let i = 0; i < Math.floor((scene.LW - L.B - L.serverX0 - 24) / 20); i++) {
    const rx = L.serverX0 + 10 + i * 20
    const t = Math.floor(now / (busy ? 180 : 900))
    for (let r = 0; r < 7; r++)
      for (let l = 0; l < 3; l++) {
        const h = (i * 97 + r * 7 + l + t) * 2654435761 >>> 0
        if (h % 3 === 0) continue
        m.box(rx + 9 + l * 2, 4 + r * 4.4, L.B + 14.4, rx + 10 + l * 2, 5 + r * 4.4, L.B + 14.8, [C.green, C.blue, C.green, C.yellow][h % 4], 1)
      }
  }
  // the boss's monitor and paper stack
  const { cx: bx, by: bz } = L.boss
  m.box(bx + 5, 11.5, bz - 8, bx + 19, 21, bz - 7.6, scene.isBossBusy ? 0x1b2a38 : C.lidDark, scene.isBossBusy ? 0.9 : 0)
  const n = Math.min(scene.stack, 10)
  for (let i = 0; i < n; i++) m.box(bx - 24, 10.5 + i * 0.8, bz - 8, bx - 14, 11.3 + i * 0.8, bz - 1, i === n - 1 && !scene.lastOk ? C.bad : C.paper)
  // desks: plates and laptops (the lid faces the camera, its logo lights while someone works there)
  for (const d of scene.desks) {
    m.box(d.cx - 5, 2, d.by + 2, d.cx + 5, 6, d.by + 2.6, d.proj ? d.proj.color : C.plate)
    m.box(d.cx - 1, 8.4, d.by - 8, d.cx + 10, 9, d.by - 2, C.lidDark)
    m.box(d.cx - 1, 9, d.by - 2, d.cx + 10, 17, d.by - 1.2, C.lid)
    m.box(d.cx + 3.5, 12, d.by - 1.2, d.cx + 5.5, 14, d.by - 0.8, d.busy ? C.logoOn : C.lidDark, d.busy ? 1 : 0)
  }
  for (const b of scene.bots) anchors.set(b.id, bot(m, b, C))
  return { mesh: m, anchors }
}

/** The size-and-theme key of the static part. */
export const staticKey = (scene) => `${scene.LW}x${scene.LH}:${JSON.stringify([scene.C.brick, scene.C.cream, scene.C.panel, scene.C.sage, scene.C.carpetA, scene.C.woodA, scene.C.deskTop, scene.C.chair, scene.C.wallTop])}`

// ---------- camera ----------
const mul = (a, b) => {
  const o = new Float32Array(16)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      o[c * 4 + r] = s
    }
  return o
}
const norm = (v) => {
  const l = Math.hypot(...v) || 1
  return v.map((x) => x / l)
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export function lookAt(eye, at, up = [0, 1, 0]) {
  const z = norm(eye.map((e, i) => e - at[i]))
  const x = norm(cross(up, z))
  const y = cross(z, x)
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1])
}
export function perspective(fov, asp, n, f) {
  const t = 1 / Math.tan(fov / 2)
  return new Float32Array([t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0])
}
export function ortho(l, r, b, t, n, f) {
  return new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1])
}
export { mul, norm }

/** World point → canvas pixel, or null behind the camera. */
export function project(mvp, [x, y, z], w, h) {
  const v = [0, 1, 2, 3].map((r) => mvp[r] * x + mvp[4 + r] * y + mvp[8 + r] * z + mvp[12 + r])
  if (v[3] <= 0) return null
  return [((v[0] / v[3]) * 0.5 + 0.5) * w, (1 - ((v[1] / v[3]) * 0.5 + 0.5)) * h]
}

const FOV = (32 * Math.PI) / 180
/** The camera's pitch for a canvas shape: a wide, short office view looks down more steeply to fill its height. */
// 32°–36° above the floor by the canvas's shape (50°–66° at first, then 40°–48°: both too steep for the user)
export const pitchFor = (w, h) => ((Math.min(36, Math.max(32, 32 + (w / h - 1.4) * 4))) * Math.PI) / 180
/**
 * The camera for a canvas of w × h pixels: above the front of the office looking down at PITCH, as far away as needed
 * for the whole office (walls included) to fit with a small margin. → { eye, target, fov, mvp }
 */
export function cameraFor(LW, LH, w, h) {
  const target = [LW / 2, 0, LH * 0.5]
  const pitch = pitchFor(w, h)
  const dir = [0, Math.sin(pitch), Math.cos(pitch)]
  /** @type {[number, number, number][]} */
  const corners = []
  for (const x of [-2, LW + 2]) for (const z of [-2, LH + 2]) for (const y of [0, WALL_H + 2]) corners.push([x, y, z])
  const at = (d) => {
    const eye = target.map((t, i) => t + dir[i] * d)
    const mvp = mul(perspective(FOV, w / h, 10, 4000), lookAt(eye, target))
    return { eye, mvp }
  }
  const fits = (d) => {
    const { mvp } = at(d)
    return corners.every((c) => {
      const p = project(mvp, c, w, h)
      return p && p[0] >= w * 0.01 && p[0] <= w * 0.99 && p[1] >= h * 0.02 && p[1] <= h * 0.98
    })
  }
  let lo = 50
  let hi = 6000
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) hi = mid
    else lo = mid
  }
  // the frame is centred: shift the target so the office's projected box sits in the middle
  const { mvp } = at(hi)
  const ps = corners.map((c) => project(mvp, c, w, h))
  const cy = (Math.min(...ps.map((p) => p[1])) + Math.max(...ps.map((p) => p[1]))) / 2
  const shift = ((cy - h / 2) / h) * LH * 0.9
  const t2 = [target[0], 0, target[2] + shift * 0.5]
  const eye = t2.map((t, i) => t + dir[i] * hi)
  return { eye, target: t2, fov: FOV, mvp: mul(perspective(FOV, w / h, 10, 4000), lookAt(eye, t2)) }
}

/** The bot under a canvas pixel (its projected body, a little slack), nearest to the camera first; or null. */
export function pickBot(anchors, mvp, w, h, px, py) {
  let best = null
  for (const [id, a] of anchors) {
    const foot = project(mvp, [a.x, 0, a.z], w, h)
    const head = project(mvp, [a.x, a.top, a.z], w, h)
    if (!foot || !head) continue
    const r = Math.max(8, Math.abs(foot[1] - head[1]) * 0.55)
    const inside = px >= foot[0] - r && px <= foot[0] + r && py >= head[1] - r * 0.3 && py <= foot[1] + r * 0.3
    if (inside && (!best || a.z > best.z)) best = { id, z: a.z }
  }
  return best ? best.id : null
}
