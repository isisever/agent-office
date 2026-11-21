// Sleeping sessions: pure functions (no Electron; tested with node --test).
//
// Every claude holds its whole conversation in memory (60-80 MB fresh, 250-350 MB after a long session), and a
// project's claude used to run from launch until the app quit. With the "sleep idle sessions" setting on:
// - at launch a tab's claude starts only when the tab is first shown (lazy start);
// - a background tab whose claude has been idle for the chosen minutes is ended and marked asleep; showing it again
//   starts `claude --resume <session id>`, so the conversation continues where it was.
// A session sleeps only when nothing can be lost: Claude Code reports it idle, the office file shows no running
// agent, background shell or open prompt, no prompt text is typed but unsent, no scheduled task (CronCreate /
// ScheduleWakeup) was ever made in it, and it is not in the active project. Anything unknown keeps it awake.

const path = require('path');

const SLEEP_CHOICES = [0, 15, 30, 60]; // minutes; 0 = off (every claude starts at launch and keeps running)
const DEFAULT_SLEEP = 30;
const normalizeSleep = (v) => (SLEEP_CHOICES.includes(v) ? v : DEFAULT_SLEEP);

// Claude Code writes <config dir>/sessions/<pid>.json for each interactive claude: { pid, sessionId, cwd, status }.
// The pty runs `exec claude`, so the pty's pid is claude's.
const claudePidFile = (configDir, home, pid) => path.join(configDir || path.join(home, '.claude'), 'sessions', `${pid}.json`);

// Tools that make a session wake itself later: a sleeping claude would never run them.
const SCHEDULE_TOOLS = ['CronCreate', 'ScheduleWakeup'];
const hasScheduleTool = (transcript) => SCHEDULE_TOOLS.some((n) => String(transcript || '').includes(`"name":"${n}"`));

/**
 * Is there prompt text typed but not sent after this input? Enter (CR) sends it and Ctrl+C clears it; any printable
 * character (pasted text too) leaves a draft; escape sequences (arrows, focus reports, paste brackets, the terminal's
 * OSC / DCS answers) change nothing.
 * Backspacing a draft away still counts as a draft: the safe side.
 * @param {boolean} draft @param {string} input
 */
function draftAfter(draft, input) {
  const s = String(input ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0d || c === 0x03) { draft = false; continue; }
    if (c === 0x1b) {
      const n = s[i + 1];
      if (n === '[') { // CSI: parameters, then a final byte @..~
        i += 2;
        while (i < s.length && !(s.charCodeAt(i) >= 0x40 && s.charCodeAt(i) <= 0x7e)) i++;
      } else if (n === 'O') i += 2; // SS3: one more byte (F1-F4, keypad arrows)
      else if (n === ']' || n === 'P' || n === '_' || n === '^' || n === 'X') {
        // v3.116 OSC / DCS / APC / PM / SOS: the terminal's own answer to claude (its background colour for the auto
        // theme, its version), up to BEL or ESC \. Its text was taken for typing: a draft that never went away
        i += 2;
        while (i < s.length && s.charCodeAt(i) !== 0x07 && !(s.charCodeAt(i) === 0x1b && s[i + 1] === '\\')) i++;
        if (s.charCodeAt(i) === 0x1b) i++;
      } else if (n !== undefined) i += 1; // Alt+key
      continue;
    }
    if (c >= 0x20 && c !== 0x7f) draft = true;
  }
  return draft;
}

/**
 * Why this running tab cannot sleep now ('' = it can).
 * @param {{ now: number, idleMs: number, lastActivityAt: number, hasDraft?: boolean, isActive?: boolean,
 *   claude?: any, office?: any, hasSchedule?: boolean }} o
 * claude: its <pid>.json; office: ~/.claude/agent-office/sessions/<sessionId>.json; lastActivityAt: start, last
 * input or last output, whichever is newest.
 */
function sleepBlocker({ now, idleMs, lastActivityAt, hasDraft = false, isActive = false, claude, office, hasSchedule = false }) {
  if (!(idleMs > 0)) return 'off';
  if (isActive) return 'active';
  if (now - (lastActivityAt || 0) < idleMs) return 'recent';
  if (hasDraft) return 'draft';
  if (!claude || typeof claude !== 'object' || typeof claude.sessionId !== 'string' || !claude.sessionId) return 'unknown';
  if (claude.status !== 'idle') return 'busy';
  if (!office || typeof office !== 'object' || office.endedAt) return 'unknown';
  const stats = office.stats || {};
  if (stats.isBossBusy) return 'busy';
  if (stats.waiting) return 'waiting';
  if ((Array.isArray(office.workers) ? office.workers : []).some((w) => w && w.doneAt == null)) return 'agents';
  if ((Array.isArray(office.shells) ? office.shells : []).some((s) => s && s.endAt == null)) return 'shells';
  if (hasSchedule) return 'scheduled';
  return '';
}

/**
 * How a sleeping tab starts (startPty options). After a sleep: its own session (--resume <id>). Not started yet at
 * launch ({ resume: true }): the "Continue last session" setting as it is now decides --continue. After an account
 * change ({}): fresh.
 * @param {{ sessionId?: string, resume?: boolean, agy?: boolean, cmd?: boolean, oc?: boolean } | undefined} how @param {boolean} resumePref
 */
// An Antigravity tab put to sleep ({ agy: true }, contract v3.23) or a Command Code one ({ cmd: true }, v3.25) or an OpenCode one ({ oc: true }, v3.40) always
// continues its folder's conversation.
const wakeOptions = (how, resumePref) => (how?.sessionId ? { sessionId: how.sessionId } : how?.agy || how?.cmd || how?.oc ? { resume: true } : { resume: Boolean(how?.resume) && resumePref !== false });

module.exports = { wakeOptions, SLEEP_CHOICES, DEFAULT_SLEEP, normalizeSleep, claudePidFile, hasScheduleTool, draftAfter, sleepBlocker };
