// GUI chat (contract v3.108): a claude child process on the SDK protocol (src/gui-session.js), shaped like a node-pty
// object so main keeps one map of running tabs: `pid` is claude's (the launch line ends in `exec claude`, so Claude
// Code's pid file and every busy/idle check read as for a terminal tab), `onData` / `onExit` return IDisposables
// (src/pty-attach.js holds and releases them), `kill` stops it, `write` and `resize` do nothing (no terminal).
// No Electron; the spawn function is passed in (tested with a fake in test/gui-session.test.cjs).
const GS = require('./gui-session.js');

const STDERR_MAX = 64 * 1024;

/**
 * @param {(file: string, args: string[], opts: object) => any} spawn child_process.spawn (or a fake)
 * @param {string} file @param {string[]} args @param {{ cwd: string, env: object }} opts
 * @param {{ onAsk?: (ask: any, input: any) => boolean, killGroup?: (pid: number, signal: string) => void }} [hooks]
 *   onAsk: true when main answered the request itself; killGroup: process.kill (a test passes a fake)
 */
function spawnGui(spawn, file, args, { cwd, env }, { onAsk, killGroup = process.kill } = {}) {
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

  const put = (s) => {
    if (ended || !child.stdin || child.stdin.destroyed) return false;
    try { child.stdin.write(s); return true; } catch { return false; }
  };
  child.stdin?.on?.('error', () => {});   // EPIPE after claude ended: the exit handler reports it

  child.stdout?.on?.('data', (chunk) => {
    for (const msg of lines.push(chunk)) {
      if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') sid = msg.session_id;
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
