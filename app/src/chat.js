// Chat view (contract v3.80): pure, no Electron; tested in test/chat.test.cjs.
// A Claude Code tab can be shown as a conversation instead of its terminal. Claude Code writes every session to its
// transcript (<config>/projects/<slug>/<session>.jsonl); main reads that file from the end, a little at a time, and
// turns its lines into chat items: what the person (or the app) typed, the boss's answers, one short line per tool
// call. Nothing here writes; the session keeps running in its pty, and what the person types in the chat is typed
// into that pty like any prompt. Thinking, sub-agent (sidechain) lines, meta lines and tool results' content are
// never shown: a tool result only marks its call done or failed.
const fs = require('fs');
const path = require('path');

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

const OUTPUT_RE = /^\s*<local-command-stdout>([\s\S]*?)(?:<\/local-command-stdout>\s*)?$/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/** A command's printed text without terminal colours, trailing spaces or blank lines around it. */
const plainOutput = (s) => String(s || '').replace(ANSI_RE, '').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
/** One "user" text → an item, or null when it is not something to show. */
function userText(s, base) {
  const text = String(s || '');
  // v3.117 what a command printed (/model's "Set model to …", /context's table, …): the terminal shows it, so the chat does
  const out = OUTPUT_RE.exec(text);
  if (out) { const o = plainOutput(out[1]); return o.trim() ? { ...base, kind: 'output', text: cut(o, TEXT_MAX) } : null; }
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
 *   | { kind: 'tool', id, name, detail, path?, agent? } | { kind: 'toolDone', id, error } | { kind: 'command', text }
 *   | { kind: 'note', note: 'compact' | 'task' | 'interrupted' | 'message' } | { kind: 'output', text } (v3.117)
 * each with key (unique per line and block) and at (ms, 0 when unknown). A bad line is skipped.
 */
function chatItems(text, { sidechain = false } = {}) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    // v3.115 a sub-agent's own transcript is all sidechain lines: read them there, never in the boss's
    if (!j || typeof j !== 'object' || (j.isSidechain && !sidechain) || j.isMeta) continue;
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
        else if (b?.type === 'tool_use') {
          // v3.109 the file a tool worked on (the chat can show it in Finder: main checks it is inside the tab's folder)
          const fp = ['file_path', 'notebook_path'].map((k2) => b.input?.[k2]).find((v) => typeof v === 'string' && v.trim() && v.length <= 4096);
          // v3.115 a call that starts a sub-agent: the chat links its row to that agent's own conversation
          const agent = AGENT_TOOLS.has(b.name) ? { agent: true } : {};
          out.push({ key: k, at, kind: 'tool', id: String(b.id || ''), name: toolName(b.name), detail: toolDetail(b.name, b.input), ...(fp ? { path: fp } : {}), ...agent });
        }
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
function readChat(file, cursor, fsm = fs, opts = {}) {
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
  const items = end > start ? chatItems(buf.subarray(start, end).toString('utf8'), opts) : [];
  return { cursor: { file, ino: st.ino, size: from + used }, items, reset: !same, more: to < st.size };
}

// v3.115 sub-agents in the chat. Claude Code keeps each sub-agent's conversation beside the session's transcript:
// <session>.jsonl → <session>/subagents/agent-<id>.jsonl, with agent-<id>.meta.json ({ agentType, description,
// toolUseId: the boss's Agent call, finished? }). The plugin's session file says which ones still run (workers).
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AGENTS_MAX = 50;              // newest first, then shown oldest first
const AGENT_QUIET_MS = 2 * 60000;   // no worker entry, not finished: running while its file changed this recently
/** The subagents/ folder of a session transcript. */
const agentsDir = (transcript) => String(transcript || '').replace(/\.jsonl$/, '') + path.sep + 'subagents';
/** A sub-agent's transcript file, or null when the id is not one Claude Code makes (no path can be built from it). */
function agentFile(transcript, agentId) {
  if (!transcript || typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) return null;
  return path.join(agentsDir(transcript), `agent-${agentId}.jsonl`);
}
/**
 * The session's sub-agents → [{ id, toolUseId, description, type, state: 'running' | 'done' | 'stopped', tool,
 * detail, toolCount, at }], oldest first, at most AGENTS_MAX. workers: the plugin's session workers ({ id, doneAt?,
 * tool, detail, toolCount }); one without doneAt runs. Else a finished meta is done, a file written in the last
 * AGENT_QUIET_MS runs, anything else stopped (killed with its tab, or the plugin is off).
 */
function chatAgents(transcript, workers, now = Date.now(), fsm = fs) {
  const dir = agentsDir(transcript);
  let names = [];
  try { names = fsm.readdirSync(dir).filter((n) => /^agent-[A-Za-z0-9_-]{1,64}\.jsonl$/.test(n)); } catch { return []; }
  const byId = new Map((Array.isArray(workers) ? workers : []).filter((w) => w && typeof w.id === 'string').map((w) => [w.id, w]));
  const out = [];
  for (const n of names) {
    const id = n.slice(6, -6);
    const file = path.join(dir, n);
    let st;
    try { st = fsm.statSync(file); } catch { continue; }
    let meta = {};
    try { meta = JSON.parse(fsm.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) || {}; } catch {}
    const w = byId.get(id);
    const state = w && w.doneAt === undefined ? 'running' : w || meta.finished === true ? 'done' : now - st.mtimeMs < AGENT_QUIET_MS ? 'running' : 'stopped';
    out.push({
      id,
      toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : '',
      description: cut(oneLine(meta.description || w?.description || ''), DETAIL_MAX),
      type: cut(oneLine(meta.agentType || w?.type || ''), 60),
      state,
      tool: state === 'running' && typeof w?.tool === 'string' ? toolName(w.tool) : '',
      detail: state === 'running' && typeof w?.detail === 'string' ? cut(oneLine(w.detail), DETAIL_MAX) : '',
      toolCount: Number.isInteger(w?.toolCount) ? w.toolCount : 0,
      at: Number.isFinite(w?.spawnAt) ? w.spawnAt : Math.round(st.birthtimeMs || st.mtimeMs),
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, AGENTS_MAX).reverse();
}

// v3.118 /resume in the chat: the sessions of the tab's project folder, newest first, the way Claude Code's picker shows
// them: the name given with /rename, else Claude Code's own title, else the first thing the person wrote.
const SESSIONS_MAX = 50;
const SESSION_PEEK = 64 * 1024;   // bytes read at each end of a transcript for its title and first prompt
const SID_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}\.jsonl$/;
/** Bytes [from, from + n) of a file as text ('' when it cannot be read). */
function peek(fsm, file, from, n) {
  let fd;
  try {
    fd = fsm.openSync(file, 'r');
    const buf = Buffer.alloc(n);
    return buf.subarray(0, fsm.readSync(fd, buf, 0, n, from)).toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fsm.closeSync(fd); } catch {} }
}
/** One transcript's title, first prompt and branch from its two ends → { title, prompt, branch }. */
function sessionInfo(file, size, fsm = fs) {
  const head = peek(fsm, file, 0, Math.min(size, SESSION_PEEK));
  const tail = size > SESSION_PEEK ? peek(fsm, file, size - SESSION_PEEK, SESSION_PEEK) : '';
  let custom = '';
  let ai = '';
  let prompt = '';
  let branch = '';
  for (const text of [head, tail]) {
    for (const line of text.split('\n')) {
      if (!line.includes('"type"')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j?.type === 'custom-title' && typeof j.customTitle === 'string') custom = j.customTitle;
      else if (j?.type === 'ai-title' && typeof j.aiTitle === 'string') ai = j.aiTitle;
      if (typeof j?.gitBranch === 'string' && j.gitBranch) branch = j.gitBranch;
      if (!prompt && j?.type === 'user' && !j.isMeta && !j.isSidechain) {
        const c = j.message?.content;
        const it = userText(typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '', {});
        if (it?.kind === 'user' && it.text) prompt = it.text;
      }
    }
  }
  return { title: cut(oneLine(custom || ai), 120), prompt: cut(oneLine(prompt), 200), branch: cut(oneLine(branch), 80) };
}
/**
 * The sessions in Claude Code's folders of one project folder → [{ id, title, prompt, branch, at, size }], newest first,
 * at most SESSIONS_MAX; `exclude` (ids: the sessions running tabs are in) and sessions with nothing the person wrote
 * are left out.
 */
/** @param {string[]} dirs @param {{ exclude?: string | Iterable<string>, fsm?: any }} [opts] */
function sessionList(dirs, { exclude = [], fsm = fs } = {}) {
  const skip = new Set(typeof exclude === 'string' ? [exclude] : exclude);
  const files = [];
  for (const dir of new Set(Array.isArray(dirs) ? dirs : [])) {
    let names = [];
    try { names = fsm.readdirSync(dir).filter((n) => SID_FILE_RE.test(n)); } catch { continue; }
    for (const n of names) {
      const id = n.slice(0, -6);
      if (skip.has(id) || files.some((f) => f.id === id)) continue;
      try { const st = fsm.statSync(path.join(dir, n)); if (st.isFile() && st.size > 0) files.push({ id, file: path.join(dir, n), at: Math.round(st.mtimeMs), size: st.size }); } catch {}
    }
  }
  const out = [];
  for (const f of files.sort((a, b) => b.at - a.at)) {
    if (out.length >= SESSIONS_MAX) break;
    const info = sessionInfo(f.file, f.size, fsm);
    if (!info.prompt && !info.title) continue;
    out.push({ id: f.id, ...info, at: f.at, size: f.size });
  }
  return out;
}

// v3.109 images pasted into the chat input: the types Claude takes, at most IMAGES_MAX of at most IMAGE_MAX characters
// of base64 each (the API counts its 5 MB on that text; the renderer scales a bigger image down before it comes here)
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const IMAGES_MAX = 5;
const IMAGE_MAX = 5 * 1024 * 1024;
/**
 * The images of a chat message, checked: [{ type, data (base64) }] → { images: [{ type, data, ext }] } | { error:
 * 'too-many-images' | 'image-type' | 'image-size' }. Not an array (or empty): no images.
 */
function cleanImages(list) {
  if (!Array.isArray(list) || !list.length) return { images: [] };
  if (list.length > IMAGES_MAX) return { error: 'too-many-images' };
  const images = [];
  for (const it of list) {
    const type = typeof it?.type === 'string' ? it.type.toLowerCase() : '';
    if (!IMAGE_TYPES[type]) return { error: 'image-type' };
    const data = typeof it.data === 'string' ? it.data : '';
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { error: 'image-type' };
    if (data.length > IMAGE_MAX) return { error: 'image-size' };
    images.push({ type, data, ext: IMAGE_TYPES[type] });
  }
  return { images };
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

// v3.100 what a paired device allowed to read sessions gets: tool rows carry the tool's NAME only. The detail line (a
// command, a path, a prompt) would need a second opt-in on the owning machine, which is not built: keep this off.
const LINK_TOOL_DETAIL = false;
// Blocks Claude Code writes into a user message that must never cross the link, wherever they sit in the message
// (HIDDEN_RE only looks at the start). An unclosed block (the text was cut) runs to the end.
const LINK_HIDDEN_RE = /<(bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|local-command-caveat|ide_selection|ide_opened_file|system-reminder|command-args)>[\s\S]*?(?:<\/\1>|$)|^[ \t]*\[Image: source: .*$/gm;
/** A user text for the link: hidden blocks and pasted-image path lines removed. */
const linkUserText = (s) => String(s || '').replace(LINK_HIDDEN_RE, '').replace(/\n{3,}/g, '\n\n');
/**
 * Chat items → the items that may cross the device link (contract v3.100): user / assistant / error / command text and
 * notes, every text through `redact` (HQ.redact: best effort), a tool row with its name only, a tool's done/failed flag.
 * Never: images (not even their count), thinking, tool input or results (chatItems reads none of the last three).
 */
function linkItems(items, { redact = (s) => require('./hq.js').redact(s), toolDetail = LINK_TOOL_DETAIL } = {}) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const base = { key: String(it.key || ''), at: Number.isInteger(it.at) && it.at > 0 ? it.at : 0, kind: it.kind };
    if (it.kind === 'user' || it.kind === 'assistant' || it.kind === 'error' || it.kind === 'command') {
      const text = redact(it.kind === 'user' ? linkUserText(it.text) : String(it.text || ''));
      if (text.trim()) out.push({ ...base, text });   // a message that was only images is not sent
    } else if (it.kind === 'tool') {
      const detail = toolDetail === true && it.detail ? redact(String(it.detail)) : '';
      out.push({ ...base, id: String(it.id || ''), name: redact(String(it.name || '')), ...(detail ? { detail } : {}) });
    } else if (it.kind === 'toolDone') out.push({ ...base, id: String(it.id || ''), error: it.error === true });
    else if (it.kind === 'note') out.push({ ...base, note: it.note });
  }
  return out;
}

module.exports = { sessionList, sessionInfo, AGENT_TOOLS, agentFile, chatAgents, IMAGES_MAX, IMAGE_MAX, cleanImages, TAIL, STEP_MAX, TEXT_MAX, LINK_TOOL_DETAIL, linkItems, chatItems, readChat, lastAnswer, toolDetail, toolName, sendRefused, menuKeys };
