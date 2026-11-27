// The shared settings model (contract v3.122): node --test app/test/settings-model.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SECTIONS, SETTINGS, OFFICE_ORDER, settingsOf, controlKind, filterSettings, firstMatchSection, keepAwakeView } from '../src/settings-model.mjs'
import { studioKey } from '../src/studio-keys.mjs'

const sidebarSrc = readFileSync(new URL('../renderer/sidebar.js', import.meta.url), 'utf8')

test('sections: the eleven Studio sections, unique, each with an icon and at least one setting', () => {
  assert.deepEqual(SECTIONS.map((s) => s.id), ['general', 'sessions', 'accounts', 'projects', 'team', 'voice', 'mcp', 'devices', 'hq', 'office', 'about'])
  for (const s of SECTIONS) {
    assert.ok(s.icon, s.id)
    assert.ok(settingsOf(s.id).length > 0, `${s.id} has no settings`)
  }
  const ids = new Set(SECTIONS.map((s) => s.id))
  for (const s of SETTINGS) assert.ok(ids.has(s.section), `${s.key}: unknown section ${s.section}`)
})

test('keys are unique; every Office popup row appears exactly once in the model, and only those', () => {
  const keys = SETTINGS.map((s) => s.key)
  assert.equal(new Set(keys).size, keys.length)
  assert.equal(new Set(OFFICE_ORDER).size, OFFICE_ORDER.length)
  for (const row of OFFICE_ORDER) {
    const n = SETTINGS.filter((s) => s.office === row).length
    if (row === 'voice') assert.equal(n, 5, 'the voice block: enabled, language, model, send, key')
    else assert.equal(n, 1, `${row} must appear exactly once`)
  }
  for (const s of SETTINGS) {
    if (s.studioOnly) assert.equal(s.office, undefined, s.key)
    else assert.ok(OFFICE_ORDER.includes(/** @type {string} */ (s.office)), `${s.key} is not in the Office popup`)
  }
})

test('the Office popup lays its rows out by OFFICE_ORDER; every non-group row has a label and control', () => {
  assert.match(sidebarSrc, /OFFICE_ORDER\.flatMap/)
  for (const row of OFFICE_ORDER.filter((r) => r !== 'voice' && r !== 'skills')) {
    assert.match(sidebarSrc, new RegExp(`officeRows = \\{[^}]*\\b${row}: `), `officeRows.${row}`)
    assert.match(sidebarSrc, new RegExp(`officeControls = \\{[^\\n]*\\b${row}: \\[`), `officeControls.${row}`)
  }
})

test('Office-only settings sit in the Office section; keep-awake stays in Sessions', () => {
  for (const s of SETTINGS.filter((x) => x.officeOnly)) assert.equal(s.section, 'office', s.key)
  assert.equal(SETTINGS.find((s) => s.key === 'keepAwake')?.section, 'sessions')
})

test('controlKind: segmented for 2–4 options, a select otherwise', () => {
  assert.equal(controlKind('choice', 2), 'segmented')
  assert.equal(controlKind('choice', 4), 'segmented')
  assert.equal(controlKind('choice', 5), 'select')
  assert.equal(controlKind('choice', 1), 'select')
  assert.equal(controlKind('switch'), 'switch')
})

test('filterSettings: every word in label or description, case-insensitive; empty keeps all', () => {
  const text = (s) => ({ label: `Label ${s.key}`, description: s.key === 'sleep' ? 'Put idle sessions to sleep' : 'other' })
  assert.equal(filterSettings(SETTINGS, '', text).length, SETTINGS.length)
  assert.deepEqual(filterSettings(SETTINGS, 'IDLE sessions', text).map((s) => s.key), ['sleep'])
  assert.deepEqual(filterSettings(SETTINGS, 'label keepawake', text).map((s) => s.key), ['keepAwake'])
  assert.deepEqual(filterSettings(SETTINGS, 'nothing-like-this', text), [])
  assert.equal(firstMatchSection(filterSettings(SETTINGS, 'idle', text)), 'sessions')
  assert.equal(firstMatchSection([]), null)
})

test('keepAwakeView: the checked option and active unless off', () => {
  const opts = [{ value: 'off', text: 'Off' }, { value: 'working', text: 'While agents work' }, { value: 'always', text: 'Always' }]
  assert.deepEqual(keepAwakeView(opts, 'off'), { items: opts.map((o) => ({ ...o, checked: o.value === 'off' })), active: false, currentText: 'Off' })
  const w = keepAwakeView(opts, 'working')
  assert.equal(w.active, true)
  assert.equal(w.currentText, 'While agents work')
  assert.equal(keepAwakeView(opts, 'bogus').active, false)
})

test('⌘, (Ctrl+, elsewhere) opens Settings in Studio only', () => {
  assert.deepEqual(studioKey({ mac: true, meta: true, code: 'Comma' }, 'studio'), { type: 'settings' })
  assert.deepEqual(studioKey({ mac: false, ctrl: true, code: 'Comma' }, 'studio'), { type: 'settings' })
  assert.equal(studioKey({ mac: true, meta: true, code: 'Comma' }, 'office'), null)
  assert.equal(studioKey({ mac: true, meta: true, shift: true, code: 'Comma' }, 'studio'), null)
})
