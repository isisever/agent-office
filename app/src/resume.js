// Resuming interrupted work: pure functions (no Electron; tested with node --test).
//
// If the app goes away while a tab's claude is in the middle of a turn (an in-app update, a crash, the user quitting,
// a reboot), `--continue` alone would bring the conversation back but leave it sitting there. So main keeps a
// durable mark per tab in state.json (`interrupted: { <pty id>: <session id or ''> }`), set when the tab's claude
// becomes busy and cleared when its turn ends or its claude exits on its own. At the next launch, with "Continue last
// session" and "Resume interrupted work" on, every marked tab starts right away (even when starts are lazy) with
// `claude --resume <id> "<RESUME_PROMPT>"` (or `--continue "<…>"`), which opens the interactive session and submits
// the prompt.
//
// The marks miss some cases (a restart from an older version, a death within the 1.5 s poll, a tab killed on purpose),
// so the "Resume unfinished work" button (contract v3.8) also reads each tab's last conversation: a transcript whose
// last turn did not end (transcriptState) counts as unfinished too, and unfinishedActions picks what to do per tab.

/** The prompt sent to the resumed session (English: it goes to the model). One line, no quotes or cmd.exe specials. */
const RESUME_PROMPT = 'Agent Office restarted (app update or restart) while you were working, which interrupted your last turn and any sub-agents you had running. Check what was finished (git status, files, your task list), then continue the unfinished work from where it stopped. Restart sub-agents that were cut off.';

/** The prompt the "Resume unfinished work" button sends (it is not always a restart). Same rules as RESUME_PROMPT. */
const UNFINISHED_PROMPT = 'Your last turn in this session did not finish: it was cut off (an Agent Office restart or update, the session ending, or a crash) before you were done, along with any sub-agents you had running. Check what was finished (git status, files, your task list), then continue the unfinished work from where it stopped. Restart sub-agents that were cut off.';

const validSid = (s) => (typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(s) ? s : '');

/**
 * The marks as read from state.json: { ptyId: sessionId | '' }; anything odd is dropped. With ptyIds, only tabs
 * that still exist are kept.
 * @param {any} raw @param {Iterable<string>} [ptyIds]
 * @returns {Record<string, string>}
 */
function normalizeInterrupted(raw, ptyIds) {
  const keep = ptyIds ? new Set(ptyIds) : null;
  /** @type {Record<string, string>} */
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, sid] of Object.entries(raw)) {
    if (!id || (keep && !keep.has(id))) continue;
    out[id] = validSid(sid);
  }
  return out;
}

/**
 * Is this claude in the middle of a turn? Claude Code's own pid file (<config>/sessions/<pid>.json, its `status`) is
 * fresh for this process; the office file's stats.isBossBusy (the plugin's hooks) is the fallback when the pid file
 * has no status (older Claude Code). An office file left by a killed claude can still say busy, so it is used only
 * when there is no pid file status. This answers "is work running": it is true for 'shell' on purpose (an idle prompt
 * with a background Bash task), so sleep, kill, restart and handoff never cut a background process off.
 * @param {{ claude?: any, office?: any }} o
 */
function isTurnBusy({ claude, office }) {
  const status = claude && typeof claude === 'object' ? claude.status : undefined;
  if (typeof status === 'string' && status) return status !== 'idle';
  if (!office || typeof office !== 'object' || office.endedAt) return false;
  return Boolean(office.stats?.isBossBusy);
}

/** Claude Code pid file statuses (2.1.310), precedence waiting > busy > shell > idle: idle | shell (idle prompt plus a
 * running background Bash task) | busy (a turn, or sub-agents running) | waiting (a dialog or permission prompt). */
const TYPEABLE = new Set(['idle', 'shell']);
/**
 * Can a typed prompt go in now? A background shell does not block the prompt; a turn, sub-agents or a dialog do.
 * Unknown status strings are not typeable; no status at all falls back to the office file like isTurnBusy.
 * @param {{ claude?: any, office?: any }} o
 */
function canTypePrompt({ claude, office }) {
  const status = claude && typeof claude === 'object' ? claude.status : undefined;
  if (typeof status === 'string' && status) return TYPEABLE.has(status);
  if (!office || typeof office !== 'object' || office.endedAt) return true;
  return !office.stats?.isBossBusy;
}

/**
 * The marks after one look at a tab. Returns the same object when nothing changes (so main saves only on change).
 * busy: mark it (with its session id, which may become known later); not busy: clear it.
 * @param {Record<string, string>} marks @param {string} id @param {{ busy: boolean, sessionId?: string }} o
 */
function nextInterrupted(marks, id, { busy, sessionId = '' }) {
  const has = Object.prototype.hasOwnProperty.call(marks, id);
  if (!busy) {
    if (!has) return marks;
    const { [id]: _, ...rest } = marks;
    return rest;
  }
  const sid = validSid(sessionId) || (has ? marks[id] : '');
  if (has && marks[id] === sid) return marks;
  return { ...marks, [id]: sid };
}

/** The marks without these tabs (same object when none was marked). @param {Record<string, string>} marks @param {string[]} ids */
function clearInterrupted(marks, ids) {
  let out = marks;
  for (const id of ids) out = nextInterrupted(out, id, { busy: false });
  return out;
}

/**
 * Which tabs resume at launch (in the order given): only with both settings on, and only tabs that exist.
 * @param {Record<string, string>} marks @param {string[]} ptyIds @param {{ resume?: boolean, resumeWork?: boolean }} prefs
 */
function resumeTargets(marks, ptyIds, { resume, resumeWork }) {
  if (resume === false || resumeWork === false) return [];
  return ptyIds.filter((id) => Object.prototype.hasOwnProperty.call(marks, id));
}

/**
 * The prompt as one safe command-line argument: one line (control characters and newlines become spaces), and
 * without characters cmd.exe treats specially even inside quotes (`"`, `%`, `!`, `^`; npm's claude.cmd goes through
 * cmd.exe on Windows). It never starts with '-' (claude would read an option).
 * @param {string} text
 */
function promptArg(text) {
  // eslint-disable-next-line no-control-regex
  const s = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/["%!^]/g, '').replace(/\s+/g, ' ').trim();
  return s.replace(/^-+\s*/, '');
}

/**
 * claude's arguments for a start: the start arguments, then the resume arguments, then (only when resuming and a
 * prompt is given) the prompt as the positional argument. Resume arguments come last among the options, so a
 * variadic option (`--mcp-config <configs...>`) cannot swallow the prompt.
 * `always` (v3.47): pass the prompt on a fresh start too (a routine starting a cold HQ).
 * @param {string[]} base @param {string[]} resumeArgs @param {string} [prompt] @param {{ always?: boolean }} [o]
 */
function claudeArgs(base, resumeArgs, prompt, { always = false } = {}) {
  const p = (resumeArgs.length || always) && prompt ? promptArg(prompt) : '';
  return [...base, ...resumeArgs, ...(p ? [p] : [])];
}

// --- the last turn of a Claude Code transcript (<config>/projects/<slug>/<session id>.jsonl, one JSON object a line)

// a user text that is not a prompt: slash commands and their output (older Claude Code wrote them as user lines)
const LOCAL_COMMAND = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/;
const USER_INTERRUPT = /^\s*\[Request interrupted by user/;

/**
 * What one transcript line says about the turn: 'open' (a prompt or tool result waiting for the model, or an
 * assistant message that stopped for a tool or did not finish), 'closed' (the model ended its turn, or the user
 * interrupted it on purpose), or null (not part of the main conversation: sub-agent (sidechain) lines, meta lines,
 * compaction summaries, system/summary/attachment/bookkeeping lines, slash commands and their output).
 * @param {any} o @returns {'open' | 'closed' | null}
 */
function entryTurn(o) {
  if (!o || typeof o !== 'object' || o.isSidechain || o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return null;
  const m = o.message;
  if (!m || typeof m !== 'object') return null;
  if (o.type === 'assistant') return m.stop_reason === 'tool_use' || m.stop_reason == null ? 'open' : 'closed';
  if (o.type !== 'user') return null;
  const c = m.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (!c.length) return null;
    if (c.some((b) => b && b.type === 'tool_result')) return 'open';
    text = c.filter((b) => b && b.type === 'text').map((b) => String(b.text ?? '')).join('\n');
    if (!text.trim()) return 'open'; // an image or document only: still a prompt
  } else return null;
  if (USER_INTERRUPT.test(text)) return 'closed';
  if (LOCAL_COMMAND.test(text) || !text.trim()) return null;
  return 'open';
}

/**
 * The state of a transcript's last turn from its text (or the tail of it: a cut first line is skipped as bad JSON):
 * 'unfinished' when the last line that counts (entryTurn) is open, 'finished' when it is closed, 'none' when no
 * line counts.
 * @param {string} text @returns {'unfinished' | 'finished' | 'none'}
 */
function transcriptState(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line[0] !== '{') continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const turn = entryTurn(o);
    if (turn) return turn === 'open' ? 'unfinished' : 'finished';
  }
  return 'none';
}

/** Tail sizes read in turn until a line counts (a big tool result can be one long line). */
const TAIL_STEPS = [64 * 1024, 1024 * 1024, 16 * 1024 * 1024];

/**
 * transcriptState of a transcript file, reading only its end (more of it while nothing counts). 'none' for a
 * missing or unreadable file.
 * @param {string | null | undefined} file @param {typeof import('fs')} [fsm]
 * @returns {'unfinished' | 'finished' | 'none'}
 */
function transcriptFileState(file, fsm = require('fs')) {
  if (!file) return 'none';
  let fd;
  try {
    fd = fsm.openSync(file, 'r');
    const size = fsm.fstatSync(fd).size;
    for (const step of TAIL_STEPS) {
      const len = Math.min(size, step);
      const buf = Buffer.alloc(len);
      fsm.readSync(fd, buf, 0, len, size - len);
      let text = buf.toString('utf8');
      if (len < size) text = text.slice(text.indexOf('\n') + 1); // the first line is cut
      const st = transcriptState(text);
      if (st !== 'none' || len === size) return st;
    }
    return 'none';
  } catch {
    return 'none';
  } finally {
    if (fd !== undefined) try { fsm.closeSync(fd); } catch {}
  }
}

/**
 * What the "Resume unfinished work" button does with each tab (in the order given). A tab has unfinished work when
 * it is marked (interrupted) or its last conversation ends mid-turn. A busy one is skipped (it is working); a
 * running one with unsent text typed in it is skipped (the prompt would be mixed into it) and listed under skipped;
 * a running idle one gets the prompt typed in ('type'); one that is not running starts with --resume <session id>
 * and the prompt ('start'), or --continue when it is marked without a known session (only a tab that continues:
 * the main tab or a worktree tab; another one would start a fresh session, so it is left alone).
 * @param {{ id: string, running: boolean, busy?: boolean, draft?: boolean, marked?: boolean, markSid?: string,
 *   sessionId?: string, continues?: boolean, transcript?: 'unfinished' | 'finished' | 'none' }[]} tabs
 * @returns {{ actions: { id: string, how: 'start' | 'type', sessionId: string }[], skipped: string[] }}
 */
function unfinishedActions(tabs) {
  /** @type {{ id: string, how: 'start' | 'type', sessionId: string }[]} */
  const actions = [];
  /** @type {string[]} */
  const skipped = [];
  for (const t of tabs) {
    if (t.busy) continue;
    const sid = validSid(t.markSid) || validSid(t.sessionId);
    if (!t.marked && !(t.transcript === 'unfinished' && sid)) continue;
    if (t.running) {
      if (t.draft) skipped.push(t.id);
      else actions.push({ id: t.id, how: 'type', sessionId: sid });
    } else if (sid || t.continues) actions.push({ id: t.id, how: 'start', sessionId: sid });
  }
  return { actions, skipped };
}

/**
 * The bytes that type a prompt into Claude Code's input box: one line inside a bracketed paste (so its characters
 * are not taken as keys). Enter (\r) is sent separately a moment later, after the paste has landed.
 * @param {string} text
 */
function typedPrompt(text) {
  return `\x1b[200~${promptArg(text)}\x1b[201~`;
}

module.exports = { RESUME_PROMPT, UNFINISHED_PROMPT, entryTurn, transcriptState, transcriptFileState, unfinishedActions, typedPrompt, normalizeInterrupted, isTurnBusy, canTypePrompt, nextInterrupted, clearInterrupted, resumeTargets, promptArg, claudeArgs };
