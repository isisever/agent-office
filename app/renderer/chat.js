// Chat view (contract v3.80): a Claude Code tab shown as a conversation instead of its terminal. Main reads the
// session's transcript (src/chat.js) and hands over chat items a little at a time; a message typed here is typed into
// the tab's terminal like a prompt (chat:send), so the session, its plugin and HQ work exactly as with the terminal.
// Claude Code's own menus (approvals, AskUserQuestion, /model, …) are drawn only in the terminal: the chat reads the open
// one off the hidden terminal's screen (src/tui-menu.mjs) and shows it as buttons that type the option's number.
import { t } from './i18n.js';
import { isFreeOption, liveStatus, openOnScreen, screenKey, mustUseTerminal } from '../src/tui-menu.mjs';
import { slashQuery, matchCommands } from '../src/slash-match.mjs';
import { withReply, quoteExcerpt, sameMessage } from '../src/chat-reply.mjs';
import { blocks as mdBlocks } from '../src/chat-md.mjs';

const POLL_MS = 400;    // while shown (a read is a stat and the bytes added since)
const KEEP = 400;       // items kept on screen (older ones are dropped from the top)
const MENU_MS = 400;    // the terminal screen is checked for an open menu this often while shown

/** @returns {any} */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.filter((x) => x !== null && x !== undefined));
  return el;
}

/** v3.80 amendment: Claude's markdown (src/chat-md.mjs) as DOM nodes; every text goes in as text, links open outside. */
function mdInline(kids) {
  return kids.map((k) => {
    if (k.t === 'text') return document.createTextNode(k.text);
    if (k.t === 'code') return h('code', { class: 'chat-icode' }, k.text);
    if (k.t === 'link') return h('a', { href: k.href, target: '_blank', rel: 'noreferrer', title: k.href }, ...mdInline(k.kids));
    return h(k.t === 'b' ? 'strong' : k.t === 'i' ? 'em' : 's', {}, ...mdInline(k.kids));
  });
}
function mdNodes(list) {
  return list.map((b) => {
    if (b.t === 'p') return h('div', { class: 'chat-p' }, ...mdInline(b.kids));
    if (b.t === 'h') return h('div', { class: `chat-h chat-h${Math.min(b.level, 4)}` }, ...mdInline(b.kids));
    if (b.t === 'pre') return h('pre', { class: 'chat-code' }, b.text);
    if (b.t === 'hr') return h('hr', { class: 'chat-hr' });
    if (b.t === 'quote') return h('blockquote', { class: 'chat-quote' }, ...mdNodes(b.blocks));
    if (b.t === 'table') {
      const row = (cells, tag) => h('tr', {}, ...cells.map((c, n) => h(tag, { style: `text-align:${b.align[n] || 'left'}` }, ...mdInline(c))));
      return h('div', { class: 'chat-table-wrap' }, h('table', { class: 'chat-table' }, h('thead', {}, row(b.head, 'th')), h('tbody', {}, ...b.rows.map((r) => row(r, 'td')))));
    }
    const attrs = b.t === 'ol' && b.start !== 1 ? { start: String(b.start) } : {};
    return h(b.t, { class: 'chat-list-md', ...attrs }, ...b.items.map((it) => h('li', {}, ...mdInline(it.kids), ...mdNodes(it.sub))));
  });
}
function mdBody(text) {
  return h('div', { class: 'chat-text chat-md' }, ...mdNodes(mdBlocks(text)));
}

/** Message text: ``` fences become code blocks, the rest keeps its line breaks (no other markdown, no HTML). */
function textBody(text) {
  const box = h('div', { class: 'chat-text' });
  const parts = String(text).split(/^```[^\n]*\n?/m);
  parts.forEach((part, n) => {
    if (!part) return;
    if (n % 2) box.append(h('pre', { class: 'chat-code' }, part.replace(/\n$/, '')));
    else box.append(h('div', { class: 'chat-p' }, part.replace(/^\n+|\n+$/g, '')));
  });
  return box;
}

/**
 * @param {HTMLElement} el the pane's chat host
 * @param {{ ptyId: string, onTerminal: () => void, screen: () => string[] }} opts onTerminal: the person wants the
 *   terminal; screen: the tab's terminal screen lines
 */
export function mountChat(el, { ptyId, onTerminal, screen }) {
  const api = window.agentOffice;
  const list = h('div', { class: 'chat-list' });
  const empty = h('p', { class: 'chat-empty dim' });
  const bannerText = h('span', {});
  const bannerBtn = h('button', { class: 'chat-banner-btn', onclick: () => onTerminal() });
  const banner = h('div', { class: 'chat-banner' }, bannerText, bannerBtn);
  const input = h('textarea', { class: 'chat-input', rows: '1' });
  const send = h('button', { class: 'chat-send', onclick: () => submit() });
  const term = h('button', { class: 'chat-term', onclick: () => onTerminal() });
  const why = h('span', { class: 'chat-why' });
  const card = h('div', { class: 'chat-menu' });
  // the "/" list above the input (Claude Code's commands for this tab, chat:commands)
  const slash = h('ul', { class: 'chat-slash', role: 'listbox' });
  slash.hidden = true;
  // the message being replied to, above the input (✕ drops it)
  const replyText = h('span', { class: 'chat-reply-text' });
  const replyBar = h('div', { class: 'chat-reply' }, h('span', { class: 'chat-reply-label' }), replyText,
    h('button', { class: 'chat-reply-x', onclick: () => replyTo('') }, '✕'));
  replyBar.hidden = true;
  let replying = '';
  // what Claude Code is doing right now (its spinner row off the terminal screen): the transcript gets a message only
  // once it is complete, so this is the live part
  const live = h('div', { class: 'chat-live' });
  live.hidden = true;
  el.append(banner, list, empty, live, card, replyBar, h('div', { class: 'chat-form' }, slash, input, send, term), why);
  card.hidden = true;
  banner.hidden = true;
  why.hidden = true;

  let shown = false;
  let timer = 0;
  let menuTimer = 0;
  let menu = null;      // the open menu (parseMenu), or null
  let menuShown = '';   // its key, as drawn
  let attention = null;
  let waitUntil = 0;    // a button was pressed: the others wait for the menu to change (or 2 s)
  let reading = false;
  let cursor = null;
  let sid;   // undefined until the first read
  const tools = new Map();   // tool call id → its line (marked done/failed by its result)

  function texts() {
    input.placeholder = t('chat.placeholder');
    send.textContent = t('chat.send');
    term.textContent = t('chat.terminal');
    term.title = t('chat.terminalTitle');
    bannerText.textContent = t('chat.permission');
    bannerBtn.textContent = t('chat.terminal');
    empty.textContent = t('chat.empty');
  }
  texts();

  function clear() { list.replaceChildren(); tools.clear(); for (const p of pending) p.n.remove(); pending.length = 0; }
  // Messages sent from here, shown at once until the transcript has that same message (its copy replaces it), as the
  // terminal shows a typed line. One sent while the boss works is queued by Claude Code, as in the terminal ("Queued"),
  // and comes when the turn takes it in. A message never matched goes once the boss has been idle for a while.
  /** @type {{ n: HTMLElement, text: string }[]} */
  const pending = [];
  let busyNow = false;
  function echo(text, queued) {
    const n = h('div', { class: `chat-msg user pending${queued ? ' queued' : ''}` }, mdBody(text), queued ? h('div', { class: 'chat-queued dim' }, t('chat.queued')) : null);
    const p = { n, text };
    pending.push(p);
    list.append(n);
    empty.hidden = true;
    list.scrollTop = list.scrollHeight;
    const expire = () => {
      if (!pending.includes(p)) return;
      if (busyNow) { setTimeout(expire, 60000); return; }   // still working: a queued message may come later
      pending.splice(pending.indexOf(p), 1);
      n.remove();
    };
    setTimeout(expire, 120000);
  }
  /** The transcript has a message: the echo that shows the same text goes (not simply the oldest one). */
  function settle(text) {
    const i = pending.findIndex((p) => sameMessage(p.text, text));
    if (i < 0) return;
    pending[i].n.remove();
    pending.splice(i, 1);
  }
  // ---- a message's own buttons (shown on hover): copy its text, reply to it
  async function copyText(text, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      // fallback: a hidden text box and the document's copy command
      const box = h('textarea', { class: 'chat-copy-buf' });
      box.value = text;
      document.body.append(box);
      box.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      box.remove();
    }
    btn.textContent = ok ? t('chat.copied') : t('chat.copyFailed');
    setTimeout(() => { btn.textContent = t('chat.copy'); }, 1200);
  }
  function message(kind, text, body) {
    const copy = h('button', { class: 'chat-act', onclick: () => copyText(String(text), copy) }, t('chat.copy'));
    const reply = h('button', { class: 'chat-act', onclick: () => replyTo(String(text)) }, t('chat.reply'));
    return h('div', { class: `chat-msg ${kind}` }, body, h('div', { class: 'chat-acts' }, copy, kind === 'error' ? null : reply));
  }
  function item(it) {
    if (it.kind === 'toolDone') {
      const line = tools.get(it.id);
      if (line) { line.classList.remove('pending'); line.classList.add(it.error ? 'failed' : 'done'); tools.delete(it.id); }
      return null;
    }
    if (it.kind === 'user') {
      const body = mdBody(it.text);
      if (it.images) body.append(h('div', { class: 'chat-images dim' }, t('chat.images', { count: it.images })));
      return message('user', it.text, body);
    }
    if (it.kind === 'assistant') return message('assistant', it.text, mdBody(it.text));
    if (it.kind === 'error') return message('error', it.text, textBody(it.text));
    if (it.kind === 'tool') {
      const line = h('div', { class: 'chat-tool pending', title: it.detail || '' }, h('span', { class: 'chat-tool-name' }, it.name), h('span', { class: 'chat-tool-detail' }, it.detail || ''));
      if (it.id) tools.set(it.id, line);
      return line;
    }
    if (it.kind === 'command') return h('div', { class: 'chat-cmd' }, it.text);
    if (it.kind === 'note') return h('div', { class: 'chat-note dim' }, t(`chat.note.${it.note}`));
    return null;
  }
  function append(items) {
    if (!items.length) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const it of items) {
      if ((it.kind === 'user' || it.kind === 'command') && pending.length) settle(it.text);
      let n = null;
      // one item that cannot be rendered must not drop the rest of the batch: it is shown as plain text
      try { n = item(it); } catch (e) {
        console.error(e);
        try { n = typeof it?.text === 'string' ? message(it.kind === 'user' ? 'user' : 'assistant', it.text, textBody(it.text)) : null; } catch (e2) { console.error(e2); }
      }
      if (n) frag.append(n);
    }
    if (pending.length) list.insertBefore(frag, pending[0].n); else list.append(frag);
    while (list.childElementCount > KEEP) list.firstElementChild.remove();
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  // ---- the open menu as a card
  // A truncated approval, a cut dialog and a dialog that reads like an approval are answered in the terminal: their
  // buttons are off (mustUseTerminal, src/tui-menu.mjs).
  async function press(steps) {
    // the card is up to MENU_MS old: the keys are typed only if what is open on the live screen (a menu or a dialog,
    // read the same way as the card) is still the one it shows
    const expect = menuShown;
    let now = null;
    try { now = openOnScreen(screen()); } catch (e) { console.error(e); }
    if (!expect || keyOf(now) !== expect || mustUseTerminal(now)) { waitUntil = 0; menu = now; menuShown = ''; drawMenu(); return; }
    waitUntil = Date.now() + 2000;
    for (const b of card.querySelectorAll('button, input')) b.disabled = true;
    let r;
    try { r = await api.chat.keys(ptyId, steps, expect); } catch (e) { console.error(e); r = 'error'; }
    if (r !== 'ok') {
      waitUntil = 0;
      menuShown = '';
      // 'stale' / 'busy': nothing was typed; the card is drawn again from the screen
      if (!['stale', 'busy'].includes(r)) note(t(`chat.why.${['not-running', 'locked'].includes(r) ? r : 'other'}`));
    }
    setTimeout(checkMenu, 300);
  }
  /** "Type something": a text box in the card; its answer is the option's number, the text, Enter. */
  function freeAnswer(o, row) {
    const box = h('input', { class: 'chat-free', type: 'text', placeholder: t('chat.freePlaceholder') });
    const go = () => { if (box.value.trim()) press([String(o.n), { text: box.value }, '\r']); };
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(); } });
    row.replaceWith(h('div', { class: 'chat-free-row' }, box, h('button', { class: 'chat-send', onclick: go }, t('chat.send'))));
    box.focus();
  }
  // v3.80 amendment: a dialog parseMenu does not read ({ dialog, lines, numbers, truncated, approval }) is shown as
  // its text with the keys; a cut one or one that reads like an approval only says "answer it in the terminal"
  const keyOf = screenKey;
  function drawDialog() {
    const keys = [...menu.numbers.map((n) => [String(n), String(n)]), ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['Enter', '\r'], [t('chat.menuCancel'), '\x1b']];
    const btns = keys.map(([label, k]) => h('button', { class: 'chat-nav', onclick: () => press([k]) }, label));
    const locked = mustUseTerminal(menu);
    if (locked) for (const b of btns) b.disabled = true;
    const cut = locked
      ? h('div', { class: 'chat-menu-cut' }, h('span', {}, t(menu.truncated ? 'chat.menuTruncated' : 'chat.permission')), h('button', { class: 'chat-banner-btn', onclick: () => onTerminal() }, t('chat.terminal')))
      : null;
    card.replaceChildren(...[h('div', { class: 'chat-menu-title' }, h('pre', { class: 'chat-dialog' }, menu.lines.join('\n'))), cut,
      h('div', { class: 'chat-menu-nav' }, ...btns)].filter(Boolean));
  }
  // the permission banner is hidden only by a menu read in full off this screen; a dialog card never hides it
  const hidesBanner = () => Boolean(menu) && !menu.dialog;
  function drawMenu() {
    const key = keyOf(menu);
    if (key === menuShown) return;
    menuShown = key;
    card.hidden = !menu;
    // the project's attention is any of its tabs: with nothing open here, the approval waits in another tab
    banner.hidden = hidesBanner() || attention !== 'permission';
    if (!menu) { card.replaceChildren(); return; }
    if (menu.dialog) { drawDialog(); if (atBottomNow()) list.scrollTop = list.scrollHeight; return; }
    const titles = menu.title.map((l, n) => h('div', { class: n === menu.title.length - 1 ? 'chat-menu-q' : 'chat-menu-ctx' }, l));
    const opts = menu.options.filter((o) => o.n <= 9).map((o) => {
      const row = h('button', { class: `chat-opt${o.checked ? ' checked' : ''}`, title: o.desc || '' },
        h('span', { class: 'chat-opt-n' }, menu.multi && o.checked !== undefined ? (o.checked ? '☑' : '☐') : String(o.n)),
        h('span', { class: 'chat-opt-label' }, o.label),
        o.desc ? h('span', { class: 'chat-opt-desc' }, o.desc) : null);
      row.addEventListener('click', () => (isFreeOption(o) && !menu.multi ? freeAnswer(o, row) : press([String(o.n)])));
      return row;
    });
    const nav = [];
    if (menu.tabs) nav.push(h('button', { class: 'chat-nav', onclick: () => press(['\x1b[D']) }, t('chat.menuBack')));
    if (menu.multi || menu.tabs) nav.push(h('button', { class: 'chat-nav', onclick: () => press(['\x1b[C']) }, t('chat.menuNext')));
    nav.push(h('button', { class: 'chat-nav', onclick: () => press(['\x1b']) }, t('chat.menuCancel')));
    // the text above the options is cut: say so; an approval is then answered in the terminal
    const cut = menu.truncated
      ? h('div', { class: 'chat-menu-cut' }, h('span', {}, t('chat.menuTruncated')), h('button', { class: 'chat-banner-btn', onclick: () => onTerminal() }, t('chat.terminal')))
      : null;
    if (mustUseTerminal(menu)) for (const b of [...opts, ...nav]) b.disabled = true;
    card.replaceChildren(...[h('div', { class: 'chat-menu-title' }, ...titles), cut, h('div', { class: 'chat-opts' }, ...opts), h('div', { class: 'chat-menu-nav' }, ...nav)].filter(Boolean));
    if (atBottomNow()) list.scrollTop = list.scrollHeight;
  }
  const atBottomNow = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  function checkMenu() {
    if (!shown) return;
    let m = null;
    try {
      m = openOnScreen(screen());
    } catch (e) { console.error(e); }
    if (keyOf(m) !== menuShown) waitUntil = 0;
    if (Date.now() < waitUntil) return;
    menu = m;
    drawMenu();
    let s = { busy: false, text: '' };
    try { s = liveStatus(screen()); } catch (e) { console.error(e); }
    busyNow = s.busy;
    live.hidden = !s.busy || Boolean(menu);
    const txt = s.text || t('chat.working');
    if (live.textContent !== txt) live.textContent = txt;
  }

  async function poll() {
    if (!shown || reading) return;
    reading = true;
    try {
      for (let n = 0; n < 20; n++) {
        const r = await api.chat.read(ptyId, cursor);
        if (!r || r.unsupported) { onTerminal(); return; }
        if (r.reset || r.sid !== sid) clear();
        sid = r.sid;
        cursor = r.cursor;
        append(r.items || []);
        if (!r.more || !shown) break;
      }
      empty.hidden = list.childElementCount > 0;
    } catch (e) { console.error(e); } finally { reading = false; }
  }

  function replyTo(text) {
    replying = text;
    replyBar.hidden = !text;
    replyBar.firstElementChild.textContent = t('chat.replyingTo');
    replyText.textContent = quoteExcerpt(text, 160);
    if (text) input.focus();
  }
  function note(text) {
    why.textContent = text;
    why.hidden = !text;
  }
  async function submit() {
    const text = input.value;
    if (!text.trim()) return;
    if (menu) { note(t('chat.why.menu')); return; }   // typed text would go into the open menu
    // a slash command is sent as typed (a quote in front would stop it being a command)
    const out = replying && !/^\s*\//.test(text) ? withReply(replying, text) : text;
    let r;
    try { r = await api.chat.send(ptyId, out); } catch (e) { console.error(e); r = 'error'; }
    if (r === 'ok') {
      let busy = busyNow;
      try { busy = liveStatus(screen()).busy; } catch { /* the last reading */ }
      echo(out, busy);
      input.value = '';
      replyTo('');
      fitInput();
      note('');
      closeSlash();
      setTimeout(poll, 150);
      // a command that opens a screen of its own (settings, pickers, panels) is answered in the terminal
      const cmd = text.trim().match(/^\/([\w:.-]+)/)?.[1];
      if (cmd && commands?.some((c) => c.name === cmd && c.ui)) setTimeout(() => onTerminal(), 400);
      return;
    }
    note(t(`chat.why.${['not-running', 'permission', 'draft', 'locked', 'too-long'].includes(r) ? r : 'other'}`));
  }
  const fitInput = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };

  // ---- "/" commands: the list loads on the first "/" (and again after 30 s), filters as the person types
  /** @type {{ name: string, description: string, source: string, ui?: boolean }[] | null} */
  let commands = null;
  let loadedAt = 0;
  /** @type {{ name: string, description: string, source: string, ui?: boolean }[]} */
  let shownCmds = [];
  let pick = 0;
  async function loadCommands() {
    if (commands && Date.now() - loadedAt < 30000) return;
    loadedAt = Date.now();
    try { commands = await api.chat.commands(ptyId); } catch { commands = commands || []; }
  }
  function closeSlash() { slash.hidden = true; shownCmds = []; }
  function drawSlash() {
    slash.replaceChildren(...shownCmds.map((c, i) => h('li', {
      class: `chat-slash-row${i === pick ? ' on' : ''}`, role: 'option',
      onmousedown: (e) => { e.preventDefault(); pick = i; complete(); },
    }, h('span', { class: 'chat-slash-name' }, `/${c.name}`), h('span', { class: 'chat-slash-desc' }, c.description || ''),
    c.source !== 'builtin' ? h('span', { class: 'chat-slash-src' }, t(`chat.slash.${c.source}`)) : null)));
    slash.hidden = !shownCmds.length;
    slash.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
  async function updateSlash() {
    const q = slashQuery(input.value, input.selectionStart ?? input.value.length);
    if (q === null) { closeSlash(); return; }
    await loadCommands();
    const again = slashQuery(input.value, input.selectionStart ?? input.value.length);
    if (again === null) { closeSlash(); return; }
    shownCmds = matchCommands(commands, again, 8);
    pick = 0;
    drawSlash();
  }
  /** The chosen command into the input, with a space for its arguments. */
  function complete() {
    const c = shownCmds[pick];
    if (!c) return;
    input.value = `/${c.name} ${input.value.replace(/^\/\S*\s?/, '')}`;
    input.setSelectionRange(c.name.length + 2, c.name.length + 2);
    closeSlash();
    fitInput();
    input.focus();
  }
  input.addEventListener('input', () => { fitInput(); note(''); updateSlash(); });
  input.addEventListener('blur', () => setTimeout(closeSlash, 150));
  input.addEventListener('keydown', (e) => {
    if (!slash.hidden && shownCmds.length && !e.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pick = (pick + (e.key === 'ArrowDown' ? 1 : -1) + shownCmds.length) % shownCmds.length; drawSlash(); return; }
      if (e.key === 'Tab') { e.preventDefault(); complete(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
      if (e.key === 'Enter' && !e.shiftKey) {
        // the typed word is already the chosen command: send it; otherwise take the choice first
        const typed = input.value.trim().slice(1);
        if (typed !== shownCmds[pick].name) { e.preventDefault(); complete(); return; }
      }
    }
    // Enter sends, Shift+Enter is a new line; not while an input method is composing (Turkish/CJK IMEs)
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === 'Escape' && replying) { e.preventDefault(); replyTo(''); }
  });

  return {
    show() {
      if (shown) return;
      shown = true;
      el.hidden = false;
      poll();
      timer = window.setInterval(poll, POLL_MS);
      checkMenu();
      menuTimer = window.setInterval(checkMenu, MENU_MS);
    },
    hide() {
      shown = false;
      el.hidden = true;
      window.clearInterval(timer);
      window.clearInterval(menuTimer);
    },
    /** The project's attention ('permission' shows the banner: Claude Code waits for an answer in the terminal). */
    setAttention(a) { attention = a; banner.hidden = hidesBanner() || a !== 'permission'; },
    texts() { texts(); menuShown = ''; drawMenu(); },
    focus() { input.focus(); },
    destroy() { shown = false; window.clearInterval(timer); window.clearInterval(menuTimer); el.remove(); },
  };
}
