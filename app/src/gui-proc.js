// GUI chat (contract v3.108): a claude child process on the SDK protocol (src/gui-session.js), shaped like a node-pty
// object so main keeps one map of running tabs: `pid` is claude's (the launch line ends in `exec claude`, so Claude
// Code's pid file and every busy/idle check read as for a terminal tab), `onData` / `onExit` return IDisposables
// (src/pty-attach.js holds and releases them), `kill` stops it, `write` and `resize` do nothing (no terminal).
// No Electron; the spawn function is passed in (tested with a fake in test/gui-session.test.cjs).
const GS = require('./gui-session.js');
const ML = require('./model-list.js');

const STDERR_MAX = 64 * 1024;
const INIT_ID = 'ao-initialize';   // v3.120 Studio UX: the request id of the initialize sent at start
const SETTING_WAIT = 10000;   // ms to wait for claude's answer to a setting request

/**
 * @param {(file: string, args: string[], opts: object) => any} spawn child_process.spawn (or a fake)
 * @param {string} file @param {string[]} args @param {{ cwd: string, env: object }} opts
 * @param {{ onAsk?: (ask: any, input: any) => boolean, onModels?: (models: import('./model-list.js').ModelOption[]) => void, killGroup?: (pid: number, signal: string) => void }} [hooks]
 *   onAsk: true when main answered the request itself; onModels: the models claude reported at start (v3.120);
 *   killGroup: process.kill (a test passes a fake)
 */
function spawnGui(spawn, file, args, { cwd, env }, { onAsk, onModels, killGroup = process.kill } = {}) {
  // its own process group (as a pty's session is): a stop reaches claude's shells and MCP servers too, not only claude
  const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const lines = GS.createLines();
  /** @type {Set<(d: string) => void>} */
  const dataFns = new Set();
  /** @type {Set<(e: { exitCode: number, signal?: number }) => void>} */
  const exitFns = new Set();
  /** @type {Map<string, { ask: any, input: any }>} */
  const asks = new Map();
  /** @type {Set<(msg: any) => void>} */
  const msgFns = new Set();
  let live = { busy: false, text: '', tool: '' };
  let sid = '';
  let ended = false;
  let seq = 0;
  let stderr = '';
  const settings = { model: '', mode: '' };   // v3.121 what Studio's pickers set in this run
  /** @type {{ model: string, usage: null | { input_tokens: number, cache_read_input_tokens: number, cache_creation_input_tokens: number }, models: import('./model-list.js').ModelOption[] }} */
  const info = { model: '', usage: null, models: [] };   // v3.120 Studio UX: the running model and the last answer's usage
  /** @type {Map<string, { key: string, value: string, done: (r: string) => void, timer: any }>} */
  const pending = new Map();   // v3.121 setting requests waiting for claude's control_response

  const put = (s) => {
    if (ended || !child.stdin || child.stdin.destroyed) return false;
    try { child.stdin.write(s); return true; } catch { return false; }
  };
  child.stdin?.on?.('error', () => {});   // EPIPE after claude ended: the exit handler reports it
  put(ML.initLine(INIT_ID));   // v3.120 Studio UX: the SDK's first request; its answer lists the account's models

  child.stdout?.on?.('data', (chunk) => {
    for (const msg of lines.push(chunk)) {
      if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') sid = msg.session_id;
      // v3.120 Studio UX: the model the session runs (init, then each answer) and the last answer's usage (context ring)
      if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.model === 'string') info.model = msg.model.slice(0, 100);
      if (msg.type === 'assistant' && msg.parent_tool_use_id == null && msg.message && typeof msg.message === 'object') {
        if (typeof msg.message.model === 'string' && msg.message.model && msg.message.model !== '<synthetic>') info.model = msg.message.model.slice(0, 100);
        const u = msg.message.usage;
        if (u && typeof u === 'object') info.usage = { input_tokens: Number(u.input_tokens) || 0, cache_read_input_tokens: Number(u.cache_read_input_tokens) || 0, cache_creation_input_tokens: Number(u.cache_creation_input_tokens) || 0 };
      }
      if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
        const ask = GS.askOf(msg);
        if (!ask) { put(GS.denyLine(String(msg.request_id || ''), 'Agent Office could not read this request.')); continue; }
        const input = msg.request.input && typeof msg.request.input === 'object' ? msg.request.input : {};
        let answered = false;
        try { answered = onAsk ? onAsk(ask, input) === true : false; } catch (e) { console.error('gui ask:', e.message); }
        if (answered) { put(GS.allowLine(ask.id, input)); continue; }
        if (asks.size >= GS.ASKS_MAX) { put(GS.denyLine(ask.id, 'Too many open requests.')); continue; }
        asks.set(ask.id, { ask, input });
      } else if (msg.type === 'control_cancel_request' && typeof msg.request_id === 'string') {
        asks.delete(msg.request_id);   // claude withdrew it (the turn was stopped)
      }
      // v3.120 Studio UX: claude's answer to our initialize: the models this account can use (the picker's list)
      if (msg.type === 'control_response' && msg.response?.request_id === INIT_ID) {
        if (msg.response.subtype === 'success') {
          info.models = ML.parseModels(msg.response.response);
          if (info.models.length && onModels) { try { onModels(info.models); } catch (e) { console.error('gui models:', e.message); } }
        }
        continue;
      }
      if (msg.type === 'control_response' && pending.has(String(msg.response?.request_id))) {
        const id = String(msg.response.request_id);
        const p = pending.get(id);
        pending.delete(id);
        clearTimeout(p.timer);
        if (msg.response.subtype === 'success') { settings[p.key === 'model' ? 'model' : 'mode'] = p.value; p.done('ok'); }
        else p.done(`error:${String(msg.response.error || 'claude refused the change').slice(0, 300)}`);
        continue;
      }
      if (msg.type === 'result') asks.clear();   // a finished turn leaves nothing to answer
      live = GS.nextLive(live, msg);
      for (const f of msgFns) { try { f(msg); } catch (e) { console.error('gui msg:', e.message); } }
    }
  });
  // what claude prints on stderr (a start error, a warning) goes where a terminal's output would
  child.stderr?.on?.('data', (chunk) => {
    const s = String(chunk);
    stderr = (stderr + s).slice(-STDERR_MAX);
    for (const f of dataFns) f(s.replace(/\r?\n/g, '\r\n'));
  });
  const finish = (code, signal) => {
    if (ended) return;
    ended = true;
    asks.clear();
    for (const p of pending.values()) { clearTimeout(p.timer); p.done('gone'); }
    pending.clear();
    live = { busy: false, text: '', tool: '' };
    const e = { exitCode: typeof code === 'number' ? code : signal ? 1 : 0, ...(signal ? { signal } : {}) };
    for (const f of exitFns) f(e);
  };
  child.on?.('exit', finish);
  child.on?.('error', (err) => {
    const s = `${err?.message || err}\r\n`;
    for (const f of dataFns) f(s);
    finish(127, null);
  });

  const listen = (set, f) => { set.add(f); return { dispose: () => set.delete(f) }; };
  return {
    gui: true,
    pid: child.pid,
    onData: (f) => listen(dataFns, f),
    onExit: (f) => listen(exitFns, f),
    /** every message claude writes (for main's own watchers) */
    onMessage: (f) => listen(msgFns, f),
    write() {},     // no terminal: keys from a hidden xterm go nowhere
    resize() {},
    kill(signal = 'SIGTERM') {
      try { if (child.pid) killGroup(-child.pid, signal); else child.kill(signal); } catch { try { child.kill(signal); } catch {} }
    },
    /** The person's or the app's message; false when claude is gone. */
    sendUser: (text, images = []) => {
      const ok = put(GS.userLine(text, images));
      if (ok) live = { ...live, busy: true };
      return ok;
    },
    interrupt: () => put(GS.interruptLine(`interrupt-${++seq}`)),
    /**
     * v3.121 the model or permission mode for the next turns, resolved by claude's control_response: 'ok', 'bad' (not
     * a known key/value), 'busy' (one is already waiting), 'gone' (claude ended), 'error:<claude's message>' (an error
     * reply, or no reply within SETTING_WAIT). Never during a turn (main checks); never a restart.
     */
    setting(key, value, modes = GS.SET_MODES) {
      const id = `setting-${++seq}`;
      const out = GS.settingLine(id, key, value, ML.modelValues(info.models), modes);
      if (!out) return Promise.resolve('bad');
      if (pending.size) return Promise.resolve('busy');
      return new Promise((done) => {
        const timer = setTimeout(() => { if (pending.delete(id)) done('error:no answer from claude'); }, SETTING_WAIT);
        timer.unref?.();
        pending.set(id, { key, value, done, timer });
        if (!put(out)) { pending.delete(id); clearTimeout(timer); done('gone'); }
      });
    },
    settings: () => ({ ...settings }),
    info: () => ({ model: info.model, usage: info.usage ? { ...info.usage } : null }),
    /** v3.120 Studio UX: the models claude reported for this session ([] until it answers, or when it lists none) */
    models: () => info.models.slice(),
    /** Answers an open card; 'ok', 'gone' (no such request any more) or 'bad-answer'. */
    answer(askId, answer) {
      const open = asks.get(String(askId));
      if (!open) return 'gone';
      const out = GS.answerLine(open.ask, open.input, answer);
      if (!out) return 'bad-answer';
      asks.delete(open.ask.id);
      return put(out) ? 'ok' : 'gone';
    },
    /** The open cards, oldest first (without the tools' full input). */
    asks: () => [...asks.values()].map((a) => a.ask),
    live: () => ({ ...live }),
    sessionId: () => sid,
    stderr: () => stderr,
  };
}

module.exports = { spawnGui };
