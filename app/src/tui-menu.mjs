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

// v3.80 amendment: any other open dialog (one parseMenu does not read: a picker without numbers, a confirmation, a
// prompt Claude Code adds later). Claude Code puts a key hint at its foot ("Enter to confirm · Esc to cancel"), so
// the chat shows the dialog's text as it is, with the keys a person would press, instead of only "answer it in the
// terminal".
// a dialog's own hint, never the prompt's ("esc to interrupt", "shift+tab to cycle", "? for shortcuts")
const HINT_RE = /\b(?:Esc|Enter|Return)\s+to\s+(?:close|continue|submit|save|skip|dismiss|apply|accept|retry|toggle)\b|[↑↓]\S*\s+to\s+(?:navigate|select|move|choose)\b/i;
const PROMPT_RE = /^\s*[❯>](?:\s|$)/;        // the prompt box's first line (the person's draft follows the glyph)
const DIALOG_MAX = 14;                       // dialog lines kept above the hint
/**
 * The open dialog at the foot of a screen →
 * { lines: string[] (trimmed, the hint last), numbers: number[], truncated, approval } or null.
 * A dialog replaces the prompt box: its key hint is the bottom-most line of the screen, below a full-width rule.
 * Never a dialog: the person's own draft in the prompt box (a hint-like text after the prompt glyph, between two
 * rules), the footer or status line under the prompt box, and ordinary output above it.
 * truncated: not all of the dialog is in `lines` (more than DIALOG_MAX lines, or no rule above it on screen).
 * approval: it reads like a permission prompt ("Do you want …", "Yes" first). The chat answers neither a truncated
 * dialog nor an approval from the card: those are answered in the terminal.
 */
export function openDialog(lines) {
  const L = (Array.isArray(lines) ? lines : []).map((l) => String(l ?? '').replace(/\s+$/, ''));
  let foot = L.length - 1;
  while (foot >= 0 && !L[foot].trim()) foot--;
  if (foot < 0 || PROMPT_RE.test(L[foot]) || !(FOOT_RE.test(L[foot]) || HINT_RE.test(L[foot]))) return null;
  let rule = -1;
  for (let i = foot - 1; i >= 0; i--) if (RULE_RE.test(L[i])) { rule = i; break; }
  const top = rule + 1;
  // the block the hint closes starts with the prompt glyph: a draft whose box lost its lower rule, not a dialog
  let first = top;
  while (first < foot && !L[first].trim()) first++;
  if (first < foot && PROMPT_RE.test(L[first])) return null;
  // the rule above the hint is the prompt box's lower rule: the hint is the footer under the prompt box
  if (rule > 0) {
    let upper = -1;
    for (let i = rule - 1; i >= 0; i--) if (RULE_RE.test(L[i])) { upper = i; break; }
    let k = upper + 1;
    while (k < rule && !L[k].trim()) k++;
    if (upper >= 0 && (k === rule || PROMPT_RE.test(L[k]))) return null;
  }
  const from = Math.max(top, foot - DIALOG_MAX);
  const body = L.slice(from, foot + 1).filter((l) => l.trim() && !DASH_RE.test(l)).map((l) => l.trim());
  const opts = body.map((l) => OPTION_RE.exec(l)).filter(Boolean);
  const numbers = [...new Set(opts.map((m) => Number(m?.[1])).filter((n) => n >= 1 && n <= 9))];
  const approval = body.some((l) => ASK_RE.test(l)) || /^Yes\b/i.test(String(opts[0]?.[3] || ''));
  return { lines: body, numbers, truncated: rule < 0 || from > top, approval };
}

/** A stable key for a dialog (its text and whether it is cut), never equal to a menu's key. */
export const dialogKey = (d) => (d ? JSON.stringify(['dialog', d.lines, Boolean(d.truncated)]) : '');

/**
 * What is open on a screen right now: the menu parseMenu reads, else another open dialog
 * ({ dialog: true, lines, numbers, truncated, approval }), else null. The chat card and the check made right before
 * its keys are typed both read the screen with this.
 */
export function openOnScreen(lines) {
  const m = parseMenu(lines);
  if (m) return m;
  const d = openDialog(lines);
  return d ? { dialog: true, ...d } : null;
}
/** The key of what openOnScreen returned ('' for nothing): the card types only while the screen still has this key. */
export const screenKey = (m) => (m?.dialog ? dialogKey(m) : menuKey(m));
/** Must this be answered in the terminal (never from the card)? A truncated approval menu; a cut or approval-like dialog. */
export const mustUseTerminal = (m) => (m?.dialog ? Boolean(m.truncated || m.approval) : Boolean(m?.truncated) && isApproval(m));

// v3.117 a command that opens a screen of its own (/resume, /model, /mcp, …) runs in the tab's terminal; the chat comes
// back once that screen is closed: Claude Code's prompt box is on screen again (a full-width rule above its prompt
// glyph and one below it), nothing is open over it and no turn runs.
const BOX_GAP = 6;   // lines a draft may take between the prompt glyph and the box's lower rule
/** Is Claude Code's prompt box back at the foot of the screen, with no menu, dialog or running turn? */
export function promptReady(lines) {
  const L = (Array.isArray(lines) ? lines : []).map((l) => String(l ?? '').replace(/\s+$/, ''));
  if (openOnScreen(L) || liveStatus(L).busy) return false;
  for (let i = L.length - 1; i > 0; i--) {
    if (!PROMPT_RE.test(L[i])) continue;
    let up = i - 1;
    while (up >= 0 && !L[up].trim()) up--;
    if (up < 0 || !RULE_RE.test(L[up])) return false;
    for (let k = i + 1; k < L.length && k <= i + BOX_GAP; k++) if (RULE_RE.test(L[k])) return true;
    return false;
  }
  return false;
}
