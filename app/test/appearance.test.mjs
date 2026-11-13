// Appearance (contract v3.74): normalisation, the 8-bit look's light derivation, contrast over the theme gallery,
// the terminal palettes and the stored setting.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  LOOKS, MODES, normalizeLook, normalizeMode, effectiveMode, parseHex, mix, contrast, luminance,
  PIXEL_DEFAULT, pixelLightChrome, CLAUDE, chromeFor, windowBackground, LIGHT_ANSI, LIGHT_STATUS, terminalTheme,
} from '../src/appearance.mjs'

const require = createRequire(import.meta.url)
const P = require('../src/projects.js')
const dir = new URL('../../themes/', import.meta.url)
/** Every gallery theme's four frame colours (missing ones fall back to the classic theme, as in the office). */
const gallery = readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) =>
  Object.entries(JSON.parse(readFileSync(new URL(f, dir), 'utf8'))).map(([name, t]) => {
    const c = (t && t.colors) || {}
    const pick = (k) => (parseHex(c[k]) ? { [k]: c[k] } : {})
    return { name, theme: { ...pick('frame'), ...pick('accent'), ...pick('statusBg'), ...pick('statusText') } }
  }))
const themes = [{ name: 'classic', theme: PIXEL_DEFAULT }, { name: 'empty', theme: {} }, ...gallery]

test('look and mode: known values pass, anything else is the default', () => {
  assert.deepEqual(LOOKS, ['pixel', 'claude'])
  assert.deepEqual(MODES, ['system', 'light', 'dark'])
  for (const v of LOOKS) assert.equal(normalizeLook(v), v)
  for (const v of MODES) assert.equal(normalizeMode(v), v)
  for (const v of [undefined, null, 3, '', 'Claude', ' pixel', 'retro', {}, ['claude']]) {
    assert.equal(normalizeLook(v), 'pixel')
    assert.equal(normalizeMode(v), 'system')
  }
})

test('system mode follows the OS; light and dark do not', () => {
  assert.equal(effectiveMode('system', true), 'dark')
  assert.equal(effectiveMode('system', false), 'light')
  assert.equal(effectiveMode('light', true), 'light')
  assert.equal(effectiveMode('dark', false), 'dark')
  assert.equal(effectiveMode('nope', false), 'light') // unknown = system
})

test('colour maths: hex parsing, mixing and WCAG contrast', () => {
  assert.deepEqual(parseHex('#fff'), [255, 255, 255])
  assert.deepEqual(parseHex(' #2B1d1a '), [43, 29, 26])
  for (const v of ['2b1d1a', '#12', 'rgb(0,0,0)', 0x2b1d1a, null]) assert.equal(parseHex(v), null)
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080')
  assert.equal(mix('#102030', '#ffffff', 0), '#102030')
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21)
  assert.equal(contrast('#777777', '#777777'), 1)
})

test('8-bit dark is the office theme untouched', () => {
  const t = { frame: '#172211', accent: '#7ad147', statusBg: '#133024', statusText: '#e3f7ea' }
  assert.deepEqual(chromeFor('pixel', 'dark', t), t)
  assert.deepEqual(chromeFor('pixel', 'dark'), PIXEL_DEFAULT)
  assert.deepEqual(chromeFor('unknown', 'dark', t), t)
  assert.equal(windowBackground('pixel', 'dark', false), '#2b1d1a') // the window colour before v3.74
  assert.equal(windowBackground('pixel', 'system', true), '#2b1d1a')
})

test('8-bit light: a light page, ink and accent readable on it, for every gallery theme', () => {
  assert.ok(gallery.length >= 9, 'the gallery was read')
  for (const { name, theme } of themes) {
    const c = pixelLightChrome(theme)
    for (const k of ['frame', 'statusBg', 'statusText', 'accent']) assert.ok(parseHex(c[k]), `${name} ${k}`)
    assert.ok(luminance(c.frame) > 0.7 && luminance(c.statusBg) > 0.8, `${name}: light backgrounds`)
    for (const bg of [c.frame, c.statusBg]) {
      assert.ok(contrast(c.statusText, bg) >= 7, `${name}: text ${c.statusText} on ${bg}`)
      assert.ok(contrast(c.accent, bg) >= 4.5, `${name}: accent ${c.accent} on ${bg}`)
    }
    assert.deepEqual(chromeFor('pixel', 'light', theme), c)
  }
  // a broken colour falls back instead of breaking the chrome
  assert.deepEqual(pixelLightChrome({ frame: 'red', accent: 7 }), pixelLightChrome({}))
})

test('Claude look: fixed palette, the office theme does not reach it', () => {
  const t = { frame: '#172211', accent: '#7ad147', statusBg: '#133024', statusText: '#e3f7ea' }
  assert.deepEqual(chromeFor('claude', 'light', t), { frame: '#FAF9F5', accent: '#D97757', statusBg: '#F0EEE6', statusText: '#141413' })
  assert.deepEqual(chromeFor('claude', 'dark', t), { frame: '#262624', accent: '#D97757', statusBg: '#1F1E1D', statusText: '#FAF9F5' })
  assert.equal(windowBackground('claude', 'light', true), '#FAF9F5')
  assert.equal(windowBackground('claude', 'system', true), '#262624')
  assert.equal(windowBackground('claude', 'system', false), '#FAF9F5')
  for (const m of ['light', 'dark']) {
    const c = CLAUDE[m]
    for (const bg of [c.frame, c.statusBg, c.raised]) {
      assert.ok(contrast(c.statusText, bg) >= 7, `${m}: text on ${bg}`)
      assert.ok(contrast(c.muted, bg) >= 4.5, `${m}: muted on ${bg}`)
    }
    assert.ok(contrast(c.onAccent, c.accent) >= 4.5, `${m}: text on the accent fill`)
    // the accent as text (small labels too) on the page and on the sidebar surface
    for (const bg of [c.frame, c.statusBg]) assert.ok(contrast(c.accentText, bg) >= 4.5, `${m}: accent text on ${bg}`)
  }
  assert.ok(contrast('#ffffff', LIGHT_STATUS['--err']) >= 4.5) // .sb-warn:hover in Claude light
  // style.css carries the same values
  const css = readFileSync(new URL('../renderer/style.css', import.meta.url), 'utf8')
  const block = (sel) => css.slice(css.indexOf(sel + ' {'), css.indexOf('}', css.indexOf(sel + ' {')))
  const lightCss = block(':root[data-look="claude"][data-mode="light"]')
  const darkCss = block(':root[data-look="claude"][data-mode="dark"]')
  for (const [m, b] of [['light', lightCss], ['dark', darkCss]]) {
    const c = CLAUDE[m]
    for (const [name, v] of [['--frame', c.frame], ['--status-bg', c.statusBg], ['--status-text', c.statusText], ['--raised', c.raised], ['--muted', c.muted], ['--accent-text', c.accentText]]) {
      assert.ok(b.includes(`${name}: ${v};`), `style.css ${m} ${name} ${v}`)
    }
  }
})

test('light mode status colours read as text on every light surface', () => {
  const css = readFileSync(new URL('../renderer/style.css', import.meta.url), 'utf8')
  const start = css.indexOf(':root[data-mode="light"] {')
  const light = css.slice(start, css.indexOf('}', start))
  const surfaces = [CLAUDE.light.frame, CLAUDE.light.statusBg, ...themes.flatMap(({ theme }) => { const c = pixelLightChrome(theme); return [c.frame, c.statusBg] })]
  for (const [name, v] of Object.entries(LIGHT_STATUS)) {
    assert.ok(light.includes(`${name}: ${v};`), `style.css light ${name} ${v}`)
    for (const bg of surfaces) assert.ok(contrast(v, bg) >= 4.5, `${name} ${v} on ${bg}: ${contrast(v, bg).toFixed(2)}`)
  }
})

test('terminal: follows the chrome; light mode gets an ANSI palette that reads on it', () => {
  assert.deepEqual(terminalTheme('pixel', 'dark'), { background: '#231815', foreground: '#f3ead8', cursor: '#3fb6a8', cursorAccent: '#231815', selectionBackground: '#3fb6a866' })
  assert.equal(terminalTheme('claude', 'dark').black, undefined) // dark keeps xterm's own colours
  assert.equal(Object.keys(LIGHT_ANSI).length, 16)
  const lights = [terminalTheme('claude', 'light'), ...themes.map(({ theme }) => terminalTheme('pixel', 'light', theme))]
  for (const tt of lights) {
    assert.ok(contrast(tt.foreground, tt.background) >= 7)
    assert.ok(contrast(tt.cursor, tt.background) >= 3)
    for (const [k, v] of Object.entries(LIGHT_ANSI)) {
      assert.equal(tt[k], v)
      assert.ok(contrast(v, tt.background) >= 4.5, `${k} ${v} on ${tt.background}`)
    }
  }
})

test('the setting survives state normalisation and reads back through prefs', () => {
  // saving: the file written from the running state keeps both
  const base = P.normalizeState({ projects: [], accounts: [] })
  const file = JSON.parse(JSON.stringify(P.stateFile({}, { ...base, look: 'claude', mode: 'light' })))
  assert.equal(file.look, 'claude')
  assert.equal(file.mode, 'light')
  // a state.json from before v3.74 has neither: the defaults
  const old = JSON.parse(JSON.stringify(P.stateFile({}, base)))
  assert.equal(normalizeLook(old.look), 'pixel')
  assert.equal(normalizeMode(old.mode), 'system')
  // main.js: prefs carry look and mode, and prefs:set stores them normalised
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8')
  assert.match(main, /const prefs = \(\) => \(\{[^\n]*\.\.\.appearance\(\)/)
  assert.match(main, /look: p\.look !== undefined \? AP\.normalizeLook\(p\.look\)/)
  assert.match(main, /look: AP \? AP\.normalizeLook\(raw\.look\) : 'pixel', mode: AP \? AP\.normalizeMode\(raw\.mode\) : 'system'/) // loading
  assert.match(main, /nativeTheme\.themeSource = /)
})

test('locales: the appearance pickers have their strings in every language', () => {
  for (const f of readdirSync(new URL('../locales/', import.meta.url)).filter((n) => n.endsWith('.json'))) {
    const l = JSON.parse(readFileSync(new URL('../locales/' + f, import.meta.url), 'utf8'))
    for (const k of ['look', 'lookPixel', 'lookClaude', 'mode', 'modeSystem', 'modeLight', 'modeDark']) assert.equal(typeof l.sidebar[k], 'string', `${f} sidebar.${k}`)
    assert.equal(l.sidebar.lookClaude, 'Claude')
    assert.equal(typeof l.app.appTitlePlain, 'string')
  }
})
