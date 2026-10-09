// Ofis görünümü: core.mjs karelerini <canvas>'a keskin (en yakın komşu) ölçekle çizer.
import { FRAME_MS, hitTest, render, setGeometry, setThemes as coreSetThemes, themeInfo, setBotColor as coreSetBotColor } from '../src/office/core.mjs'

const EMPTY = { workers: [], delivered: 0, isBossBusy: false, projects: [], project: '', sessionId: '' }

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

  // tuvalin arka tamponu CSS kutusu × devicePixelRatio
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
    // çekirdek modül durumu paylaşımlı: geometriyi her karede yeniden ver
    setGeometry(canvas.width, canvas.height)
    // odak verilmişse tema ondan, masaları vurgulu; yoksa en yeni oturumun projesi
    const { fb, LW, LH, S } = render(Date.now(), data, { focus: focus ?? '', selected })
    if (!image || image.width !== LW || image.height !== LH) {
      off.width = LW
      off.height = LH
      image = offCtx.createImageData(LW, LH)
      pixels = new Uint32Array(image.data.buffer)
    }
    // 0xRRGGBB → küçük endian RGBA (0xAABBGGRR)
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

  // ---- seçim: tıklama → hitTest → onSelect; bot üstünde el imleci ----
  // CSS pikseli → tuval arka tampon pikseli (drawImage uzayı; devicePixelRatio ve CSS boyutu dahil)
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
    // tema bu projeden gelir ve masaları vurgulanır; null = en yeni oturumun projesi
    setFocus(projectName) {
      focus = projectName ? String(projectName) : null
      draw()
    },
    setThemes(t) {
      coreSetThemes(t ?? {})
      draw()
    },
    // seçili botun üstüne işaret (masada, yolda, müdürde, pistte); null = yok
    setSelected(id) {
      const next = id == null || id === '' ? null : String(id)
      if (next === selected) return
      selected = next
      draw()
    },
    theme() {
      return lastTheme
    },
    // bot rengi '#rrggbb' (null = temanın rengi)
    setBotColor(hex) {
      coreSetBotColor(hex)
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
