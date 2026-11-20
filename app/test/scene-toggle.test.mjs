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
