// Studio scene (v3.137): an isometric office drawn for Studio's wide, short strip above the chat.
// Canvas 2D paths only (no images, no WebGL). Boss desk on the left, one desk per worker in the middle, a server rack on
// the right. Colours come from Studio's tokens (--st-*) so it follows Studio light/dark. The Office keeps its own
// pixel scene (office-view.js); this renderer is used only in Studio. Layout maths: ../src/studio-scene-layout.mjs.
import { visibleWorkers, shortTool, projectHue, stripLayout, deskAt, LINGER_MS } from '../src/studio-scene-layout.mjs'
import { t } from './i18n.js'

const FRAME_MS = 80          // ~12 fps
const K = 1.75               // iso unit in CSS px at scale 1
const EMPTY = { workers: [], isBossBusy: false, projects: [] }

/** @param {string} s */
function parseColor(s) {
  const v = String(s || '').trim()
  let m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (m) {
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]
  }
  m = v.match(/^rgba?\(([^)]+)\)$/i)
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return [p[0] || 0, p[1] || 0, p[2] || 0, p.length > 3 ? p[3] : 1]
  }
  return null
}
/** @param {number[]} a @param {number[]} b @param {number} k */
const mix = (a, b, k) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k))
/** @param {number[]} c @param {number} [alpha] */
const css = (c, alpha = 1) => `rgba(${c[0]},${c[1]},${c[2]},${alpha})`
/** @param {number} h @param {number} s @param {number} l */
function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))
  return [f(0), f(8), f(4)]
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ onSelect?: (id: string) => void }} [opts]
 */
export function mountStudioScene(canvas, { onSelect } = {}) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'))
  /** @type {any} */
  let data = EMPTY
  let W = 0
  let H = 0
  let timer = 0
  let dead = false
  let paused = true
  let scroll = 0
  let frame = 0
  /** @type {any} */
  let pal = null
  let font = 'system-ui, sans-serif'
  /** @type {ReturnType<typeof stripLayout> | null} */
  let layout = null
  /** @type {any[]} */
  let shown = []

  function readPalette() {
    const cs = getComputedStyle(document.body)
    const get = (/** @type {string} */ k, /** @type {number[]} */ dflt) => parseColor(cs.getPropertyValue(k)) || dflt
    const bg = get('--st-bg', [248, 246, 241])
    const text = get('--st-text', [41, 38, 31])
    const accent = get('--st-accent', [196, 103, 63])
    const side = get('--st-side', mix(bg, text, 0.04))
    const dark = (bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114) < 128
    const wood = dark ? [92, 76, 62] : [226, 206, 180]
    font = cs.fontFamily || font
    pal = {
      dark, bg, text, accent, side,
      muted: get('--st-muted', mix(bg, text, 0.55)),
      wall: mix(bg, text, dark ? 0.03 : 0.025),
      floor: mix(side, text, dark ? 0.05 : 0.035),
      line: mix(side, text, dark ? 0.1 : 0.08),
      woodTop: wood, woodL: mix(wood, [0, 0, 0], 0.16), woodR: mix(wood, [0, 0, 0], 0.28),
      metal: dark ? [58, 56, 52] : [74, 70, 64],
      screenOff: dark ? [34, 33, 30] : [60, 57, 52],
      skin: [232, 190, 160], hair: dark ? [40, 34, 30] : [70, 52, 40],
      ok: [76, 150, 92], fail: [196, 72, 60],
    }
  }

  function resize() {
    const r = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    W = r.width
    H = r.height
    const bw = Math.max(0, Math.round(W * dpr))
    const bh = Math.max(0, Math.round(H * dpr))
    if (canvas.width !== bw) canvas.width = bw
    if (canvas.height !== bh) canvas.height = bh
    draw()
  }

  // ---- iso primitives: P(x, y, z) → screen, with x going right-down, y left-down, z up ----
  /** @param {number} ox @param {number} oy @param {number} k */
  const isoAt = (ox, oy, k) => (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) =>
    /** @type {[number, number]} */ ([ox + (x - y) * k, oy + ((x + y) * k) / 2 - z * k])
  /** @param {Array<[number, number]>} pts @param {string} fill */
  function poly(pts, fill) {
    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
  }
  /** an iso box from (x,y,z) with size a×b×h; colours for the top, left (y+b) and right (x+a) faces */
  function box(/** @type {ReturnType<typeof isoAt>} */ P, x, y, z, a, b, h, /** @type {number[]} */ top, /** @type {number[]} */ left, /** @type {number[]} */ right, alpha = 1) {
    poly([P(x, y + b, z), P(x + a, y + b, z), P(x + a, y + b, z + h), P(x, y + b, z + h)], css(left, alpha))
    poly([P(x + a, y, z), P(x + a, y + b, z), P(x + a, y + b, z + h), P(x + a, y, z + h)], css(right, alpha))
    poly([P(x, y, z + h), P(x + a, y, z + h), P(x + a, y + b, z + h), P(x, y + b, z + h)], css(top, alpha))
  }
  /** @param {number[]} c @param {number} [k] */
  const shade = (c, k = 0.2) => mix(c, [0, 0, 0], k)

  /** a seated character at (x, y) facing -x towards a desk; typing moves the arm */
  function person(/** @type {ReturnType<typeof isoAt>} */ P, k, x, y, /** @type {number[]} */ shirt, typing, now, seed, alpha = 1) {
    // chair seat and stem
    box(P, x - 3, y - 4, 0, 1.5, 8, 6, pal.metal, shade(pal.metal, 0.2), shade(pal.metal, 0.3), alpha)
    box(P, x - 4, y - 4, 6, 9, 8, 2, mix(pal.metal, [255, 255, 255], 0.15), pal.metal, shade(pal.metal, 0.25), alpha)
    const bob = typing ? Math.sin(now / 110 + seed) * 0.5 : Math.sin(now / 900 + seed) * 0.4
    // torso
    const [tx, ty] = P(x, y, 15 + bob)
    ctx.fillStyle = css(shirt, alpha)
    ctx.beginPath()
    ctx.roundRect(tx - 5 * k, ty - 7 * k, 10 * k, 13 * k, 3.5 * k)
    ctx.fill()
    // head and hair
    const [hx, hy] = P(x - 0.5, y, 26 + bob)
    ctx.fillStyle = css(pal.skin, alpha)
    ctx.beginPath()
    ctx.arc(hx, hy, 4.4 * k, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = css(pal.hair, alpha)
    ctx.beginPath()
    ctx.arc(hx, hy - 0.6 * k, 4.6 * k, Math.PI * 0.95, Math.PI * 2.05)
    ctx.fill()
    // arm to the keyboard
    const reach = typing ? Math.sin(now / 70 + seed * 2) * 1.4 : 0
    const [sx, sy] = P(x - 1, y + 2, 18 + bob)
    const [ex, ey] = P(x - 9 + reach, y + 2, 14 + Math.abs(reach) * 0.3)
    ctx.strokeStyle = css(shade(shirt, 0.15), alpha)
    ctx.lineWidth = 2.6 * k
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.lineTo(ex, ey)
    ctx.stroke()
    // backrest (in front of the back)
    box(P, x + 4, y - 4, 8, 1.5, 8, 9, pal.metal, shade(pal.metal, 0.2), shade(pal.metal, 0.35), alpha)
  }

  /** a monitor whose screen is its +x face; lit shows code lines */
  function monitor(/** @type {ReturnType<typeof isoAt>} */ P, k, x, y, b, h, lit, now, seed, alpha = 1) {
    box(P, x + 0.5, y + b / 2 - 1, 0, 1.5, 2, 3, pal.metal, pal.metal, shade(pal.metal, 0.2), alpha)   // stand
    box(P, x, y, 3, 2, b, h, pal.metal, shade(pal.metal, 0.2), pal.metal, alpha)
    const sx = x + 2.05
    const screen = lit ? mix(pal.accent, [255, 255, 255], pal.dark ? 0.55 : 0.7) : pal.screenOff
    poly([P(sx, y + 0.8, 3.8), P(sx, y + b - 0.8, 3.8), P(sx, y + b - 0.8, 3 + h - 0.8), P(sx, y + 0.8, 3 + h - 0.8)], css(screen, alpha))
    if (!lit) return
    ctx.strokeStyle = css(shade(pal.accent, 0.1), 0.75 * alpha)
    ctx.lineWidth = Math.max(1, 0.9 * k)
    const rows = Math.max(2, Math.floor((h - 2) / 2.6))
    const tick = Math.floor(now / 240)
    for (let r = 0; r < rows; r++) {
      const z = 3 + h - 2.2 - r * 2.6
      const len = (((r * 7 + seed * 13 + tick * (r === rows - 1 ? 1 : 0)) % 5) + 3) / 9
      const [ax, ay] = P(sx, y + 1.6, z)
      const [bx, by] = P(sx, y + 1.6 + (b - 3.2) * len, z)
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.stroke()
    }
  }

  /** fit a string into maxW pixels with an ellipsis */
  function fit(/** @type {string} */ s, maxW) {
    if (ctx.measureText(s).width <= maxW) return s
    let lo = 0
    let hi = s.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (ctx.measureText(`${s.slice(0, mid)}…`).width <= maxW) lo = mid
      else hi = mid - 1
    }
    return lo > 0 ? `${s.slice(0, lo)}…` : ''
  }

  function label(cx, bottom, maxW, /** @type {string} */ title, /** @type {string} */ sub, /** @type {number[]} */ dot, alpha = 1) {
    ctx.font = `600 10.5px ${font}`
    const a = fit(title, maxW - 18)
    ctx.font = `400 10px ${font}`
    const b = fit(sub, maxW - 10)
    ctx.font = `600 10.5px ${font}`
    const wa = ctx.measureText(a).width + 12
    ctx.font = `400 10px ${font}`
    const w = Math.min(maxW, Math.max(wa, ctx.measureText(b).width) + 12)
    const h = 27
    const x = Math.round(cx - w / 2) + 0.5
    const y = Math.round(bottom - h) + 0.5
    ctx.globalAlpha = alpha
    ctx.fillStyle = css(pal.bg, 0.92)
    ctx.strokeStyle = css(pal.line)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 6)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = css(dot)
    ctx.beginPath()
    ctx.arc(x + 7, y + 8.5, 2.6, 0, Math.PI * 2)
    ctx.fill()
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.font = `600 10.5px ${font}`
    ctx.fillStyle = css(pal.text)
    ctx.fillText(a, x + 12, y + 9)
    ctx.font = `400 10px ${font}`
    ctx.fillStyle = css(pal.muted)
    ctx.textAlign = 'center'
    ctx.fillText(b, x + w / 2, y + 20)
    ctx.textAlign = 'left'
    ctx.globalAlpha = 1
  }

  function bubble(x, y, ok, alpha) {
    const c = ok ? pal.ok : pal.fail
    ctx.globalAlpha = alpha
    ctx.fillStyle = css(c)
    ctx.beginPath()
    ctx.arc(x, y, 7, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.8
    ctx.lineCap = 'round'
    ctx.beginPath()
    if (ok) { ctx.moveTo(x - 3.2, y + 0.2); ctx.lineTo(x - 0.8, y + 2.6); ctx.lineTo(x + 3.4, y - 2.4) }
    else { ctx.moveTo(x - 2.6, y - 2.6); ctx.lineTo(x + 2.6, y + 2.6); ctx.moveTo(x + 2.6, y - 2.6); ctx.lineTo(x - 2.6, y + 2.6) }
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  function drawRoom(L, k) {
    const floorTop = Math.round(L.floorY - 30 * k)
    ctx.fillStyle = css(pal.wall)
    ctx.fillRect(0, 0, W, floorTop)
    ctx.fillStyle = css(pal.floor)
    ctx.fillRect(0, floorTop, W, H - floorTop)
    // iso floor tiles: two families of diagonals with slope ±1/2
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, floorTop, W, H - floorTop)
    ctx.clip()
    ctx.strokeStyle = css(pal.line, 0.55)
    ctx.lineWidth = 1
    ctx.beginPath()
    const step = 34 * k
    const span = (H - floorTop) * 2
    for (let c = -span; c < W + span; c += step) {
      ctx.moveTo(c, floorTop)
      ctx.lineTo(c + span, floorTop + span / 2)
      ctx.moveTo(c, floorTop)
      ctx.lineTo(c - span, floorTop + span / 2)
    }
    ctx.stroke()
    ctx.restore()
    // baseboard
    ctx.fillStyle = css(pal.line)
    ctx.fillRect(0, floorTop - 2, W, 2)
  }

  function drawBoss(L, now) {
    const k = K * L.scale
    const busy = Boolean(data.isBossBusy)
    const ox = L.boss.x - 14 * k
    const oy = L.floorY - 28 * k
    const P = isoAt(ox, oy, k)
    if (busy) {
      const [gx, gy] = P(20, 12, 14)
      const pulse = 0.5 + 0.5 * Math.sin(now / 420)
      const g = ctx.createRadialGradient(gx, gy, 2, gx, gy, 46 * k)
      g.addColorStop(0, css(pal.accent, 0.18 + 0.12 * pulse))
      g.addColorStop(1, css(pal.accent, 0))
      ctx.fillStyle = g
      ctx.fillRect(gx - 50 * k, gy - 50 * k, 100 * k, 100 * k)
    }
    // rug under the boss desk
    poly([P(-6, -4, 0), P(48, -4, 0), P(48, 26, 0), P(-6, 26, 0)], css(pal.accent, pal.dark ? 0.16 : 0.12))
    box(P, 0, 0, 0, 36, 20, 13, pal.woodTop, pal.woodL, pal.woodR)
    box(P, 14, 6, 13, 9, 8, 0.8, pal.metal, pal.metal, pal.metal)                 // keyboard
    monitor(P, k, 3, 1, 8, 11, busy, now, 1)
    monitor(P, k, 3, 10, 8, 11, busy, now, 2)
    person(P, k, 42, 10, pal.accent, busy, now, 0.7)
  }

  function drawRack(L, now) {
    const k = K * L.scale
    const P = isoAt(L.rack.x, L.floorY - 16 * k, k)
    box(P, 0, 0, 0, 16, 16, 46, mix(pal.metal, [255, 255, 255], 0.12), shade(pal.metal, 0.1), pal.metal)
    const tick = Math.floor(now / 260)
    for (let r = 0; r < 6; r++) {
      const z = 40 - r * 6.4
      // a server slot line, then two LEDs
      const [ax, ay] = P(16, 2, z - 2.5)
      const [bx, by] = P(16, 14, z - 2.5)
      ctx.strokeStyle = css(shade(pal.metal, 0.35))
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.stroke()
      for (let j = 0; j < 2; j++) {
        const on = ((r * 5 + j * 3 + tick * (j + 1) + (data.isBossBusy ? r : 0)) % 4) !== 0
        const c = j === 0 ? [90, 200, 110] : pal.accent
        const [lx, ly] = P(16, 3 + j * 2.6, z)
        ctx.fillStyle = css(c, on ? 1 : 0.25)
        ctx.fillRect(lx - 1.2, ly - 1.2, 2.4, 2.4)
      }
    }
  }

  function draw() {
    if (dead || paused || document.hidden || W <= 0 || H <= 0) return
    if (!pal || frame++ % 12 === 0) readPalette()
    const now = Date.now()
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    shown = visibleWorkers(data.workers, now)
    const L = stripLayout(W, H, shown.length)
    layout = L
    scroll = Math.min(Math.max(0, scroll), L.scrollMax)
    const k = K * L.scale
    ctx.fillStyle = css(pal.bg)
    ctx.fillRect(0, 0, W, H)
    drawRoom(L, k)
    drawBoss(L, now)
    drawRack(L, now)

    // the worker row, clipped between the boss and the rack (it scrolls when it does not fit)
    ctx.save()
    ctx.beginPath()
    ctx.rect(L.row.x0, 0, L.row.x1 - L.row.x0, H)
    ctx.clip()
    const labels = []
    L.desks.forEach((d, i) => {
      const w = shown[i]
      const cx = d.x - scroll
      if (cx < L.row.x0 - L.pitch || cx > L.row.x1 + L.pitch) return
      const ox = cx - 11 * k
      const oy = L.floorY - 22 * k
      const P = isoAt(ox, oy, k)
      const proj = w?.project ? hsl(projectHue(w.project), 0.5, pal.dark ? 0.6 : 0.56) : null
      const done = w && w.doneAt != null
      const left = done ? Math.max(0, LINGER_MS - (now - Number(w.doneAt))) : LINGER_MS
      const alpha = done ? Math.min(1, left / 1200) : 1
      box(P, 0, 0, 0, 28, 16, 13, pal.woodTop, pal.woodL, pal.woodR)
      if (proj) poly([P(0, 16, 10), P(28, 16, 10), P(28, 16, 13), P(0, 16, 13)], css(proj))     // project stripe
      if (!w) {
        monitor(P, k, 3, 3, 10, 9, false, now, i)
        return
      }
      const tool = shortTool(w.tool)
      const typing = !done && Boolean(tool)
      box(P, 13, 4, 13, 8, 7, 0.8, pal.metal, pal.metal, pal.metal, alpha)          // keyboard
      monitor(P, k, 3, 3, 10, 9, !done, now, i, alpha)
      person(P, k, 34, 8, proj || mix(pal.accent, pal.muted, 0.5), typing, now, i * 1.7, alpha)
      const [hx, hy] = P(33.5, 8, 26)
      if (done) bubble(hx + 9 * k, hy - 5 * k, Boolean(w.isOk), alpha)
      labels.push({ cx, bottom: oy - 23 * k, w, tool, proj, done, alpha })
    })
    for (const l of labels) {
      const sub = l.done ? (l.w.isOk ? t('panel.done') : t('panel.failed')) : (l.tool || t('panel.thinking'))
      label(l.cx, l.bottom, L.pitch - 6, String(l.w.type || 'agent'), sub, l.proj || pal.accent, l.alpha)
    }
    // soft edges when the row scrolls
    if (L.scrollMax > 0) {
      for (const [x, dir] of /** @type {Array<[number, number]>} */ ([[L.row.x0, 1], [L.row.x1, -1]])) {
        if ((dir > 0 && scroll <= 0) || (dir < 0 && scroll >= L.scrollMax)) continue
        const g = ctx.createLinearGradient(x, 0, x + dir * 24, 0)
        g.addColorStop(0, css(pal.wall, 0.95))
        g.addColorStop(1, css(pal.wall, 0))
        ctx.fillStyle = g
        ctx.fillRect(Math.min(x, x + dir * 24), 0, 24, H)
      }
    }
    ctx.restore()
    if (!shown.length) {
      ctx.font = `400 11.5px ${font}`
      ctx.fillStyle = css(pal.muted)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(t('studio.scene.noAgents'), (L.row.x0 + L.row.x1) / 2, Math.max(14, L.floorY - 45 * k - 13))
      ctx.textAlign = 'left'
    }
  }

  // ---- input: click selects a worker; wheel and drag scroll the row when it overflows ----
  /** @param {MouseEvent} e */
  const local = (e) => {
    const r = canvas.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const workerAt = (/** @type {MouseEvent} */ e) => {
    if (!layout) return null
    const [x, y] = local(e)
    if (x < layout.row.x0 || x > layout.row.x1) return null
    const i = deskAt(layout, x, y, scroll)
    return i >= 0 ? shown[i] ?? null : null
  }
  /** @type {{ x: number, scroll: number, moved: boolean } | null} */
  let drag = null
  const onWheel = (/** @type {WheelEvent} */ e) => {
    if (!layout || layout.scrollMax <= 0) return
    e.preventDefault()
    scroll = Math.min(layout.scrollMax, Math.max(0, scroll + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY)))
    draw()
  }
  const onDown = (/** @type {PointerEvent} */ e) => {
    if (e.button !== 0) return
    drag = { x: e.clientX, scroll, moved: false }
  }
  const onMove = (/** @type {PointerEvent} */ e) => {
    if (drag && layout && layout.scrollMax > 0) {
      const dx = e.clientX - drag.x
      if (Math.abs(dx) > 4) drag.moved = true
      if (drag.moved) { scroll = Math.min(layout.scrollMax, Math.max(0, drag.scroll - dx)); draw() }
    }
    canvas.style.cursor = drag?.moved ? 'grabbing' : workerAt(e) ? 'pointer' : ''
  }
  const onUp = (/** @type {PointerEvent} */ e) => {
    const wasDrag = drag?.moved
    drag = null
    if (wasDrag) return
    const w = workerAt(e)
    if (w) onSelect?.(String(w.id))
  }
  const onLeave = () => { drag = null; canvas.style.cursor = '' }
  const onVisibility = () => { if (!document.hidden) draw() }
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointerleave', onLeave)
  document.addEventListener('visibilitychange', onVisibility)
  const ro = new ResizeObserver(resize)
  ro.observe(canvas)

  return {
    /** the same data object the Office receives (workers, isBossBusy, projects, …) */
    setData(/** @type {any} */ d) { data = d && typeof d === 'object' ? { ...EMPTY, ...d, workers: Array.isArray(d.workers) ? d.workers : [] } : EMPTY },
    /** stop the frame timer: nothing is drawn until resume() */
    pause() {
      if (paused) return
      paused = true
      clearInterval(timer)
      timer = 0
    },
    resume() {
      if (!paused || dead) return
      paused = false
      pal = null
      resize()
      timer = window.setInterval(draw, FRAME_MS)
    },
    isPaused: () => paused,
    destroy() {
      dead = true
      clearInterval(timer)
      ro.disconnect()
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
      document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
