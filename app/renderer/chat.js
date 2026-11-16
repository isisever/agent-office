// Chat view (contract v3.78): a Claude Code tab shown as a conversation instead of its terminal. Main reads the
// session's transcript (src/chat.js) and hands over chat items a little at a time; a message typed here is typed into
// the tab's terminal like a prompt (chat:send), so the session, its plugin and HQ work exactly as with the terminal.
// Claude Code's own menus (approvals, /model, …) live in the terminal: the chat says so and switches with one click.
import { t } from './i18n.js';

const POLL_MS = 1000;   // while shown
const KEEP = 400;       // items kept on screen (older ones are dropped from the top)

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
 * @param {{ ptyId: string, onTerminal: () => void }} opts onTerminal: the person wants the terminal
 */
export function mountChat(el, { ptyId, onTerminal }) {
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
  el.append(banner, list, empty, h('div', { class: 'chat-form' }, input, send, term), why);
  banner.hidden = true;
  why.hidden = true;

  let shown = false;
  let timer = 0;
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
    },
    hide() {
      shown = false;
      el.hidden = true;
      window.clearInterval(timer);
    },
    /** The project's attention ('permission' shows the banner: Claude Code waits for an answer in the terminal). */
    setAttention(a) { banner.hidden = a !== 'permission'; },
    texts,
    focus() { input.focus(); },
    destroy() { shown = false; window.clearInterval(timer); el.remove(); },
  };
}
