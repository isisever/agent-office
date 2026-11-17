// Mail (contract v3.83): mail accounts (state.mailAccounts, no secret) and the outbox of drafts waiting for the person
// (userData/mail/outbox.json, 0600). Pure, no Electron; tested in test/mail.test.cjs. A draft only ever leaves the
// outbox through the person's "Send" in the app (main: mail:send); a model can add drafts, never send or approve one.
'use strict';
const crypto = require('crypto');
const G = require('./guard.js');

const PROVIDERS = ['gmail', 'm365', 'exchange', 'imap'];
// a certificate the person trusted for a server (its SHA-256 fingerprint as Node prints it)
const PIN_RE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
// Exchange Online / Outlook.com: IMAP and SMTP take OAuth only there (IMAP says LOGINDISABLED): the m365 provider
const MICROSOFT_HOST = /(?:^|\.)(?:office365\.com|outlook\.com|office\.com|outlook\.office\.com|hotmail\.com|live\.com)$/i;
const MICROSOFT_DOMAIN = /@(?:outlook|hotmail|live|msn)\.[a-z.]+$/i;
const ACCOUNT_ID_RE = /^m-[0-9a-f]{6,16}$/;
const DRAFT_ID_RE = /^d-[0-9a-f]{8,16}$/;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const ACCOUNTS_MAX = 10;
const PENDING_MAX = 50;
const KEEP = 200;

// Gmail: IMAP and SMTP with an app password (Google account → Security → 2-Step Verification → App passwords)
const GMAIL = { imap: { host: 'imap.gmail.com', port: 993 }, smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' } };

const str = (v, max) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '');
const port = (v, d) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : d; };
const server = (raw, def) => (raw && HOST_RE.test(String(raw.host || '')) ? {
  host: String(raw.host).toLowerCase(), port: port(raw.port, def.port),
  ...(def.security ? { security: raw.security === 'starttls' || raw.security === 'tls' ? raw.security : def.security } : {}),
  ...(PIN_RE.test(String(raw.pin || '')) ? { pin: String(raw.pin) } : {}),
} : null);

/** One stored account → the account, or null. The password / token is never here (main's encrypted store). */
function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object' || !ACCOUNT_ID_RE.test(String(raw.id)) || !PROVIDERS.includes(raw.provider)) return null;
  const address = G.addressOf(raw.address);
  if (!address) return null;
  const label = str(raw.label, 40) || address;
  if (raw.provider === 'gmail') return { id: raw.id, label, provider: 'gmail', address, user: address, ...GMAIL };
  if (raw.provider === 'm365') {
    const clientId = str(raw.clientId, 40);
    const tenant = str(raw.tenant, 100) || 'common';
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) return null;
    return { id: raw.id, label, provider: 'm365', address, clientId, tenant };
  }
  // Exchange (on premises): one server for both, IMAP 993 and the client submission port 587 with STARTTLS
  const exchange = raw.provider === 'exchange';
  const host = exchange && !raw.imap && HOST_RE.test(String(raw.server || '')) ? String(raw.server) : '';
  const imap = server(raw.imap || (host ? { host } : null), { port: 993 });
  const smtp = server(raw.smtp || (host ? { host } : null), exchange ? { port: 587, security: 'starttls' } : { port: 465, security: 'tls' });
  if (!imap || !smtp) return null;
  return { id: raw.id, label, provider: exchange ? 'exchange' : 'imap', address, user: str(raw.user, 200) || address, imap, smtp };
}
const normalizeAccounts = (list) => {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) { const a = normalizeAccount(raw); if (a && !out.some((x) => x.id === a.id) && out.length < ACCOUNTS_MAX) out.push(a); }
  return out;
};
/** What state.json keeps of an account: the same fields (nothing secret exists on it). */
const accountFile = (a) => ({ ...a });

/**
 * The add / edit form → { account } | { error: 'provider' | 'address' | 'host' | 'client' | 'too-many' | 'address-used' | 'use-m365' }.
 * Exchange Online and Outlook.com addresses or hosts go to the Microsoft 365 provider (their IMAP/SMTP take OAuth only).
 * Secrets in the form are not looked at here (main stores them encrypted).
 */
function accountFromForm(list, f, newId = () => `m-${crypto.randomBytes(5).toString('hex')}`) {
  const accounts = Array.isArray(list) ? list : [];
  if (!PROVIDERS.includes(f?.provider)) return { error: 'provider' };
  const exists = typeof f.id === 'string' && accounts.some((a) => a.id === f.id);
  if (!exists && accounts.length >= ACCOUNTS_MAX) return { error: 'too-many' };
  const address = G.addressOf(f.address);
  if (!address) return { error: 'address' };
  if (accounts.some((a) => a.id !== f.id && a.address === address)) return { error: 'address-used' };
  if ((f.provider === 'exchange' || f.provider === 'imap') && ([f.server, f.imap?.host, f.smtp?.host].some((h) => MICROSOFT_HOST.test(String(h || '').trim())) || MICROSOFT_DOMAIN.test(address))) return { error: 'use-m365' };
  const account = normalizeAccount({ ...f, id: exists ? f.id : newId(), address });
  if (!account) return { error: f.provider === 'm365' ? 'client' : 'host' };
  return { account };
}

/** Accounts as a session sees them: id, label, address (no host, no user, no client id). */
const publicAccounts = (accounts, ids) => accounts.filter((a) => ids.includes(a.id)).map((a) => ({ id: a.id, label: a.label, address: a.address }));
/** An account the member may use, by id, label or address (case ignored); null otherwise. */
function accountFor(accounts, ids, key) {
  const k = String(key || '').trim().toLowerCase();
  const allowed = accounts.filter((a) => ids.includes(a.id));
  if (!k) return allowed.length === 1 ? allowed[0] : null;
  return allowed.find((a) => a.id === k || a.label.toLowerCase() === k || a.address === k) || null;
}

// ---------- the outbox

const emptyOutbox = () => ({ drafts: [] });
function normalizeOutbox(raw) {
  const drafts = (Array.isArray(raw?.drafts) ? raw.drafts : []).filter((d) => d && DRAFT_ID_RE.test(String(d.id)) && ['pending', 'sent', 'discarded', 'failed', 'sending'].includes(d.status));
  // a send cut short by a crash is not known to have gone: it comes back as failed, for the person to check
  return { drafts: drafts.map((d) => (d.status === 'sending' ? { ...d, status: 'failed', error: 'interrupted' } : d)).slice(0, KEEP) };
}
const pendingOf = (outbox) => outbox.drafts.filter((d) => d.status === 'pending');

/**
 * A model's draft into the outbox. → { outbox, draft } | { error } (checkDraft's, or 'queue-full').
 * @param {{ account: any, form: any, source?: any, staff: { id: string, name: string }, project: { id: string, name: string }, now?: number }} o
 */
function addDraft(outbox, o, newId = () => `d-${crypto.randomBytes(5).toString('hex')}`) {
  const { account, form, source = null, staff, project, now = Date.now() } = o;
  const c = G.checkDraft(form);
  if (c.error) return { error: c.error };
  if (pendingOf(outbox).length >= PENDING_MAX) return { error: 'queue-full' };
  const draft = {
    id: newId(), status: 'pending', account: account.id, from: account.address, ...c.draft,
    ...(source ? { replyTo: { id: source.id, from: G.cleanLine(source.from, 200), subject: G.cleanLine(source.subject), messageId: source.messageId || '', references: source.references || '', flags: source.flags || [] } } : {}),
    warnings: G.draftWarnings(c.draft, account.address, source),
    staffId: staff.id, staffName: staff.name, projectId: project.id, projectName: project.name, createdAt: now,
  };
  return { outbox: { drafts: [draft, ...outbox.drafts].slice(0, KEEP) }, draft };
}

/** The person's edit of a pending draft (recipients, subject, body), checked again. → { outbox, draft } | { error } */
function editDraft(outbox, id, form) {
  const d = outbox.drafts.find((x) => x.id === id);
  if (!d || d.status !== 'pending') return { error: 'unknown' };
  const c = G.checkDraft(form);
  if (c.error) return { error: c.error };
  const next = { ...d, ...c.draft, warnings: G.draftWarnings(c.draft, d.from, d.replyTo ? { from: d.replyTo.from, flags: d.replyTo.flags } : null), edited: true };
  return { outbox: { drafts: outbox.drafts.map((x) => (x.id === id ? next : x)) }, draft: next };
}

/** Moves a draft on: pending → sending → sent | failed; pending | failed → discarded; failed → pending (retry). */
function setStatus(outbox, id, status, extra = {}) {
  const d = outbox.drafts.find((x) => x.id === id);
  const ok = d && ({ sending: ['pending'], sent: ['sending'], failed: ['sending'], discarded: ['pending', 'failed'], pending: ['failed'] }[status] || []).includes(d.status);
  if (!ok) return { error: 'state' };
  const next = { ...d, status, ...extra };
  return { outbox: { drafts: outbox.drafts.map((x) => (x.id === id ? next : x)) }, draft: next };
}

/** What a session may see of its own drafts: no body of another member's draft, nothing of the outbox otherwise. */
const draftsFor = (outbox, staffId) => outbox.drafts.filter((d) => d.staffId === staffId).slice(0, 30)
  .map((d) => ({ id: d.id, status: d.status, to: d.to, subject: d.subject, createdAt: d.createdAt }));

/** Puts the person's trust in a server certificate on the account (`which`: 'imap' | 'smtp'). */
function withPin(account, which, fingerprint) {
  if (!account[which] || !PIN_RE.test(String(fingerprint))) return account;
  return { ...account, [which]: { ...account[which], pin: fingerprint } };
}

module.exports = {
  PIN_RE, withPin,
  PROVIDERS, ACCOUNTS_MAX, PENDING_MAX, GMAIL, normalizeAccount, normalizeAccounts, accountFile, accountFromForm, publicAccounts, accountFor,
  emptyOutbox, normalizeOutbox, pendingOf, addDraft, editDraft, setStatus, draftsFor,
};
