// GUI chat (contract v3.108): pure, no Electron; tested in test/gui-session.test.cjs.
// With the chat view on, a Claude Code tab runs claude over its SDK protocol instead of in a terminal, the way the VS
// Code extension does: `claude -p --input-format stream-json --output-format stream-json --verbose
// --permission-prompt-tool stdio`. One JSON object a line each way. The app writes the person's messages as `user`
// lines; claude writes its messages, and asks the app a `control_request` `can_use_tool` before every tool call that
// would open a permission dialog in the terminal (AskUserQuestion and ExitPlanMode included). The app answers allow or
// deny in a `control_response`, and stops a turn with a `control_request` `interrupt`. Checked with Claude Code 2.1.311.
// Nothing is read off a screen and no key is typed: the chat draws each request as a card from its data.
const { toolDetail, toolName } = require('./chat.js');
const { draftAfter } = require('./sleep.js');

/** The flags that turn claude into the SDK protocol; they go before every other argument. */
const GUI_FLAGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
/** v3.120 the model probe's flags: the SDK protocol without the account's MCP servers (a throwaway session) */
const PROBE_FLAGS = [...GUI_FLAGS, '--strict-mcp-config'];
const LINE_MAX = 64 * 1024 * 1024;   // a line longer than this is dropped (claude's lines are messages, not files)
const LIVE_MAX = 4000;               // characters of the answer being written shown live (the transcript has it all)
const ASKS_MAX = 20;                 // open requests kept per tab (claude asks one at a time per agent)
const QUESTION_TOOLS = ['AskUserQuestion', 'ExitPlanMode'];

/**
 * Does this tab run as a GUI chat? The chat view is on (or the Studio experience, v3.120), the person has not switched it to the terminal, Claude Code,
 * not a plain shell tab and not HQ (HQ keeps its terminal: its keys are held and minted, v3.46/v3.47). Not on Windows
 * yet: claude is a `.cmd` shim there and its pipes are untested.
 * @param {{ chatView: boolean, studio?: boolean, terminal: boolean, engine: string, hq: boolean, shell: boolean, platform: string }} o
 */
function guiEligible({ chatView, studio = false, terminal, engine, hq, shell, platform }) {
  return (chatView === true || studio === true) && !terminal && engine === 'claude' && !hq && !shell && platform !== 'win32';
}

/**
 * Does a tab the app restarts on its own (a backup-account move, v3.17) start as a GUI chat? It keeps the mode it ran
 * in: a running chat stays a chat whenever it could run as one at all (anyMode: guiEligible with Studio), also in the
 * Office with the chat view off (a chat that ran in Studio). Otherwise the setting decides, as on any start (now).
 * @param {{ wasGui: boolean, now: boolean, anyMode: boolean }} o
 */
function keepsGui({ wasGui, now, anyMode }) {
  return Boolean(now) || (Boolean(wasGui) && Boolean(anyMode));
}

/**
 * v3.110 the tabs the person switched to the terminal, as kept in state.json: strings only, each once, only tabs that
 * still exist (a removed tab or project drops out), at most 500.
 * @param {unknown} raw
 * @param {Iterable<string>} ptyIds every tab id that exists now
 * @returns {string[]}
 */
function cleanTermTabs(raw, ptyIds) {
  const known = new Set(ptyIds);
  const out = new Set();
  for (const id of Array.isArray(raw) ? raw : []) if (typeof id === 'string' && known.has(id) && out.size < 500) out.add(id);
  return [...out];
}

/**
 * v3.112 may a running tab switch between the GUI chat and its terminal now, and how?
 * 'resume': its session goes on in the other mode; 'fresh': a GUI tab that has no conversation yet starts the other
 * mode new (there is nothing to resume, which used to refuse the switch as busy); 'busy': not now.
 * A GUI tab is idle when it has no open card, no turn, no open task and no sub-agent or shell running: its prompts
 * arrive whole, so the terminal's 15 s typing window (`recent`) and its pid-file status do not apply to it.
 * A terminal tab needs its pid file's idle session (`sid`), no open task, no recent typing and no permission prompt.
 * @param {{ gui: boolean, sid?: string, guiSid?: string, asks?: number, busy?: boolean, tasks?: boolean, working?: boolean, recent?: boolean, permission?: boolean }} o
 * @returns {'resume' | 'fresh' | 'busy'}
 */
function switchPlan({ gui, sid = '', guiSid = '', asks = 0, busy = false, tasks = false, working = false, recent = false, permission = false }) {
  if (tasks) return 'busy';
  if (gui) {
    if (asks > 0 || busy || working) return 'busy';
    return guiSid || sid ? 'resume' : 'fresh';
  }
  return sid && !recent && !permission ? 'resume' : 'busy';
}

/**
 * v3.116 why switchPlan said 'busy' → 'task' | 'asks' | 'turn' | 'agents' | 'recent' | 'permission' | 'draft' |
 * 'session' (the chat names it). idleWhy: main's idle check of a terminal tab ('draft' | 'session' | 'turn' | 'agents').
 */
function switchWhy({ gui, sid = '', asks = 0, busy = false, tasks = false, working = false, recent = false, permission = false, idleWhy = '' }) {
  if (tasks) return 'task';
  if (gui) return asks > 0 ? 'asks' : busy ? 'turn' : working ? 'agents' : '';
  if (!sid) return ['draft', 'turn', 'agents'].includes(idleWhy) ? idleWhy : 'session';
  return permission ? 'permission' : recent ? 'recent' : '';
}
/** v3.117 a slash command the chat may type for the person: "/name" (letters, digits, : . _ -) and its arguments. */
const isCommand = (s) => typeof s === 'string' && s.length <= 2000 && /^\/\w[\w:.-]{0,63}(?:\s|$)/.test(s)
  && ![...s].some((c) => { const n = c.charCodeAt(0); return (n < 0x20 && c !== '\n' && c !== '\t') || n === 0x7f; });
/** v3.116 is this terminal input typing (an Enter or a printable key), not an escape the terminal sends by itself? */
const typesInput = (d) => { const s = String(d ?? ''); return s.includes('\r') || s.includes('\x03') || draftAfter(false, s); };

/** claude's argv for a GUI start: the protocol flags, then the tab's own arguments (built without a prompt). */
const guiArgs = (args) => [...GUI_FLAGS, ...args];

const line = (o) => `${JSON.stringify(o)}\n`;
/** The person's (or the app's) message; v3.109 with images (checked by chat.js cleanImages) as content blocks. */
const userLine = (text, images = []) => line({ type: 'user', message: { role: 'user', content: images.length
  ? [...(String(text).trim() ? [{ type: 'text', text: String(text) }] : []), ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.type, data: i.data } }))]
  : String(text) } });
/** Stop the running turn (Esc in the terminal). */
/** v3.121 Studio's pickers: the permission modes a running GUI chat may switch to, and the fallback models ('' model: the
 * start's) when the session reported none (v3.120 Studio UX: model-list.js, from claude's initialize answer). */
const SET_MODELS = ['', 'opus', 'sonnet', 'haiku'];
const SET_MODES = ['auto', 'default', 'acceptEdits', 'plan'];   // v3.120 the fallback; main passes the account's list
/**
 * A control request that changes the running session's model or permission mode (the SDK protocol's set_model /
 * set_permission_mode); null for any other key or value. `models`: the values the session reported (model-list.js). No restart: the next turn uses it.
 */
function settingLine(requestId, key, value, models = SET_MODELS, modes = SET_MODES) {
  if (key === 'model' && typeof value === 'string' && models.includes(value)) {
    return line({ type: 'control_request', request_id: String(requestId), request: value ? { subtype: 'set_model', model: value } : { subtype: 'set_model' } });
  }
  if (key === 'mode' && typeof value === 'string' && value !== 'bypassPermissions' && modes.includes(value)) return line({ type: 'control_request', request_id: String(requestId), request: { subtype: 'set_permission_mode', mode: value } });
  return null;
}
const interruptLine = (requestId) => line({ type: 'control_request', request_id: String(requestId), request: { subtype: 'interrupt' } });
const allowLine = (requestId, input) => line({ type: 'control_response', response: { subtype: 'success', request_id: String(requestId), response: { behavior: 'allow', updatedInput: input && typeof input === 'object' ? input : {} } } });
const denyLine = (requestId, message) => line({ type: 'control_response', response: { subtype: 'success', request_id: String(requestId), response: { behavior: 'deny', message: String(message || 'The person declined this.') } } });

/** Splits claude's stdout into JSON objects; a line that is not JSON (an rc file's echo) is skipped. */
function createLines() {
  let buf = '';
  return {
    /** @param {string | Buffer} chunk @returns {any[]} */
    push(chunk) {
      buf += String(chunk);
      const out = [];
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const s = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!s.trim()) continue;
        try { const o = JSON.parse(s); if (o && typeof o === 'object') out.push(o); } catch {}
      }
      if (buf.length > LINE_MAX) buf = '';
      return out;
    },
  };
}

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
/** AskUserQuestion's questions, only the fields the card draws. */
function questionsOf(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs.slice(0, 4).map((q) => ({
    question: str(q?.question, 2000),
    header: str(q?.header, 60),
    multiSelect: q?.multiSelect === true,
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 8).map((o) => ({ label: str(o?.label, 200), description: str(o?.description, 600) })).filter((o) => o.label),
  })).filter((q) => q.question && q.options.length);
}

/**
 * A `can_use_tool` request → the card the chat draws, or null for another message. kind: 'question'
 * (AskUserQuestion), 'plan' (ExitPlanMode), 'permission' (any other tool). The tool's full input stays in main.
 * @returns {null | { id: string, kind: 'question' | 'plan' | 'permission', tool: string, name: string, detail: string,
 *   reason: string, agent: boolean, questions?: any[], plan?: string, since: number }}
 */
function askOf(msg, now = Date.now()) {
  if (msg?.type !== 'control_request' || msg.request?.subtype !== 'can_use_tool') return null;
  const id = typeof msg.request_id === 'string' ? msg.request_id : '';
  const tool = typeof msg.request.tool_name === 'string' ? msg.request.tool_name : '';
  if (!id || !tool) return null;
  const input = msg.request.input && typeof msg.request.input === 'object' ? msg.request.input : {};
  const base = { id, tool, name: toolName(tool), detail: toolDetail(tool, input), reason: str(msg.request.decision_reason, 400), agent: typeof msg.request.agent_id === 'string' && msg.request.agent_id !== '', since: now };
  if (tool === 'AskUserQuestion') {
    const questions = questionsOf(input);
    if (questions.length) return { ...base, kind: 'question', questions };
  }
  if (tool === 'ExitPlanMode') return { ...base, kind: 'plan', plan: str(input.plan, 50000) };
  return { ...base, kind: 'permission' };
}

/**
 * Does the app answer this request itself, without a card? Only "allow", only with the project's Auto-approve on
 * (v3.71), never on a mail desk (v3.85), never a question to the person, and only what the plugin's own rules would
 * approve (`canAutoApprove`, plugin/hooks/auto-approve.ts). Anything else goes to the person.
 * @param {{ tool: string, input: any, autoApprove: boolean, mailGuard: boolean, canAutoApprove: null | ((t: string, i: any) => boolean) }} o
 */
function autoAllows({ tool, input, autoApprove, mailGuard, canAutoApprove }) {
  if (!autoApprove || mailGuard || typeof canAutoApprove !== 'function' || QUESTION_TOOLS.includes(tool)) return false;
  try { return canAutoApprove(tool, input) === true; } catch { return false; }
}

const ANSWER_MAX = 2000;
/**
 * The person's answer to a card → the control_response line, or null when the answer does not fit the card.
 * answer: { allow: boolean, message?: string, answers?: { [question]: string } }. A question is answered with allow and
 * the chosen labels (or the typed text) in `answers`; a plan is approved (allow) or sent back with a message (deny).
 */
function answerLine(ask, input, answer) {
  if (!ask || !answer || typeof answer !== 'object') return null;
  const message = str(answer.message, ANSWER_MAX).trim();
  if (answer.allow !== true) return denyLine(ask.id, message || undefined);
  if (ask.kind !== 'question') return allowLine(ask.id, input);
  const answers = {};
  for (const q of ask.questions || []) {
    const a = answer.answers?.[q.question];
    // eslint-disable-next-line no-control-regex
    if (typeof a === 'string' && a.trim()) answers[q.question] = a.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, ANSWER_MAX);
  }
  if (!Object.keys(answers).length) return null;
  return allowLine(ask.id, { ...input, answers });
}

/**
 * What the chat shows live, updated by each message: busy from a sent message until the turn's `result`; the answer
 * being written (from `stream_event` text deltas, dropped when its whole message arrives); the tool running.
 * @param {{ busy: boolean, text: string, tool: string }} live @param {any} msg @returns {{ busy: boolean, text: string, tool: string }}
 */
function nextLive(live, msg) {
  if (!msg || typeof msg !== 'object') return live;
  if (msg.type === 'result') return { busy: false, text: '', tool: '' };
  if (msg.type === 'stream_event' && msg.parent_tool_use_id == null) {
    const ev = msg.event;
    if (ev?.type === 'message_start') return { ...live, busy: true, text: '' };
    if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') return { ...live, busy: true, tool: toolName(ev.content_block.name) };
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      const text = (live.text + String(ev.delta.text || '')).slice(-LIVE_MAX);
      return { ...live, busy: true, text, tool: '' };
    }
    return live;
  }
  // a whole message only updates a turn that runs (a sent message or message_start made it busy): claude also writes
  // user / assistant messages outside a turn (replayed at a start or a resume), which must not read as working forever
  if (msg.type === 'assistant' && msg.parent_tool_use_id == null) return live.busy ? { ...live, text: '' } : live;
  if (msg.type === 'user' && msg.parent_tool_use_id == null) return live.busy ? { ...live, tool: '' } : live;
  return live;
}

/** v3.108 the text of an error claude reports (a failed turn's `result`, an API error message), else '': the usage-limit
 * watch reads it as it reads a terminal's output (v3.77). */
function errorText(msg) {
  if (msg?.type === 'result' && msg.is_error === true) {
    const parts = [msg.result, ...(Array.isArray(msg.errors) ? msg.errors : [])].filter((x) => typeof x === 'string');
    return parts.join('\n').slice(0, 4000);
  }
  if (msg?.type === 'assistant' && (msg.error || msg.message?.isApiErrorMessage)) {
    const c = msg.message?.content;
    return (Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => String(b.text || '')).join('\n') : '').slice(0, 4000);
  }
  return '';
}

const END_NOTE_MAX = 800;
/** v3.108 the end of claude's stderr for the chat: login-shell noise dropped, control characters out, last lines kept. */
function endNote(stderr) {
  const lines = String(stderr || '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  return lines.join('\n').slice(-END_NOTE_MAX);
}

/**
 * v3.120 the /rename message for a GUI chat: Claude Code's stream-json input runs `/rename <name>` locally (checked
 * with claude 2.1.332: a session_title_changed event and a custom-title line, no model turn). One line, control
 * characters out, at most 120 characters; '' when no name is left.
 */
function renameCommand(name) {
  // eslint-disable-next-line no-control-regex
  const n = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).trim() : '';
  return n ? `/rename ${n}` : '';
}

module.exports = { keepsGui, PROBE_FLAGS, renameCommand, settingLine, SET_MODELS, SET_MODES, isCommand, switchWhy, typesInput, endNote, errorText, GUI_FLAGS, ASKS_MAX, guiEligible, cleanTermTabs, switchPlan, guiArgs, userLine, interruptLine, allowLine, denyLine, createLines, askOf, autoAllows, answerLine, nextLive, questionsOf };
