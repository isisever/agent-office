// Studio scene (v3.137): the pure part of the isometric strip drawn by renderer/studio-scene.js.
// Which workers are on the floor, the short labels, the project hue, and where every desk goes in a W×H strip.

/** how long a finished worker stays at its desk with a ✓ / ✗ bubble before leaving (ms) */
export const LINGER_MS = 6000

/**
 * Workers shown in the strip: the active ones plus those finished less than LINGER_MS ago, oldest first.
 * @param {Array<any>} workers
 * @param {number} now
 * @param {number} [linger]
 */
export function visibleWorkers(workers, now, linger = LINGER_MS) {
  if (!Array.isArray(workers)) return []
  return workers
    .filter((w) => w && w.id != null && (w.doneAt == null || now - Number(w.doneAt) < linger))
    .sort((a, b) => (Number(a.spawnAt) || 0) - (Number(b.spawnAt) || 0) || String(a.id).localeCompare(String(b.id)))
}

/**
 * The tool name without the `mcp__server__` prefix; '' when there is none.
 * @param {unknown} tool
 */
export function shortTool(tool) {
  const s = String(tool ?? '').trim()
  return s.startsWith('mcp__') ? s.replace(/^mcp__.*__/, '') : s
}

/**
 * Text cut to max characters with an ellipsis.
 * @param {unknown} s
 * @param {number} max
 */
export function clip(s, max) {
  const str = String(s ?? '')
  return str.length > max ? `${str.slice(0, Math.max(1, max - 1))}…` : str
}

/**
 * A stable hue (0..359) for a project name, so a project keeps its colour across frames and windows.
 * @param {unknown} name
 */
export function projectHue(name) {
  const s = String(name ?? '').toLowerCase()
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) % 360
}

/**
 * Where everything goes in a W×H strip (CSS pixels). The boss desk is fixed on the left and the server rack on the
 * right; the worker row fills the middle. Desks share the row evenly between minPitch and maxPitch; when n desks do
 * not fit at minPitch the row scrolls horizontally (scrollMax > 0) instead of shrinking further.
 * With few workers, empty desks fill the row up to `minDesks`.
 * @param {number} W
 * @param {number} H
 * @param {number} n number of workers
 * @param {{ minPitch?: number, maxPitch?: number, minDesks?: number }} [opts]
 */
export function stripLayout(W, H, n, { minPitch = 100, maxPitch = 150, minDesks = 4 } = {}) {
  const width = Math.max(0, Number(W) || 0)
  const height = Math.max(0, Number(H) || 0)
  const scale = Math.min(1.25, Math.max(0.7, height / 150))
  const pad = Math.round(10 * scale)
  const floorY = Math.round(height * 0.84)           // baseline of desks and characters
  const bossW = Math.round(150 * scale)
  const rackW = Math.round(80 * scale)
  const boss = { x: pad + bossW / 2, y: floorY }
  const rack = { x: width - pad - rackW / 2, y: floorY }
  const x0 = pad + bossW
  const x1 = Math.max(x0, width - pad - rackW)
  const avail = x1 - x0
  const lo = minPitch * scale
  const hi = maxPitch * scale
  const workers = Math.max(0, Math.floor(Number(n) || 0))
  const fitting = Math.max(1, Math.floor(avail / lo))
  const count = Math.max(workers, Math.min(minDesks, fitting))
  const pitch = count > 0 ? Math.min(hi, Math.max(lo, avail / count)) : hi
  const contentW = count * pitch
  const scrollMax = Math.max(0, Math.ceil(contentW - avail))
  const start = scrollMax > 0 ? x0 : x0 + (avail - contentW) / 2
  const desks = Array.from({ length: count }, (_, i) => ({ x: start + pitch * (i + 0.5), y: floorY }))
  return { scale, pad, floorY, boss, rack, row: { x0, x1 }, pitch, desks, contentW, scrollMax }
}

/**
 * The desk index under a point (row coordinates, scroll already applied), or -1.
 * @param {{ desks: Array<{ x: number, y: number }>, pitch: number, floorY: number, scale: number }} layout
 * @param {number} x
 * @param {number} y
 * @param {number} [scroll]
 */
export function deskAt(layout, x, y, scroll = 0) {
  const top = layout.floorY - 100 * layout.scale
  if (y < top || y > layout.floorY + 14 * layout.scale) return -1
  const half = layout.pitch / 2
  return layout.desks.findIndex((d) => Math.abs(d.x - scroll - x) <= half)
}
