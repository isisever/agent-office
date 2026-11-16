// Chat view (contract v3.78): a Claude Code tab shown as a conversation instead of its terminal. Main reads the
// session's transcript (src/chat.js) and hands over chat items a little at a time; a message typed here is typed into
// the tab's terminal like a prompt (chat:send), so the session, its plugin and HQ work exactly as with the terminal.
// Claude Code's own menus (approvals, AskUserQuestion, /model, …) are drawn only in the terminal: the chat reads the open
// one off the hidden terminal's screen (src/tui-menu.mjs) and shows it as buttons that type the option's number.
import { t } from './i18n.js';
import { parseMenu, isFreeOption, menuKey } from '../src/tui-menu.mjs';

const POLL_MS = 1000;   // while shown
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
  el.append(banner, list, empty, card, h('div', { class: 'chat-form' }, input, send, term), why);
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

  function clear() { list.replaceChildren(); tools.clear(); }
  function item(it) {
    if (it.kind === 'toolDone') {
      const line = tools.get(it.id);
      if (line) { line.classList.remove('pending'); line.classList.add(it.error ? 'failed' : 'done'); tools.delete(it.id); }
      return null;
    }
    if (it.kind === 'user') {
      const body = textBody(it.text);
      if (it.images) body.append(h('div', { class: 'chat-images dim' }, t('chat.images', { count: it.images })));
      return h('div', { class: 'chat-msg user' }, body);
    }
    if (it.kind === 'assistant') return h('div', { class: 'chat-msg assistant' }, textBody(it.text));
    if (it.kind === 'error') return h('div', { class: 'chat-msg error' }, textBody(it.text));
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
    for (const it of items) { const n = item(it); if (n) frag.append(n); }
    list.append(frag);
    while (list.childElementCount > KEEP) list.firstElementChild.remove();
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  // ---- the open menu as a card
  async function press(steps) {
    waitUntil = Date.now() + 2000;
    for (const b of card.querySelectorAll('button, input')) b.disabled = true;
    let r;
    try { r = await api.chat.keys(ptyId, steps); } catch (e) { console.error(e); r = 'error'; }
    if (r !== 'ok') { waitUntil = 0; menuShown = ''; note(t(`chat.why.${['not-running', 'locked'].includes(r) ? r : 'other'}`)); }
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
  function drawMenu() {
    const key = menuKey(menu);
    if (key === menuShown) return;
    menuShown = key;
    card.hidden = !menu;
    banner.hidden = Boolean(menu) || attention !== 'permission';
    if (!menu) { card.replaceChildren(); return; }
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
    card.replaceChildren(h('div', { class: 'chat-menu-title' }, ...titles), h('div', { class: 'chat-opts' }, ...opts), h('div', { class: 'chat-menu-nav' }, ...nav));
    if (atBottomNow()) list.scrollTop = list.scrollHeight;
  }
  const atBottomNow = () => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  function checkMenu() {
    if (!shown) return;
    let m = null;
    try { m = parseMenu(screen()); } catch (e) { console.error(e); }
    if (menuKey(m) !== menuShown) waitUntil = 0;
    if (Date.now() < waitUntil) return;
    menu = m;
    drawMenu();
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

  function note(text) {
    why.textContent = text;
    why.hidden = !text;
  }
  async function submit() {
    const text = input.value;
    if (!text.trim()) return;
    if (menu) { note(t('chat.why.menu')); return; }   // typed text would go into the open menu
    let r;
    try { r = await api.chat.send(ptyId, text); } catch (e) { console.error(e); r = 'error'; }
    if (r === 'ok') { input.value = ''; fitInput(); note(''); setTimeout(poll, 300); return; }
    note(t(`chat.why.${['not-running', 'permission', 'draft', 'locked', 'too-long'].includes(r) ? r : 'other'}`));
  }
  const fitInput = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };
  input.addEventListener('input', () => { fitInput(); note(''); });
  input.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter is a new line; not while an input method is composing (Turkish/CJK IMEs)
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
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
    setAttention(a) { attention = a; banner.hidden = Boolean(menu) || a !== 'permission'; },
    texts() { texts(); menuShown = ''; drawMenu(); },
    focus() { input.focus(); },
    destroy() { shown = false; window.clearInterval(timer); window.clearInterval(menuTimer); el.remove(); },
  };
}
