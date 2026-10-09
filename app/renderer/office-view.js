// Office view: draws core.mjs frames to a <canvas> with crisp (nearest-neighbor) scaling.
import { FRAME_MS, hitTest, render, setGeometry, setThemes as coreSetThemes, setTheme as coreSetTheme, themeInfo, setBotColor as coreSetBotColor, setLanguage as coreSetLanguage } from '../src/office/core.mjs'

const EMPTY = { workers: [], delivered: 0, isBossBusy: false, projects: [], project: '', sessionId: '' }

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ onTheme?: (theme: ReturnType<typeof themeInfo>) => void, onSelect?: (id: string | null) => void }} [opts]
 */
export function mountOffice(canvas, { onTheme, onSelect } = {}) {
  const ctx = canvas.getContext('2d', { alpha: false })
  const off = document.createElement('canvas')
  const offCtx = off.getContext('2d', { alpha: false })
  let image = null
  let pixels = null
  let data = EMPTY
  let focus = null
  let lastTheme = null
  let lastThemeKey = ''
  let geo = null
  let timer = 0
  let dead = false
  let selected = null

  // the canvas back buffer is the CSS box × devicePixelRatio
  function resize() {
    const r = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(0, Math.round(r.width * dpr))
    const h = Math.max(0, Math.round(r.height * dpr))
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    geo = w > 0 && h > 0 ? setGeometry(w, h) : null
    draw()
  }

  function draw() {
    if (dead || !geo) return
    // the core module's state is shared: pass the geometry again every frame
    setGeometry(canvas.width, canvas.height)
    // if a focus is given, the theme comes from it and its desks are highlighted; otherwise the newest session's project
    const { fb, LW, LH, S } = render(Date.now(), data, { focus: focus ?? '', selected })
    if (!image || image.width !== LW || image.height !== LH) {
      off.width = LW
      off.height = LH
      image = offCtx.createImageData(LW, LH)
      pixels = new Uint32Array(image.data.buffer)
    }
    // 0xRRGGBB → little-endian RGBA (0xAABBGGRR)
    for (let i = 0; i < fb.length; i++) {
      const c = fb[i]
      pixels[i] = 0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff)
    }
    offCtx.putImageData(image, 0, 0)

    const t = themeInfo()
    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = t.frame
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const dw = LW * S
    const dh = LH * S
    ctx.drawImage(off, Math.floor((canvas.width - dw) / 2), Math.floor((canvas.height - dh) / 2), dw, dh)

    const key = `${t.name}|${t.title}|${t.frame}|${t.accent}|${t.statusBg}|${t.statusText}`
    if (key !== lastThemeKey) {
      lastThemeKey = key
      lastTheme = t
      try {
        onTheme?.(t)
      } catch (err) {
        console.error(err)
      }
    }
  }

  // ---- selection: click → hitTest → onSelect; hand cursor over a bot ----
  // CSS pixel → canvas back-buffer pixel (drawImage space; includes devicePixelRatio and CSS size)
  function pick(e) {
    const r = canvas.getBoundingClientRect()
    if (!r.width || !r.height || !geo) return null
    setGeometry(canvas.width, canvas.height)
    return hitTest(((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height)
  }
  function onClick(e) {
    if (e.button !== 0) return
    const id = pick(e)
    try {
      onSelect?.(id)
    } catch (err) {
      console.error(err)
    }
  }
  let hoverEvent = null
  let hoverRaf = 0
  function onMove(e) {
    hoverEvent = e
    if (hoverRaf) return
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0
      if (dead || !hoverEvent) return
      canvas.style.cursor = pick(hoverEvent) ? 'pointer' : ''
    })
  }
  function onLeave() {
    hoverEvent = null
    canvas.style.cursor = ''
  }
  canvas.addEventListener('click', onClick)
  canvas.addEventListener('mousemove', onMove)
  canvas.addEventListener('mouseleave', onLeave)

  const ro = new ResizeObserver(resize)
  ro.observe(canvas)
  resize()
  timer = setInterval(draw, FRAME_MS)

  return {
    setData(d) {
      data = d && typeof d === 'object' ? { ...EMPTY, ...d } : EMPTY
    },
    // the theme comes from this project and its desks are highlighted; null = the newest session's project
    setFocus(projectName) {
      focus = projectName ? String(projectName) : null
      draw()
    },
    setThemes(t) {
      coreSetThemes(t ?? {})
      draw()
    },
    // one theme for the whole office, whatever the project (theme picker, v3.1); '' or null = pick by project
    setTheme(name) {
      coreSetTheme(name || '')
      draw()
    },
    // marker above the selected bot (at a desk, walking, at the boss, on the floor); null = none
    setSelected(id) {
      const next = id == null || id === '' ? null : String(id)
      if (next === selected) return
      selected = next
      draw()
    },
    theme() {
      return lastTheme
    },
    // bot color '#rrggbb' (null = the theme's color)
    setBotColor(hex) {
      coreSetBotColor(hex)
      draw()
    },
    // language of the office's text ('en' | 'tr'); the title depends on it too (themeInfo().title)
    setLanguage(lang) {
      coreSetLanguage(lang)
      draw()
    },
    destroy() {
      dead = true
      clearInterval(timer)
      if (hoverRaf) cancelAnimationFrame(hoverRaf)
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseleave', onLeave)
      ro.disconnect()
    },
  }
}
