// Hızlı kontrol: node test/office.test.mjs
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, existsSync, readFileSync, mkdtempSync, utimesSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { BOSS_ID, shellLabel, demoOffice, hitBoxes, hitTest, partyCount, render, resetOffice, setGeometry, setTheme, setThemes, themeInfo } from '../src/office/core.mjs'

const require = createRequire(import.meta.url)

// çizicinin tek kaynağı eklentide; uygulamadaki dosya onun birebir kopyası olmalı
{
  const source = new URL('../../plugin/viewer/core.mjs', import.meta.url)
  const copy = new URL('../src/office/core.mjs', import.meta.url)
  assert.ok(readFileSync(copy).equals(readFileSync(source)), 'app/src/office/core.mjs, plugin/viewer/core.mjs ile aynı değil: node app/scripts/sync-core.mjs çalıştırın')
}
const { readOffice, readThemes } = require('../src/sessions.js')

const OUT = process.env.SNAP_DIR ?? join(tmpdir(), 'agent-office-snapshots')
const NOW = Number(process.env.NOW ?? new Date(2026, 9, 9, 11, 0, 0).getTime())

// office.mjs writePng ile aynı: fb'yi S kat büyütüp RGB PNG yazar
function writePng(path, { fb, LW, LH, S }) {
  const W = LW * S
  const H = LH * S
  const raw = Buffer.alloc((W * 3 + 1) * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = fb[Math.floor(y / S) * LW + Math.floor(x / S)]
      const o = y * (W * 3 + 1) + 1 + x * 3
      raw[o] = (c >> 16) & 255
      raw[o + 1] = (c >> 8) & 255
      raw[o + 2] = c & 255
    }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const tb = Buffer.concat([Buffer.from(type), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(tb))
    return Buffer.concat([len, tb, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

setThemes(readThemes())
const geo = setGeometry(1320, 700)
assert.deepEqual(geo, { LW: 440, LH: 233, S: 3 })
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const infos = {}
const firstPixels = {}
for (const theme of ['classic', 'forest']) {
  resetOffice()
  setTheme(theme)
  const frame = render(NOW, demoOffice(NOW))
  assert.equal(frame.fb.length, frame.LW * frame.LH)
  assert.ok(frame.fb.some(c => c !== 0), 'fb boş')
  assert.ok(new Set(frame.fb).size > 20, 'fb çok tekdüze')
  infos[theme] = themeInfo()
  assert.equal(infos[theme].name, theme)
  for (const k of ['frame', 'accent', 'statusBg', 'statusText']) assert.match(infos[theme][k], /^#[0-9a-f]{6}$/)
  firstPixels[theme] = frame.fb.slice()
  writePng(join(OUT, `app-${theme}.png`), frame)
}
assert.notEqual(infos.classic.frame, infos.forest.frame)
assert.notEqual(infos.classic.accent, infos.forest.accent)
assert.notDeepEqual(firstPixels.classic, firstPixels.forest)
assert.equal(infos.classic.title, 'AGENT OFİS')
assert.equal(infos.forest.title, 'FOREST OFİS')

// dil: başlık, yazılar ve büyük harf kuralı İngilizceye geçer, Türkçeye döner
{
  const { setLanguage } = await import('../src/office/core.mjs')
  setTheme('classic')
  setLanguage('en')
  const en = render(NOW, demoOffice(NOW)).fb.slice()
  assert.equal(themeInfo().title, 'AGENT OFFICE')
  setLanguage('tr')
  assert.notDeepEqual(render(NOW, demoOffice(NOW)).fb, en)
  assert.equal(themeInfo().title, 'AGENT OFİS')
}

// boş veriyle (henüz veri gelmemiş) çizim
setTheme('')
const empty = render(NOW, { workers: [], delivered: 0, isBossBusy: false, project: '', sessionId: '' })
assert.equal(themeInfo().name, 'classic')
assert.ok(empty.fb.some(c => c !== 0))
assert.equal(render(NOW, { project: 'forest-api' }) && themeInfo().name, 'forest')
assert.ok(render(NOW, { project: 'billing' }) && themeInfo().name.startsWith('auto:'))

// gerçek oturum dizini: yalnız şekil
const shape = d => {
  assert.ok(Array.isArray(d.workers))
  assert.equal(typeof d.delivered, 'number')
  assert.equal(typeof d.isBossBusy, 'boolean')
  assert.equal(typeof d.project, 'string')
  assert.equal(typeof d.sessionId, 'string')
  assert.ok(Array.isArray(d.projects))
  for (const w of d.workers) assert.equal(typeof w.project, 'string')
  assert.ok(Array.isArray(d.shells))
  for (const sh of d.shells) assert.equal(typeof sh.project, 'string')
}
const all = readOffice(null)
shape(all)
shape(readOffice('agent-office'))
shape(readOffice('olmayan-proje-xyz'))
assert.equal(readOffice('olmayan-proje-xyz').workers.length, 0)
assert.equal(typeof readThemes(), 'object')

// ---------- readOffice: geçici kök dizinde ----------
{
  const root = mkdtempSync(join(tmpdir(), 'agent-office-test-'))
  const dir = join(root, 'sessions')
  mkdirSync(dir, { recursive: true })
  const today = '2026-10-09'
  const H = 3600 * 1000
  const put = (name, body, mtime = NOW - 1000) => {
    const f = join(dir, `${name}.json`)
    writeFileSync(f, JSON.stringify(body))
    utimesSync(f, mtime / 1000, mtime / 1000)
  }
  // alpha canlı: biri çalışıyor, biri bugün teslim etti (stats.today'de de var: tekilleşmeli),
  // w0 dosyadan silinmiş ama stats.today'de; w9 dün gece teslim etti (sayılmaz)
  put('alpha-live', {
    project: 'alpha', updatedAt: NOW - 1000,
    workers: [
      { id: 'w1', type: 'Explore', spawnAt: NOW - 30000, tool: 'Read' },
      { id: 'w2', type: 'Plan', spawnAt: NOW - 90000, doneAt: NOW - 60000, isOk: true },
      { id: 'w9', type: 'Plan', spawnAt: NOW - 13 * H, doneAt: NOW - 12 * H, isOk: true },
    ],
    stats: { delivered: 3, isBossBusy: true, today: { date: today, ids: ['w2', 'w0'] } },
  })
  // alpha bugün bitmiş oturum: işçisi yok ama teslimleri bugünün sayısında
  put('alpha-ended', { project: 'alpha', updatedAt: NOW - 3 * H, endedAt: NOW - 3 * H, workers: [], stats: { delivered: 2, isBossBusy: false, today: { date: today, ids: ['e1', 'e2'] } } }, NOW - 3 * H)
  // beta canlı: eski eklenti (stats.today yok), aynı işçi kimliği başka oturumda
  put('beta-live', {
    project: 'beta', updatedAt: NOW - 2000,
    workers: [
      { id: 'w1', type: 'general-purpose', spawnAt: NOW - 20000, tool: 'Bash' },
      { id: 'w3', type: 'Explore', spawnAt: NOW - 50000, doneAt: NOW - 40000, isOk: false },
    ],
    stats: { delivered: 1, isBossBusy: false, waiting: { kind: 'permission', tool: 'Bash', since: NOW - 5000 } },
  })
  // gamma dün: hem dosya hem kayıt dünden
  put('gamma-yday', { project: 'gamma', updatedAt: NOW - 20 * H, endedAt: NOW - 20 * H, workers: [], stats: { delivered: 4, isBossBusy: false, today: { date: '2026-10-08', ids: ['y1', 'y2'] } } }, NOW - 20 * H)
  // delta: dosya dün değişmiş (kayıt bugünü gösterse de) → atlanır
  // omega: daha yeni bir eklentinin biçimi: okunmaz, uyarı verir
  put('omega-future', { format: 3, project: 'omega', updatedAt: NOW - 1000, workers: [{ id: 'z', type: 'x', spawnAt: NOW }], stats: { isBossBusy: true } })
  put('delta-stale', { project: 'delta', updatedAt: NOW - 15 * H, workers: [], stats: { delivered: 1, isBossBusy: false, today: { date: today, ids: ['d1'] } } }, NOW - 15 * H)
  writeFileSync(join(dir, 'bozuk.json'), '{')
  // arka plan kabukları: alpha canlı (biri çalışıyor, biri yeni bitti, biri unutma süresini (5 dk) geçti)
  const M = 60 * 1000
  const alphaLive = JSON.parse(readFileSync(join(dir, 'alpha-live.json'), 'utf8'))
  alphaLive.shells = [
    { id: 'a1', command: 'npm run dev', startAt: NOW - 2 * M, status: 'running' },
    { id: 'a2', command: 'npm run build', startAt: NOW - 3 * M, endAt: NOW - 1 * M, exitCode: 0, status: 'completed' },
    { id: 'a3', command: 'cargo test', startAt: NOW - 12 * M, endAt: NOW - 10 * M, exitCode: 1, status: 'failed' },
  ]
  put('alpha-live', alphaLive)
  // beta 2 dk önce bitti: bitenler süre içindeyse kalır, "çalışıyor" görünen oturumla kapanmıştır (killed)
  put('beta-ended', {
    project: 'beta', updatedAt: NOW - 2 * M, endedAt: NOW - 2 * M, workers: [],
    shells: [
      { id: 'b1', command: 'pytest -x', agentId: 'w1', startAt: NOW - 4 * M, endAt: NOW - 2.5 * M, exitCode: 0, status: 'completed' },
      { id: 'b2', command: 'tail -f log', startAt: NOW - 3.5 * M, status: 'running' },
      { id: 'b3', command: 'make', startAt: NOW - 11 * M, endAt: NOW - 10 * M, exitCode: 0, status: 'completed' },
    ],
  }, NOW - 2 * M)
  // epsilon bayat ama bitmemiş: çalışan kabuğu gösterilmez, eski biteni de
  put('eps-stale', {
    project: 'epsilon', updatedAt: NOW - 10 * M, workers: [],
    shells: [
      { id: 'e1', command: 'sleep 999', startAt: NOW - 11 * M, status: 'running' },
      { id: 'e2', command: 'ls', startAt: NOW - 21 * M, endAt: NOW - 20 * M, exitCode: 0, status: 'completed' },
    ],
  }, NOW - 10 * M)

  const byName = d => Object.fromEntries(d.projects.map(p => [p.name, p]))
  const all = readOffice(null, NOW, root)
  shape(all)
  assert.equal(all.delivered, 5, 'bugün: alpha 4 (w2, w0, e1, e2) + beta 1 (w3)')
  assert.equal(all.isBossBusy, true)
  assert.equal(all.workers.length, 5)
  assert.deepEqual(all.workers.map(w => w.project).sort(), ['alpha', 'alpha', 'alpha', 'beta', 'beta'])
  assert.deepEqual(Object.keys(byName(all)).sort(), ['alpha', 'beta'], 'dünkü/bayat projeler listede olmamalı')
  assert.deepEqual(byName(all).alpha, { name: 'alpha', working: 1, delivered: 4, isBossBusy: true, waiting: null })
  assert.deepEqual(byName(all).beta, { name: 'beta', working: 1, delivered: 1, isBossBusy: false, waiting: { tool: 'Bash', since: NOW - 5000 } })
  assert.equal(all.isBossAsking, true, 'izin bekleyen bir oturum var')
  assert.equal(readOffice(['alpha'], NOW, root).isBossAsking, false)
  assert.equal(all.project, 'alpha')
  assert.equal(all.sessionId, 'alpha-live')
  assert.equal(all.themesError, undefined, 'themes.json yoksa sessiz')
  assert.equal(all.newerFormat, 3, 'yeni biçimli dosya uyarı verir, işçileri sayılmaz')
  assert.equal(readOffice(['beta'], NOW, root).newerFormat, undefined, 'süzgeç dışındaki proje uyarmaz')
  // kabuklar: projeleriyle, başlama sırasıyla; süresi geçenler ve bayat oturumun çalışanı yok
  assert.deepEqual(all.shells.map(sh => [sh.id, sh.project]), [['b1', 'beta'], ['b2', 'beta'], ['a2', 'alpha'], ['a1', 'alpha']])
  const b2 = all.shells.find(sh => sh.id === 'b2')
  assert.equal(b2.status, 'killed', 'bitmiş oturumun çalışan kabuğu kapanmıştır')
  assert.equal(b2.endAt, NOW - 2 * M)
  assert.equal(all.shells.find(sh => sh.id === 'b1').agentId, 'w1', 'alanlar olduğu gibi geçer')
  assert.equal(all.shells.find(sh => sh.id === 'a1').endAt, undefined)

  // proje süzgeci: verilen sıra, oturumu olmayan proje de sıfırla listede
  const two = readOffice(['beta', 'zeta'], NOW, root)
  assert.equal(two.delivered, 1)
  assert.equal(two.isBossBusy, false)
  assert.deepEqual(two.workers.map(w => w.id).sort(), ['w1', 'w3'])
  assert.ok(two.workers.every(w => w.project === 'beta'))
  assert.deepEqual(two.projects, [
    { name: 'beta', working: 1, delivered: 1, isBossBusy: false, waiting: { tool: 'Bash', since: NOW - 5000 } },
    { name: 'zeta', working: 0, delivered: 0, isBossBusy: false, waiting: null },
  ])
  assert.deepEqual(two.shells.map(sh => sh.id), ['b1', 'b2'], 'süzgeç kabuklara da uygulanır')
  assert.deepEqual(readOffice(['alpha'], NOW, root).shells.map(sh => sh.id), ['a2', 'a1'])
  assert.deepEqual(readOffice(['zeta'], NOW, root).shells, [])
  // alpha canlılığını yitirince (bitmemiş, bayat): çalışan kabuk gider, yeni biten süre dolana dek kalır
  assert.deepEqual(readOffice(['alpha'], NOW + 3.5 * M, root).shells.map(sh => sh.id), ['a2'])
  assert.deepEqual(readOffice(['alpha'], NOW + 6 * M, root).shells, [])
  // beta: bitişten 5 dk sonra kabukları da unutulur
  assert.deepEqual(readOffice(['beta'], NOW + 2.4 * M, root).shells.map(sh => sh.id), ['b1', 'b2'])
  assert.deepEqual(readOffice(['beta'], NOW + 2.8 * M, root).shells.map(sh => sh.id), ['b2'])
  assert.deepEqual(readOffice(['beta'], NOW + 3.5 * M, root).shells, [])
  // settings.json forgetMinutes: 30 dk → eskiler de görünür, bayat oturumun çalışanı yine görünmez
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ forgetMinutes: 30 }))
  const long = readOffice(null, NOW, root)
  assert.deepEqual(long.shells.map(sh => sh.id).sort(), ['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'e2'])
  assert.equal(long.shells.find(sh => sh.id === 'e2').project, 'epsilon')
  rmSync(join(root, 'settings.json'))
  assert.equal(readOffice(null, NOW, root).shells.length, 4)
  // yalnız bitmiş oturumu olan proje: işçi yok, teslim var, tema projeden
  const ended = readOffice(['alpha'], NOW + 4 * 60 * 1000, root)
  assert.equal(ended.workers.length, 0)
  assert.equal(ended.delivered, 4)
  assert.equal(ended.project, 'alpha')
  assert.equal(readOffice(['gamma'], NOW, root).delivered, 0, 'dün sayılmaz')
  assert.equal(readOffice(['delta'], NOW, root).delivered, 0, 'dünden kalma dosya atlanır')
  // eski imza: tek proje adı
  assert.equal(readOffice('beta', NOW, root).delivered, 1)
  // ertesi gün: hepsi sıfır
  assert.equal(readOffice(null, NOW + 24 * H, root).delivered, 0)

  // themes.json: bozuk → hata (yol + ayrıştırma mesajı), nesne değil → hata, düzelince sessiz
  const themesPath = join(root, 'themes.json')
  writeFileSync(themesPath, '{ "acme": ')
  let d = readOffice(null, NOW, root)
  assert.ok(d.themesError?.includes(themesPath), d.themesError)
  assert.ok(d.themesError.length > themesPath.length + 2)
  assert.deepEqual(readThemes(root), {})
  writeFileSync(themesPath, '[1, 2]')
  assert.match(readOffice(null, NOW, root).themesError ?? '', /nesne/)
  writeFileSync(themesPath, JSON.stringify({ acme: { match: 'acme', title: 'ACME OFİS' } }))
  d = readOffice(null, NOW, root)
  assert.equal(d.themesError, undefined)
  assert.equal(readThemes(root).acme.title, 'ACME OFİS')
  rmSync(themesPath)
  assert.equal(readOffice(null, NOW, root).themesError, undefined)
  rmSync(root, { recursive: true, force: true })
}

// HOME'dan okuma (varsayılan kök): HOME geçici dizine çevrilince oradan okur
{
  const home = mkdtempSync(join(tmpdir(), 'agent-office-home-'))
  mkdirSync(join(home, '.claude', 'agent-office', 'sessions'), { recursive: true })
  writeFileSync(join(home, '.claude', 'agent-office', 'themes.json'), 'bozuk')
  const old = process.env.HOME
  process.env.HOME = home
  try {
    assert.equal(homedir(), home)
    const d = readOffice(null, NOW)
    assert.equal(d.workers.length, 0)
    assert.ok(d.themesError?.startsWith(join(home, '.claude', 'agent-office', 'themes.json')))
  } finally {
    process.env.HOME = old
    rmSync(home, { recursive: true, force: true })
  }
}

// ---------- çok proje: müdür hepsine bakar ----------
const PROJECTS = ['agent-office-app', 'forest-api', 'billing']
// demo işçilerini projelere dağıtır; proje tablosu readOffice ile aynı biçimde
function multiOffice(t, names) {
  const d = demoOffice(t)
  const workers = d.workers.map(w => ({ ...w, project: names[Number(w.id.split('-')[1]) % names.length] }))
  const projects = names.map((name, i) => ({
    name,
    working: workers.filter(w => w.project === name && w.doneAt == null).length,
    delivered: 3 + i * 4 + workers.filter(w => w.project === name && w.doneAt != null).length,
    isBossBusy: i !== 1,
  }))
  return { workers, delivered: projects.reduce((n, p) => n + p.delivered, 0), isBossBusy: true, projects, project: names[0], sessionId: '' }
}
const multiShots = []
const play = (names, name, opts = {}) => {
  resetOffice()
  setTheme('')
  setGeometry(opts.w ?? 1320, opts.h ?? 700)
  let frame
  for (let t = NOW - 70000; t <= NOW; t += 110) frame = render(t, multiOffice(t, names), { focus: opts.focus })
  const path = join(OUT, `multi-${name}.png`)
  writePng(path, frame)
  multiShots.push(path)
  return frame
}
const one = play(PROJECTS.slice(0, 1), '1')
// tek projede görünüm değişmez: proje alanları olmayan aynı veriyle birebir aynı kare
resetOffice()
setGeometry(1320, 700)
let plain
for (let t = NOW - 70000; t <= NOW; t += 110) {
  const { projects, ...d } = multiOffice(t, PROJECTS.slice(0, 1))
  plain = render(t, { ...d, workers: d.workers.map(({ project, ...w }) => w) })
}
assert.deepEqual(one.fb, plain.fb, 'tek proje görünümü değişmemeli')
const three = play(PROJECTS, '3')
assert.notDeepEqual(three.fb, one.fb)
const focused = play(PROJECTS, '3-focus-billing', { focus: 'billing' })
assert.ok(themeInfo().name.startsWith('auto:billing'), themeInfo().name)
assert.notDeepEqual(focused.fb, three.fb)
play(PROJECTS, '3-narrow', { w: 600, h: 400 })
play([...PROJECTS, 'acme-web', 'beta-api', 'gamma', 'delta-svc', 'epsilon'], '8-projects')

// odak değişimi masaları karıştırmaz: aynı veride odaklı ve odaksız karelerde işçiler aynı yerde
resetOffice()
setTheme('')
setGeometry(1320, 700)
for (let t = NOW - 70000; t <= NOW; t += 110) render(t, multiOffice(t, PROJECTS))
const before = render(NOW, multiOffice(NOW, PROJECTS), { focus: 'forest-api' })
const fbA = before.fb.slice()
render(NOW, multiOffice(NOW, PROJECTS), { focus: 'billing' })
const back = render(NOW, multiOffice(NOW, PROJECTS), { focus: 'forest-api' })
assert.deepEqual(back.fb, fbA, 'odak gidip gelince kare aynı kalmalı')

// kalabalık: masalar dolunca salona taşar, birkaç proje birden
{
  resetOffice()
  setTheme('')
  setGeometry(1320, 700)
  const workers = []
  for (let i = 0; i < 30; i++) workers.push({ id: `k-${i}`, type: i % 2 ? 'Explore' : 'Plan', spawnAt: NOW - 60000 + i * 500, tool: 'Read', project: PROJECTS[i % 3] })
  const projects = PROJECTS.map(name => ({ name, working: 10, delivered: 2, isBossBusy: true }))
  const crowd = { workers, delivered: 6, isBossBusy: true, projects, project: PROJECTS[0], sessionId: '' }
  let frame
  for (let t = NOW - 1000; t <= NOW + 20000; t += 110) frame = render(t, crowd, { focus: PROJECTS[2] })
  const path = join(OUT, 'multi-crowd.png')
  writePng(path, frame)
  multiShots.push(path)
}

// ---------- parti alanı ----------
// zaman çizelgesi oynatılır: teslim edenler piste gider, veri silinse de kalır, yeni iş gelince biri pistten masaya döner
const shots = []
const snap = (name, frame) => {
  const path = join(OUT, `party-${name}.png`)
  writePng(path, frame)
  shots.push(path)
}
for (const theme of ['classic', 'forest']) {
  resetOffice()
  setTheme(theme)
  setGeometry(1320, 700)
  let frame
  const T0 = NOW - 70000
  for (let t = T0; t <= NOW; t += 110) frame = render(t, demoOffice(t))
  assert.ok(partyCount() > 0, 'pistte kimse yok')
  assert.ok(partyCount() <= 8)
  snap(`${theme}-demo`, frame)
  if (theme !== 'classic') continue
  frame = render(NOW + 3000, demoOffice(NOW + 3000))
  snap('classic-demo-3s', frame)

  // veri tamamen silinir (FORGET_MS), müdür boşta: parti en canlı, botlar kalır
  const before = partyCount()
  const idle = { workers: [], delivered: 20, isBossBusy: false, project: '', sessionId: '' }
  for (let t = NOW; t <= NOW + 4000; t += 110) frame = render(t, idle)
  assert.equal(partyCount(), before, 'veri gidince partidekiler kaybolmamalı')
  snap('classic-idle', frame)

  // yeni iş: biri pistten masaya yürür
  const T1 = NOW + 4100
  const fresh = { ...idle, isBossBusy: true, workers: [{ id: 'yeni-1', type: 'Explore', spawnAt: T1, tool: 'Read' }] }
  render(T1, fresh)
  assert.equal(partyCount(), before - 1, 'pistten biri çağrılmalı')
  frame = render(T1 + 2000, fresh)
  snap('classic-recall', frame)
  // 10 dk sonra pist boşalır
  for (let t = T1; t <= T1 + 11 * 60 * 1000; t += 5000) render(t, { ...fresh, workers: [] })
  assert.equal(partyCount(), 0, 'parti süresi bitince pist boşalmalı')
}
// dar ekran: yerleşim bozulmasın
resetOffice()
setTheme('classic')
setGeometry(600, 400)
snap('narrow', render(NOW, demoOffice(NOW)))
setGeometry(2400, 1000)
snap('wide', render(NOW, demoOffice(NOW)))

// ---------- seçim: tıklanan bot ----------
const selectShots = []
{
  resetOffice()
  setTheme('classic')
  // ortalanan kare: tuval LW*S'e tam bölünmüyor, kaydırma hesaba katılmalı
  const g = setGeometry(1333, 707)
  const ox = Math.floor((1333 - g.LW * g.S) / 2)
  const oy = Math.floor((707 - g.LH * g.S) / 2)
  let frame
  for (let t = NOW - 70000; t <= NOW; t += 110) frame = render(t, demoOffice(t))
  const toPx = b => [ox + (b.x + b.w / 2) * g.S, oy + (b.y + b.h / 2) * g.S]
  const boxes = hitBoxes()
  // üstünde sonra çizilmiş başka kutu olmayanlar (en üstteki kazanır)
  const inside = (b, x, y) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h
  const clear = b => !boxes.slice(boxes.indexOf(b) + 1).some(o => o.id !== b.id && inside(o, b.x + b.w / 2, b.y + b.h / 2))
  const bodies = boxes.filter(b => !b.isTag && b.id !== BOSS_ID && clear(b))
  assert.ok(bodies.length > 5, 'bot kutusu kaydedilmeli')
  const live = new Set(demoOffice(NOW).workers.map(w => w.id))
  const working = bodies.find(b => live.has(b.id) && boxes.some(t => t.isTag && t.id === b.id && clear(t)))
  assert.ok(working, 'masada çalışan bir işçi olmalı')
  assert.equal(hitTest(...toPx(working)), working.id)
  // etiketine tıklamak da onu seçer
  assert.equal(hitTest(...toPx(boxes.find(t => t.isTag && t.id === working.id))), working.id)
  // pistteki dansçı (veride olmayabilir) da seçilebilir
  const dancer = bodies.find(b => b.y > g.LH * 0.4 && !boxes.some(t => t.isTag && t.id === b.id))
  if (dancer) assert.equal(hitTest(...toPx(dancer)), dancer.id)
  // müdür
  const boss = boxes.find(b => b.id === BOSS_ID && !b.isTag)
  assert.equal(hitTest(...toPx(boss)), BOSS_ID)
  // boş zemin: sol üst köşe duvar, tuval dışı, ölçü dışı değerler
  assert.equal(hitTest(ox + 2, oy + 2), null)
  assert.equal(hitTest(-5, -5), null)
  assert.equal(hitTest(NaN, 10), null)
  // birkaç piksel pay: kutunun hemen dışı (2 mantıksal piksel) hâlâ isabet, uzağı değil
  assert.equal(hitTest(ox + (working.x + working.w + 2) * g.S, oy + (working.y + working.h / 2) * g.S) !== null, true)
  // seçim işareti: aynı kare, seçili işçiyle farklı ve vurgu renginde piksel var
  const plain = render(NOW, demoOffice(NOW)).fb.slice()
  const sel = render(NOW, demoOffice(NOW), { selected: working.id })
  assert.notDeepEqual(sel.fb, plain, 'seçim işareti çizilmeli')
  const accent = parseInt(themeInfo().accent.slice(1), 16)
  const above = []
  for (let y = Math.max(0, working.y - 30); y < working.y; y++)
    for (let x = Math.floor(working.x); x < working.x + working.w; x++) above.push(sel.fb[y * sel.LW + x])
  assert.ok(above.includes(accent), 'ok botun üstünde olmalı')
  let path = join(OUT, 'select-desk.png')
  writePng(path, sel) // fb paylaşımlı: sonraki render üstüne yazar
  selectShots.push(path)
  // seçili id karede yoksa işaret yok, kare aynı
  assert.deepEqual(render(NOW, demoOffice(NOW), { selected: 'yok-boyle-biri' }).fb, plain)
  if (dancer) {
    path = join(OUT, 'select-party.png')
    writePng(path, render(NOW, demoOffice(NOW), { selected: dancer.id }))
    selectShots.push(path)
  }
  path = join(OUT, 'select-boss.png')
  writePng(path, render(NOW, demoOffice(NOW), { selected: BOSS_ID }))
  selectShots.push(path)
}

// ---------- arka plan kabukları: sunucu odasının raf yuvaları ----------
const shellShots = []
{
  assert.equal(shellLabel('npm run dev'), 'NPM')
  assert.equal(shellLabel('cd app && FOO=1 python3 -m http.server'), 'PYT')
  assert.equal(shellLabel('/usr/bin/tail -f x.log'), 'TAI')
  assert.equal(shellLabel(''), '?')

  // kabuk yokken kare eskisiyle birebir aynı: alan yok, boş dizi
  const playShells = (extra, opts = {}) => {
    resetOffice()
    setTheme('')
    setGeometry(1320, 700)
    let frame
    for (let t = NOW - 30000; t <= NOW; t += 110) frame = render(t, { ...multiOffice(t, PROJECTS), ...(typeof extra === 'function' ? extra(t) : extra) }, opts)
    return frame.fb.slice()
  }
  const noField = playShells({})
  assert.deepEqual(playShells({ shells: [] }), noField, 'boş kabuk listesi kareyi değiştirmemeli')
  assert.deepEqual(playShells({ shells: null }), noField)
  assert.ok(!hitBoxes().some(b => String(b.id).startsWith('shell:')))

  const M = 60 * 1000
  const shells = [
    { id: 'sh-dev', command: 'npm run dev', startAt: NOW - 5 * M, status: 'running', project: PROJECTS[0] },
    { id: 'sh-test', command: 'pytest -x tests', startAt: NOW - 1 * M, status: 'running', project: PROJECTS[1], agentId: 'demo-1' },
    { id: 'sh-log', command: 'tail -f server.log', startAt: NOW - 3 * M, status: 'running', project: PROJECTS[2] },
    { id: 'sh-build', command: 'npm run build', startAt: NOW - 4 * M, endAt: NOW - 2 * M, exitCode: 0, status: 'completed', project: PROJECTS[0] },
    { id: 'sh-cargo', command: 'cargo test', startAt: NOW - 4 * M, endAt: NOW - 1 * M, exitCode: 101, status: 'failed', project: PROJECTS[1] },
    { id: 'sh-kill', command: 'docker compose up', startAt: NOW - 6 * M, endAt: NOW - 1 * M, status: 'killed', project: PROJECTS[2] },
  ]
  const lit = playShells({ shells })
  assert.notDeepEqual(lit, noField, 'kabuklar raflarda görünmeli')
  const g = setGeometry(1320, 700)
  const boxes = hitBoxes()
  const slotBoxes = boxes.filter(b => String(b.id).startsWith('shell:'))
  assert.equal(slotBoxes.length, shells.length)
  // tıklama: yuva → 'shell:<id>'; müdür ve işçiler hâlâ seçilir
  const toPx = b => [(b.x + b.w / 2) * g.S + Math.floor((1320 - g.LW * g.S) / 2), (b.y + b.h / 2) * g.S + Math.floor((700 - g.LH * g.S) / 2)]
  for (const b of slotBoxes) assert.equal(hitTest(...toPx(b)), b.id)
  assert.ok(slotBoxes.every(b => b.x > g.LW - 100 && b.y < 45), 'yuvalar sağ üstteki sunucu odasında')
  assert.equal(hitTest(...toPx(boxes.find(b => b.id === BOSS_ID && !b.isTag))), BOSS_ID)
  const worker = boxes.find(b => !b.isTag && b.id.startsWith('demo-'))
  assert.ok(worker && hitTest(...toPx(worker)) !== null)
  // çalışan yuvanın lambaları yanıp söner (kabuğa özgü faz), bitenlerinki sabit
  const at = (fb, b) => { const out = []; for (let x = b.x; x < b.x + b.w; x++) out.push(fb[(b.y + 1) * g.LW + x]); return out }
  const dev = slotBoxes.find(b => b.id === 'shell:sh-dev')
  const build = slotBoxes.find(b => b.id === 'shell:sh-build')
  const blinks = new Set()
  const steady = new Set()
  for (let t = NOW; t < NOW + 3000; t += 110) {
    const f = render(t, { ...multiOffice(NOW, PROJECTS), shells })
    blinks.add(at(f.fb, dev).join())
    steady.add(at(f.fb, build).join())
  }
  assert.ok(blinks.size > 1, 'çalışan kabuk yanıp sönmeli')
  assert.equal(steady.size, 1, 'biten kabuk sabit yanmalı')
  // seçim işareti yuvada da çalışır
  const plainFb = render(NOW, { ...multiOffice(NOW, PROJECTS), shells }).fb.slice()
  const sel = render(NOW, { ...multiOffice(NOW, PROJECTS), shells }, { selected: 'shell:sh-test' })
  assert.notDeepEqual(sel.fb, plainFb, 'yuvada seçim işareti çizilmeli')
  const accent = parseInt(themeInfo().accent.slice(1), 16)
  const test = slotBoxes.find(b => b.id === 'shell:sh-test')
  const ring = []
  for (let x = test.x - 1; x <= test.x + test.w; x++) ring.push(sel.fb[(test.y - 1) * g.LW + x])
  assert.ok(ring.includes(accent), 'köşe çizgileri vurgu renginde')
  let path = join(OUT, 'shells-selected.png')
  writePng(path, sel)
  shellShots.push(path)

  // fazlası: 9 yuva; son yuva "+n" ve ilk gizli kabuğu seçer
  const many = []
  for (let i = 0; i < 14; i++) many.push({ id: `k${i}`, command: ['npm run dev', 'make watch', 'go test ./...', 'bun x'][i % 4], startAt: NOW - (20 - i) * 1000, status: 'running', project: PROJECTS[0] })
  resetOffice()
  setTheme('classic')
  setGeometry(1320, 700)
  const crowd = render(NOW, { ...demoOffice(NOW), shells: many }, { selected: 'shell:k8' })
  const kBoxes = hitBoxes().filter(b => String(b.id).startsWith('shell:'))
  assert.equal(kBoxes.length, 9)
  assert.equal(kBoxes[8].id, 'shell:k8', '+n yuvası ilk gizli kabuk')
  path = join(OUT, 'shells-overflow.png')
  writePng(path, crowd)
  shellShots.push(path)
}

console.log('ok', shellShots)
console.log('ok', selectShots)
console.log('ok', multiShots)
console.log('ok', geo, infos, { live: { project: all.project, workers: all.workers.length, delivered: all.delivered } }, shots)
