// Every Office panel has a way in from Studio (contract v3.122): node --test app/test/studio-panels.test.mjs
// body.studio hides the Office's sidebar and its floating panels; each one must be reachable from the ⌘K palette
// (studioCommands in renderer/app.js) or from Studio Settings (renderer/studio-settings.js), through studio.showPanel.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SETTINGS } from '../src/settings-model.mjs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const appSrc = read('../renderer/app.js')
const settingsSrc = read('../renderer/studio-settings.js')
const studioSrc = read('../renderer/studio.js')
const sidebarSrc = read('../renderer/sidebar.js')
const devicesSrc = read('../renderer/devices.js')
const html = read('../renderer/index.html')
const en = JSON.parse(read('../locales/en.json'))
const tr = JSON.parse(read('../locales/tr.json'))

/** The Office's panels: the sidebar's sections and the floating panels next to the office canvas. */
const OFFICE_PANELS = [
  '#sb-panel-team', '#sb-panel-projects', '#sb-panel-accounts', '#sb-panel-mcp', '#sb-panel-mail',   // sidebar.js panel(id, …)
  '#sb-devices',                                                                                        // devices.js
  '#usage-panel', '#machines-panel',                                                                    // index.html <aside>, studio.js FLOATS
]
/** Selectors Studio uses for a panel other than its id. */
const ALIASES = { '#sb-panel-accounts': ['.sb-accounts'] }
/** Office asides that are not panels of their own: the sidebar itself, and one agent's details (opened from the scene). */
const NOT_PANELS = ['sidebar', 'agent-panel']

const cmdStart = appSrc.indexOf('function studioCommands(')
const studioCommandsSrc = appSrc.slice(cmdStart, appSrc.indexOf('studio?.setOn(studioOn);', cmdStart))

test('the list of Office panels is complete', () => {
  const sidebarIds = [...sidebarSrc.matchAll(/panel\('([a-z]+)', \[/g)].map((m) => `#sb-panel-${m[1]}`)
  assert.ok(sidebarIds.length >= 5)
  for (const id of sidebarIds) assert.ok(OFFICE_PANELS.includes(id), `${id} is missing from OFFICE_PANELS`)
  assert.match(devicesSrc, /id: 'sb-devices'/)
  const asides = [...html.matchAll(/<aside id="([a-z-]+)"/g)].map((m) => m[1]).filter((id) => !NOT_PANELS.includes(id))
  for (const id of asides) assert.ok(OFFICE_PANELS.includes(`#${id}`), `#${id} is missing from OFFICE_PANELS`)
  assert.match(studioSrc, /export const FLOATS = Object\.freeze\(\['#usage-panel', '#machines-panel'\]\)/)
})

test('every Office panel has a way in from Studio: a ⌘K command or a Studio Settings row', () => {
  for (const id of OFFICE_PANELS) {
    const sels = [id, ...(ALIASES[id] || [])]
    const way = sels.some((sel) => studioCommandsSrc.includes(`panel('${sel}')`) || settingsSrc.includes(`panel('${sel}')`)
      || settingsSrc.includes(`showPanel('${sel}')`))
    assert.ok(way, `${id} has no way in from Studio`)
  }
})

test('⌘K: Usage and Machines show the Office panels; Mail too', () => {
  assert.match(studioCommandsSrc, /cmd\('usage', panel\('#usage-panel'\), Boolean\(p\)\)/)   // a project's usage: needs one
  assert.match(studioCommandsSrc, /cmd\('machines', panel\('#machines-panel'\)\)/)
  assert.match(studioCommandsSrc, /cmd\('mail', panel\('#sb-panel-mail'\)\)/)
  for (const id of ['usage', 'machines', 'mail']) {
    for (const [lang, L] of [['en', en], ['tr', tr]]) {
      assert.ok(L.studio.cmd[id], `${lang} studio.cmd.${id}`)
      assert.ok(L.studio.cmdKeys[id], `${lang} studio.cmdKeys.${id}`)
    }
  }
})

test('Studio Settings: Usage under Accounts, Machines under Devices & phone', () => {
  assert.equal(SETTINGS.find((s) => s.key === 'usage')?.section, 'accounts')
  assert.equal(SETTINGS.find((s) => s.key === 'machines')?.section, 'devices')
  assert.match(settingsSrc, /case 'usage': return head\(button\(t\('studio\.set\.open'\), panel\('#usage-panel'\)\)\)/)
  assert.match(settingsSrc, /case 'machines': return head\(button\(t\('studio\.set\.open'\), panel\('#machines-panel'\)\)\)/)
  for (const key of ['usage', 'machines']) {
    for (const [lang, L] of [['en', en], ['tr', tr]]) {
      assert.ok(L.settings.label[key], `${lang} settings.label.${key}`)
      assert.ok(L.settings.desc[key], `${lang} settings.desc.${key}`)
    }
  }
})

test('the floating panels: the Office opens and closes them, and their own close takes Studio\'s card away', () => {
  assert.match(appSrc, /openFloat: \(sel\) => openFloatPanel\(sel\)/)
  assert.match(appSrc, /closeFloat: \(sel\) => \{ if \(sel === '#usage-panel'\) usagePanel\?\.hide\(\); else if \(sel === '#machines-panel'\) machines\?\.hide\(\); \}/)
  assert.equal((appSrc.match(/onClose: \(\) => \{ studio\?\.hidePanel\(\); focusActive\(\); \}/g) || []).length, 2)
})
