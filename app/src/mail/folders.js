// Mail folders (contract v3.93): a member reads any folder and proposes an organizing plan (new folders, renames, mails
// moved to folders, empty folders removed); the plan waits in the app like a draft, and only the person's Approve runs
// it, done by main (never by the session). Pure, no Electron; tested in test/mail.test.cjs. Nothing here deletes a mail:
// a move into a trash, junk, outbox, drafts or sent folder is refused (it would delete or send in all but name), only an
// empty folder without subfolders can be removed, and the inbox and the special folders are never renamed or removed.
'use strict';
const crypto = require('crypto');
const G = require('./guard.js');

const PLAN_ID_RE = /^p-[0-9a-f]{8,16}$/;
const MOVES_MAX = 300;          // mails moved by one plan
const FOLDER_OPS_MAX = 20;      // folders made, renamed or removed by one plan
const PLANS_PENDING_MAX = 20;
const PLANS_KEEP = 100;
const SEGMENT_MAX = 60;
const DEPTH_MAX = 5;

// ---------- IMAP folder names: modified UTF-7 (RFC 3501 5.1.3); Exchange and most servers speak only this

/** A folder name as typed → its IMAP form (ASCII). */
function encodeMutf7(s) {
  let out = '';
  let run = '';
  const flush = () => {
    if (!run) return;
    const b = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i++) b.writeUInt16BE(run.charCodeAt(i), i * 2);
    out += `&${b.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
    run = '';
  };
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c <= 0x7e) { flush(); out += ch === '&' ? '&-' : ch; } else run += ch;
  }
  flush();
  return out;
}
/** An IMAP folder name → as people read it (a broken shift is kept as typed). */
function decodeMutf7(s) {
  return String(s).replace(/&([A-Za-z0-9+,]*)-/g, (all, b64) => {
    if (!b64) return '&';
    const b = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    if (b.length % 2) return all;
    let r = '';
    for (let i = 0; i < b.length; i += 2) r += String.fromCharCode(b.readUInt16BE(i));
    return r;
  });
}

// ---------- folder paths ("Customers/Acme", '/' between levels whatever the server's own separator is)

/** A folder path from a model or the person → the clean path, or '' when it is not one we accept. */
function cleanPath(p) {
  const parts = String(p ?? '').split('/').map((x) => G.cleanLine(x, SEGMENT_MAX + 1).trim());
  // eslint-disable-next-line no-control-regex
  if (!parts.length || parts.length > DEPTH_MAX || parts.some((x) => !x || x.length > SEGMENT_MAX || /[*%"\\\u0000-\u001f]/.test(x) || x === '.' || x === '..')) return '';
  return parts.join('/');
}
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

// Special folders by name, for servers that do not mark them (Exchange's IMAP, localized): English and Turkish
const SPECIAL_NAMES = {
  trash: /^(trash|deleted items|deleted messages|bin|silinmiş öğeler|silinen öğeler|çöp kutusu|çöp)$/i,
  junk: /^(junk|junk e-?mail|spam|bulk mail|gereksiz e-?posta|istenmeyen e-?posta|önemsiz e-?posta)$/i,
  sent: /^(sent|sent items|sent mail|sent messages|gönderilmiş öğeler|gönderilenler|giden öğeler)$/i,
  drafts: /^(drafts|taslaklar)$/i,
  outbox: /^(outbox|giden kutusu)$/i,
};
/**
 * A folder's special use: 'inbox' | 'trash' | 'junk' | 'sent' | 'drafts' | 'outbox' | 'archive' | 'all' | '' — from the
 * server's own mark (IMAP SPECIAL-USE flags, Graph well-known names) or, for a top-level folder, its name.
 */
function specialOf({ path, flags = [], wellKnown = '' }) {
  const f = flags.map((x) => String(x).toLowerCase());
  if (/^inbox$/i.test(path) || wellKnown === 'inbox') return 'inbox';
  const mark = { '\\trash': 'trash', '\\junk': 'junk', '\\sent': 'sent', '\\drafts': 'drafts', '\\archive': 'archive', '\\all': 'all' };
  for (const [k, v] of Object.entries(mark)) if (f.includes(k)) return v;
  const wk = { deleteditems: 'trash', junkemail: 'junk', sentitems: 'sent', drafts: 'drafts', outbox: 'outbox', archive: 'archive' }[wellKnown];
  if (wk) return wk;
  const last = path.split('/').pop();
  if (!path.includes('/') || /^\[gmail\]|^\[google mail\]/i.test(path)) for (const [k, re] of Object.entries(SPECIAL_NAMES)) if (re.test(last)) return k;
  return '';
}
// a mail moved into these is deleted, sent or hidden in all but name; Gmail's "All Mail" is not a folder one moves into
const NO_MOVE_INTO = new Set(['trash', 'junk', 'sent', 'drafts', 'outbox', 'all']);

/** IMAP LIST rows ({ name, delim, flags }) → folders [{ path, name, delim, special, selectable }]. */
function imapFolders(rows) {
  return rows.map((r) => {
    const decoded = decodeMutf7(r.name);
    const path = r.delim && r.delim !== '/' ? decoded.split(r.delim).join('/') : decoded;
    const flags = r.flags.map((f) => f.toLowerCase());
    return { path: /^inbox$/i.test(path) ? 'INBOX' : path, name: r.name, delim: r.delim, special: specialOf({ path, flags: r.flags }), selectable: !flags.includes('\\noselect') && !flags.includes('\\nonexistent') };
  }).filter((f) => f.path);
}
/** A path → its IMAP name, with the server's separator (the one its folders use; '/' when unknown). */
function imapName(p, folders) {
  if (/^inbox$/i.test(p)) return 'INBOX';
  const delim = folders.find((f) => f.delim)?.delim || '/';
  return encodeMutf7(p.split('/').join(delim));
}
/** Graph folders ({ path, id, wellKnown }) → folders [{ path, id, special, selectable }]. */
const graphFolders = (rows) => rows.map((r) => ({ path: r.wellKnown === 'inbox' ? 'INBOX' : r.path, id: r.id, special: specialOf({ path: r.path, wellKnown: r.wellKnown }), selectable: true, count: r.count }));

/** Folders as a session sees them: [{ path, special? }] (sorted, no ids, no server names). */
const publicFolders = (folders) => folders.filter((f) => f.selectable !== false).map((f) => ({ path: f.path, ...(f.special ? { special: f.special } : {}) }))
  .sort((a, b) => a.path.localeCompare(b.path));
const findFolder = (folders, p) => folders.find((f) => sameName(f.path, p)) || null;

// ---------- a plan from a model

/**
 * The model's mail_organize call → { plan } | { error, detail? }. `seen` maps `${folder}\n${id}` to the mail as it
 * was listed or read in this session ({ from, subject, date }): a plan moves only mails the session has seen, and the
 * person reviews them by sender and subject. `folders`: the account's folders now (main lists them first).
 * @param {{ account: any, form: any, seen: { get: (key: string) => any }, folders: any[], staff: { id: string, name: string }, project: { id: string, name: string }, now?: number }} o
 */
function planFromForm(o, newId = () => `p-${crypto.randomBytes(5).toString('hex')}`) {
  const { account, form, seen, folders, staff, project, now = Date.now() } = o;
  const f = form && typeof form === 'object' ? form : {};
  const list = (v) => (Array.isArray(v) ? v : []);
  const creates = [];
  for (const raw of list(f.create_folders)) {
    const p = cleanPath(raw);
    if (!p) return { error: 'bad-folder', detail: String(raw).slice(0, 80) };
    if (findFolder(folders, p) || creates.some((x) => sameName(x, p))) continue;   // already there: nothing to do
    creates.push(p);
  }
  // the parents of a new folder are made too (Graph needs each level; most IMAP servers make them anyway)
  for (const p of [...creates]) for (let q = parentOf(p); q; q = parentOf(q)) if (!findFolder(folders, q) && !creates.some((x) => sameName(x, q))) creates.push(q);
  creates.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const exists = (p) => Boolean(findFolder(folders, p)) || creates.some((x) => sameName(x, p));

  const renames = [];
  for (const r of list(f.rename_folders)) {
    const from = cleanPath(r?.folder);
    const name = G.cleanLine(String(r?.new_name ?? ''), SEGMENT_MAX + 1).trim();
    const cur = from && findFolder(folders, from);
    if (!cur) return { error: 'unknown-folder', detail: String(r?.folder ?? '').slice(0, 80) };
    if (!name || name.length > SEGMENT_MAX || name.includes('/') || !cleanPath(name)) return { error: 'bad-folder', detail: name.slice(0, 80) };
    if (cur.special) return { error: 'special-folder', detail: cur.path };
    const to = parentOf(cur.path) ? `${parentOf(cur.path)}/${name}` : name;
    if (exists(to)) return { error: 'folder-exists', detail: to };
    renames.push({ folder: cur.path, to });
  }

  const removes = [];
  for (const raw of list(f.remove_empty_folders)) {
    const p = cleanPath(raw);
    const cur = p && findFolder(folders, p);
    if (!cur) return { error: 'unknown-folder', detail: String(raw).slice(0, 80) };
    if (cur.special) return { error: 'special-folder', detail: cur.path };
    if (folders.some((x) => x.path.startsWith(`${cur.path}/`))) return { error: 'has-subfolders', detail: cur.path };
    if (renames.some((r) => sameName(r.folder, cur.path))) return { error: 'bad-plan', detail: cur.path };
    if (!removes.includes(cur.path)) removes.push(cur.path);
  }
  if (creates.length + renames.length + removes.length > FOLDER_OPS_MAX) return { error: 'too-many-folders' };

  const moves = [];
  for (const m of list(f.moves)) {
    const id = String(m?.id ?? '').slice(0, 400);
    const from = m?.folder ? cleanPath(m.folder) : 'INBOX';
    const src = from && (findFolder(folders, from) || (/^inbox$/i.test(from) ? { path: 'INBOX', special: 'inbox' } : null));
    if (!src) return { error: 'unknown-folder', detail: String(m?.folder ?? '').slice(0, 80) };
    const mail = seen.get(`${src.special === 'inbox' ? 'INBOX' : src.path}\n${id}`);
    if (!mail) return { error: 'list-first', detail: id.slice(0, 80) };
    const to = cleanPath(m?.to);
    if (!to) return { error: 'bad-folder', detail: String(m?.to ?? '').slice(0, 80) };
    const dest = findFolder(folders, to);
    if (!dest && !creates.some((x) => sameName(x, to))) return { error: 'unknown-folder', detail: to };
    if (dest && NO_MOVE_INTO.has(dest.special)) return { error: 'no-move-into', detail: dest.path };
    if (removes.some((x) => sameName(x, to))) return { error: 'bad-plan', detail: to };
    const srcPath = src.special === 'inbox' ? 'INBOX' : src.path;
    if (dest && sameName(dest.path, srcPath)) continue;   // already there
    if (moves.some((x) => x.id === id && x.from === srcPath)) continue;
    moves.push({ id, from: srcPath, to: dest ? dest.path : creates.find((x) => sameName(x, to)), mail: { from: G.cleanLine(mail.from, 120), subject: G.cleanLine(mail.subject, 200), date: G.cleanLine(mail.date, 60) } });
  }
  if (moves.length > MOVES_MAX) return { error: 'too-many-moves' };
  if (!creates.length && !renames.length && !removes.length && !moves.length) return { error: 'empty-plan' };
  return {
    plan: {
      id: newId(), status: 'pending', account: account.id, address: account.address,
      title: G.cleanLine(String(f.title ?? ''), 120), note: G.cleanText(String(f.note ?? ''), 2000).text,
      creates, renames, removes, moves, staffId: staff.id, staffName: staff.name, projectId: project.id, projectName: project.name, createdAt: now,
    },
  };
}

// ---------- plans in the outbox file (userData/mail/outbox.json, next to the drafts)

/** The stored plans, checked; one cut short by a crash comes back as `failed: interrupted` (some steps may be done). */
function normalizePlans(raw) {
  return (Array.isArray(raw) ? raw : []).filter((p) => p && PLAN_ID_RE.test(String(p.id)) && ['pending', 'running', 'done', 'partial', 'failed', 'discarded'].includes(p.status)
    && Array.isArray(p.creates) && Array.isArray(p.renames) && Array.isArray(p.removes) && Array.isArray(p.moves))
    .map((p) => (p.status === 'running' ? { ...p, status: 'failed', error: 'interrupted' } : p)).slice(0, PLANS_KEEP);
}
const pendingPlans = (plans) => plans.filter((p) => p.status === 'pending');
/** A new plan at the top. → { plans } | { error: 'queue-full' } */
function addPlan(plans, plan) {
  if (pendingPlans(plans).length >= PLANS_PENDING_MAX) return { error: 'queue-full' };
  return { plans: [plan, ...plans].slice(0, PLANS_KEEP) };
}
/** pending → running → done | partial | failed; pending → discarded. → { plans, plan } | { error: 'state' } */
function setPlanStatus(plans, id, status, extra = {}) {
  const p = plans.find((x) => x.id === id);
  const ok = p && ({ running: ['pending'], done: ['running'], partial: ['running'], failed: ['running'], discarded: ['pending'] }[status] || []).includes(p.status);
  if (!ok) return { error: 'state' };
  const next = { ...p, status, ...extra };
  return { plans: plans.map((x) => (x.id === id ? next : x)), plan: next };
}
/** The person's choice: only the steps they kept (indexes per kind; a missing kind keeps all of it). */
function keepOnly(plan, keep) {
  const pick = (arr, idx) => (Array.isArray(idx) ? arr.filter((_, i) => idx.includes(i)) : arr);
  const k = keep && typeof keep === 'object' ? keep : {};
  const moves = pick(plan.moves, k.moves);
  // a kept move into a new folder keeps that folder (and its parents)
  const creates = plan.creates.filter((c, i) => (Array.isArray(k.creates) ? k.creates.includes(i) : true)
    || moves.some((m) => sameName(m.to, c) || m.to.startsWith(`${c}/`)));
  return { ...plan, creates, renames: pick(plan.renames, k.renames), removes: pick(plan.removes, k.removes), moves };
}
/** What a session may see of its plans: status and counts, never another member's. */
const plansFor = (plans, staffId) => plans.filter((p) => p.staffId === staffId).slice(0, 30).map((p) => ({
  id: p.id, status: p.status, title: p.title, createdAt: p.createdAt,
  counts: { create: p.creates.length, rename: p.renames.length, remove: p.removes.length, move: p.moves.length },
  ...(p.result ? { result: p.result.summary } : {}), ...(p.error ? { error: p.error } : {}),
}));

// ---------- running an approved plan

/**
 * Runs a plan through a driver (IMAP or Graph, made by main), checking each step again against the folders as they
 * are now. Order: new folders, renames, moves, removals of empty folders. A step that cannot run is recorded and the
 * rest go on. → { status: 'done' | 'partial' | 'failed', steps: [{ kind, …, ok, error? }], summary }
 * driver: { folders(): Promise<folder[]>, create(path, folders), rename(folder, to, folders), move(from, ids[], to, folders) → { moved: ids[], missing: ids[] }, remove(folder, folders) → 'removed' | 'not-empty' }
 */
async function runPlan(plan, driver) {
  const steps = [];
  const err = (e) => (typeof e?.message === 'string' && /^[a-z-]{2,30}$/.test(e.message) ? e.message : 'failed');
  let folders = await driver.folders();
  const refresh = async () => { folders = await driver.folders(); };
  for (const p of plan.creates) {
    if (findFolder(folders, p)) { steps.push({ kind: 'create', folder: p, ok: true, already: true }); continue; }
    try { await driver.create(p, folders); steps.push({ kind: 'create', folder: p, ok: true }); await refresh(); } catch (e) { steps.push({ kind: 'create', folder: p, ok: false, error: err(e) }); }
  }
  for (const r of plan.renames) {
    const cur = findFolder(folders, r.folder);
    const error = !cur ? 'unknown-folder' : cur.special ? 'special-folder' : findFolder(folders, r.to) ? 'folder-exists' : '';
    if (error) { steps.push({ kind: 'rename', folder: r.folder, to: r.to, ok: false, error }); continue; }
    try { await driver.rename(cur, r.to, folders); steps.push({ kind: 'rename', folder: r.folder, to: r.to, ok: true }); await refresh(); } catch (e) { steps.push({ kind: 'rename', folder: r.folder, to: r.to, ok: false, error: err(e) }); }
  }
  // moves, by source and destination
  const groups = new Map();
  for (const m of plan.moves) { const k = `${m.from}\n${m.to}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  for (const ms of groups.values()) {
    const { from, to } = ms[0];
    const src = /^inbox$/i.test(from) ? { path: 'INBOX', special: 'inbox', ...(findFolder(folders, 'INBOX') || {}) } : findFolder(folders, from);
    const dest = findFolder(folders, to);
    const error = !src || !dest ? 'unknown-folder' : NO_MOVE_INTO.has(dest.special) ? 'no-move-into' : '';
    if (error) { for (const m of ms) steps.push({ kind: 'move', id: m.id, from, to, ok: false, error }); continue; }
    try {
      const r = await driver.move(src, ms.map((m) => m.id), dest, folders);
      for (const m of ms) steps.push({ kind: 'move', id: m.id, from, to, ok: r.moved.includes(m.id), ...(r.moved.includes(m.id) ? {} : { error: 'gone' }) });
    } catch (e) { for (const m of ms) steps.push({ kind: 'move', id: m.id, from, to, ok: false, error: err(e) }); }
  }
  for (const p of plan.removes) {
    const cur = findFolder(folders, p);
    const error = !cur ? 'unknown-folder' : cur.special ? 'special-folder' : folders.some((x) => x.path.startsWith(`${cur.path}/`)) ? 'has-subfolders' : '';
    if (error) { steps.push({ kind: 'remove', folder: p, ok: false, error }); continue; }
    try {
      const r = await driver.remove(cur, folders);
      steps.push({ kind: 'remove', folder: p, ok: r === 'removed', ...(r === 'removed' ? {} : { error: 'not-empty' }) });
      if (r === 'removed') await refresh();
    } catch (e) { steps.push({ kind: 'remove', folder: p, ok: false, error: err(e) }); }
  }
  const okN = steps.filter((s) => s.ok).length;
  const moved = steps.filter((s) => s.kind === 'move' && s.ok).length;
  return {
    status: okN === steps.length ? 'done' : okN ? 'partial' : 'failed',
    steps,
    summary: { ok: okN, failed: steps.length - okN, moved, folders: steps.filter((s) => s.kind !== 'move' && s.ok).length },
  };
}

module.exports = {
  PLAN_ID_RE, MOVES_MAX, FOLDER_OPS_MAX, PLANS_PENDING_MAX, NO_MOVE_INTO,
  encodeMutf7, decodeMutf7, imapFolders, imapName, graphFolders, cleanPath, parentOf, specialOf, publicFolders, findFolder,
  planFromForm, normalizePlans, pendingPlans, addPlan, setPlanStatus, keepOnly, plansFor, runPlan,
};
