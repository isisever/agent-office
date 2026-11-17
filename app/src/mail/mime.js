// Mail (contract v3.85): a small RFC 5322 / MIME reader and writer, no dependencies; tested in test/mail.test.cjs.
// Reading: headers (unfolded, RFC 2047 words decoded), the text of a message (text/plain preferred, else text/html
// turned into text with invisible parts dropped), and its attachments by name, type and size only (never their
// content). Writing: a plain-text UTF-8 message for SMTP, with every header checked for line breaks.
'use strict';
const crypto = require('crypto');

/** bytes in a charset → string (unknown charsets read as UTF-8, then Latin-1). @param {Buffer} buf */
function decodeBytes(buf, charset = 'utf-8') {
  const cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  for (const name of [cs, 'utf-8']) {
    try { return new TextDecoder(name === 'us-ascii' || name === 'ascii' ? 'utf-8' : name).decode(buf); } catch { /* next */ }
  }
  return buf.toString('latin1');
}

/** Quoted-printable → bytes. */
function fromQuotedPrintable(s, header = false) {
  const text = header ? s.replace(/_/g, ' ') : s.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) { bytes.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(...(c.charCodeAt(0) < 256 ? [c.charCodeAt(0)] : Buffer.from(c, 'utf8')));
  }
  return Buffer.from(bytes);
}

/** RFC 2047 encoded words in a header value → text. */
function decodeWords(v) {
  return String(v ?? '')
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')   // whitespace between two encoded words is dropped
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g, (_m, cs, enc, data) => {
      try { return decodeBytes(enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : fromQuotedPrintable(data, true), cs); } catch { return data; }
    });
}

/** Header block → Map(lower-case name → [values]) (unfolded, raw). */
function parseHeaders(block) {
  const out = new Map();
  const lines = String(block).replace(/\r\n/g, '\n').split('\n');
  let cur = '';
  const push = () => {
    const i = cur.indexOf(':');
    if (i > 0) {
      const k = cur.slice(0, i).trim().toLowerCase();
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(cur.slice(i + 1).trim());
    }
  };
  for (const l of lines) {
    if (/^[ \t]/.test(l) && cur) cur += ` ${l.trim()}`;
    else { if (cur) push(); cur = l; }
  }
  if (cur) push();
  return out;
}
const first = (h, k) => (h.get(k) || [])[0] || '';

/** "text/plain; charset=utf-8; name=\"a b\"" → { value, params } (RFC 2231 name*= too). */
function parseParams(v) {
  const parts = [];
  let cur = '';
  let q = false;
  for (const c of String(v ?? '')) {
    if (c === '"') q = !q;
    if (c === ';' && !q) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const params = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    let k = p.slice(0, i).trim().toLowerCase();
    let val = p.slice(i + 1).trim().replace(/^"|"$/g, '');
    if (k.endsWith('*')) {
      k = k.slice(0, -1);
      const m = val.match(/^([^']*)'[^']*'(.*)$/);
      if (m) try { val = decodeBytes(Buffer.from(decodeURIComponent(m[2]).split('').map((ch) => ch.charCodeAt(0))), m[1]); } catch { /* as is */ }
    }
    params[k] = decodeWords(val);
  }
  return { value: parts[0].trim().toLowerCase(), params };
}

/** Body bytes of one part, decoded from its transfer encoding. @param {Buffer} raw */
function decodeBody(raw, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return fromQuotedPrintable(raw.toString('latin1'));
  return raw;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', euro: '€', ccedil: 'ç', Ccedil: 'Ç', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü' };
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
});

// an element whose style hides it (a classic way to show the model text the person never sees)
const HIDDEN_STYLE = /style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|%)?\s*[;"']|opacity\s*:\s*0(?:\.0+)?\s*[;"']|max-height\s*:\s*0|height\s*:\s*0(?:px)?\s*[;"'][^"']*overflow\s*:\s*hidden)/i;

/**
 * HTML → text the person would see: head, scripts, styles, comments and elements styled invisible or `hidden` are
 * dropped (hiddenDropped tells), blocks become lines, links keep their address after the text.
 * → { text, hiddenDropped }
 */
function htmlToText(html) {
  let s = String(html ?? '');
  let hiddenDropped = false;
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(head|script|style|template|noscript|title)\b[\s\S]*?<\/\1\s*>/gi, '');
  // invisible elements, innermost first, a few rounds for nesting
  for (let round = 0; round < 6; round++) {
    let changed = false;
    s = s.replace(/<([a-z][a-z0-9]*)\b([^>]*)>((?:(?!<\1\b)[\s\S])*?)<\/\1\s*>/gi, (m, tag, attrs) => {
      if (HIDDEN_STYLE.test(attrs) || /\shidden(?:\s|=|$)/i.test(attrs) || /aria-hidden\s*=\s*["']?true/i.test(attrs)) { changed = true; hiddenDropped = true; return ''; }
      return m;
    });
    if (!changed) break;
  }
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href, inner) => {
    const t = inner.replace(/<[^>]+>/g, '').trim();
    return /^(?:https?|mailto):/i.test(href) && !t.includes(href) ? `${t} (${href})` : t;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|section|article)\s*>/gi, '\n').replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<(td|th)\b[^>]*>/gi, ' ').replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: s, hiddenDropped };
}

/** Splits a multipart body on its boundary. @param {Buffer} body → Buffer[] */
function splitParts(body, boundary) {
  const s = body.toString('latin1');
  const marker = `--${boundary}`;
  const out = [];
  let i = s.indexOf(marker);
  while (i >= 0) {
    const start = s.indexOf('\n', i);
    if (start < 0) break;
    if (s.slice(i + marker.length, i + marker.length + 2) === '--') break;
    let end = s.indexOf(`\n${marker}`, start);
    if (end < 0) end = s.length;
    const part = s.slice(start + 1, s[end - 1] === '\r' ? end - 1 : end);
    out.push(Buffer.from(part, 'latin1'));
    i = end < s.length ? end + 1 : -1;
  }
  return out;
}

/** One part (headers + body) → its pieces, depth-limited. */
function walk(raw, depth, acc) {
  const s = raw.toString('latin1');
  const sep = s.search(/\r?\n\r?\n/);
  const headBlock = sep >= 0 ? s.slice(0, sep) : s;
  const bodyStart = sep >= 0 ? sep + (s.slice(sep).match(/^\r?\n\r?\n/) || [''])[0].length : s.length;
  const h = parseHeaders(headBlock);
  const ct = parseParams(first(h, 'content-type') || 'text/plain');
  const disp = parseParams(first(h, 'content-disposition'));
  const body = Buffer.from(s.slice(bodyStart), 'latin1');
  const name = disp.params.filename || ct.params.name || '';
  if (ct.value.startsWith('multipart/') && ct.params.boundary && depth < 8) {
    for (const p of splitParts(body, ct.params.boundary)) walk(p, depth + 1, acc);
    return h;
  }
  if (ct.value === 'message/rfc822' && depth < 8) { acc.attachments.push({ name: name || 'message.eml', type: ct.value, size: body.length }); return h; }
  const isAttachment = disp.value === 'attachment' || (name && !ct.value.startsWith('text/'));
  if (isAttachment) { acc.attachments.push({ name: decodeWords(name) || 'attachment', type: ct.value, size: decodeBody(body, first(h, 'content-transfer-encoding')).length }); return h; }
  if (ct.value === 'text/plain' || ct.value === 'text/html') {
    const text = decodeBytes(decodeBody(body, first(h, 'content-transfer-encoding')), ct.params.charset);
    acc[ct.value === 'text/plain' ? 'plain' : 'html'].push(text);
  }
  return h;
}

/**
 * A whole message → { from, to, cc, subject, date, messageId, inReplyTo, references, text, hiddenDropped, attachments }.
 * @param {Buffer | string} raw
 */
function parseMessage(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const acc = { plain: [], html: [], attachments: [] };
  const h = walk(buf, 0, acc);
  let text = acc.plain.join('\n\n').trim();
  let hiddenDropped = false;
  if (!text && acc.html.length) {
    const r = htmlToText(acc.html.join('\n'));
    text = r.text;
    hiddenDropped = r.hiddenDropped;
  } else if (acc.html.length) hiddenDropped = htmlToText(acc.html.join('\n')).hiddenDropped;
  return {
    from: decodeWords(first(h, 'from')), to: decodeWords(first(h, 'to')), cc: decodeWords(first(h, 'cc')), subject: decodeWords(first(h, 'subject')),
    date: first(h, 'date'), messageId: first(h, 'message-id'), inReplyTo: first(h, 'in-reply-to'), references: first(h, 'references'),
    text, hiddenDropped, attachments: acc.attachments.slice(0, 50),
  };
}

// ---------- writing

/** A header value may never carry a line break (header injection). */
const safeHeader = (v) => { const s = String(v ?? ''); if (/[\r\n]/.test(s)) throw new Error('header'); return s; };
/** UTF-8 B-encoded word when the value is not plain ASCII. */
const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();

/**
 * A plain-text message for SMTP. → { raw: string (CRLF), messageId }
 * @param {{ from: string, to: string[], cc?: string[], subject: string, body: string, inReplyTo?: string, references?: string, date?: Date, domain?: string }} m
 */
function buildMessage(m, rand = crypto.randomBytes) {
  const domain = String(m.domain || (String(m.from).split('@')[1] || 'localhost')).replace(/[^\w.-]/g, '');
  const messageId = `<${rand(12).toString('hex')}@${domain}>`;
  const date = (m.date || new Date()).toUTCString().replace('GMT', '+0000');
  const headers = [
    `From: ${safeHeader(m.from)}`,
    `To: ${m.to.map(safeHeader).join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(safeHeader).join(', ')}`] : []),
    `Subject: ${encodeWord(safeHeader(m.subject))}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${safeHeader(m.inReplyTo)}`] : []),
    ...(m.references || m.inReplyTo ? [`References: ${safeHeader([m.references, m.inReplyTo].filter(Boolean).join(' '))}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'X-Mailer: Agent Office',
  ];
  const body = wrap76(Buffer.from(String(m.body).replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'), 'utf8').toString('base64'));
  return { raw: `${headers.join('\r\n')}\r\n\r\n${body}\r\n`, messageId };
}

module.exports = { decodeBytes, decodeWords, parseHeaders, parseParams, htmlToText, parseMessage, buildMessage, encodeWord, fromQuotedPrintable };
