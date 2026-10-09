// Seni bekleyen projeler ve kota eşikleri: saf işlevler (Electron yok; node --test ile sınanır).
//
// Bir proje iki türlü bekler (sözleşme v2.6):
// - 'permission': oturumunda açık bir izin penceresi var (eklentinin stats.waiting'i).
// - 'done': müdür çalışıyordu, turu bitti ve kullanıcı o projeye henüz bakmadı.
// Bakmak = pencere odakta ve proje etkin. Bakılan projede bildirim çıkmaz, 'done' düşer.

/**
 * prev: { busy: Map<id, boolean>, waits: Map<id, string>, done: Set<id> } (ilk çağrıda boş)
 * projects: state.projects; office: readOffice(...).projects (ada göre); seenId: bakılan proje ya da null
 * → { state, attention: Map<id, 'permission' | 'done'>, events: [{ kind, id, tool? }] }
 */
function nextAttention(prev, projects, office, seenId) {
  const byName = new Map((office || []).map((p) => [p.name, p]));
  const state = { busy: new Map(), waits: new Map(), done: new Set() };
  const attention = new Map();
  const events = [];
  for (const proj of projects) {
    const p = byName.get(proj.name);
    const isSeen = proj.id === seenId;
    const busy = Boolean(p?.isBossBusy);
    const wait = p?.waiting ? `${p.waiting.tool}@${p.waiting.since}` : '';
    const wasBusy = prev.busy.get(proj.id);
    const prevWait = prev.waits.get(proj.id);
    let done = prev.done.has(proj.id) && !busy && !isSeen;
    // ilk okuma (önceki durum yok) bildirim üretmez
    if (wait && prevWait !== undefined && wait !== prevWait && !isSeen) events.push({ kind: 'permission', id: proj.id, tool: p.waiting.tool });
    if (wasBusy && !busy && !wait && !isSeen) {
      done = true;
      events.push({ kind: 'done', id: proj.id });
    }
    if (p) {
      state.busy.set(proj.id, busy);
      state.waits.set(proj.id, wait);
    }
    if (done) state.done.add(proj.id);
    if (wait) attention.set(proj.id, 'permission');
    else if (done) attention.set(proj.id, 'done');
  }
  return { state, attention, events };
}

const emptyAttention = () => ({ busy: new Map(), waits: new Map(), done: new Set() });

// Kota uyarısı eşikleri (yüzde); en yükseği bir kez söylenir.
const LEVELS = [95, 80];
const WINDOWS = ['fiveHour', 'sevenDay'];
const levelOf = (pct) => LEVELS.find((l) => pct >= l) || 0;

/**
 * usage: AccountUsage; alerted: Map<"<account>:<window>:<resetsAt>", level> (yerinde güncellenir)
 * seed: true ise yalnızca işaretler (açılışta eski değerler için uyarı yok)
 * → [{ window, pct, level, resetsAt }]
 */
function usageAlerts(accountId, usage, alerted, { seed = false, now = Date.now() } = {}) {
  const out = [];
  for (const win of WINDOWS) {
    const w = usage?.[win];
    if (!w || !Number.isFinite(w.pct) || (w.resetsAt != null && w.resetsAt <= now)) continue;
    const level = levelOf(w.pct);
    if (!level) continue;
    const key = `${accountId}:${win}:${w.resetsAt ?? ''}`;
    if (level <= (alerted.get(key) || 0)) continue;
    alerted.set(key, level);
    if (!seed) out.push({ window: win, pct: Math.round(w.pct), level, resetsAt: w.resetsAt });
  }
  return out;
}

module.exports = { nextAttention, emptyAttention, usageAlerts, LEVELS };
