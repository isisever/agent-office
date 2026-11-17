// Mail (contract v3.85): Microsoft 365 / Outlook.com through Microsoft Graph, no dependencies; `fetch` is passed in so
// tests run without a network (test/mail.test.cjs). Sign-in is the OAuth device code flow with the person's own app
// registration (a public client id; tenant 'common' by default): the person opens the address, types the code and
// consents; main keeps the refresh token encrypted (never in a session, the renderer or state.json). Reading uses GET
// only (never marks as read); sending (the person's click in the app) is createReply/sendMail.
'use strict';

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'offline_access User.Read Mail.Read Mail.Send';
// v3.93 an account signed in since folders came also has Mail.ReadWrite (folders and moves, for a plan the person
// approved); an older one keeps asking for SCOPES only (asking more than was consented would break its refresh)
const SCOPES_RW = `${SCOPES} Mail.ReadWrite`;
const scopesOf = (write) => (write ? SCOPES_RW : SCOPES);
const CLIENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_RE = /^(?:common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;
const ID_RE = /^[A-Za-z0-9=_+/-]{10,400}$/;   // a Graph message id

const form = (o) => new URLSearchParams(o).toString();
const validClient = (c) => CLIENT_RE.test(String(c || ''));
const validTenant = (t) => TENANT_RE.test(String(t || ''));

async function postForm(fetchFn, url, body) {
  const r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });
  let data = {};
  try { data = await r.json(); } catch { /* not json */ }
  return { status: r.status, data };
}

/** Starts the device code flow. → { deviceCode, userCode, verificationUri, interval, expiresIn } */
async function startDeviceCode(fetchFn, { clientId, tenant = 'common' }) {
  if (!validClient(clientId) || !validTenant(tenant)) throw new Error('client');
  const { status, data } = await postForm(fetchFn, `${LOGIN}/${tenant}/oauth2/v2.0/devicecode`, { client_id: clientId, scope: SCOPES_RW });
  if (status !== 200 || !data.device_code) throw Object.assign(new Error('device-code'), { detail: String(data.error_description || data.error || status).slice(0, 300) });
  return { deviceCode: data.device_code, userCode: String(data.user_code), verificationUri: String(data.verification_uri || 'https://microsoft.com/devicelogin'), interval: Math.max(2, Number(data.interval) || 5), expiresIn: Number(data.expires_in) || 900 };
}

/**
 * Polls until the person signed in (or it expires / is cancelled). → { accessToken, refreshToken, expiresAt }
 * @param {{ clientId: string, tenant?: string, deviceCode: string, interval: number, expiresIn: number, sleep?: (ms: number) => Promise<void>, cancelled?: () => boolean, now?: () => number }} o
 */
async function pollDeviceCode(fetchFn, o) {
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now || Date.now;
  const end = now() + o.expiresIn * 1000;
  let wait = o.interval * 1000;
  while (now() < end) {
    await sleep(wait);
    if (o.cancelled?.()) throw new Error('cancelled');
    const { status, data } = await postForm(fetchFn, `${LOGIN}/${o.tenant || 'common'}/oauth2/v2.0/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: o.clientId, device_code: o.deviceCode,
    });
    if (status === 200 && data.access_token) return tokensOf(data, now);
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') { wait += 5000; continue; }
    throw Object.assign(new Error(data.error === 'expired_token' ? 'expired' : data.error === 'authorization_declined' ? 'declined' : 'token'), { detail: String(data.error_description || data.error || status).slice(0, 300) });
  }
  throw new Error('expired');
}

const tokensOf = (data, now = Date.now) => ({ accessToken: String(data.access_token), refreshToken: String(data.refresh_token || ''), expiresAt: now() + (Number(data.expires_in) || 3600) * 1000 - 60000 });

/** A new access token from the refresh token. → { accessToken, refreshToken (maybe rotated), expiresAt } */
async function refresh(fetchFn, { clientId, tenant = 'common', refreshToken, write = false }, now = Date.now) {
  const { status, data } = await postForm(fetchFn, `${LOGIN}/${tenant}/oauth2/v2.0/token`, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, scope: scopesOf(write) });
  if (status !== 200 || !data.access_token) throw Object.assign(new Error('auth'), { detail: String(data.error_description || data.error || status).slice(0, 300) });
  const t = tokensOf(data, now);
  return { ...t, refreshToken: t.refreshToken || refreshToken };
}

/** @param {any} fetchFn @param {string} token @param {string} method @param {string} pathAndQuery @param {{ body?: any, prefer?: string }} [opts] */
async function api(fetchFn, token, method, pathAndQuery, opts = {}) {
  const { body, prefer } = opts;
  const r = await fetchFn(`${GRAPH}${pathAndQuery}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(prefer ? { prefer } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 202 || r.status === 204) return {};
  let data = {};
  try { data = await r.json(); } catch { /* empty */ }
  if (r.status >= 400) throw Object.assign(new Error(r.status === 401 ? 'auth' : r.status === 403 ? 'forbidden' : r.status === 404 ? 'not-found' : 'graph'), { detail: String(data?.error?.message || r.status).slice(0, 300) });
  return data;
}

const addr = (x) => (x?.emailAddress ? (x.emailAddress.name ? `${x.emailAddress.name} <${x.emailAddress.address}>` : String(x.emailAddress.address || '')) : '');

/** The signed-in mailbox's address. */
async function me(fetchFn, token) {
  const d = await api(fetchFn, token, 'GET', '/me?$select=mail,userPrincipalName');
  return String(d.mail || d.userPrincipalName || '');
}

/**
 * The newest messages of a folder (read only; the inbox when no folder id is given).
 * → [{ id, from, subject, date, seen, hasAttachments, size }]
 */
async function list(fetchFn, token, { sinceDays = 3, limit = 15, unseenOnly = false, now = new Date(), folderId = '' } = {}) {
  const since = new Date(now.getTime() - Math.max(1, Math.min(365, sinceDays)) * 86400000).toISOString();
  const filter = encodeURIComponent(`receivedDateTime ge ${since}${unseenOnly ? ' and isRead eq false' : ''}`);
  const top = Math.max(1, Math.min(100, limit));
  if (folderId && !ID_RE.test(folderId)) throw new Error('mailbox');
  const d = await api(fetchFn, token, 'GET', `/me/mailFolders/${folderId ? encodeURIComponent(folderId) : 'inbox'}/messages?$top=${top}&$filter=${filter}&$orderby=receivedDateTime%20desc&$select=id,subject,from,receivedDateTime,isRead,hasAttachments`);
  return (Array.isArray(d.value) ? d.value : []).map((m) => ({ id: String(m.id), from: addr(m.from), subject: String(m.subject || ''), date: String(m.receivedDateTime || ''), seen: m.isRead === true, hasAttachments: m.hasAttachments === true }));
}

/**
 * One message (read only). → { from, to, cc, subject, date, text, html, messageId, attachments }: the body comes as
 * Graph stores it (html or text), so main turns HTML into text with its own reader (hidden parts dropped).
 */
async function read(fetchFn, token, id) {
  if (!ID_RE.test(String(id))) throw new Error('not-found');
  const m = await api(fetchFn, token, 'GET', `/me/messages/${encodeURIComponent(id)}?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,internetMessageId`);
  let attachments = [];
  if (m.hasAttachments) {
    const a = /** @type {any} */ (await api(fetchFn, token, 'GET', `/me/messages/${encodeURIComponent(id)}/attachments?$select=name,contentType,size`).catch(() => ({ value: [] })));
    attachments = (a.value || []).slice(0, 50).map((x) => ({ name: String(x.name || 'attachment'), type: String(x.contentType || ''), size: Number(x.size) || 0 }));
  }
  return {
    from: addr(m.from), to: (m.toRecipients || []).map(addr).join(', '), cc: (m.ccRecipients || []).map(addr).join(', '),
    subject: String(m.subject || ''), date: String(m.receivedDateTime || ''), messageId: String(m.internetMessageId || ''), attachments,
    html: String(m.body?.contentType || '').toLowerCase() === 'html' ? String(m.body?.content || '') : '',
    text: String(m.body?.contentType || '').toLowerCase() === 'html' ? '' : String(m.body?.content || ''),
  };
}

const recips = (list) => list.map((address) => ({ emailAddress: { address } }));

/**
 * Sends an approved draft: a reply in its conversation (createReply → update → send) or a new message (sendMail).
 * @param {{ to: string[], cc: string[], subject: string, body: string, replyToId?: string }} d
 */
async function sendDraft(fetchFn, token, d) {
  const body = { contentType: 'Text', content: d.body };
  if (d.replyToId && ID_RE.test(d.replyToId)) {
    const draft = await api(fetchFn, token, 'POST', `/me/messages/${encodeURIComponent(d.replyToId)}/createReply`, { body: {} });
    if (!draft?.id) throw new Error('graph');
    await api(fetchFn, token, 'PATCH', `/me/messages/${encodeURIComponent(draft.id)}`, { body: { subject: d.subject, body, toRecipients: recips(d.to), ccRecipients: recips(d.cc) } });
    await api(fetchFn, token, 'POST', `/me/messages/${encodeURIComponent(draft.id)}/send`);
    return { ok: true };
  }
  await api(fetchFn, token, 'POST', '/me/sendMail', { body: { message: { subject: d.subject, body, toRecipients: recips(d.to), ccRecipients: recips(d.cc) }, saveToSentItems: true } });
  return { ok: true };
}

// ---------- v3.93 folders (read: GET; the rest only for a plan the person approved, with Mail.ReadWrite)

const WELL_KNOWN = ['inbox', 'archive', 'deleteditems', 'junkemail', 'drafts', 'sentitems', 'outbox'];
const FOLDERS_MAX = 300;
/**
 * Every mail folder, as paths ("Customers/Acme"), down to 5 levels. → [{ path, id, wellKnown, count, children }]
 * The well-known folders (inbox, deleted items, junk, …) are found by their names, whatever the mailbox's language.
 */
async function folders(fetchFn, token) {
  const known = new Map();
  await Promise.all(WELL_KNOWN.map(async (w) => {
    const f = await api(fetchFn, token, 'GET', `/me/mailFolders/${w}?$select=id`).catch(() => null);
    if (f?.id) known.set(String(f.id), w);
  }));
  const out = [];
  const sel = '$top=250&$select=id,displayName,childFolderCount,totalItemCount';
  async function walk(url, prefix, depth) {
    const d = await api(fetchFn, token, 'GET', url);
    for (const f of Array.isArray(d.value) ? d.value : []) {
      if (out.length >= FOLDERS_MAX || !ID_RE.test(String(f.id))) continue;
      const name = String(f.displayName || '').replace(/\//g, '∕').trim();
      if (!name) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      out.push({ path, id: String(f.id), wellKnown: known.get(String(f.id)) || '', count: Number(f.totalItemCount) || 0, children: Number(f.childFolderCount) || 0 });
      if (f.childFolderCount > 0 && depth < 5) await walk(`/me/mailFolders/${encodeURIComponent(f.id)}/childFolders?${sel}`, path, depth + 1);
    }
  }
  await walk(`/me/mailFolders?${sel}`, '', 1);
  return out;
}
/** A new folder under parentId (or at the top). → its id */
async function createFolder(fetchFn, token, parentId, name) {
  if (parentId && !ID_RE.test(parentId)) throw new Error('mailbox');
  const d = await api(fetchFn, token, 'POST', parentId ? `/me/mailFolders/${encodeURIComponent(parentId)}/childFolders` : '/me/mailFolders', { body: { displayName: name } });
  return String(d.id || '');
}
async function renameFolder(fetchFn, token, id, name) {
  if (!ID_RE.test(id)) throw new Error('mailbox');
  await api(fetchFn, token, 'PATCH', `/me/mailFolders/${encodeURIComponent(id)}`, { body: { displayName: name } });
}
/** Removes a folder only when Graph says it holds no mail and no folder now. → 'removed' | 'not-empty' */
async function removeEmptyFolder(fetchFn, token, id) {
  if (!ID_RE.test(id)) throw new Error('mailbox');
  const f = await api(fetchFn, token, 'GET', `/me/mailFolders/${encodeURIComponent(id)}?$select=totalItemCount,childFolderCount`);
  if (Number(f.totalItemCount) !== 0 || Number(f.childFolderCount) !== 0) return 'not-empty';
  await api(fetchFn, token, 'DELETE', `/me/mailFolders/${encodeURIComponent(id)}`);
  return 'removed';
}
/** Moves messages to a folder, one call each. → { moved: ids, missing: ids } */
async function moveMessages(fetchFn, token, ids, destId) {
  if (!ID_RE.test(destId)) throw new Error('mailbox');
  const moved = [];
  const missing = [];
  for (const id of ids) {
    if (!ID_RE.test(String(id))) { missing.push(id); continue; }
    try { await api(fetchFn, token, 'POST', `/me/messages/${encodeURIComponent(id)}/move`, { body: { destinationId: destId } }); moved.push(id); } catch (e) {
      if (e.message === 'not-found') missing.push(id); else throw e;
    }
  }
  return { moved, missing };
}

/** Is this an https page of microsoft.com or microsoftonline.com (the host itself or a subdomain)? Only such a
 *  sign-in page is opened in the browser; a look-alike host ("evilmicrosoft.com") is not. */
const isMicrosoftUrl = (url) => typeof url === 'string' && /^https:\/\/([\w-]+\.)*microsoft(online)?\.com\//i.test(url);

module.exports = { SCOPES, SCOPES_RW, folders, createFolder, renameFolder, removeEmptyFolder, moveMessages, validClient, validTenant, startDeviceCode, pollDeviceCode, refresh, me, list, read, sendDraft, ID_RE, isMicrosoftUrl };
