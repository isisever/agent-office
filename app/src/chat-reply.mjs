// Chat view (contract v3.80 amendment): replying to a message. The quoted message goes in front of the person's text
// as a markdown quote ("> " lines), cut to QUOTE_MAX characters, so the session sees what the answer is about.
// Pure; the renderer imports it, tested in test/chat.test.cjs.

export const QUOTE_MAX = 600;

/** The first QUOTE_MAX characters of a message, trimmed, cut at a word end with "…" when longer. */
export function quoteExcerpt(text, max = QUOTE_MAX) {
  const s = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.search(/\s\S*$/);
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/** The message sent for a reply: the quote's lines as "> …", an empty line, then the person's text. */
export function withReply(quoted, text) {
  const q = quoteExcerpt(quoted);
  if (!q) return String(text);
  return `${q.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}\n\n${String(text)}`;
}

const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/…$/, '');
/**
 * Does a message in the transcript match one the chat sent and shows until then? Whitespace aside (the terminal may
 * fold lines); a long one compared on its start (the transcript's command line is cut).
 * @param {string} a @param {string} b
 */
export function sameMessage(a, b) {
  const x = flat(a);
  const y = flat(b);
  if (!x || !y) return false;
  const n = Math.min(x.length, y.length, 190);
  return x === y || (n >= 20 && x.slice(0, n) === y.slice(0, n));
}
