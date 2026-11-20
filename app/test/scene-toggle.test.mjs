// Scene toggle: the office view stops its frame timer while hidden; the strings and the menu wiring exist.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('office-view exposes pause/resume that stop and restart the frame timer', () => {
  const src = fs.readFileSync(new URL('../renderer/office-view.js', import.meta.url), 'utf8')
  assert.match(src, /pause\(\) \{[\s\S]*clearInterval\(timer\)/)
  assert.match(src, /resume\(\) \{[\s\S]*setInterval\(draw, FRAME_MS\)/)
  assert.match(src, /dead \|\| paused/)
})

test('the strings and the View menu wiring exist', () => {
  for (const f of ['en', 'tr']) {
    const j = JSON.parse(fs.readFileSync(new URL(`../locales/${f}.json`, import.meta.url), 'utf8'))
    assert.ok(j.app.hideOffice && j.app.showOffice && j.main.hideOffice && j.main.showOffice, f)
  }
  const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8')
  assert.match(main, /scene:toggle/)
  assert.match(main, /scene:hidden/)
})

test('the splitter drag always ends and does not select text', () => {
  const src = fs.readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf("div.addEventListener('pointerdown'"), src.indexOf('// hide / show the pixel office'))
  assert.match(block, /e\.button !== 0/)
  assert.match(block, /e\.preventDefault\(\)/)
  assert.match(block, /setPointerCapture\(pointerId\)/)
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) assert.match(block, new RegExp(`addEventListener\\('${ev}'`), ev)
  assert.match(block, /window\.addEventListener\('blur', end\)/)
  assert.match(block, /addEventListener\('visibilitychange'/)
  assert.match(block, /\(ev\.buttons & 1\) === 0/)
  assert.match(block, /classList\.remove\('dragging'\)/)
  assert.match(block, /removeAllRanges\(\)/)
  assert.match(block, /clearSelection/)
  const css = fs.readFileSync(new URL('../renderer/style.css', import.meta.url), 'utf8')
  assert.match(css, /body\.dragging, body\.dragging \* \{[^}]*user-select: none/)
  assert.match(css, /body\.dragging #terminal[^{]*body\.dragging #office[^{]*\{ pointer-events: none/)
  const term = fs.readFileSync(new URL('../renderer/terminal.js', import.meta.url), 'utf8')
  assert.match(term, /clearSelection\(\) \{ term\.clearSelection\(\); \}/)
})
