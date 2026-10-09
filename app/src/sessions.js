// Ofis verisi: agent-office eklentisinin yazdığı oturum dosyalarını okur (Electron main).
// Bütün projeler tek ofiste: müdür hepsine bakar, her işçi kendi projesinin adını taşır.
const { readdirSync, readFileSync, statSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

const LIVE_MS = 3 * 60 * 1000

// yollar her çağrıda hesaplanır: testler HOME'u değiştirebilsin
const rootDir = () => join(homedir(), '.claude', 'agent-office')

const slugOf = p => String(p ?? '').replace(/[^\w.-]/g, '_')

// eklentinin görüntüleyicisiyle (viewer/office.mjs) aynı: yerel takvim günü
function dayKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------- temalar ----------
// themes.json bozuksa hata kaydedilir; dosya yoksa sessiz kalınır.
// Dosya ancak değiştiğinde (mtime/boyut) yeniden okunur; readOffice her 500 ms'de buna bakar.
let themesCache = { key: null, themes: {}, error: undefined }

function loadThemes(root = rootDir()) {
  const path = join(root, 'themes.json')
  let st
  try {
    st = statSync(path)
  } catch {
    themesCache = { key: `${path}|yok`, themes: {}, error: undefined }
    return themesCache
  }
  const key = `${path}|${st.mtimeMs}|${st.size}`
  if (themesCache.key === key) return themesCache
  let themes = {}
  let error
  try {
    const t = JSON.parse(readFileSync(path, 'utf8'))
    if (t && typeof t === 'object' && !Array.isArray(t)) themes = t
    else error = `${path}: tema dosyası bir nesne olmalı`
  } catch (err) {
    error = `${path}: ${err?.message ?? err}`
  }
  themesCache = { key, themes, error }
  return themesCache
}

function readThemes(root) {
  return loadThemes(root).themes
}

// son okunan themes.json hatası (yoksa undefined)
function themesError(root) {
  return loadThemes(root).error
}

// ---------- ayarlar ----------
// settings.json { forgetMinutes: 1-60 } (eklentiyle aynı kural, varsayılan 5): bitmiş kabuklar bu kadar kalır
const FORGET_MINUTES = { min: 1, max: 60, default: 5 }
let settingsCache = { key: null, forgetMs: FORGET_MINUTES.default * 60_000 }

function forgetMs(root = rootDir()) {
  const path = join(root, 'settings.json')
  let key
  try {
    const st = statSync(path)
    key = `${path}|${st.mtimeMs}|${st.size}`
  } catch {
    key = `${path}|yok`
  }
  if (settingsCache.key === key) return settingsCache.forgetMs
  let minutes = FORGET_MINUTES.default
  try {
    const m = JSON.parse(readFileSync(path, 'utf8'))?.forgetMinutes
    if (typeof m === 'number' && Number.isFinite(m)) minutes = Math.min(FORGET_MINUTES.max, Math.max(FORGET_MINUTES.min, m))
  } catch {}
  settingsCache = { key, forgetMs: minutes * 60_000 }
  return settingsCache.forgetMs
}

// ---------- arka plan kabukları ----------
// canlı oturum: dosyadaki hepsi (çalışanlar + unutma süresi dolmamış bitenler; eklenti budar, burada da süzülür).
// canlı olmayan oturum: yalnız bitişi unutma süresi içinde olanlar; oturum bittiğinde hâlâ "çalışan" görünenler
// oturumla birlikte kapanmıştır (killed, endAt = endedAt). Bitmemiş ama bayat oturumun çalışanları gösterilmez.
function shellsOf(s, isLive, now, forget) {
  const out = []
  for (const sh of Array.isArray(s.shells) ? s.shells : []) {
    if (!sh || typeof sh !== 'object' || sh.id == null) continue
    let shell = sh
    if (sh.endAt == null && !isLive) {
      if (!s.endedAt) continue
      shell = { ...sh, endAt: s.endedAt, status: 'killed' }
    }
    if (shell.endAt != null && now - shell.endAt > forget) continue
    out.push(shell)
  }
  return out
}

// ---------- ofis ----------
// projects: dahil edilecek proje adları; null = bütün canlı oturumlar. (Eski tek proje adı da kabul edilir.)
// delivered: bugün (yerel gün) teslim edilenler; doneAt'i bugün olan işçiler ∪ stats.today kimlikleri,
// oturum/işçi kimliğiyle tekilleştirilir; bugün biten oturumlar dahil.
// Bu uygulamanın okuyabildiği en yeni oturum dosyası biçimi (eklentinin FORMAT'ı; yoksa eski dosya, 2 sayılır).
const FORMAT = 2

// Sekmeler (sözleşme v3.0): eklenti oturumu klasörün adıyla anar; worktree sekmesinin klasörü başka adlıysa
// (`<depo>-wt-<n>`) aliases { oturum adı: proje adı } o oturumları projesine sayar: işçiler, kabuklar,
// teslimler, meşgul/onay durumu proje adını taşır. Eşlenmeyen ad kendisidir.
function aliasOf(aliases) {
  const map = new Map()
  for (const [from, to] of Object.entries(aliases ?? {})) if (from && to) map.set(slugOf(from), String(to))
  return name => map.get(slugOf(name)) ?? name
}

function readOffice(projects, now = Date.now(), root = rootDir(), aliases = null) {
  const list = projects == null ? null : (Array.isArray(projects) ? projects : [projects]).filter(p => p != null && p !== '')
  const only = list ? new Set(list.map(slugOf)) : null
  const projectOf = aliasOf(aliases)
  const data = { workers: [], shells: [], delivered: 0, isBossBusy: false, isBossAsking: false, projects: [], project: '', sessionId: '' }
  const forget = forgetMs(root)

  // proje tablosu: verilen sırayla, sonra görülenler
  const table = new Map()
  const entry = name => {
    const key = slugOf(name)
    if (!table.has(key)) table.set(key, { name: String(name ?? ''), working: 0, delivered: 0, isBossBusy: false, waiting: null })
    return table.get(key)
  }
  for (const p of list ?? []) entry(p)

  const sessions = join(root, 'sessions')
  let files = []
  try {
    files = readdirSync(sessions).filter(f => f.endsWith('.json'))
  } catch {
    files = []
  }
  const day = dayKey(now)
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const seen = new Map() // "<oturum>/<işçi>" → proje anahtarı
  let newest = 0
  for (const f of files) {
    let s
    try {
      // bugünden önce değişmiş ve canlı olmayan dosyalar ne işçi ne de bugünün teslimini taşır
      if (statSync(join(sessions, f)).mtimeMs < Math.min(midnight, now - LIVE_MS)) continue
      s = JSON.parse(readFileSync(join(sessions, f), 'utf8'))
    } catch {
      continue
    }
    if (!s || typeof s !== 'object') continue
    s.project = projectOf(s.project)
    const key = slugOf(s.project)
    if (only && !only.has(key)) continue
    // daha yeni bir eklentinin yazdığı dosya: yanlış okumak yerine uyar (sözleşme v2.8)
    if (Number.isFinite(s.format) && s.format > FORMAT) {
      data.newerFormat = Math.max(data.newerFormat ?? 0, s.format)
      continue
    }
    const sessionId = f.replace(/\.json$/, '')
    const workers = Array.isArray(s.workers) ? s.workers : []
    let delivers = false
    for (const w of workers) {
      if (w?.doneAt != null && w.id != null && dayKey(w.doneAt) === day) {
        seen.set(`${sessionId}/${w.id}`, key)
        delivers = true
      }
    }
    // kancanın kalıcı günlük kaydı: dosyadan silinmiş teslimler
    if (s.stats?.today?.date === day && Array.isArray(s.stats.today.ids)) {
      for (const id of s.stats.today.ids) seen.set(`${sessionId}/${id}`, key)
      delivers ||= s.stats.today.ids.length > 0
    }
    const isLive = !s.endedAt && now - (s.updatedAt ?? 0) <= LIVE_MS
    const shells = shellsOf(s, isLive, now, forget)
    if (!isLive) {
      if (delivers || shells.length) {
        const p = entry(s.project)
        const project = p.name || String(s.project ?? '')
        for (const sh of shells) data.shells.push({ ...sh, project })
      }
      continue
    }
    const p = entry(s.project)
    const project = p.name || String(s.project ?? '')
    for (const sh of shells) data.shells.push({ ...sh, project })
    for (const w of workers) {
      if (!w || typeof w !== 'object') continue
      data.workers.push({ ...w, project })
      if (w.doneAt == null) p.working++
    }
    const busy = Boolean(s.stats?.isBossBusy)
    p.isBossBusy ||= busy
    data.isBossBusy ||= busy
    // açık izin penceresi (sözleşme v2.6): projede en eskisi
    const w = s.stats?.waiting
    if (w && w.kind === 'permission' && Number.isFinite(w.since) && (!p.waiting || w.since < p.waiting.since)) {
      p.waiting = { tool: typeof w.tool === 'string' ? w.tool : '', since: w.since }
      data.isBossAsking = true
    }
    if ((s.updatedAt ?? 0) > newest) {
      newest = s.updatedAt ?? 0
      data.project = s.project ?? ''
      data.sessionId = sessionId
    }
  }
  for (const key of seen.values()) {
    const p = table.get(key)
    if (p) p.delivered++
  }
  data.delivered = seen.size
  data.shells.sort((a, b) => (a.startAt ?? 0) - (b.startAt ?? 0))
  data.projects = [...table.values()]
  // oturum yoksa da tema ilk projeye göre seçilsin
  if (!data.project && list?.length) data.project = String(list[0])
  const err = themesError(root)
  if (err) data.themesError = err
  return data
}

// ---------- gün sonu özeti (sözleşme v2.9) ----------
// Bugünün teslimleri: her oturumun stats.today.log'u (işçi ofisten ayrılsa da kalır), projesiyle, en yenisi önce.
// projects verilirse yalnız onlar. untracked: günlüğü olmayan (eski eklenti) teslim sayısı.
function readToday(projects, now = Date.now(), root = rootDir(), aliases = null) {
  const only = projects == null ? null : new Set(projects.map(slugOf))
  const projectOf = aliasOf(aliases)
  const day = dayKey(now)
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const sessions = join(root, 'sessions')
  const out = { date: day, deliveries: [], untracked: 0 }
  let files = []
  try {
    files = readdirSync(sessions).filter(f => f.endsWith('.json'))
  } catch {
    return out
  }
  for (const f of files) {
    let s
    try {
      if (statSync(join(sessions, f)).mtimeMs < midnight) continue
      s = JSON.parse(readFileSync(join(sessions, f), 'utf8'))
    } catch {
      continue
    }
    if (!s || typeof s !== 'object' || s.stats?.today?.date !== day) continue
    if (Number.isFinite(s.format) && s.format > FORMAT) continue
    s.project = projectOf(s.project)
    if (only && !only.has(slugOf(s.project))) continue
    const project = String(s.project ?? '')
    const ids = Array.isArray(s.stats.today.ids) ? s.stats.today.ids : []
    const log = Array.isArray(s.stats.today.log) ? s.stats.today.log : []
    const sessionId = f.replace(/\.json$/, '')
    for (const d of log) {
      if (!d || typeof d !== 'object' || !Number.isFinite(d.doneAt)) continue
      out.deliveries.push({
        id: String(d.id ?? ''), sessionId, project,
        type: String(d.type ?? ''), description: String(d.description ?? ''),
        spawnAt: Number.isFinite(d.spawnAt) ? d.spawnAt : d.doneAt, doneAt: d.doneAt,
        isOk: d.isOk !== false, toolCount: Number.isFinite(d.toolCount) ? d.toolCount : 0,
      })
    }
    out.untracked += Math.max(0, new Set(ids).size - log.length)
  }
  out.deliveries.sort((a, b) => b.doneAt - a.doneAt)
  return out
}

module.exports = { readOffice, readToday, readThemes, themesError, dayKey, forgetMs, LIVE_MS, FORMAT }
