// Chat view (contract v3.80): pure, no Electron; tested in test/chat.test.cjs.
// A Claude Code tab can be shown as a conversation instead of its terminal. Claude Code writes every session to its
// transcript (<config>/projects/<slug>/<session>.jsonl); main reads that file from the end, a little at a time, and
// turns its lines into chat items: what the person (or the app) typed, the boss's answers, one short line per tool
// call. Nothing here writes; the session keeps running in its pty, and what the person types in the chat is typed
// into that pty like any prompt. Thinking, sub-agent (sidechain) lines, meta lines and tool results' content are
// never shown: a tool result only marks its call done or failed.
const fs = require('fs');

const TAIL = 512 * 1024;            // the first read of a transcript starts this far from its end
const STEP_MAX = 2 * 1024 * 1024;   // bytes read per call; the rest comes with the next calls
const TEXT_MAX = 20000;             // characters of one message
const DETAIL_MAX = 160;             // characters of a tool call's detail

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** A tool call's short detail: the command, the file, the pattern or the description, on one line. */
function toolDetail(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const pick = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill']
    .map((k) => i[k]).find((v) => typeof v === 'string' && v.trim());
  if (pick) return cut(oneLine(pick), DETAIL_MAX);
  if (name === 'TodoWrite' && Array.isArray(i.todos)) return `${i.todos.length}`;
  if (Array.isArray(i.questions)) return cut(oneLine(i.questions.map((q) => q?.question).filter((q) => typeof q === 'string').join(' · ')), DETAIL_MAX);
  return '';
}
/** mcp__server__tool → "server · tool"; other names as they are. */
function toolName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ''));
  return m ? `${m[1]} · ${m[2]}` : String(name || '?');
}

// Text Claude Code itself puts in a "user" line: a slash command (shown), its output and caveats (not shown).
const COMMAND_RE = /<command-name>([^<]*)<\/command-name>(?:[\s\S]*?<command-args>([^<]*)<\/command-args>)?/;
const HIDDEN_RE = /^\s*<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|system-reminder)>/;

/** One "user" text → an item, or null when it is not something to show. */
function userText(s, base) {
  const text = String(s || '');
  if (!text.trim() || HIDDEN_RE.test(text)) return null;
  const cmd = COMMAND_RE.exec(text);
  if (cmd) return { ...base, kind: 'command', text: cut(oneLine(`${cmd[1]} ${cmd[2] || ''}`), 200) };
  if (/^\s*<task-notification>/.test(text)) return { ...base, kind: 'note', note: 'task' };
  if (/^\[Request interrupted by user/.test(text)) return { ...base, kind: 'note', note: 'interrupted' };
  if (/^\[Image: source: /.test(text)) return null;   // the path Claude Code adds after a pasted image
  if (/^Another Claude session sent a message:/.test(text)) return { ...base, kind: 'note', note: 'message' };
  return { ...base, kind: 'user', text: cut(text.trim(), TEXT_MAX) };
}

/**
 * Transcript lines (JSONL text, whole lines) → chat items, in order:
 *   { kind: 'user', text, images? } | { kind: 'assistant', text } | { kind: 'error', text }
 *   | { kind: 'tool', id, name, detail } | { kind: 'toolDone', id, error } | { kind: 'command', text }
 *   | { kind: 'note', note: 'compact' | 'task' | 'interrupted' | 'message' }
 * each with key (unique per line and block) and at (ms, 0 when unknown). A bad line is skipped.
 */
function chatItems(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== 'object' || j.isSidechain || j.isMeta) continue;
    const at = Date.parse(j.timestamp) || 0;
    const key = String(j.uuid || `${at}-${out.length}`);
    const content = j.message?.content;
    if (j.type === 'user') {
      if (j.isCompactSummary) { out.push({ key, at, kind: 'note', note: 'compact' }); continue; }
      if (typeof content === 'string') { const it = userText(content, { key, at }); if (it) out.push(it); continue; }
      if (!Array.isArray(content)) continue;
      const texts = [];
      let images = 0;
      content.forEach((b, n) => {
        if (b?.type === 'tool_result') out.push({ key: `${key}:${n}`, at, kind: 'toolDone', id: String(b.tool_use_id || ''), error: b.is_error === true });
        else if (b?.type === 'image') images++;
        else if (b?.type === 'text') texts.push(String(b.text || ''));
      });
      if (texts.length || images) {
        const it = texts.length ? userText(texts.join('\n'), { key, at }) : { key, at, kind: 'user', text: '' };
        if (it && it.kind === 'user' && images) it.images = images;
        if (it) out.push(it);
      }
    } else if (j.type === 'assistant' && Array.isArray(content)) {
      content.forEach((b, n) => {
        const k = `${key}:${n}`;
        if (b?.type === 'text' && String(b.text || '').trim()) out.push({ key: k, at, kind: j.isApiErrorMessage ? 'error' : 'assistant', text: cut(String(b.text).trim(), TEXT_MAX) });
        else if (b?.type === 'tool_use') out.push({ key: k, at, kind: 'tool', id: String(b.id || ''), name: toolName(b.name), detail: toolDetail(b.name, b.input) });
      });
    }
  }
  return out;
}

/**
 * Reads what the transcript gained since `cursor` ({ file, ino, size } from the last call, or null) →
 * { cursor, items, reset, more }. reset: the items start over (first read, another file, the file was replaced or got
 * shorter); the first read starts TAIL bytes from the end, at a line start. Only whole lines are read: a line still
 * being written comes with the next call. more: there is more to read right away (STEP_MAX was reached).
 * A missing file → { cursor: null, items: [], reset: true, more: false }.
 */
function readChat(file, cursor, fsm = fs) {
  let st;
  try { st = fsm.statSync(file); } catch { return { cursor: null, items: [], reset: true, more: false }; }
  const same = Boolean(cursor && cursor.file === file && cursor.ino === st.ino && Number.isFinite(cursor.size) && cursor.size >= 0 && st.size >= cursor.size);
  const from = same ? cursor.size : Math.max(0, st.size - TAIL);
  const to = Math.min(st.size, from + STEP_MAX);
  let buf = Buffer.alloc(0);
  if (to > from) {
    let fd;
    try {
      fd = fsm.openSync(file, 'r');
      buf = Buffer.alloc(to - from);
      const n = fsm.readSync(fd, buf, 0, buf.length, from);
      buf = buf.subarray(0, n);
    } catch { buf = Buffer.alloc(0); } finally { if (fd !== undefined) try { fsm.closeSync(fd); } catch {} }
  }
  let start = 0;
  if (!same && from > 0) { const nl = buf.indexOf(10); start = nl < 0 ? buf.length : nl + 1; }   // a cut first line
  const end = buf.lastIndexOf(10) + 1;   // whole lines only
  // a line longer than STEP_MAX: skipped (its pieces are not JSON), so the reading never stalls on it
  const used = end > start ? end : to < st.size && buf.length ? buf.length : start;
  const items = end > start ? chatItems(buf.subarray(start, end).toString('utf8')) : [];
  return { cursor: { file, ino: st.ino, size: from + used }, items, reset: !same, more: to < st.size };
}

/** Why a message typed in the chat can't go to the tab now → a reason, or null (it can). */
function sendRefused({ text, running, locked, draft, permission }) {
  if (!String(text || '').trim()) return 'empty';
  if (String(text).length > TEXT_MAX) return 'too-long';
  if (locked) return 'locked';
  if (!running) return 'not-running';
  if (permission) return 'permission';   // a typed text would answer Claude Code's approval menu
  if (draft) return 'draft';             // the terminal's input box holds something typed there
  return null;
}

// Keys a chat-view menu button may type into the tab (src/tui-menu.mjs reads the menu): an option's number, Esc, the
// arrows that move between AskUserQuestion's tabs, Enter, and the text of a "Type something" answer.
const MENU_KEYS = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', '\x1b', '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\r']);   // ↑ ↓: a dialog without numbers
const MENU_TEXT_MAX = 2000;
/** The steps of a menu answer → the strings to write, one by one; null when any step is not allowed. */
function menuKeys(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 8) return null;
  const out = [];
  for (const s of steps) {
    if (typeof s === 'string' && MENU_KEYS.has(s)) out.push(s);
    else if (s && typeof s === 'object' && typeof s.text === 'string') {
      // typed text: one line, no control characters (an Esc or a CR in it would act on the menu)
      // eslint-disable-next-line no-control-regex
      const text = s.text.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
      if (!text || text.length > MENU_TEXT_MAX) return null;
      out.push(text);
    } else return null;
  }
  return out;
}

/** The last assistant text of a transcript file (its tail), or '' (v3.83 amendment: a task's fallback report). */
function lastAnswer(file, fsm = fs) {
  const items = readChat(file, null, fsm).items;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'assistant' && String(items[i].text || '').trim()) return items[i].text;
  return '';
}

module.exports = { TAIL, STEP_MAX, TEXT_MAX, chatItems, readChat, lastAnswer, toolDetail, toolName, sendRefused, menuKeys };
