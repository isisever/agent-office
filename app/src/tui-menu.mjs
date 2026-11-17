// Chat view menus (contract v3.80): pure, shared with the renderer; tested in test/tui-menu.test.mjs.
// Claude Code asks in its terminal: approvals ("Do you want to proceed? 1. Yes 2. Yes, and always … 3. No"),
// AskUserQuestion (numbered options, "Type something", checkboxes for a multi-select, a "Review your answers" step)
// and its other menus. They are never written to the transcript while open, so the chat view reads the open menu off
// the tab's (hidden) terminal screen and shows it as buttons; a button types the option's number into the tab, which
// is what a person does in the terminal (number keys pick an option in every one of these menus, Claude Code 2.1).

const OPTION_RE = /^\s*(?:❯\s*)?(\d{1,2})\.\s+(?:\[([ ✔])\]\s+)?(\S.*?)\s*$/;
const RULE_RE = /^\s*[─━]{8,}\s*$/;          // a full-width rule: above the menu's title
const DASH_RE = /^\s*[╌┄]{8,}\s*$/;          // a dashed rule inside a prompt (around a command)
const FOOT_RE = /Esc to (cancel|go back|exit)|Enter to (select|confirm)/i;
const TABS_RE = /^\s*←.*→\s*$/;              // AskUserQuestion's tab row ("←  ☐ Color  ☐ Size  ✔ Submit  →")
const REVIEW_RE = /^Ready to submit your answers\?/;
const FREE_RE = /^(Type something|Other)\b/i; // the option that takes typed text
const ASK_RE = /^(Do you want|Would you like)\b/i;   // an approval's question ("Do you want to proceed?")
const TITLE_MAX = 8;                          // title lines kept (the ones nearest the options)

/**
 * The open menu at the bottom of a terminal screen (its visible lines, top to bottom) →
 * { title: string[], truncated, options: { n, label, desc, checked? }[], cursor, multi, tabs, submitRow } or null.
 * truncated: the text above the options is not all in `title` (more than TITLE_MAX lines, or its start has scrolled
 * off the top of the screen, so no full-width rule is above it).
 * A menu is numbered options 1…n (n ≥ 2) followed, within a few lines, by Claude Code's key hint
 * ("Enter to select", "Esc to cancel"), or AskUserQuestion's review step; numbered lines anywhere else (an answer
 * listing steps) are not a menu.
 */
export function parseMenu(lines) {
  const L = (Array.isArray(lines) ? lines : []).map((l) => String(l ?? '').replace(/\s+$/, ''));
  let foot = -1;
  for (let i = L.length - 1, seen = 0; i >= 0 && seen < 4; i--) {
    if (!L[i].trim()) continue;
    seen++;
    if (FOOT_RE.test(L[i])) { foot = i; break; }
  }
  // AskUserQuestion's last step ("Review your answers … Ready to submit your answers? 1. Submit answers 2. Cancel")
  // has no hint: it is taken by its title, with the options ending the screen
  const hinted = foot >= 0;
  if (!hinted) {
    let last = L.length - 1;
    while (last >= 0 && !L[last].trim()) last--;
    if (last < 0 || !OPTION_RE.test(L[last])) return null;
    foot = last + 1;
  }
  // the menu block: options, their indented descriptions, rules and blanks, upward from the hint
  let top = foot;
  for (let i = foot - 1; i >= 0; i--) {
    const l = L[i];
    if (!l.trim() || OPTION_RE.test(l) || RULE_RE.test(l) || /^\s{3,}\S/.test(l)) { top = i; continue; }
    break;
  }
  const options = [];
  let cursor = 0;
  let submitRow = false;
  let start = -1;
  for (let i = top; i < foot; i++) {
    const l = L[i];
    const m = OPTION_RE.exec(l);
    if (m) {
      if (start < 0) start = i;
      const opt = { n: Number(m[1]), label: m[3], desc: '' };
      if (m[2] !== undefined) opt.checked = m[2] === '✔';
      if (/^\s*❯/.test(l)) cursor = opt.n;
      options.push(opt);
    } else if (/^\s+Submit$/.test(l)) submitRow = true;
    else if (options.length && l.trim() && !RULE_RE.test(l)) {
      const last = options[options.length - 1];
      last.desc = last.desc ? `${last.desc} ${l.trim()}` : l.trim();
    }
  }
  if (options.length < 2 || options.some((o, k) => o.n !== k + 1)) return null;
  // the title: the lines above the block (and indented lines above its first option), up to the full-width rule
  const title = [];
  let tabs = false;
  let ruled = false;        // the full-width rule above the title is on screen
  let truncated = false;
  for (let i = (start < 0 ? top : start) - 1; i >= 0; i--) {
    const l = L[i];
    if (RULE_RE.test(l)) { ruled = true; break; }
    if (!l.trim() || DASH_RE.test(l)) continue;
    if (TABS_RE.test(l)) { tabs = true; continue; }
    if (title.length >= TITLE_MAX) { truncated = true; break; }
    title.unshift(l.trim());
  }
  if (!truncated && !ruled && title.length) truncated = true;   // the text runs off the top of the screen
  if (!hinted && !title.some((l) => REVIEW_RE.test(l))) return null;
  return { title, truncated, options, cursor, multi: options.some((o) => 'checked' in o), tabs, submitRow };
}

/**
 * Is this menu an approval (a permission prompt: "Do you want to proceed?" with "Yes" first)? A truncated one is
 * answered in the terminal, where all of the request can be read.
 */
export function isApproval(m) {
  if (!m || m.multi || m.tabs) return false;
  const ask = String(m.title?.[m.title.length - 1] || '');
  return ASK_RE.test(ask) || /^Yes\b/i.test(String(m.options?.[0]?.label || ''));
}

/** Does this option take typed text ("Type something", "Other")? */
export const isFreeOption = (o) => FREE_RE.test(String(o?.label || '').replace(/^\[[ ✔]\]\s*/, ''));

/** A stable key for a menu (its title and labels): the card is redrawn only when the menu changes. */
export const menuKey = (m) => (m ? JSON.stringify([m.title, m.options.map((o) => [o.label, o.checked]), Boolean(m.truncated)]) : '');

// v3.80 amendment: Claude Code's live status while it works ("✻ Creating… (10s · ↓ 875 tokens · thinking)", the glyph
// cycling), above the mode line that says "esc to interrupt" (Claude Code 2.1.286, captured in a pty, 110 columns).
const SPIN_RE = /^\s*[·✢✳✶✻✽✦*]\s+(\S[^…\n]{0,60}….*?)\s*$/;
const BUSY_RE = /\besc to interrupt\b/i;
/** The terminal screen's working line → { busy, text } (text '' when the spinner row is not on screen). */
export function liveStatus(lines) {
  const ls = (lines || []).map((l) => String(l ?? ''));
  if (!ls.some((l) => BUSY_RE.test(l))) return { busy: false, text: '' };
  for (let i = ls.length - 1; i >= 0; i--) {
    const m = ls[i].match(SPIN_RE);
    if (m) return { busy: true, text: m[1].slice(0, 120) };
  }
  return { busy: true, text: '' };
}
