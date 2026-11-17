// Chat view (contract v3.80 amendment): the markdown Claude writes, read into plain data the renderer turns into DOM
// nodes (never HTML: text stays text). Pure; the renderer imports it, tested in test/chat.test.cjs.
// Blocks: ``` fences, # headings, - / * / + and 1. lists (nested by indent), > quotes, --- rules,
// | pipe | tables |, paragraphs. Inline: `code`, **bold** / __bold__, *italic* / _italic_, ~~strike~~,
// [text](http(s) link) and bare http(s) links. Anything else is shown as typed (a mailto link too: the app opens
// only http(s) outside). Quotes and lists nest MAX_NEST deep; deeper marks stay text.

/** @typedef {{ t: 'text', text: string } | { t: 'code', text: string } | { t: 'b' | 'i' | 's', kids: Inline[] } | { t: 'link', href: string, kids: Inline[] }} Inline */
/** @typedef {{ t: 'p', kids: Inline[] } | { t: 'h', level: number, kids: Inline[] } | { t: 'pre', lang: string, text: string }
 *   | { t: 'ul' | 'ol', start?: number, items: { kids: Inline[], sub: Block[] }[] } | { t: 'quote', blocks: Block[] } | { t: 'hr' }
 *   | { t: 'table', head: Inline[][], rows: Inline[][][], align: string[] }} Block */

const SAFE_HREF = /^https?:\/\/[^\s<>"']+$/i;

/** Inline markdown → tokens. @param {string} s @returns {Inline[]} */
export function inline(s) {
  /** @type {Inline[]} */
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', text: buf }); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && /[\\`*_~[\]()#>|-]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === '`') {
      const n = s.slice(i).match(/^`+/)[0].length;
      const end = s.indexOf('`'.repeat(n), i + n);
      if (end > i) { flush(); out.push({ t: 'code', text: s.slice(i + n, end).replace(/^ (.*) $/, '$1') }); i = end + n; continue; }
    }
    if (c === '[') {
      const m = s.slice(i).match(/^\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)/);
      if (m && SAFE_HREF.test(m[2])) { flush(); out.push({ t: 'link', href: m[2], kids: inline(m[1]) }); i += m[0].length; continue; }
    }
    if (c === 'h' && /^https?:\/\//.test(s.slice(i, i + 8)) && (i === 0 || /[\s(]/.test(s[i - 1]))) {
      const m = s.slice(i).match(/^https?:\/\/[^\s<>"')\]]+/);
      if (m) { const href = m[0].replace(/[.,;:!?]+$/, ''); flush(); out.push({ t: 'link', href, kids: [{ t: 'text', text: href }] }); i += href.length; continue; }
    }
    // **bold** / __bold__ / ~~strike~~ / *italic* / _italic_ (an underscore inside a word is a word: snake_case)
    const pair = s.startsWith('**', i) ? '**' : s.startsWith('__', i) ? '__' : s.startsWith('~~', i) ? '~~' : c === '*' || c === '_' ? c : '';
    if (pair) {
      const wordy = pair[0] === '_' && i > 0 && /\w/.test(s[i - 1]);
      const end = wordy ? -1 : s.indexOf(pair, i + pair.length);
      const inner = end > i ? s.slice(i + pair.length, end) : '';
      const closesWord = pair[0] === '_' && end >= 0 && /\w/.test(s[end + pair.length] || '');
      if (inner && !/^\s|\s$/.test(inner) && !closesWord) {
        flush();
        out.push({ t: pair === '~~' ? 's' : pair.length === 2 ? 'b' : 'i', kids: inline(inner) });
        i = end + pair.length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/;
// linear on purpose ([\s\S]*, not .*: a line may hold U+2028, where .* stops and \s+ backtracks): the marker and the rest; closing #s and spaces are cut in code (headText), never by a lazy group
const HEAD = /^\s{0,3}(#{1,6})\s+([\s\S]*)$/;
const headText = (s) => {
  let e = s.length;
  while (e > 0 && /\s/.test(s[e - 1])) e--;
  while (e > 0 && s[e - 1] === '#') e--;
  while (e > 0 && /\s/.test(s[e - 1])) e--;
  return s.slice(0, e);
};
/** How deep quotes and lists nest; deeper ones stay text (a hostile message cannot overflow the stack or memory). */
export const MAX_NEST = 4;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+([\s\S]*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

/** Markdown text → blocks. @param {string} text @param {number} [depth] nesting so far (internal) @returns {Block[]} */
export function blocks(text, depth = 0) {
  const deep = depth >= MAX_NEST;   // no quote or list opens here: their lines are paragraph text
  const L = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {Block[]} */
  const out = [];
  let i = 0;
  while (i < L.length) {
    const l = L[i];
    if (!l.trim()) { i++; continue; }
    const f = l.match(FENCE);
    if (f) {
      const close = new RegExp(`^\\s{0,3}${f[1][0] === '`' ? '`' : '~'}{${f[1].length},}\\s*$`);
      const body = [];
      i++;
      while (i < L.length && !close.test(L[i])) body.push(L[i++]);
      i++;   // the closing fence (or the end)
      out.push({ t: 'pre', lang: f[2] || '', text: body.join('\n') });
      continue;
    }
    const hd = l.match(HEAD);
    if (hd) { out.push({ t: 'h', level: hd[1].length, kids: inline(headText(hd[2])) }); i++; continue; }
    if (RULE.test(l)) { out.push({ t: 'hr' }); i++; continue; }
    if (!deep && QUOTE.test(l)) {
      const body = [];
      while (i < L.length && QUOTE.test(L[i])) body.push(L[i++].match(QUOTE)[1]);
      out.push({ t: 'quote', blocks: blocks(body.join('\n'), depth + 1) });
      continue;
    }
    if (l.includes('|') && i + 1 < L.length && TABLE_SEP.test(L[i + 1])) {
      const head = cells(l);
      const align = cells(L[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : 'left'));
      const rows = [];
      i += 2;
      while (i < L.length && L[i].includes('|') && L[i].trim()) rows.push(cells(L[i++]).map(inline));
      out.push({ t: 'table', head: head.map(inline), rows, align });
      continue;
    }
    const it = deep ? null : l.match(ITEM);
    if (it) {
      const ordered = /\d/.test(it[2]);
      const base = it[1].length;
      /** @type {{ kids: Inline[], sub: Block[] }[]} */
      const items = [];
      while (i < L.length) {
        const m = L[i].match(ITEM);
        if (m && m[1].length <= base + 1 && /\d/.test(m[2]) === ordered) { items.push({ kids: inline(m[3]), sub: [] }); i++; continue; }
        // deeper lines (a nested list, a continuation) belong to the last item
        if (items.length && L[i].trim() && /^\s{2,}/.test(L[i])) {
          const sub = [];
          while (i < L.length && L[i].trim() && /^\s{2,}/.test(L[i]) && !((L[i].match(ITEM)?.[1].length ?? 99) <= base + 1)) {
            const line = L[i++];
            sub.push(line.slice(Math.min(base + 2, line.search(/\S/))));
          }
          items[items.length - 1].sub.push(...blocks(sub.join('\n'), depth + 1));
          continue;
        }
        break;
      }
      out.push(ordered ? { t: 'ol', start: Number(it[2].replace(/\D/g, '')) || 1, items } : { t: 'ul', items });
      continue;
    }
    // a paragraph: lines up to a blank line or the start of another block
    const para = [];
    while (i < L.length && L[i].trim() && !FENCE.test(L[i]) && !HEAD.test(L[i]) && (deep || (!QUOTE.test(L[i]) && !ITEM.test(L[i]))) && !RULE.test(L[i])
      && !(L[i].includes('|') && i + 1 < L.length && TABLE_SEP.test(L[i + 1]))) para.push(L[i++].trim());
    if (!para.length) { para.push(L[i++].trim()); }
    /** @type {Inline[]} */
    const kids = [];
    para.forEach((p, n) => { if (n) kids.push({ t: 'text', text: '\n' }); kids.push(...inline(p)); });
    out.push({ t: 'p', kids });
  }
  return out;
}
