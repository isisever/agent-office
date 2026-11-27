// Chat view (contract v3.80): a Claude Code tab shown as a conversation instead of its terminal. Main reads the
// session's transcript (src/chat.js) and hands over chat items a little at a time; a message typed here is typed into
// the tab's terminal like a prompt (chat:send), so the session, its plugin and HQ work exactly as with the terminal.
// Claude Code's own menus (approvals, AskUserQuestion, /model, …) are drawn only in the terminal: the chat reads the open
// one off the hidden terminal's screen (src/tui-menu.mjs) and shows it as buttons that type the option's number.
// v3.108 GUI chat: a tab that runs claude on its SDK protocol (chat:read returns `gui`) has no terminal to read: its
// permission requests, questions and plans come as data and are answered with chat:answer; Stop is chat:interrupt.
import { t, hasText } from './i18n.js';
import { micButton } from './voice.js';
import { isFreeOption, liveStatus, openOnScreen, screenKey, mustUseTerminal } from '../src/tui-menu.mjs';
import { slashQuery, matchCommands } from '../src/slash-match.mjs';
import { withReply, quoteExcerpt } from '../src/chat-reply.mjs';
import { blocks as mdBlocks } from '../src/chat-md.mjs';
import { chipInfo, addChips, dropText, withMentions, splitMentions, pickerState, modelChoices, modeChoices } from '../src/composer.mjs';
import { icon } from './studio-icons.js';
import { modelName, contextUsage, shortTokens } from '../src/studio-ux.mjs';

const POLL_MS = 400;    // while shown (a read is a stat and the bytes added since)
const KEEP = 400;       // items kept on screen (older ones are dropped from the top)
const MENU_MS = 400;    // the terminal screen is checked for an open menu this often while shown
const AGENTS_MS = 1500; // v3.115 the tab's sub-agents are listed this often while shown
const BUSY_WHY = ['task', 'asks', 'turn', 'agents', 'recent', 'permission', 'draft', 'session'];   // v3.116 chat:mode's 'busy:<why>'

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
 * @param {{ ptyId: string, onTerminal: () => void, onCommand?: (how: 'moved' | 'typed', text: string) => void, screen: () => string[], source?: { read: (cursor: any) => Promise<any> } | null }} opts
 *   onTerminal: the person wants the terminal; onCommand (v3.117): a command with a screen of its own was started in the
 *   tab's terminal ('moved': a GUI tab restarted there; 'typed'); screen: the tab's terminal screen lines; source (v3.100): another
 *   place the items come from (read answers like chat:read), shown read-only: no input, no menu buttons, no reply
 *   (renderer/remote-view.js: a session on another machine)
 */
export function mountChat(el, { ptyId, onTerminal, onCommand = () => onTerminal(), screen, source = null }) {
  const api = window.agentOffice;
  const list = h('div', { class: 'chat-list' });
  const empty = h('p', { class: 'chat-empty dim' });
  const bannerText = h('span', {});
  const bannerBtn = h('button', { class: 'chat-banner-btn', onclick: () => onTerminal() });
  const banner = h('div', { class: 'chat-banner' }, bannerText, bannerBtn);
  const input = h('textarea', { class: 'chat-input', rows: '1' });
  const sendLabel = h('span', { class: 'chat-label' });
  const send = h('button', { class: 'chat-send', onclick: () => submit() }, sendLabel, icon('arrowUp', 18));
  const term = h('button', { class: 'chat-term', onclick: () => onTerminal() });
  // v3.113 attach: the native file picker (images into the image bar in a GUI tab, every other file as @path)
  const attach = h('button', { class: 'chat-attach', type: 'button', onclick: () => { if (attach.disabled) return; attach.disabled = true; attachFiles().catch((e) => console.error(e)).finally(() => { attach.disabled = false; }); } },
    h('span', { class: 'chat-glyph' }, '📎'), icon('paperclip', 18));
  const stopLabel = h('span', { class: 'chat-label' });
  const stop = h('button', { class: 'chat-stop', onclick: () => interrupt() }, stopLabel, icon('stop', 14));
  stop.hidden = true;
  // v3.108 a GUI tab whose claude ended by itself: why (exit code, the end of its stderr) and Start again
  const endText = h('div', { class: 'chat-end-title' });
  const endPre = h('pre', { class: 'chat-dialog chat-end-text' });
  const endBtn = h('button', { class: 'chat-send', onclick: () => { endBox.hidden = true; endShown = ''; api.pty.restart(ptyId); setTimeout(poll, 500); } });
  const endBox = h('div', { class: 'chat-end' }, endText, endPre, h('div', { class: 'chat-menu-nav' }, endBtn));
  endBox.hidden = true;
  let endShown = '';
  const why = h('span', { class: 'chat-why' });
  const card = h('div', { class: 'chat-menu' });
  // the "/" list above the input (Claude Code's commands for this tab, chat:commands)
  const slash = h('ul', { class: 'chat-slash', role: 'listbox' });
  slash.hidden = true;
  // v3.109 the "@" list: the tab's project files (chat:files); the pick goes in as @path, which Claude Code attaches
  const atList = h('ul', { class: 'chat-slash chat-at', role: 'listbox' });
  atList.hidden = true;
  // v3.109 images pasted into the input: small previews above it (✕ drops one); they go with the next message
  /** @type {{ type: string, data: string }[]} */
  const images = [];
  const imgBar = h('div', { class: 'chat-images-bar' });
  imgBar.hidden = true;
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
  // v3.119 the mic: hold to talk (or click, click again); the text goes into the input
  const mic = source ? null : micButton(input, () => submit());
  // v3.121 Studio's composer: one box (.chat-composer) with the attachments above the input and a row of controls under
  // it. In the Office the box and the row are display: contents and the controls keep their one-line order (style.css);
  // the file chips, the pickers and the overflow menu are Studio's only (studio.css).
  /** @type {{ path: string, size?: number, type?: string }[]} */
  /** @type {{ path: string, size?: number, type?: string, dir?: boolean }[]} */
  let fileChips = [];
  let picks = { model: '', mode: '' };   // what this chat's pickers last set (main's gui.settings wins when it has them)
  const chipBar = h('div', { class: 'chat-chips' });
  const dropHint = h('div', { class: 'chat-drop-hint', 'aria-live': 'polite' });   // v3.121 "Drop 3 files" while dragging
  chipBar.hidden = true;
  const modelSel = h('select', { class: 'chat-pick chat-pick-model', onchange: () => setting('model', modelSel.value) });
  const modeSel = h('select', { class: 'chat-pick chat-pick-mode', onchange: () => setting('mode', modeSel.value) });
  // v3.120 Studio UX: the context the session uses (the last answer's input tokens) as a small ring
  const ctxRing = h('span', { class: 'chat-ctx', role: 'img' });
  ctxRing.hidden = true;
  // v3.120 the project's Auto-approve is on while this session runs another mode: the manager still answers
  const modeNote = h('span', { class: 'chat-pick-note' });
  modeNote.hidden = true;
  const pickers = h('span', { class: 'chat-picks chat-studio-only' }, ctxRing, modelSel, modeSel, modeNote);
  const moreTerm = h('button', { class: 'chat-more-item', type: 'button', role: 'menuitem', onclick: () => { moreMenu.hidden = true; onTerminal(); } }, icon('terminal'), h('span', {}));
  const moreMenu = h('div', { class: 'chat-more-menu', role: 'menu' }, moreTerm);
  moreMenu.hidden = true;
  const more = h('button', { class: 'chat-more', type: 'button', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); moreMenu.hidden = !moreMenu.hidden; } }, icon('more', 18));
  const closeMore = () => { moreMenu.hidden = true; };
  document.addEventListener('click', closeMore);   // removed again in destroy()
  const row = h('div', { class: 'chat-row' }, attach, mic, h('span', { class: 'chat-row-gap chat-studio-only' }), pickers,
    h('span', { class: 'chat-more-wrap chat-studio-only' }, more, moreMenu), stop, send);
  const form = h('div', { class: 'chat-form' }, slash, atList, input, row, term);
  form.hidden = Boolean(source);
  const composer = h('div', { class: 'chat-composer' }, dropHint, imgBar, chipBar, form);
  // v3.115 sub-agents: the running ones above the input (as the terminal lists them); one opens its own conversation
  // in place of the chat (read-only; ← Back returns). A paired device's chat has none (source).
  const agentBar = h('div', { class: 'chat-agents' });
  agentBar.hidden = true;
  const agentBack = h('button', { class: 'chat-nav', onclick: () => closeAgent() });
  const agentTitle = h('span', { class: 'chat-agent-title' });
  const agentState = h('span', { class: 'chat-agent-state dim' });
  const agentList = h('div', { class: 'chat-list chat-agent-list' });
  const agentEmpty = h('p', { class: 'chat-empty dim' });
  const agentView = h('div', { class: 'chat-agent-view' }, h('div', { class: 'chat-agent-head' }, agentBack, agentTitle, agentState), agentList, agentEmpty);
  agentView.hidden = true;
  // v3.118 /resume in a GUI chat tab: the project's sessions in place of the chat (search, ↑/↓, Enter; Esc closes)
  const pickBack = h('button', { class: 'chat-nav', onclick: () => closeResume() });
  const pickTitle = h('span', { class: 'chat-agent-title' });
  const pickSearch = h('input', { class: 'chat-free chat-pick-search', type: 'text' });
  const pickList = h('div', { class: 'chat-list chat-pick-list', role: 'listbox' });
  const pickEmpty = h('p', { class: 'chat-empty dim' });
  const pickWhy = h('span', { class: 'chat-why' });
  pickWhy.hidden = true;
  const picker = h('div', { class: 'chat-agent-view chat-picker' }, h('div', { class: 'chat-agent-head' }, pickBack, pickTitle), pickSearch, pickList, pickEmpty, pickWhy);
  picker.hidden = true;
  agentView.tabIndex = -1;
  agentView.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeAgent(); } });
  el.append(banner, list, empty, agentView, picker, live, card, endBox, agentBar, replyBar, composer, why);
  // v3.120 Studio UX: "jump to latest" while the list is scrolled up
  const jump = h('button', { class: 'chat-jump chat-studio-only', type: 'button', title: t('chat.jumpLatest'), 'aria-label': t('chat.jumpLatest'), onclick: () => { list.scrollTo?.({ top: list.scrollHeight, behavior: 'smooth' }); } }, icon('down', 14), h('span', {}, t('chat.jumpLatest')));
  jump.hidden = true;
  el.append(jump);
  list.addEventListener('scroll', () => { jump.hidden = list.scrollHeight - list.scrollTop - list.clientHeight < 120; }, { passive: true });
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
  /** @type {null | { asks: any[], live: { busy: boolean, text: string, tool: string }, ended?: { code: number, text: string, at: number }, settings?: { model: string, mode: string }, info?: { model: string, usage: any }, contextCap?: number }} */
  let gui = null;   // v3.108 a GUI chat tab's open requests and live line (null: a terminal tab)
  const ASK_REDRAW = '\u0000';   // askShown that matches no request: the next setGui draws the card again
  let askShown = '';   // the open request's id, as drawn
  const answered = new Set();   // requests answered here: not drawn again while main's list catches up

  function texts() {
    input.placeholder = t('chat.placeholder');
    sendLabel.textContent = t('chat.send');
    send.title = t('chat.send');
    moreTerm.lastElementChild.textContent = t('chat.terminal');
    more.title = t('chat.more');
    more.setAttribute('aria-label', t('chat.more'));
    drawPickOptions();
    term.textContent = t('chat.terminal');
    term.title = t(gui ? 'chat.gui.terminalTitle' : 'chat.terminalTitle');
    attach.title = t('chat.attach');
    attach.setAttribute('aria-label', t('chat.attach'));
    stopLabel.textContent = t('chat.gui.stop');
    endBtn.textContent = t('chat.gui.restart');
    endShown = '';
    stop.title = t('chat.gui.stopTitle');
    bannerText.textContent = t('chat.permission');
    bannerBtn.textContent = t('chat.terminal');
    empty.textContent = t('chat.empty');
    agentBack.textContent = t('chat.agents.back');
    pickBack.textContent = t('chat.agents.back');
    pickTitle.textContent = t('chat.resume.title');
    pickSearch.placeholder = t('chat.resume.search');
    pickEmpty.textContent = t('chat.resume.empty');
    agentEmpty.textContent = t('chat.agents.empty');
    agentsShown = '';
    drawAgents();
  }

  function clear() { list.replaceChildren(); tools.clear(); agentRows.clear(); pending.length = 0; }
  // messages sent from here, shown at once until the transcript has them (then the transcript's copy replaces them)
  /** @type {HTMLElement[]} */
  const pending = [];
  function echo(text, imgs = []) {
    const n = h('div', { class: 'chat-msg user pending' }, userBody(text, imgs));
    pending.push(n);
    list.append(n);
    empty.hidden = true;
    list.scrollTop = list.scrollHeight;
    setTimeout(() => { const i = pending.indexOf(n); if (i >= 0) { pending.splice(i, 1); n.remove(); } }, 120000);
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
  function message(kind, text, body, ro = false) {
    const copy = h('button', { class: 'chat-act', onclick: () => copyText(String(text), copy) }, t('chat.copy'));
    const reply = h('button', { class: 'chat-act', onclick: () => replyTo(String(text)) }, t('chat.reply'));
    // v3.120 Studio UX: a person's message can be put back in the input to edit and send again (Studio only, CSS)
    const edit = kind === 'user' && !source && !ro ? h('button', { class: 'chat-act chat-edit chat-studio-only', title: t('chat.editTitle'), onclick: () => { input.value = String(text); input.focus(); input.dispatchEvent(new Event('input')); } }, t('chat.edit')) : null;
    // v3.120 Studio UX: each code block has its own copy button in its corner
    for (const pre of body.querySelectorAll?.('pre.chat-code') || []) {
      const b = h('button', { class: 'chat-code-copy chat-studio-only', type: 'button', title: t('chat.copyCode'), onclick: (/** @type {Event} */ e) => { e.stopPropagation(); copyText(pre.firstChild?.textContent || pre.textContent || '', b); } }, t('chat.copy'));
      pre.append(b);
    }
    return h('div', { class: `chat-msg ${kind}` }, body, h('div', { class: 'chat-acts' }, copy, edit, kind === 'error' || source || ro ? null : reply));
  }
  /** One chat item → its row (or null). map: the tool rows waiting for their result; ro: no Reply (a sub-agent's view). */
  function item(it, map = tools, ro = false) {
    if (it.kind === 'toolDone') {
      const line = map.get(it.id);
      if (line?.dataset.agent) {   // v3.115 a background agent's call returns at once: its row follows the agent instead
        line.dataset.result = it.error ? 'failed' : 'done';
        map.delete(it.id);
        agentRowState(line);
      } else if (line) { line.classList.remove('pending'); line.classList.add(it.error ? 'failed' : 'done'); map.delete(it.id); }
      return null;
    }
    if (it.kind === 'user') {
      const body = userBody(it.text);
      if (it.images) body.append(h('div', { class: 'chat-images dim' }, t('chat.images', { count: it.images })));
      return message('user', it.text, body, ro);
    }
    if (it.kind === 'assistant') return message('assistant', it.text, mdBody(it.text), ro);
    if (it.kind === 'error') return message('error', it.text, textBody(it.text), ro);
    if (it.kind === 'tool') {
      // v3.109 a file the tool worked on: Show in Finder (main allows only a path inside the tab's folder)
      const reveal = it.path && !source ? h('button', { class: 'chat-reveal', title: revealLabel(), onclick: async (e) => {
        e.stopPropagation();
        let r = 'outside';
        try { r = await api.chat.reveal(ptyId, it.path); } catch (err) { console.error(err); }
        if (r === 'gone') note(t('chat.revealGone'));
        else if (r !== 'ok') note(t('chat.revealOutside'));
      } }, '⌕') : null;
      const line = h('div', { class: 'chat-tool pending', title: it.detail || '' }, h('span', { class: 'chat-tool-name' }, it.name), h('span', { class: 'chat-tool-detail' }, it.detail || ''), reveal);
      if (it.id) map.set(it.id, line);
      if (it.agent && it.id && !source) agentRow(line, it.id);
      // Studio: a click shows the call's whole detail (the row is a card that opens); the Office keeps its line as it was
      else line.addEventListener('click', () => { if (studioOn() && !window.getSelection()?.toString()) line.classList.toggle('open'); });
      return line;
    }
    if (it.kind === 'command') return h('div', { class: 'chat-cmd' }, it.text);
    if (it.kind === 'output') return message('output', it.text, h('pre', { class: 'chat-output' }, it.text), true);   // v3.117 what a command printed
    if (it.kind === 'note') return h('div', { class: 'chat-note dim' }, t(`chat.note.${it.note}`));
    return null;
  }
  function append(items) {
    if (!items.length) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const it of items) {
      // v3.121 the echo's image thumbnails move to the transcript's copy (the transcript only knows how many)
      let carry = null;
      if ((it.kind === 'user' || it.kind === 'command') && pending.length) { const old = pending.shift(); carry = old?.querySelector('.chat-sent-images') || null; old?.remove(); }
      let n = null;
      // one item that cannot be rendered must not drop the rest of the batch: it is shown as plain text
      try { n = item(it); } catch (e) {
        console.error(e);
        try { n = typeof it?.text === 'string' ? message(it.kind === 'user' ? 'user' : 'assistant', it.text, textBody(it.text)) : null; } catch (e2) { console.error(e2); }
      }
      if (n && carry && it.kind === 'user') { const count = n.querySelector('.chat-images'); if (count) count.replaceWith(carry); else n.firstElementChild?.append(carry); }
      if (n) frag.append(n);
    }
    if (pending.length) list.insertBefore(frag, pending[0]); else list.append(frag);
    while (list.childElementCount > KEEP) {
      const gone = list.firstElementChild;
      for (const [id, line] of tools) if (line === gone) tools.delete(id);   // a trimmed tool row is never marked done
      if (gone instanceof HTMLElement && gone.dataset.agent) agentRows.delete(gone.dataset.agent);
      gone.remove();
    }
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  // ---- v3.115 sub-agents
  /** @type {{ id: string, toolUseId: string, description: string, type: string, state: string, tool: string, detail: string, toolCount: number, at: number }[]} */
  let agents = [];
  let agentsShown = '';
  let agentsReading = false;
  let agentsAt = 0;
  const agentRows = new Map();   // the boss's Agent call id → its row in the chat
  let open = null;   // the sub-agent shown: { id, toolUseId, cursor, reading, tools }
  const agentOf = (toolUseId) => agents.find((a) => a.toolUseId === toolUseId) || null;
  /** An Agent call's row: clickable, with the agent's state once it is known. */
  function agentRow(line, toolUseId) {
    line.dataset.agent = toolUseId;
    line.classList.add('chat-agent-row');
    line.append(h('span', { class: 'chat-agent-badge' }));
    line.addEventListener('click', () => { if (!window.getSelection()?.toString()) openAgent(toolUseId); });
    agentRows.set(toolUseId, line);
    agentRowState(line);
  }
  function agentRowState(line) {
    const a = agentOf(line.dataset.agent || '');
    // no sub-agent file (yet, or a session from before): the call's own result decides, as for any tool
    const st = a ? a.state : line.dataset.result || 'pending';
    line.classList.toggle('pending', st === 'pending' || st === 'running');
    line.classList.toggle('running', st === 'running');
    line.classList.toggle('done', st === 'done');
    line.classList.toggle('failed', st === 'failed');
    line.classList.toggle('stopped', st === 'stopped');
    line.classList.toggle('openable', Boolean(a));
    const badge = line.querySelector('.chat-agent-badge');
    const txt = !a ? '' : st === 'running' ? (a.tool ? t('chat.agents.runningTool', { tool: a.tool, count: a.toolCount }) : t('chat.agents.running')) : t(`chat.agents.${st}`);
    if (badge && badge.textContent !== txt) badge.textContent = txt;
  }
  /** The running agents above the input; the open agent's header. */
  function drawAgents() {
    const run = agents.filter((a) => a.state === 'running');
    const key = `${run.map((a) => `${a.id}:${a.tool}:${a.toolCount}`).join('|')}#${open?.id || ''}`;
    if (key !== agentsShown) {
      agentsShown = key;
      agentBar.replaceChildren(...(run.length ? [h('span', { class: 'chat-agents-label dim' }, t('chat.agents.label', { count: run.length }))] : []),
        ...run.map((a) => h('button', { class: `chat-agent-chip${open?.id === a.id ? ' on' : ''}`, title: a.detail || a.description, onclick: () => openAgent(a.toolUseId, a.id) },
          h('span', { class: 'chat-agent-chip-name' }, a.description || a.type || a.id),
          a.tool ? h('span', { class: 'chat-agent-chip-tool dim' }, a.tool) : null)));
      agentBar.hidden = !run.length;
    }
    if (open) {
      const a = agents.find((x) => x.id === open.id);
      agentTitle.textContent = a ? `${a.description || a.id}${a.type ? ` · ${a.type}` : ''}` : open.id;
      agentState.textContent = !a ? '' : a.state === 'running' && a.tool ? t('chat.agents.runningTool', { tool: a.tool, count: a.toolCount }) : t(`chat.agents.${a.state}`);
    }
  }
  async function readAgents() {
    if (source || !api.chat.agents || agentsReading || !shown) return;
    agentsReading = true;
    try {
      const r = await api.chat.agents(ptyId);
      agents = Array.isArray(r) ? r : [];
      for (const line of agentRows.values()) agentRowState(line);
      drawAgents();
    } catch (e) { console.error(e); } finally { agentsReading = false; agentsAt = Date.now(); }
  }
  function openAgent(toolUseId, id = agentOf(toolUseId)?.id) {
    if (!id) return;
    if (open?.id !== id) {
      open = { id, toolUseId, cursor: null, reading: false, tools: new Map() };
      agentList.replaceChildren();
      agentEmpty.hidden = true;
    }
    agentView.hidden = false;
    el.classList.add('chat-in-agent');
    agentView.focus();
    agentsShown = '';
    drawAgents();
    readAgent();
  }
  function closeAgent() {
    open = null;
    agentView.hidden = true;
    agentList.replaceChildren();
    el.classList.remove('chat-in-agent');
    agentsShown = '';
    drawAgents();
    list.scrollTop = list.scrollHeight;
    input.focus();
  }
  /** The open sub-agent's transcript: what it gained since the last read (readChat with its sidechain lines). */
  async function readAgent() {
    const o = open;
    if (!o || o.reading || !shown) return;
    o.reading = true;
    try {
      for (let n = 0; n < 20; n++) {
        const r = await api.chat.agent(ptyId, o.id, o.cursor);
        if (open !== o) return;
        if (!r || r.gone) { agentEmpty.hidden = agentList.childElementCount > 0; return; }
        if (r.reset) { agentList.replaceChildren(); o.tools.clear(); }
        o.cursor = r.cursor;
        const atBottom = agentList.scrollHeight - agentList.scrollTop - agentList.clientHeight < 40;
        const frag = document.createDocumentFragment();
        for (const it of r.items || []) {
          let row = null;
          try { row = item(it, o.tools, true); } catch (e) { console.error(e); }
          if (row) frag.append(row);
        }
        agentList.append(frag);
        while (agentList.childElementCount > KEEP) agentList.firstElementChild?.remove();
        if (atBottom || r.reset) agentList.scrollTop = agentList.scrollHeight;
        if (!r.more) break;
      }
      agentEmpty.hidden = agentList.childElementCount > 0;
    } catch (e) { console.error(e); } finally { o.reading = false; }
  }
  texts();

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
    if (!shown || gui) return;   // v3.108 a GUI tab has no screen to read
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
    live.hidden = !s.busy || Boolean(menu);
    const txt = s.text || t('chat.working');
    if (live.textContent !== txt) live.textContent = txt;
  }

  async function poll() {
    if (!shown || reading) return;
    reading = true;
    try {
      for (let n = 0; n < 20; n++) {
        const r = source ? await source.read(cursor) : await api.chat.read(ptyId, cursor);
        if (!r || r.unsupported) { onTerminal(); return; }
        if (r.reset || r.sid !== sid) clear();
        sid = r.sid;
        cursor = r.cursor;
        append(r.items || []);
        setGui(r.gui || null);
        if (!r.more || !shown) break;
      }
      empty.hidden = list.childElementCount > 0;
    } catch (e) { console.error(e); } finally { reading = false; }
    // v3.115 the sub-agents every AGENTS_MS (a folder listing), the open one's conversation with every read
    if (Date.now() - agentsAt >= AGENTS_MS) readAgents();
    if (open) readAgent();
  }

  // ---- v3.108 GUI chat: the open request as a card, the live line, Stop
  function setGui(g) {
    const was = Boolean(gui);
    gui = g ? { ...g, asks: (g.asks || []).filter((a) => !answered.has(a.id)) } : null;
    drawPicks();
    if (gui && !was) { menu = null; menuShown = ''; texts(); }
    if (!gui) { if (was) { askShown = ''; card.hidden = true; card.replaceChildren(); stop.hidden = true; endBox.hidden = true; texts(); } return; }
    drawEnd(gui.ended || null);
    const first = gui.asks[0] || null;
    banner.hidden = true;   // another tab's request is no terminal dialog to open here: the badge shows it
    if ((first?.id || '') !== askShown) drawAsk(first);
    const l = gui.live;
    stop.hidden = !l.busy && !first;
    live.hidden = !l.busy || Boolean(first);
    const txt = l.text ? l.text.slice(-300).replace(/\s+/g, ' ') : l.tool ? t('chat.gui.running', { tool: l.tool }) : t('chat.working');
    if (live.textContent !== txt) live.textContent = txt;
  }
  function drawEnd(e) {
    const key = e ? `${e.at}` : '';
    if (key === endShown) return;
    endShown = key;
    endBox.hidden = !e;
    if (!e) return;
    endText.textContent = t(e.code === 0 ? 'chat.gui.ended' : 'chat.gui.endedError', { code: e.code });
    endPre.textContent = e.text || '';
    endPre.hidden = !e.text;
    if (atBottomNow()) list.scrollTop = list.scrollHeight;
  }
  async function answer(ask, a) {
    answered.add(ask.id);
    for (const b of card.querySelectorAll('button, input, textarea')) b.disabled = true;
    let r;
    try { r = await api.chat.answer(ptyId, ask.id, a); } catch (e) { console.error(e); r = 'error'; }
    // 'gone': claude withdrew it. Anything else failed: the card comes back so it can still be answered
    if (r !== 'ok' && r !== 'gone') { answered.delete(ask.id); note(t(`chat.why.${['not-running', 'locked'].includes(r) ? r : 'other'}`)); }
    // the card is drawn again from main's list: the next open request, the same one when this failed, or none.
    // ASK_REDRAW, not '': '' is also "nothing open", so an answered last card would never have been taken down
    askShown = ASK_REDRAW;
    if (r === 'ok' || r === 'gone') { const next = gui ? gui.asks.filter((x) => !answered.has(x.id)) : []; if (!next.length) drawAsk(null); }
    setTimeout(poll, 100);
  }
  /** A text box for "tell Claude what to do instead", shown on Deny / Keep planning; Enter sends it. */
  function withMessage(ask, label, allow) {
    const box = h('textarea', { class: 'chat-free', rows: '2', placeholder: t('chat.gui.denyPlaceholder') });
    const go = () => answer(ask, { allow, message: box.value });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); } });
    card.querySelector('.chat-menu-nav')?.replaceWith(h('div', { class: 'chat-free-row' }, box, h('button', { class: 'chat-send', onclick: go }, label)));
    box.focus();
  }
  function questionCard(ask) {
    /** @type {Map<string, Set<string>>} */
    const picked = new Map();
    const other = new Map();   // question → its "Other" text box
    const parts = ask.questions.map((q) => {
      picked.set(q.question, new Set());
      const rows = q.options.map((o) => {
        const row = h('button', { class: 'chat-opt', title: o.description || '' },
          h('span', { class: 'chat-opt-n' }, q.multiSelect ? '☐' : '○'), h('span', { class: 'chat-opt-label' }, o.label),
          o.description ? h('span', { class: 'chat-opt-desc' }, o.description) : null);
        row.addEventListener('click', () => {
          const set = picked.get(q.question);
          if (!q.multiSelect) { set.clear(); for (const b of row.parentElement.children) { b.classList.remove('checked'); const n = b.querySelector('.chat-opt-n'); if (n) n.textContent = '○'; } }
          if (set.has(o.label)) set.delete(o.label); else set.add(o.label);
          row.classList.toggle('checked', set.has(o.label));
          row.querySelector('.chat-opt-n').textContent = q.multiSelect ? (set.has(o.label) ? '☑' : '☐') : (set.has(o.label) ? '●' : '○');
          if (!q.multiSelect && ask.questions.length === 1) submitAnswers();   // one question, one choice: done
        });
        return row;
      });
      const box = h('input', { class: 'chat-free', type: 'text', placeholder: t('chat.gui.other') });
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitAnswers(); } });
      other.set(q.question, box);
      return h('div', { class: 'chat-question' }, q.header ? h('div', { class: 'chat-menu-ctx' }, q.header) : null,
        h('div', { class: 'chat-menu-q' }, q.question), h('div', { class: 'chat-opts' }, ...rows), box);
    });
    function submitAnswers() {
      const answers = {};
      for (const q of ask.questions) {
        const typed = other.get(q.question)?.value.trim();
        const labels = [...picked.get(q.question)];
        const a = typed || labels.join(', ');
        if (a) answers[q.question] = a;
      }
      if (Object.keys(answers).length < ask.questions.length) { note(t('chat.gui.answerAll')); return; }
      note('');
      answer(ask, { allow: true, answers });
    }
    return [...parts, h('div', { class: 'chat-menu-nav' },
      h('button', { class: 'chat-nav', onclick: () => answer(ask, { allow: false }) }, t('chat.gui.skip')),
      h('button', { class: 'chat-send', onclick: () => submitAnswers() }, t('chat.gui.submit')))];
  }
  function drawAsk(ask) {
    askShown = ask?.id || '';
    card.hidden = !ask;
    if (!ask) { card.replaceChildren(); return; }
    const more = gui && gui.asks.length > 1 ? h('div', { class: 'chat-menu-ctx' }, t('chat.gui.more', { count: gui.asks.length - 1 })) : null;
    let kids;
    if (ask.kind === 'question') kids = questionCard(ask);
    else if (ask.kind === 'plan') {
      kids = [h('div', { class: 'chat-menu-q' }, t('chat.gui.planTitle')), h('div', { class: 'chat-plan' }, mdBody(ask.plan || '')),
        h('div', { class: 'chat-menu-nav' },
          h('button', { class: 'chat-nav', onclick: () => withMessage(ask, t('chat.gui.keepPlanning'), false) }, t('chat.gui.keepPlanning')),
          h('button', { class: 'chat-send', onclick: () => answer(ask, { allow: true }) }, t('chat.gui.approvePlan')))];
    } else {
      kids = [h('div', { class: 'chat-menu-q' }, t(ask.agent ? 'chat.gui.agentWants' : 'chat.gui.wants', { tool: ask.name })),
        ask.detail ? h('pre', { class: 'chat-dialog' }, ask.detail) : null,
        h('div', { class: 'chat-menu-nav' },
          h('button', { class: 'chat-nav', onclick: () => withMessage(ask, t('chat.gui.deny'), false) }, t('chat.gui.deny')),
          h('button', { class: 'chat-send', onclick: () => answer(ask, { allow: true }) }, t('chat.gui.allow')))];
    }
    card.replaceChildren(...[more, ...kids].filter(Boolean));
    if (atBottomNow()) list.scrollTop = list.scrollHeight;
  }
  async function interrupt() {
    try { await api.chat.interrupt(ptyId); } catch (e) { console.error(e); }
    setTimeout(poll, 200);
  }

  const revealLabel = () => t(api.platform === 'darwin' ? 'chat.revealMac' : 'chat.reveal');
  // ---- v3.109 "@": files of the tab's project
  /** @type {{ path: string, insert: string }[]} */
  let atShown = [];
  let atPick = 0;
  let atSeq = 0;
  /** The "@…" word the caret is in (after a space or at the start), or null. */
  function atQuery() {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const m = /(?:^|\s)@([^\s@"]{0,200})$/.exec(before);
    return m ? m[1] : null;
  }
  function closeAt() { atList.hidden = true; atShown = []; }
  function drawAt() {
    atList.replaceChildren(...atShown.map((f, i) => h('li', {
      class: `chat-slash-row${i === atPick ? ' on' : ''}`, role: 'option',
      onmousedown: (e) => { e.preventDefault(); atPick = i; completeAt(); },
    }, h('span', { class: 'chat-slash-name' }, f.path.slice(f.path.lastIndexOf('/') + 1)), h('span', { class: 'chat-slash-desc' }, f.path))));
    atList.hidden = !atShown.length;
    atList.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
  async function updateAt() {
    const q = atQuery();
    if (q === null || !api.chat.files) { closeAt(); return; }
    const seq = ++atSeq;
    let list = [];
    try { list = await api.chat.files(ptyId, q); } catch (e) { console.error(e); }
    if (seq !== atSeq || atQuery() === null) return;   // a newer key, or the word is gone
    atShown = list || []; atPick = 0;
    drawAt();
  }
  function completeAt() {
    const f = atShown[atPick];
    if (!f) return;
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret).replace(/@[^\s@"]*$/, '');
    const after = input.value.slice(caret);
    input.value = `${before}${f.insert} ${after.replace(/^\s+/, '')}`;
    const pos = before.length + f.insert.length + 1;
    input.setSelectionRange(pos, pos);
    closeAt(); fitInput(); input.focus();
  }
  // ---- v3.109 a file dropped on the chat goes in as @path (its full path); v3.112 anywhere on the chat, not only on
  // the one-line input (a file dropped beside it made the window open the file)
  /** Full paths into the input at the caret as @path (quoted when they hold a space). */
  function insertPaths(paths) {
    if (!paths.length) return;
    const add = paths.map((p) => (/\s/.test(p) ? `@"${p.replace(/"/g, '')}"` : `@${p}`)).join(' ');
    const caret = input.selectionStart ?? input.value.length;
    const sep = caret > 0 && !/\s$/.test(input.value.slice(0, caret)) ? ' ' : '';
    input.value = `${input.value.slice(0, caret)}${sep}${add} ${input.value.slice(caret)}`;
    const pos = caret + sep.length + add.length + 1;
    input.setSelectionRange(pos, pos);
    fitInput(); input.focus();
  }
  /**
   * v3.113 the attach button: files picked in the native picker (opens in the tab's folder). In a GUI tab an image goes
   * into the image bar like a pasted one (while there is room, else as @path); every other file goes in as @path like
   * a dropped one. A terminal tab takes every file as @path (Claude Code attaches an image file itself).
   */
  async function attachFiles() {
    if (source || !api.chat.pick) return;
    const r = await api.chat.pick(ptyId, Boolean(gui));
    if (!r) { input.focus(); return; }
    const paths = Array.isArray(r.paths) ? r.paths.filter((p) => typeof p === 'string' && p) : [];
    const blobs = [];
    for (const im of Array.isArray(r.images) ? r.images : []) {
      if (images.length + imageReads.length + blobs.length >= 5) { paths.push(im.path); continue; }
      blobs.push({ blob: new Blob([im.data], { type: im.type }), path: im.path });
    }
    if (blobs.length) addImages(blobs.map((b) => b.blob), (f) => { const b = blobs.find((x) => x.blob === f); if (b) insertPaths([b.path]); });
    if (paths.length) attachPaths(paths, Array.isArray(r.dirs) ? r.dirs : []);
    else input.focus();
  }
  if (!source) {
    const dragOn = (/** @type {boolean} */ on) => el.classList.toggle('chat-drag', on);   // v3.121 Studio highlights the drop target
    el.addEventListener('dragover', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      dragOn(true);
      // v3.121 how many are coming (items are readable while dragging, files only on drop)
      const n = [...(e.dataTransfer?.items || [])].filter((i) => i.kind === 'file').length;
      dropHint.textContent = dropText(n, t);
    });
    el.addEventListener('dragleave', (e) => { if (!(e.relatedTarget instanceof Node) || !el.contains(e.relatedTarget)) dragOn(false); });
    el.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      dragOn(false);
      const files = [...(e.dataTransfer?.files || [])];
      // v3.121 a dropped folder is one chip (never expanded): the entry says what it is, a File cannot
      const dirAt = new Set([...(e.dataTransfer?.items || [])].filter((i) => i.kind === 'file')
        .map((i, k) => { try { return i.webkitGetAsEntry?.()?.isDirectory ? k : -1; } catch { return -1; } }).filter((k) => k >= 0));
      const isDirFile = (/** @type {File} */ f) => dirAt.has(files.indexOf(f));
      const pathOf = (/** @type {File} */ f) => { try { return api.pathForFile?.(f) || ''; } catch { return ''; } };
      if (!studioOn()) { const ps = files.map(pathOf).filter(Boolean); registerAttached(ps); insertPaths(ps); return; }
      // Studio: images go with the message as images (a GUI chat), every other file as a chip (sent as @path)
      const imgs = gui ? files.filter((f) => !isDirFile(f) && IMAGE_TYPES.includes(f.type)) : [];
      if (imgs.length) addImages(imgs, (f) => { const p = pathOf(f); if (p) addFiles([{ path: p, size: f.size, type: f.type }]); });
      addFiles(files.filter((f) => !imgs.includes(f)).map((f) => (isDirFile(f) ? { path: pathOf(f), dir: true } : { path: pathOf(f), size: f.size, type: f.type })).filter((f) => f.path));
    });
  }

  // ---- v3.121 Studio's composer: file chips, sent media, the model / permission pickers
  const studioOn = () => document.body.classList.contains('studio');
  /** v3.121 a chip opens in its default app or shows in Finder (main shows what would run code instead of opening it). */
  async function openChip(/** @type {string} */ p, /** @type {'open' | 'reveal'} */ how) {
    let r = 'gone';
    try { r = api.chat.openFile ? await api.chat.openFile(ptyId, p, how) : 'gone'; } catch (e) { console.error(e); }
    if (r === 'gone') note(t('chat.fileGone'));
    else if (r === 'shown') note(t('chat.fileShown'));
    else if (r === 'refused') note(t('chat.fileNotAttached'));   // not attached in this chat (an HQ or delegated prompt)
    else if (r === 'outside') note(t('chat.revealOutside'));
  }
  /** v3.121 a chip's context menu: Open, Show in Finder, and Remove for a chip that is not sent yet. */
  function chipMenu(/** @type {MouseEvent} */ e, /** @type {string} */ p, /** @type {(() => void) | null} */ onRemove) {
    e.preventDefault(); e.stopPropagation();
    document.querySelector('.chat-chip-menu')?.remove();
    const item = (/** @type {string} */ label, /** @type {() => void} */ run) => h('button', { class: 'chat-more-item', type: 'button', onclick: () => { m.remove(); run(); } }, label);
    const m = h('div', { class: 'chat-chip-menu chat-more-menu', role: 'menu' },
      item(t('chat.fileOpen'), () => openChip(p, 'open')), item(revealLabel(), () => openChip(p, 'reveal')),
      onRemove ? item(t('chat.fileRemove'), onRemove) : null);
    m.style.left = `${e.clientX}px`; m.style.top = `${e.clientY}px`;
    document.body.append(m);
    const close = (/** @type {Event} */ ev) => { if (!(ev.target instanceof Node) || !m.contains(ev.target)) { m.remove(); window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', close, true); } };
    setTimeout(() => { window.addEventListener('pointerdown', close, true); window.addEventListener('keydown', close, true); });
  }
  /** v3.121 an image in the image bar, larger, over the chat; a click or Escape closes it. */
  function previewImage(/** @type {string} */ src) {
    const o = h('div', { class: 'chat-preview', role: 'dialog', 'aria-label': t('chat.imageAlt'), tabindex: '-1', onclick: () => o.remove(), onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { e.stopPropagation(); o.remove(); } } },
      h('img', { src, alt: t('chat.imageAlt') }));
    document.body.append(o);
    o.focus();
  }
  /** A file chip: kind icon, name, size (or extension); ✕ when it can be removed. A click opens it, a right click has the menu. */
  function fileChip(/** @type {{ path: string, size?: number, type?: string, dir?: boolean }} */ f, /** @type {(() => void) | null} */ onRemove = null) {
    const c = chipInfo(f);
    return h('span', { class: `chat-file-chip kind-${c.kind}`, title: f.path, role: 'button', tabindex: '0',
      onclick: (/** @type {MouseEvent} */ e) => { if (!(e.target instanceof Element) || !e.target.closest('.chat-image-x')) openChip(f.path, 'open'); },
      onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openChip(f.path, 'open'); },
      oncontextmenu: (/** @type {MouseEvent} */ e) => chipMenu(e, f.path, onRemove) },
      h('span', { class: 'chat-file-icon' }, icon('file', 16)),
      h('span', { class: 'chat-file-text' }, h('span', { class: 'chat-file-name' }, c.name), c.meta ? h('span', { class: 'chat-file-meta' }, c.meta) : null),
      onRemove ? h('button', { class: 'chat-image-x', type: 'button', title: t('chat.fileRemove'), 'aria-label': t('chat.fileRemove'), onclick: onRemove }, '✕') : null);
  }
  function drawChips() {
    chipBar.replaceChildren(...fileChips.map((f) => fileChip(f, () => { fileChips = fileChips.filter((x) => x.path !== f.path); drawChips(); input.focus(); })),
      fileChips.length > 1 ? h('button', { class: 'chat-chips-clear', type: 'button', onclick: () => { fileChips = []; drawChips(); input.focus(); } }, t('chat.fileClear')) : '');
    chipBar.hidden = !fileChips.length;
  }
  /** v3.121 tells main which files the person dropped or pasted here: only attached files open from a chip. */
  function registerAttached(/** @type {string[]} */ paths) {
    const list = paths.filter((p) => typeof p === 'string' && p);
    if (list.length && api.chat.attach) api.chat.attach(ptyId, list).catch((/** @type {unknown} */ e) => console.error(e));
  }
  function addFiles(/** @type {{ path: string, size?: number, type?: string }[]} */ list) {
    registerAttached(list.map((f) => f.path));
    fileChips = addChips(fileChips, list);
    drawChips();
    input.focus();
  }
  /** Files from the picker or the clipboard: chips in Studio, @path in the input in the Office. */
  function attachPaths(/** @type {string[]} */ paths, /** @type {string[]} */ dirs = []) {
    if (studioOn() && !source) addFiles(paths.map((p) => (dirs.includes(p) ? { path: p, dir: true } : { path: p })));
    else { registerAttached(paths); insertPaths(paths); }
  }
  /** A person's message: its text, then (Studio) the images sent with it and the files it mentions as chips. */
  function userBody(/** @type {string} */ text, /** @type {{ type: string, data: string }[]} */ imgs = []) {
    const split = studioOn() ? splitMentions(text) : { text, files: [] };
    const body = mdBody(split.text);
    if (imgs.length) body.append(h('div', { class: 'chat-sent-images' }, ...imgs.map((im) => h('img', { src: `data:${im.type};base64,${im.data}`, alt: t('chat.imageAlt') }))));
    if (split.files.length) body.append(h('div', { class: 'chat-sent-files' }, ...split.files.map((p) => fileChip({ path: p }))));
    return body;
  }
  function drawPickOptions() {
    drawModelOptions(true);
    drawModeOptions(true);
    drawPicks();
  }
  /** v3.120 the account's reported modes (modeChoices); bypassPermissions is never offered: it only shows the mode of a
   * session started with skip permissions. A mode with no text of its own shows its name. */
  function drawModeOptions(force = false) {
    const list = modeChoices(gui);
    const sig = list.join(',');
    if (!force && modeSel.dataset.sig === sig) return;
    modeSel.dataset.sig = sig;
    const label = (/** @type {string} */ m) => (hasText(`chat.pick.mode.${m}`) ? t(`chat.pick.mode.${m}`) : m);
    modeSel.replaceChildren(...list.map((m) => h('option', { value: m }, label(m))),
      h('option', { value: 'bypassPermissions', disabled: true, hidden: true }, t('chat.pick.mode.bypassPermissions')));
  }
  /** v3.120 Studio UX: the model options are the models the session reported (modelChoices); redrawn when they change. */
  function drawModelOptions(force = false) {
    const list = modelChoices(gui);
    const sig = list.map((m) => `${m.value}\u0001${m.label}`).join('\u0002');
    if (!force && modelSel.dataset.sig === sig) return;
    modelSel.dataset.sig = sig;
    modelSel.replaceChildren(...list.map((m) => h('option', { value: m.value, title: m.description }, m.label || t(`chat.pick.model.${m.value || 'start'}`))));
  }
  function drawPicks() {
    drawModelOptions();
    drawModeOptions();
    const st = pickerState(gui, gui?.settings || picks);
    if (modelSel.value !== st.model) modelSel.value = st.model;
    if (modeSel.value !== st.mode) modeSel.value = st.mode;
    modelSel.disabled = !st.enabled;
    modeSel.disabled = !st.modeEnabled;   // also a skip-permissions or desk session's mode (st.lock)
    const why = st.why ? ` · ${t(`chat.pick.why.${st.why}`)}` : '';
    modelSel.title = `${t('chat.pick.modelTitle')}${why}`;
    // v3.120 Studio UX: the '' option names the model the session really runs (system init, then each answer)
    const running = modelName(gui?.info?.model);
    const first = modelSel.options[0];
    if (first) first.textContent = running || t('chat.pick.model.start');
    const ctx = contextUsage(gui?.info?.usage, gui?.info?.model, gui?.contextCap);
    ctxRing.hidden = !ctx;
    if (ctx) {
      const c = 2 * Math.PI * 7;
      const dash = `${((ctx.pct / 100) * c).toFixed(2)} ${c.toFixed(2)}`;
      if (ctxRing.dataset.dash !== dash) {
        ctxRing.dataset.dash = dash;
        ctxRing.innerHTML = `<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><circle cx="9" cy="9" r="7" class="chat-ctx-bg"/><circle cx="9" cy="9" r="7" class="chat-ctx-fg" stroke-dasharray="${dash}" transform="rotate(-90 9 9)"/></svg>`;
      }
      ctxRing.classList.toggle('high', ctx.pct >= 80);
      ctxRing.title = t('chat.context', { used: shortTokens(ctx.used), limit: shortTokens(ctx.limit), pct: ctx.pct });
      ctxRing.setAttribute('aria-label', ctxRing.title);
    }
    modeSel.title = `${t('chat.pick.modeTitle')}${st.lock ? ` · ${t(`chat.pick.why.${st.lock}`)}` : why}`;
    modeNote.hidden = !st.managerNote;
    if (st.managerNote) { modeNote.textContent = t('chat.pick.managerNote'); modeNote.title = t('chat.pick.managerNoteTitle'); }
  }
  async function setting(/** @type {'model' | 'mode'} */ key, /** @type {string} */ value) {
    let r = 'error';
    try { r = api.chat.setting ? await api.chat.setting(ptyId, key, value) : 'not-running'; } catch (e) { console.error(e); }
    if (r === 'ok') { picks = { ...picks, [key]: value }; if (gui) gui.settings = { model: '', mode: '', ...(gui.settings || {}), [key]: value }; note(''); }
    else {
      // claude's own error text when it refused; the pickers go back to what runs (drawPicks reads the unchanged state)
      const detail = typeof r === 'string' && r.startsWith('error:') ? ` (${r.slice(6)})` : '';
      note(`${t(`chat.pick.failed.${['busy', 'not-running'].includes(r) ? r : 'other'}`)}${detail}`);
    }
    drawPicks();
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
  function drawImages() {
    imgBar.replaceChildren(...images.map((im, i) => h('span', { class: 'chat-image-chip' },
      h('img', { src: `data:${im.type};base64,${im.data}`, alt: t('chat.imageAlt'), onclick: () => { if (studioOn()) previewImage(`data:${im.type};base64,${im.data}`); } }),
      h('button', { class: 'chat-image-x', title: t('chat.imageRemove'), onclick: () => { images.splice(i, 1); drawImages(); input.focus(); } }, '✕'))));
    imgBar.hidden = !images.length;
  }
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const B64_MAX = 5 * 1024 * 1024;   // the API's limit, on the base64 text (main checks the same)
  const EDGE_MAX = 8000;             // the API's largest side
  const readUrl = (blob) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result || '')); r.onerror = () => bad(r.error); r.readAsDataURL(blob); });
  const b64 = (url) => url.slice(url.indexOf(',') + 1);
  /** An image as it goes out: as it is when within the API's limits, else scaled down (long side 2000 px, JPEG). */
  async function prepare(f) {
    const url = await readUrl(f);
    let bmp = null;
    try { bmp = await window.createImageBitmap(f); } catch { return null; }
    const big = Math.max(bmp.width, bmp.height);
    if (b64(url).length <= B64_MAX && big <= EDGE_MAX) { bmp.close?.(); return { type: f.type, data: b64(url) }; }
    const k = Math.min(1, 2000 / big);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const data = b64(c.toDataURL('image/jpeg', 0.85));
    return data.length <= B64_MAX ? { type: 'image/jpeg', data } : null;
  }
  /** @type {Promise<void>[]} */
  const imageReads = [];   // pastes still being read: a message waits for them
  /** Images (File or Blob) into the bar above the input, at most 5 with those still being read. */
  function addImages(files, onFail) {
    for (const f of files) {
      if (images.length + imageReads.length >= 5) { note(t('chat.why.too-many-images')); break; }
      if (!IMAGE_TYPES.includes(f.type)) { note(t('chat.why.image-type')); continue; }
      const job = prepare(f).then((im) => {
        if (!im) { if (onFail) onFail(f); else note(t('chat.why.image-size')); }
        else if (images.length < 5) { images.push(im); drawImages(); }
      }).catch((err) => { console.error(err); if (onFail) onFail(f); else note(t('chat.why.image-type')); })
        .finally(() => { imageReads.splice(imageReads.indexOf(job), 1); });
      imageReads.push(job);
    }
  }
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;   // text: the input's own paste
    if (!(e.clipboardData?.getData('text/plain') || '').trim()) e.preventDefault();
    addImages(files);
  });
  /**
   * v3.112 the menu's Paste (⌘V) with the input focused, before the browser's own paste: files copied in Finder go in
   * as @path (the browser's paste sees only their names); an image is read with the async clipboard API, since the
   * browser's paste event does not always carry it. → true when handled here, false: the normal paste goes on.
   */
  async function pasteFromMenu() {
    if (source || document.activeElement !== input) return false;
    let clip = null;
    try { clip = await api.clipboard.read(); } catch (e) { console.error(e); return false; }
    if (Array.isArray(clip?.files) && clip.files.length) { attachPaths(clip.files.filter((p) => typeof p === 'string' && p)); return true; }
    // text with an image (spreadsheet cells, rich text): the normal paste keeps the text and adds the image
    if (!clip?.hasImage || (typeof clip.text === 'string' && clip.text.trim())) return false;
    try {
      const blobs = [];
      for (const it of await navigator.clipboard.read()) {
        const type = it.types.find((x) => IMAGE_TYPES.includes(x));
        if (type) blobs.push(await it.getType(type));
      }
      if (!blobs.length) return false;
      addImages(blobs);
      return true;
    } catch (e) { console.error(e); return false; }
  }
  async function submit() {
    if (imageReads.length) await Promise.all(imageReads.slice());   // an image pasted a moment ago goes with this message
    const text = input.value;
    const files = fileChips.map((f) => f.path);
    if (!text.trim() && !images.length && !files.length) return;
    if (menu && !gui) { note(t('chat.why.menu')); return; }   // typed text would go into the open menu
    // a slash command is sent as typed (a quote in front would stop it being a command)
    const out = withMentions(replying && !/^\s*\//.test(text) ? withReply(replying, text) : text, files);
    // v3.117 a command with a screen of its own (/resume, /model, /mcp, …) runs in the tab's terminal; the chat comes back
    // when that screen is closed (app.js watches it)
    const cmd = files.length ? undefined : text.trim().match(/^\/([\w:.-]+)/)?.[1];
    if (cmd === 'resume' && gui && !images.length && api.chat.sessions) { openResume(text.trim().slice(7).trim()); return; }   // v3.118
    if (cmd && !images.length) await loadCommands();
    if (cmd && !images.length && commands?.some((c) => c.name === cmd && c.ui)) { await runCommand(text.trim()); return; }
    let r;
    const sent = images.slice();
    try { r = await api.chat.send(ptyId, out, sent); } catch (e) { console.error(e); r = 'error'; }
    if (r === 'ok') {
      if (studioOn()) echo(out, sent);
      else echo(sent.length ? `${out}${out.trim() ? '\n\n' : ''}${t('chat.images', { count: sent.length })}` : out);
      images.length = 0; drawImages();
      fileChips = []; drawChips();   // only after a send that worked: a failed one keeps them
      input.value = '';
      replyTo('');
      fitInput();
      note('');
      closeSlash();
      setTimeout(poll, 150);
      return;
    }
    note(t(`chat.why.${['not-running', 'permission', 'draft', 'locked', 'too-long', 'too-many-images', 'image-type', 'image-size', 'image-save'].includes(r) ? r : 'other'}`));
  }
  // ---- v3.118 /resume without the terminal
  /** @type {{ id: string, title: string, prompt: string, branch: string, at: number, size: number }[]} */
  let sessions = [];
  /** @type {typeof sessions} */
  let pickShown = [];
  let pickAt = 0;
  let resuming = false;
  async function openResume(query) {
    input.value = ''; replyTo(''); fitInput(); note(''); closeSlash(); closeAt();
    picker.hidden = false;
    el.classList.add('chat-in-picker');
    pickSearch.value = query;
    pickWhy.hidden = true;
    pickEmpty.hidden = true;
    pickList.replaceChildren();
    pickSearch.focus();
    try { sessions = await api.chat.sessions(ptyId) || []; } catch (e) { console.error(e); sessions = []; }
    drawResume();
  }
  function closeResume() {
    picker.hidden = true;
    el.classList.remove('chat-in-picker');
    input.focus();
  }
  function drawResume() {
    const q = pickSearch.value.trim().toLowerCase();
    pickShown = q ? sessions.filter((s) => `${s.title} ${s.prompt} ${s.branch}`.toLowerCase().includes(q)) : sessions;
    pickAt = Math.min(pickAt, Math.max(0, pickShown.length - 1));
    pickList.replaceChildren(...pickShown.map((s, i) => h('button', {
      class: `chat-pick-row${i === pickAt ? ' on' : ''}`, role: 'option', onclick: () => { pickAt = i; resumeOne(); },
    }, h('span', { class: 'chat-pick-title' }, s.title || s.prompt),
    s.title && s.prompt ? h('span', { class: 'chat-pick-prompt dim' }, s.prompt) : null,
    h('span', { class: 'chat-pick-meta dim' }, [new Date(s.at).toLocaleString(), s.branch].filter(Boolean).join(' · ')))));
    pickEmpty.hidden = pickShown.length > 0;
    pickList.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
  async function resumeOne() {
    const s = pickShown[pickAt];
    if (!s || resuming) return;
    resuming = true;
    let r;
    try { r = await api.chat.resume(ptyId, s.id); } catch (e) { console.error(e); r = 'error'; } finally { resuming = false; }
    if (r === 'moved') { closeResume(); clear(); cursor = null; sid = undefined; empty.hidden = true; setTimeout(poll, 800); return; }
    const why = String(r).startsWith('busy:') ? String(r).slice(5) : '';
    pickWhy.textContent = why && BUSY_WHY.includes(why) ? t(`chat.gui.busyWhy.${why}`) : t(r === 'gone' ? 'chat.resume.gone' : `chat.why.${['not-running', 'locked'].includes(r) ? r : 'other'}`);
    pickWhy.hidden = false;
  }
  pickSearch.addEventListener('input', () => { pickAt = 0; drawResume(); });
  picker.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); closeResume(); }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && pickShown.length) { e.preventDefault(); pickAt = (pickAt + (e.key === 'ArrowDown' ? 1 : -1) + pickShown.length) % pickShown.length; drawResume(); }
    else if (e.key === 'Enter') { e.preventDefault(); resumeOne(); }
  });

  /** v3.117 a command with a screen of its own: a GUI tab moves to its terminal (main types it there once claude is idle), a terminal tab takes it as typed; the view follows (onCommand). */
  async function runCommand(text) {
    let r;
    try {
      r = gui ? await api.chat.command(ptyId, text) : 'terminal';
      // a terminal tab (or one that just went to its terminal): sent like any message, with chat:send's refusals
      if (r === 'terminal') r = await api.chat.send(ptyId, text);
    } catch (e) { console.error(e); r = 'error'; }
    if (r === 'moved' || r === 'typed' || r === 'ok') {
      input.value = ''; replyTo(''); fitInput(); note(''); closeSlash();
      onCommand(r === 'moved' ? 'moved' : 'typed', text);
      return;
    }
    const why = String(r).startsWith('busy:') ? String(r).slice(5) : '';
    note(why && BUSY_WHY.includes(why) ? t(`chat.gui.busyWhy.${why}`)
      : t(`chat.why.${['not-running', 'permission', 'draft', 'locked', 'too-long'].includes(r) ? r : 'other'}`));
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
  input.addEventListener('input', () => { fitInput(); note(''); updateSlash(); updateAt(); });
  input.addEventListener('blur', () => setTimeout(() => { closeSlash(); closeAt(); }, 150));
  input.addEventListener('keydown', (e) => {
    if (!atList.hidden && atShown.length && !e.isComposing) {   // v3.109 the "@" list first
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); atPick = (atPick + (e.key === 'ArrowDown' ? 1 : -1) + atShown.length) % atShown.length; drawAt(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); completeAt(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeAt(); return; }
    }
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
    else if (e.key === 'Escape' && gui?.live.busy && (!studioOn() || !input.value.trim())) { e.preventDefault(); interrupt(); }   // v3.120 Studio: only from an empty input   // v3.108 Esc stops the turn, as in the terminal
  });

  return {
    show() {
      if (shown) return;
      shown = true;
      el.hidden = false;
      poll();
      timer = window.setInterval(poll, POLL_MS);
      if (source) return;   // read-only: there is no terminal screen to look for a menu on
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
    setAttention(a) { attention = a; banner.hidden = Boolean(gui) || hidesBanner() || a !== 'permission'; },
    texts() { texts(); if (gui) { askShown = ''; setGui(gui); return; } menuShown = ''; drawMenu(); },
    /** v3.108 is this tab a GUI chat (as of the last read)? */
    isGui: () => Boolean(gui),
    focus() { input.focus(); },
    /** v3.112 the menu's Paste while this chat's input has the focus (see pasteFromMenu). */
    paste: () => pasteFromMenu(),
    /** v3.112 a line under the input (why the Terminal button did not switch). */
    note: (text) => note(String(text || '')),
    destroy() { shown = false; window.clearInterval(timer); window.clearInterval(menuTimer); document.removeEventListener('click', closeMore); el.remove(); },
  };
}
