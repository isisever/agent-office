// Chat view slash commands (contract v3.78 amendment): which "/" suggestions the chat input shows. Pure; the renderer
// imports it, tested in test/slash-commands.test.cjs. The list comes from main (chat:commands, src/slash-commands.js).

/**
 * The command being typed: the text starts with "/" and the caret is still in its first word. → the word after "/"
 * ('' right after the slash), or null when no list should show.
 * @param {string} text @param {number} caret
 */
export function slashQuery(text, caret = String(text).length) {
  const s = String(text);
  if (!s.startsWith('/')) return null;
  const word = s.slice(1, caret);
  return /\s/.test(word) || caret < 1 ? null : word;
}

/**
 * The best matches first: the name starts with the query, then a `plugin:` name's own part does, then the name holds
 * it, then the description does; shorter names first within each. → at most `max` commands.
 * @template {{ name: string, description?: string }} C
 * @param {C[]} list @param {string} query @returns {C[]}
 */
export function matchCommands(list, query, max = 8) {
  const q = String(query).toLowerCase();
  /** @type {[number, C][]} */
  const scored = [];
  for (const c of Array.isArray(list) ? list : []) {
    const n = c.name.toLowerCase();
    const own = n.includes(':') ? n.slice(n.lastIndexOf(':') + 1) : n;
    const score = n.startsWith(q) ? 0 : own.startsWith(q) ? 1 : n.includes(q) ? 2 : q && String(c.description || '').toLowerCase().includes(q) ? 3 : -1;
    if (score >= 0) scored.push([score, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length || a[1].name.localeCompare(b[1].name));
  return scored.slice(0, max).map(([, c]) => c);
}
