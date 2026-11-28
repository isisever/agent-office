// Wires everything together: sidebar (projects, accounts), per-project terminal(s) (tabs, v3.0), office and theme colors.
import { mountTerminal, pasteIntoFocused } from './terminal.js';
import { mountChat } from './chat.js';
import { mountSidebar } from './sidebar.js';
import { shownOrder } from '../src/project-groups.mjs';
import { mountHq } from './hq-board.js';
import { paletteRows } from './templates-ui.js';
import { mountLogin } from './login.js';
import { mountDevices, mergeRemote } from './devices.js';
import { setLang, onLang, t, getLang } from './i18n.js';
import { modLabel, isModKey, keyOf, isMac, platform as osPlatform } from './platform.js';
import { mountStudio } from './studio.js';
import { icon } from './studio-icons.js';
import { mountKeepAwake } from './keep-awake-button.js';
import { mountEconomy } from './economy-button.js';
import { mountBudgetBanner } from './budget-banner.js';
import { startStep, startFailure } from '../src/studio-ux.mjs';
import { deskTarget, deskSend } from '../src/studio-team.mjs';
import { studioKey, otherExperience, experienceSwitch } from '../src/studio-keys.mjs';
import { chatShownFor, chatButtonFor } from '../src/chat-view.mjs';
import { themeChoices, effectiveTheme } from '../src/themes.mjs';
import { normalizeLook, normalizeMode, effectiveMode, chromeFor, terminalTheme } from '../src/appearance.mjs';
import { tildePath, windowTitle } from '../src/layout.mjs';
import { promptReady } from '../src/tui-menu.mjs';
import { initVoice } from './voice.js';
import { mountWhatsNew, splitAction } from './whats-new.js';

// Fake window.agentOffice to see the layout in a plain browser (outside Electron).
if (!window.agentOffice) await import('./dev-mock.js');

const api = window.agentOffice;
// language before first render: sidebar and title are built in the right language
let initialLang = null;
try { initialLang = await api.language?.get(); } catch (e) { console.error(e); }
if (initialLang) await setLang(initialLang.lang);
initVoice();   // v3.119 the talk key and voice progress
const $ = (id) => document.getElementById(id);
const root = document.documentElement;

const DEFAULT_THEME = { frame: '#2b1d1a', accent: '#3fb6a8', statusBg: '#231815', statusText: '#f3ead8' };
const isLoginId = (id) => typeof id === 'string' && id.startsWith('login:');
const BUFFER_MAX = 256 * 1024; // data for a project that has no terminal yet

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch {} },
};

let projects = [];
let activeId = null;
let status = [];
let accounts = [];
let theme = DEFAULT_THEME;
let focusName; // project last reported to the office
const panes = new Map(); // pty id (projectId or `<projectId>:<n>`) -> { el, hint, term }
const pending = new Map(); // pty id -> { data: string, exited: boolean }
const activeTab = new Map(); // projectId -> number of the visible tab (1 = main terminal; this window only)

// ---- Tabs (contract v3.0): first tab is the main terminal (pty id projectId), extra tabs `<projectId>:<n>` ----
const MAIN_TAB = 1;
const tabsOf = (p) => (Array.isArray(p?.tabs) ? p.tabs : []);
const tabPtyId = (projectId, n) => (n === MAIN_TAB ? projectId : `${projectId}:${n}`);
const ptyIdsOf = (p) => [p.id, ...tabsOf(p).map((x) => tabPtyId(p.id, x.n))];
/** Visible tab in the project; a closed tab falls back to the main terminal. */
function tabOf(p) {
  const n = activeTab.get(p.id);
  return tabsOf(p).some((x) => x.n === n) ? n : MAIN_TAB;
}
// v3.46 HQ: selected in this window only (main's activeId stays a project); its pane is pty 'hq'
const HQ_ROW = { id: 'hq', name: 'HQ', hq: true };
let hqSelected = false;
// v3.120 the experience (Office / Studio, renderer/studio.js); main keeps the setting (prefs experience)
let experience = 'office';
let studioOn = false;   // Studio has its own design (renderer/studio.css); light/dark follow the system there
/** @type {ReturnType<typeof mountStudio>} */
let studio = null;
let hqUi = null;
const activeProject = () => (hqSelected ? HQ_ROW : projects.find((p) => p.id === activeId) || null);
/** pty id of the visible terminal. */
const activePty = () => { const p = activeProject(); return p ? tabPtyId(p.id, tabOf(p)) : null; };
// While the login overlay is open, focus stays on its terminal.
// v3.80: a tab shown as a chat takes the focus in its input box (the hidden terminal must not get keys)
const focusActive = () => { if (login?.isOpen()) return login.focus(); const p = panes.get(activePty()); return (p?.chatOn ? p.chat : p?.term)?.focus(); };
let login = null; // login overlay (login.js)

// ---- Theme ----
// Appearance (v3.74): look ('pixel' | 'claude') and mode ('system' | 'light' | 'dark'). <html> carries data-look and
// data-mode (effective: light | dark). The 8-bit look takes its four frame colours from the office theme (dark: as
// they are; light: derived, src/appearance.mjs); the Claude look's colours are fixed in style.css, so they are unset.
let look = 'pixel';
let modeSetting = 'system';
const lookNow = () => look;   // Studio keeps the person's look underneath; body.studio's own tokens cover it
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const shownMode = () => effectiveMode(studioOn ? 'system' : modeSetting, systemDark.matches);
const termTheme = () => terminalTheme(lookNow(), shownMode(), theme);
const FRAME_VARS = { '--frame': 'frame', '--accent': 'accent', '--status-bg': 'statusBg', '--status-text': 'statusText' };
function applyAppearance() {
  const mode = shownMode();
  const shown = lookNow();
  root.dataset.look = shown;
  root.dataset.mode = mode;
  root.style.colorScheme = mode;
  const chrome = chromeFor(shown, mode, theme);
  for (const [name, key] of Object.entries(FRAME_VARS)) {
    if (shown === 'claude') root.style.removeProperty(name);
    else root.style.setProperty(name, chrome[key]);
  }
  // the 8-bit colours of this mode, for appearance-boot.js at the next start (once the office theme is known)
  if (themeKnown && !studioOn) store.set('chrome', shown === 'claude' ? '' : JSON.stringify({ mode, ...chrome }));
  for (const p of panes.values()) p.term.setTheme(termTheme());
  login?.setTheme(termTheme());
  $('title').textContent = (shown === 'claude' ? t('app.appTitlePlain') : t('app.appTitle'));
}
systemDark.addEventListener('change', () => applyAppearance());
let themeKnown = false;
function applyTheme(info) {
  theme = { ...DEFAULT_THEME, ...info };
  themeKnown = true;
  applyAppearance();
}

// ---- Title bar ----
// v3.18: the project's name, then its folder (~ for home; long paths lose their start, style.css #project-dir);
// the native window title says the same (Window menu, Mission Control, the Linux/Windows frame).
function setTitleProject() {
  const p = activeProject();
  $('project').textContent = p ? p.name : t('app.noProject');
  $('project').title = p ? p.dir : '';
  const dir = $('project-dir');
  const shown = p ? tildePath(p.dir, api.home) : '';
  // LRM marks keep a leading '/' or '~' in place inside the right-to-left box that ellipsizes from the left
  dir.textContent = shown ? `\u200e${shown}\u200e` : '';
  dir.title = p ? p.dir : '';
  dir.hidden = !shown;
  document.title = windowTitle(p, api.home, 'Agent Office');
}

let lastStats = null; // to rewrite when the language changes
function setStats(d) {
  lastStats = d;
  const list = d?.projects;
  const working = Array.isArray(list)
    ? list.reduce((n, p) => n + (p.working || 0), 0)
    : (d?.workers || []).filter((w) => w.doneAt == null).length;
  // the boss's turn ended but its agents still run: it waits for them, not for the user
  const busy = d?.isBossBusy ? t('app.bossBusy') : working > 0 ? t('app.bossAgents') : '';
  $('stats').textContent = t('app.stats', { working, delivered: d?.delivered ?? 0, busy });
  $('stats').title = t('app.statsTitle');
  const warn = $('warn');
  // a session file in a newer format (contract v2.8) takes precedence over the theme warning
  warn.textContent = d?.newerFormat ? t('app.formatWarn') : t('app.themeWarn');
  warn.hidden = !d?.themesError && !d?.newerFormat;
  warn.title = d?.newerFormat ? t('app.formatError') : d?.themesError ? t('app.themesError', { error: d.themesError }) : '';
}

// ---- Update: button in the title bar once a new version is downloaded; clicking restarts the app ----
let updateVersion = null;
let appVersion = null; // running version: tooltip of the title bar's app title
function setVersionTitle() {
  $('title').title = appVersion ? t('app.versionTitle', { version: appVersion }) : '';
}
function showUpdate(version) {
  const b = $('update');
  if (!version) return;
  updateVersion = version;
  b.hidden = false;
  b.textContent = t('app.updateReady', { version });
  b.title = t('app.updateTitle');
}
$('update').addEventListener('click', () => {
  if (confirm(t('app.updateConfirm'))) api.update?.install();
});
api.update?.onReady(showUpdate);
api.update?.state().then((s) => {
  appVersion = s?.version || null;
  setVersionTitle();
  showUpdate(s?.ready);
}).catch(() => {});

// ---- Terminals: one xterm per project, hidden ones keep their history ----
function hint(projectId, text) {
  const p = panes.get(projectId);
  if (!p) return;
  p.hint.querySelector('span').textContent = text || '';
  p.hint.hidden = !text;
}

function createPane(id) {
  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.id = id;
  el.hidden = true;
  const hintEl = document.createElement('div');
  hintEl.className = 'hint';
  hintEl.hidden = true;
  const hintText = document.createElement('span');
  const close = document.createElement('button');
  close.textContent = '×';
  close.className = 'hint-close';
  close.title = t('app.close');
  close.addEventListener('click', () => { hintEl.hidden = true; focusActive(); });
  hintEl.append(hintText, close);
  const host = document.createElement('div');
  host.className = 'term-host';
  el.append(hintEl, host);
  $('terminals').appendChild(el);

  const term = mountTerminal(host, { projectId: id, theme: termTheme() });
  panes.set(id, { el, hint: hintEl, term });
  const buf = pending.get(id);
  if (buf) {
    pending.delete(id);
    if (buf.data) term.write(buf.data);
    if (buf.exited) term.exit();
  }
}

function syncPanes() {
  const ids = new Set([HQ_ROW, ...projects].flatMap(ptyIdsOf).filter((id) => !isLoginId(id)));
  for (const [id, p] of panes) {
    if (ids.has(id)) continue;
    p.chat?.destroy();
    p.term.destroy();
    p.el.remove();
    panes.delete(id);
  }
  for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id);
  for (const id of ids) if (!panes.has(id)) createPane(id);
}

/** Is the tab's claude asleep (not started yet, or ended while idle in the background; see main's src/sleep.js)? */
function isAsleep(id) {
  const [projectId, n] = String(id).split(':');
  const st = status.find((x) => x.id === projectId);
  return Boolean(n ? st?.tabs?.find((x) => x.n === Number(n))?.isAsleep : st?.isAsleep);
}

// ---- Chat view (contract v3.80, chat.js): with the setting on, a Claude Code tab shows its conversation; the
// terminal stays mounted under it and is one click away. Off: nothing below runs and the pane is as before.
let chatView = false;
// v3.120 a tab follows the mode main runs it in (status isGui; a stopped tab: the mode it would start in). A GUI chat
// shows its chat in either experience (it has no terminal). In Studio a tab running in a terminal (started in the
// Office, or on Windows, where GUI chat is off) shows its terminal in the main region, with the Chat button to move it:
// switching the experience never restarts or moves a running session (src/chat-view.mjs).
function guiRunning(id) {
  if (!id) return false;
  const [projectId, n] = String(id).split(':');
  const st = status.find((x) => x.id === projectId);
  return Boolean(n ? st?.tabs?.find((x) => x.n === Number(n))?.isGui : st?.isGui);
}
/** @param {string | null | undefined} id */
const chatFacts = (id) => ({ chatView, studio: studioOn, win: osPlatform === 'win32', isGui: guiRunning(id), chatOff: Boolean(id) && chatOff.has(String(id)), hq: String(id || '').split(':')[0] === HQ_ROW.id });
/** @param {string | null | undefined} id */
const chatShown = (id) => Boolean(id) && chatShownFor(chatFacts(id));
const chatOff = new Set();   // pty ids the person switched back to the terminal (v3.110 seeded from main's termTabs)
let chatOffSeeded = false;
let chatSwitch = null;       // the "chat" button over a terminal (made when first needed)
/** Can this tab be shown as a chat? Claude Code tabs only (not Antigravity / Command Code / OpenCode, not a shell tab). */
function chatCapable(id) {
  if (!id) return false;
  const [projectId, n] = String(id).split(':');
  if (projectId === HQ_ROW.id) return true;
  const p = projects.find((x) => x.id === projectId);
  if (!p || (p.engine && p.engine !== 'claude')) return false;
  return !n || !tabsOf(p).find((x) => x.n === Number(n))?.shell;
}
// v3.108 a GUI chat tab has no terminal of its own: main continues its session in a terminal (or back in the GUI chat)
// only while nothing runs in it; HQ (and Windows) switch the view only, as before
const switching = new Set();
const BUSY_WHY = ['task', 'asks', 'turn', 'agents', 'recent', 'permission', 'draft', 'session'];
async function setChatMode(id, on) {
  if (switching.has(id)) return;
  switching.add(id);
  let r = 'ok';
  let failed = '';   // v3.110 the switch could not be asked: the tab keeps its mode and says why
  try { r = String(id).split(':')[0] === HQ_ROW.id ? 'ok' : await api.chat.mode(id, on ? 'gui' : 'terminal'); } catch (e) { console.error(e); failed = String((e && /** @type {any} */ (e).message) || e); } finally { switching.delete(id); }
  const busy = r === 'busy' || r.startsWith('busy:');   // v3.116 'busy:<why>': what the tab is waiting for
  if (failed || busy || r === 'locked') {
    const why = failed ? t('chat.gui.switchFailed', { error: failed }) : !busy ? t('chat.why.locked')
      : BUSY_WHY.includes(r.slice(5)) ? t(`chat.gui.busyWhy.${r.slice(5)}`) : t('chat.gui.busySwitch');
    hint(id, why);
    panes.get(id)?.chat?.note?.(why);   // v3.112 also under the chat's input, where the button was pressed
    setTimeout(() => hint(id, ''), 4000);
    return;
  }
  if (r === 'moved') panes.get(id)?.term.reset({ restarting: true });
  if (on) chatOff.delete(id); else chatOff.add(id);
  syncChat();
  focusActive();
}
// v3.117 a command with a screen of its own runs in the tab's terminal: shown until that screen is closed (Claude
// Code's prompt box is back, nothing open over it), then the chat comes back by itself (a GUI tab restarts in the chat
// with the session the terminal is in now, so /resume's pick goes on there)
const CMD_TYPE_MS = 30000;   // the restarted terminal's prompt box must come within this, or the command is given up
const CMD_SETTLE_MS = 4000;  // a command with no screen (its output only): back after this
const CMD_STABLE_MS = 700;   // the prompt box stays this long before the command is typed or the chat comes back
/** @type {Map<string, { gui: boolean, text: string, at: number, typedAt: number, seen: boolean, readyAt: number, going: boolean }>} */
const cmdRuns = new Map();
let cmdTimer = 0;
function startCommand(id, how, text) {
  const gui = how === 'moved';
  if (gui) panes.get(id)?.term.reset({ restarting: true });
  cmdRuns.set(id, { gui, text: String(text || ''), at: Date.now(), typedAt: gui ? 0 : Date.now(), seen: false, readyAt: 0, going: false });
  chatOff.add(id);
  syncChat();
  hint(id, t('chat.cmd.running'));
  if (!cmdTimer) cmdTimer = window.setInterval(watchCommands, 300);
}
function endCommand(id, why = '') {
  cmdRuns.delete(id);
  hint(id, why);
  if (why) setTimeout(() => { if (!cmdRuns.has(id)) hint(id, ''); }, 6000);
  if (!cmdRuns.size) { window.clearInterval(cmdTimer); cmdTimer = 0; }
}
/** The prompt box still holds the command as typed (Claude Code has not taken it yet). */
const stillTyped = (lines, text) => Boolean(text) && lines.some((l) => /^\s*[❯>]\s/.test(l) && l.includes(text));
function watchCommands() {
  const now = Date.now();
  for (const [id, w] of cmdRuns) {
    const p = panes.get(id);
    // the person went back to the chat (or the tab is gone): nothing to watch
    if (!p || !chatOff.has(id) || !chatShown(id)) { endCommand(id); continue; }
    let lines = [];
    try { lines = p.term.screen(); } catch (e) { console.error(e); }
    if (!w.typedAt) {
      // a GUI tab restarted in its terminal: the command is typed once its prompt box is up with nothing over it (main
      // checks the session is idle, no approval waits and claude takes a prompt)
      if (now - w.at > CMD_TYPE_MS) { endCommand(id, t('chat.cmd.gaveUp')); continue; }
      if (w.going) continue;
      if (!promptReady(lines)) { w.readyAt = 0; continue; }
      if (!w.readyAt) w.readyAt = now;
      if (now - w.readyAt < CMD_STABLE_MS) continue;
      w.going = true;
      api.chat.commandGo(id).then((r) => {
        w.going = false;
        w.readyAt = 0;
        if (r === 'typed') w.typedAt = Date.now();
        else if (r === 'gone') endCommand(id, t('chat.cmd.gaveUp'));
      }).catch((e) => { console.error(e); w.going = false; });
      continue;
    }
    if (now - w.typedAt < 600) continue;   // its Enter goes 400 ms after the text
    if (stillTyped(lines, w.text)) { w.readyAt = 0; continue; }
    if (!promptReady(lines)) { w.seen = true; w.readyAt = 0; continue; }
    if (!w.readyAt) w.readyAt = now;
    if (now - w.readyAt < CMD_STABLE_MS || (!w.seen && now - w.typedAt < CMD_SETTLE_MS)) continue;
    endCommand(id);
    if (w.gui) setChatMode(id, true);
    else { chatOff.delete(id); syncChat(); focusActive(); }
  }
}
/** Shows the visible tab as chat or terminal; the terminal gets a resize nudge when it comes back. */
function syncChat() {
  const visible = activePty();
  const attn = (id) => status.find((x) => x.id === String(id).split(':')[0])?.attention || null;
  for (const [id, p] of panes) {
    const want = chatShown(id) && id === visible && chatCapable(id) && !chatOff.has(id);
    if (want && !p.chat) {
      const host = document.createElement('div');
      host.className = 'chat-host';
      p.el.append(host);
      p.chat = mountChat(host, { ptyId: id, onTerminal: () => setChatMode(id, false), onCommand: (how, text) => startCommand(id, how, text), screen: () => p.term.screen() });
    }
    const was = Boolean(p.chatOn);
    p.chatOn = want;
    // the terminal stays laid out under the chat (invisible, not focusable): it keeps its size, so its screen (where
    // Claude Code draws its menus) is read the way the pty draws it
    p.el.classList.toggle('under-chat', want);
    if (want) { p.chat.setAttention(attn(id)); p.chat.show(); if (!was) requestAnimationFrame(() => p.term.fit()); } else p.chat?.hide();
    if (was && !want && id === visible) requestAnimationFrame(() => { p.term.fit(); p.term.focus(); });
  }
  // never over a pane that shows its chat (Studio with the chat view on offers it over any Claude Code tab)
  const canSwitch = Boolean(visible) && !panes.get(visible)?.chatOn && chatButtonFor({ ...chatFacts(visible), capable: chatCapable(visible) });
  if (canSwitch && !chatSwitch) {
    chatSwitch = document.createElement('button');
    chatSwitch.id = 'chat-switch';
    chatSwitch.addEventListener('click', () => { const id = activePty(); if (id) setChatMode(id, true); });
    $('terminal').append(chatSwitch);
  }
  if (chatSwitch) {
    chatSwitch.hidden = !canSwitch;
    // v3.137 Studio: the way back from a terminal is a "Back to chat" pill (same button, same click)
    if (studioOn) chatSwitch.replaceChildren(icon('back', 14), document.createTextNode(t('chat.backToChat')));
    else chatSwitch.textContent = t('chat.chat');
    chatSwitch.title = t(studioOn ? 'chat.backToChat' : 'chat.chatTitle');
  }
}

/** v3.80 the chat view setting from main's prefs (startup and the settings checkbox). */
function applyChatView(p) {
  chatView = p?.chatView === true;
  // v3.110 the tabs kept in the terminal across an app restart (main's state.json), once at startup
  if (!chatOffSeeded && Array.isArray(p?.termTabs)) { chatOffSeeded = true; for (const id of p.termTabs) if (typeof id === 'string') chatOff.add(id); }
  sidebar?.setChatView?.(chatView);
  syncChat();
  focusActive();
}

/** v3.120 the experience from main's prefs (startup, the settings, ⌘⇧E): body.studio and Studio's sidebar; the Office's
 * panes, tabs and sessions stay as they are, so switching back shows the Office exactly as it was. */
function applyExperience(p) {
  experience = p?.experience === 'studio' ? 'studio' : 'office';
  studioOn = experience === 'studio';
  studio?.setOn(studioOn);
  sidebar?.setExperience?.(experience);
  syncExperienceSwitch();
  applyAppearance();
  render();
  focusActive();
}
/** v3.120 the title bar's Studio switch follows the experience and the language. */
function syncExperienceSwitch() {
  const btn = $('experience-switch');
  if (!btn) return;
  const s = experienceSwitch(experience, isMac);
  btn.setAttribute('aria-checked', s.ariaChecked);
  btn.classList.toggle('on', s.checked);
  const label = btn.querySelector('.xs-label');
  if (label) label.textContent = t('studio.switchLabel');
  btn.title = t('studio.switchTitle', { key: s.hotkey });
  btn.setAttribute('aria-label', t('studio.switchLabel'));
}
$('experience-switch')?.addEventListener('click', () => setExperience(otherExperience(experience)));
onLang(syncExperienceSwitch);
function setExperience(value) {
  applyExperience({ experience: value });
  api.prefs?.set({ experience: value }).then((r) => { if (r && r.experience !== experience) applyExperience(r); }).catch((e) => console.error(e));
}

let shownId; // visible terminal; focus/resize only when it changes
let shownSent; // last tab told to main (pty:shown): main types a routine into HQ only when HQ is not on screen
function showActive() {
  const visible = activePty();
  for (const [id, p] of panes) p.el.hidden = id !== visible;
  $('empty').hidden = projects.length > 0;
  renderTabs();
  // the shown tab always runs: a sleeping claude starts (and continues its session)
  if (visible && isAsleep(visible)) api.pty.wake?.(visible);
  if (shownSent !== visible) { shownSent = visible; api.pty.shown?.(visible || ''); }
  syncChat();
  if (shownId === visible) return;
  shownId = visible;
  const p = panes.get(visible);
  if (p) requestAnimationFrame(() => { p.term.fit(); (p.chatOn ? p.chat : p.term).focus(); });
}

// The tab strip shows only when the project has more than one tab; a single terminal looks as before
// (then "+" sits in the terminal's top-right corner and appears on hover).
const baseName = (d) => String(d || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''; // '/' or Windows '\\'
function tabButton(p, tab, active, running) {
  const n = tab?.n ?? MAIN_TAB;
  const dir = tab?.dir || p.dir;
  const b = document.createElement('div');
  const sleeping = !running && isAsleep(tabPtyId(p.id, n));
  b.className = 'tab' + (n === active ? ' active' : '') + (running ? '' : sleeping ? ' asleep' : ' stopped') + (tab?.worktree ? ' worktree' : '') + (tab?.shell ? ' shell' : '');
  b.dataset.n = String(n);
  b.title = (tab?.shell ? t('app.shellTab', { dir }) : tab?.worktree ? t('app.worktreeTab', { branch: tab.worktree.branch, dir }) : n === MAIN_TAB ? t('app.mainTab', { dir }) : t('app.sameTab', { dir })) + (running ? '' : sleeping ? t('app.asleep') : t('app.stopped'));
  const num = document.createElement('span');
  num.className = 'tab-n';
  num.textContent = String(n);
  const label = document.createElement('span');
  label.className = 'tab-label';
  // v3.83 a desk shows its staff member's name
  const member = tab?.staffId ? staffList.find((m) => m.id === tab.staffId) : null;
  label.textContent = member ? `● ${member.name}` : tab?.shell ? `› ${baseName(dir)}` : tab?.worktree ? `⎇ ${tab.worktree.branch}` : baseName(dir);
  b.append(num, label);
  b.addEventListener('click', () => { userSelect(); selectTab(p.id, n); });
  if (tab) {
    const x = document.createElement('button');
    x.className = 'tab-x';
    x.textContent = '×';
    x.title = t('app.closeTab');
    x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(p.id, n); });
    b.append(x);
  }
  return b;
}
function renderTabs() {
  const p = activeProject();
  const strip = $('tabs');
  const many = Boolean(p && tabsOf(p).length);
  strip.hidden = !many;
  $('terminal').classList.toggle('has-tabs', many);
  $('tab-add').hidden = !p || many;
  $('tab-add').title = t(isMac ? 'app.newTabMac' : 'app.newTab');
  if (!many) { strip.replaceChildren(); return; }
  const st = status.find((x) => x.id === p.id);
  const runningOf = (n) => (n === MAIN_TAB ? st?.isRunning !== false : st?.tabs?.find((x) => x.n === n)?.isRunning !== false);
  const active = tabOf(p);
  const add = document.createElement('button');
  add.className = 'tab-new';
  add.textContent = '+';
  add.title = t(isMac ? 'app.newTabMac' : 'app.newTab');
  add.addEventListener('click', () => addTab(p.id));
  strip.replaceChildren(
    tabButton(p, null, active, runningOf(MAIN_TAB)),
    ...tabsOf(p).map((tab) => tabButton(p, tab, active, runningOf(tab.n))),
    add,
  );
}

/** v3.158 a person's own selection of a local session closes a remote session shown in the main chat (programmatic selects do not). */
const userSelect = () => window.dispatchEvent(new Event('ao:local-select'));
function selectTab(projectId, n) {
  activeTab.set(projectId, n);
  render();
  focusActive();
}
// without mode, main asks (in a git repo, a menu: same folder / new worktree).
async function addTab(projectId, mode) {
  if (!projectId) return;
  try {
    const tab = await api.tabs?.add(projectId, mode);
    if (tab?.n) {
      applyProjects(await api.projects.list());
      selectTab(projectId, tab.n);
      return tab.n;
    }
  } catch (e) { console.error(e); }
  focusActive();
  return 0;
}
/**
 * v3.120 Studio UX start screen: a new tab (same folder or a new worktree), then the chosen model and mode through
 * chat:setting once its GUI chat runs (tabs start with the project's own), then the first prompt. Each setting must
 * answer 'ok' (only 'not-running' and 'busy' are tried again, for START_WAIT_MS); anything else stops the start before
 * the prompt is sent, so a prompt never runs with a mode or model other than the one chosen. plan.reuseN: the tab an
 * earlier failed start of the same project created (used again instead of a second tab while it is still open).
 * → { ok, n, failed?: { step: 'tab' | 'model' | 'mode' | 'prompt', why, detail } }
 * @param {string} projectId @param {{ tabMode: 'same' | 'worktree', settings: [string, string][], reuseN?: number }} plan @param {string} text
 */
async function startStudioSession(projectId, plan, text) {
  leaveBoard();
  selectProject(projectId);
  const p = projects.find((x) => x.id === projectId);
  const reuse = plan.reuseN && p && tabsOf(p).some((x) => x.n === plan.reuseN) ? plan.reuseN : 0;
  const n = reuse || await addTab(projectId, plan.tabMode);
  if (!n) return { ok: false, n: 0, failed: { step: 'tab', why: 'other', detail: '' } };
  if (reuse) selectTab(projectId, n);
  const pty = tabPtyId(projectId, n);
  const wait = () => new Promise((r) => setTimeout(r, 400));
  /** @param {'model' | 'mode' | 'prompt'} step @param {() => Promise<any>} call */
  const until = async (step, call) => {
    const t0 = Date.now();
    for (;;) {
      const r = await call().catch(() => 'error');
      const next = startStep(r, Date.now() - t0);
      if (next === 'ok') return null;
      if (next === 'fail') return { step, ...startFailure(r) };
      await wait();
    }
  };
  for (const [key, value] of plan.settings) {
    const failed = await until(key === 'model' ? 'model' : 'mode', () => api.chat.setting(pty, key, value));
    if (failed) return { ok: false, n, failed };
  }
  const failed = await until('prompt', () => api.chat.send(pty, text));
  return failed ? { ok: false, n, failed } : { ok: true, n };
}
async function closeTab(projectId, n) {
  try {
    const r = await api.tabs?.close(projectId, n);
    // git did not remove the worktree: claude restarted in the same tab from its last session
    if (r?.restarted) panes.get(tabPtyId(projectId, n))?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
  focusActive();
}
/** ⇧⌘[ / ⇧⌘] (Linux: Ctrl+Shift+PageUp/PageDown): previous/next tab in the active project. */
function cycleTab(step) {
  const p = activeProject();
  if (!p || !tabsOf(p).length) return;
  const ns = [MAIN_TAB, ...tabsOf(p).map((x) => x.n)];
  const i = ns.indexOf(tabOf(p));
  userSelect();
  selectTab(p.id, ns[(i + step + ns.length) % ns.length]);
}

// `login:<account>` ids go to the login overlay; a project pane is never built for them.
api.pty.onData((id, d) => {
  if (isLoginId(id)) return login?.write(id, d);
  const p = panes.get(id);
  if (p) return p.term.write(d);
  const buf = pending.get(id) || { data: '', exited: false };
  buf.data = (buf.data + d).slice(-BUFFER_MAX);
  buf.exited = false;
  pending.set(id, buf);
});
api.pty.onReloaded?.((id) => panes.get(id)?.term.reloaded());
api.chat?.onMoved?.((id) => panes.get(id)?.term.reset({ restarting: true }));   // v3.108 the chat view setting moved an idle tab
api.pty.onSleep?.((id) => {
  panes.get(id)?.term.sleep();
  pending.delete(id);
});
api.pty.onExit((id, code) => {
  if (isLoginId(id)) return login?.exit(id, code);
  const p = panes.get(id);
  if (p) return p.term.exit();
  const buf = pending.get(id) || { data: '', exited: false };
  buf.exited = true;
  pending.set(id, buf);
});

// ---- State ----
let office = null;
let studioScene = null;   // v3.137 Studio's isometric strip (studio-scene.js); #office is hidden in Studio
// Only one scene renders: the Office's pixel scene outside Studio, the isometric strip in Studio (not on the HQ board);
// both pause while the scene is collapsed (officeHidden). Run on every body class change and by setSceneHidden.
function syncScenes() {
  const cl = document.body.classList;
  const studioOn = cl.contains('studio');
  const hidden = cl.contains('office-hidden');
  if (studioOn || hidden) office?.pause?.(); else office?.resume?.();
  if (studioOn && !hidden && !cl.contains('studio-board')) studioScene?.resume(); else studioScene?.pause();
}
// v3.81 the 3D office setting (main's prefs); applied to the office view once it is mounted
let office3dOn = false;
function applyOffice3d(p) {
  office3dOn = p?.office3d === true;
  sidebar?.setOffice3d?.(office3dOn);
  office?.set3d?.(office3dOn);
}
let sidebar = null;

function render() {
  studio?.changed();   // v3.120 Studio's sidebar follows the projects, tabs and the active session
  if (!projects.some((p) => p.id === activeId)) activeId = shownOrder(projects)[0]?.id ?? projects[0]?.id ?? null;
  syncPanes();
  showActive();
  sidebar?.setState({ projects, activeId: hqSelected ? HQ_ROW.id : activeId, status, accounts });
  setTitleProject();
  const name = activeProject()?.name ?? null;
  if (office && name !== focusName) {
    focusName = name;
    try { office.setFocus?.(name); } catch (e) { console.error(e); }
  }
}

function applyProjects(s) {
  if (!s) return;
  projects = s.projects || [];
  activeId = s.activeId ?? null;
  status = s.status || [];
  render();
}

function setAccounts(list) {
  accounts = Array.isArray(list) ? list : [];
  login?.setAccounts(accounts);
  render();
}

async function refreshAccounts() {
  try { setAccounts(await api.accounts.list()); } catch (e) { console.error(e); render(); }
}

// ---- Actions ----
/** v3.83 team mode and the staff into the sidebar (and the staff's names for desk tabs). */
let staffList = [];
let teamOn = false;
let deskList = [];
async function loadStaff() {
  try {
    const v = await api.staff?.list();
    staffList = Array.isArray(v?.staff) ? v.staff : [];
    teamOn = v?.teamMode === true;
    sidebar?.setTeam(v);
    renderTabs();
  } catch (e) { console.error(e); }
}
api.staff?.onDesks?.((list) => { deskList = Array.isArray(list) ? list : []; sidebar?.setDesks?.(list); });
/** v3.83 the office gets the team: each member's own desk, and whether (and on which projects) it is at work. */
function withStaff(d) {
  if (!teamOn || !staffList.length || !d) return d;
  const name = (pid) => projects.find((p) => p.id === pid)?.name;
  return { ...d, staff: staffList.map((m) => {
    const at = deskList.filter((x) => x.staffId === m.id && x.state === 'busy').map((x) => name(x.projectId)).filter(Boolean);
    return { id: m.id, name: m.name, busy: at.length > 0, projects: at };
  }) };
}
/**
 * v3.83 opens a member's desk in a project and shows it.
 * @returns {Promise<string | null>} the desk's pty id, or null when the desk did not open
 */
async function openDesk(projectId, staffId) {
  const r = await (projectId ? api.staff?.desk(projectId, staffId) : api.staff?.personal?.(staffId))?.catch(() => null);
  if (!r?.ok || !r.id) { if (r?.error) alert(t(`staff.deskError.${['staff-not-allowed', 'engine', 'git'].includes(r.error) ? r.error : 'failed'}`)); return null; }
  applyProjects(await api.projects.list());
  const [pid, n] = String(r.id).split(':');
  selectProject(pid);
  if (n) selectTab(pid, Number(n));
  setTimeout(focusActive, 50);   // v3.90: the desk's input is ready to type in
  return tabPtyId(pid, n ? Number(n) : MAIN_TAB);
}
async function addProject() {
  try {
    const p = await api.projects.add();
    if (p) applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

// MCP servers (contract v3.44): one list per project; the ones added here restart the idle sessions they reach.
async function mcpChange(call) {
  try {
    const r = await call();
    for (const pid of r?.restarted || []) panes.get(pid)?.term.reset({ restarting: true });
    return r;
  } catch (e) { console.error(e); return { ok: false, error: 'failed' }; }
}

function selectProject(id) {
  if (id === HQ_ROW.id) { hqSelected = true; hqUi?.setSelected(true); render(); return focusActive(); }
  if (!id || !projects.some((p) => p.id === id)) return;
  const wasHq = hqSelected;
  hqSelected = false;
  hqUi?.setSelected(false);
  if (wasHq && id === activeId) { render(); focusActive(); return; }
  if (id !== activeId) {
    activeId = id; // show immediately; onChange confirms
    render();
    api.projects.setActive(id).catch((e) => console.error(e));
  } else focusActive();
}

async function removeProject(p) {
  if (!confirm(t('app.removeProject', { name: p.name }))) return focusActive();
  try {
    await api.projects.remove(p.id);
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Per-project manager mode (v3.10): true | false | null; main restarts the idle tabs, whose terminals start over. */
async function setProjectManager(projectId, value) {
  try {
    const r = await api.projects.setManager?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Per-project boss model (v3.27): 'sonnet' | 'opus' | 'haiku' | null (Auto); main restarts the idle tabs. */
async function setBossModel(projectId, value) {
  try {
    const r = await api.projects.setBossModel?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Per-project subagent model (v3.14): 'sonnet' | 'haiku' | 'opus' | null (Auto); main restarts the idle tabs. */
async function setAgentModel(projectId, value) {
  try {
    const r = await api.projects.setAgentModel?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Opt-in project files (v3.38): true | false; main writes or removes its files and restarts the idle tabs. */
async function setProjectFiles(projectId, value) {
  try {
    const r = await api.projects.setProjectFiles?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Skip permissions (v3.72): true | false; main restarts the idle tabs. */
async function setSkipPermissions(projectId, value) {
  try {
    const r = await api.projects.setSkipPermissions?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** v3.133 economy override ('inherit' | 'on' | 'off') and token budget; main restarts the idle tabs. */
async function setProjectEconomy(projectId, value) {
  try {
    const r = await api.projects.setEconomy?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}
async function setBudget(projectId, value) {
  try { await api.projects.setBudget?.(projectId, value); applyProjects(await api.projects.list()); } catch (e) { console.error(e); }
}

/** Use my shared MCP servers (v3.128): true | false; main restarts the idle tabs. */
async function setProjectShareMcp(projectId, value) {
  try {
    const r = await api.projects.setShareMcp?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Auto-approve permission prompts (v3.71): true | false; main restarts the idle tabs. */
async function setAutoApprove(projectId, value) {
  try {
    const r = await api.projects.setAutoApprove?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Per-project context cap (v3.15): 200000 | 400000 | null (Auto); main restarts the idle tabs. */
async function setContextCap(projectId, value) {
  try {
    const r = await api.projects.setContextCap?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Bundled skill packs (v3.45): a global on/off or a project's 'inherit' | 'on' | 'off'; main restarts the idle tabs. */
async function skillPackChange(fn) {
  try {
    const r = await fn();
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
    return r;
  } catch (e) { console.error(e); return null; }
}

/** Per-project savings (v3.20): 'off' | 'normal' | 'strict'; main restarts the idle tabs. */
async function setSavings(projectId, value) {
  try {
    const r = await api.projects.setSavings?.(projectId, value);
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/**
 * Per-project engine (v3.22): 'agy' (Antigravity) | null (Claude Code); main starts every tab of the project again,
 * fresh, or refuses / asks first when a tab is working (r.refused; the row's select goes back on the re-render).
 * The usage panel is Claude Code's only: it closes when its project moves to Antigravity or OpenCode.
 */
async function setEngine(projectId, value) {
  try {
    const r = await api.projects.setEngine?.(projectId, value);
    if ((value === 'agy' || value === 'opencode') && !r?.refused && usagePanel?.shownId() === projectId) usagePanel.hide();
    for (const id of r?.restarted || []) panes.get(id)?.term.reset({ restarting: true });
    applyProjects(await api.projects.list());
    return r;
  } catch (e) { console.error(e); return null; }
}

/** Per-project backup account (v3.17): null (none) | 'auto' | an account id; nothing restarts. */
async function setBackup(projectId, value) {
  try {
    await api.projects.setBackup?.(projectId, value);
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** v3.111 the model to continue with when no account has quota: null (next model below) | 'none' | a model id. */
async function setLimitModel(projectId, value) {
  try {
    await api.projects.setLimitModel?.(projectId, value);
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

/** Per-project delegate accounts (account delegate): account ids; the boss stays manager; nothing restarts. */
async function setDelegates(projectId, ids) {
  try {
    await api.projects.setDelegates?.(projectId, ids);
    applyProjects(await api.projects.list());
  } catch (e) { console.error(e); }
}

async function setAccount(projectId, accountId) {
  // a new claude starts in every tab with the new account
  const proj = projects.find((p) => p.id === projectId);
  for (const id of proj ? ptyIdsOf(proj) : [projectId]) panes.get(id)?.term.reset({ restarting: true });
  hint(projectId, '');
  try {
    await api.projects.setAccount(projectId, accountId);
    applyProjects(await api.projects.list());
    if (accounts.find((a) => a.id === accountId)?.auth?.state === 'out') hint(projectId, t('app.loginHint'));
  } catch (e) { console.error(e); }
  if (projectId !== activeId) selectProject(projectId);
  else focusActive();
}

// Adding a new account opens the login overlay right away.
// With projectId ("+ Yeni hesap…" in a project row), the new account is assigned to that project at once.
async function addAccount(label, projectId) {
  let a = null;
  try { a = await api.accounts.add(label); } catch (e) { console.error(e); }
  if (a?.id && projectId) try { await api.projects.setAccount(projectId, a.id); } catch (e) { console.error(e); }
  await refreshAccounts();
  if (a?.id) openLogin(a.id, a);
}

function openLogin(id, fallback) {
  const a = accounts.find((x) => x.id === id) || fallback;
  if (a) login.open(a);
}

async function logoutAccount(a) {
  if (a.id === 'default') return; // the system's Claude Code login cannot be signed out from here
  if (!confirm(t('app.logout', { label: a.label }))) return focusActive();
  try { await api.accounts.logout(a.id); } catch (e) { console.error(e); }
  await refreshAccounts();
}

async function refreshAuth(id) {
  try {
    const list = await api.accounts.refreshAuth(id);
    if (Array.isArray(list)) return setAccounts(list);
  } catch (e) { console.error(e); }
  await refreshAccounts();
}

async function renameAccount(id, label) {
  try { await api.accounts.rename(id, label); } catch (e) { console.error(e); }
  await refreshAccounts();
}

async function setAccountShare(id, on) {
  try { await api.accounts.setShare?.(id, on); } catch (e) { console.error(e); }
  await refreshAccounts();
}

async function removeAccount(a) {
  const users = projects.filter((p) => p.accountId === a.id).length;
  const note = users ? t('app.removeAccountNote', { n: users }) : '';
  if (!confirm(t('app.removeAccount', { label: a.label, note }))) return;
  try { await api.accounts.remove(a.id); } catch (e) { console.error(e); }
  await refreshAccounts();
  try { applyProjects(await api.projects.list()); } catch {}
}

// ---- Sidebar ----
sidebar = mountSidebar($('sidebar'), {
  select: selectProject,
  openWhatsNew: () => openWhatsNew(),   // v3.123 Settings → About
  appVersion: () => appVersion,
  showPanel: (sel) => Boolean(studio?.showPanel(sel)),   // v3.122 an Office panel on its own over Studio
  addProject,
  setBotColor,
  removeProject,
  openFolder: (p) => api.projects.openFolder?.(p.id).catch((e) => console.error(e)),
  projectMenu: (p) => api.projects.menu?.(p.id).catch((e) => console.error(e)),
  setGroup: (id, group) => api.projects.setGroup?.(id, group).catch((e) => console.error(e)),   // v3.86
  setAccount,
  setProjectManager,
  setBossModel,
  effectiveModel: (id) => Promise.resolve(api.projects.effectiveModel?.(id)).catch((e) => { console.error(e); return null; }),
  setAgentModel,
  setProjectFiles,
  setAutoApprove,
  setProjectShareMcp,
  setProjectEconomy,
  setBudget,
  setSkipPermissions,
  setContextCap,
  setSavings,
  setEngine,
  setBackup,
  setLimitModel,
  setDelegates,
  addAccount,
  renameAccount,
  removeAccount,
  setShare: setAccountShare,
  login: (id) => openLogin(id),
  logout: logoutAccount,
  refreshAuth,
  agyLogin: () => openAgy('login'),
  agyLogout: () => openAgy('logout'),
  agyRefresh: () => api.agy?.auth(true).then(setAgyAuth, (e) => console.error(e)),
  cmdLogin: () => openCmd(),
  ocLogin: (mode) => openOc(mode || 'console'),
  ocLogout: () => openOc('logout'),
  ocRefresh: () => api.oc?.auth(true).then(setOcAuth, (e) => console.error(e)),
  cmdRefresh: () => api.cmd?.auth(true).then(setCmdAuth, (e) => console.error(e)),
  addAgy: () => addEngineAccount('agy'),
  addCmd: () => addEngineAccount('cmd'),
  addOc: () => addEngineAccount('oc'),
  hideOc: () => setEngineRow('showOcAccount', false),
  hideAgy: () => setEngineRow('showAgyAccount', false),
  hideCmd: () => setEngineRow('showCmdAccount', false),
  setLanguage: (setting) => api.language?.set(setting).catch((e) => console.error(e)),
  setResume: (on) => api.prefs?.set({ resume: on }).then((p) => sidebar.setResume(p?.resume)).catch((e) => console.error(e)),
  resumeUnfinished,
  setResumeWork: (on) => api.prefs?.set({ resumeWork: on }).then((p) => sidebar.setResumeWork(p?.resumeWork)).catch((e) => console.error(e)),
  setManager: (on) => api.prefs?.set({ manager: on }).then((p) => sidebar.setManager(p?.manager)).catch((e) => console.error(e)),
  setShareMcp: (on) => api.prefs?.set({ shareMcp: on }).then((p) => sidebar.setShareMcp(p?.shareMcp)).catch((e) => console.error(e)),
  setReloadMcp: (on) => api.prefs?.set({ reloadMcp: on }).then((p) => sidebar.setReloadMcp(p?.reloadMcp)).catch((e) => console.error(e)),
  setExperience: (v) => setExperience(v === 'studio' ? 'studio' : 'office'),   // v3.120
  setChatView: (on) => api.prefs?.set({ chatView: on }).then(applyChatView).catch((e) => console.error(e)),   // v3.80
  setOffice3d: (on) => api.prefs?.set({ office3d: on }).then(applyOffice3d).catch((e) => console.error(e)),   // v3.81
  // v3.83 team: the setting and the member popup's calls; every change reloads the list from main
  team: {
    setMode: (on) => api.prefs?.set({ teamMode: on }).then(loadStaff).catch((e) => console.error(e)),
    save: (form) => api.staff.save(form).then((r) => { loadStaff(); return r; }).catch(() => ({ ok: false, error: 'failed' })),
    reload: () => loadStaff(),
    remove: (id) => api.staff.remove(id).then((r) => { loadStaff(); return r; }).catch(() => ({ ok: false, error: 'failed' })),
    openDesk: (projectId, staffId) => openDesk(projectId, staffId),
    openPersonal: (staffId) => openDesk('', staffId),   // v3.83 amendment: the member's personal workspace
    setParallel: (projectId, on) => api.staff.setParallel(projectId, on).catch((e) => console.error(e)),
    // v3.84 the role library and the wizard
    saveRole: (form) => api.roles.save(form).then(async (r) => { await loadStaff(); return r; }).catch(() => ({ ok: false, error: 'failed' })),
    removeRole: (id) => api.roles.remove(id).then((r) => { loadStaff(); return r; }).catch(() => ({ ok: false, error: 'failed' })),
    wizard: (req) => api.roles.wizard(req).catch(() => ({ ok: false, error: 'failed' })),
    tools: () => (api.mcp?.apps ? api.mcp.apps().then((r) => r?.servers || []).catch(() => []) : Promise.resolve([])),
  },
  mail: api.mail || null,   // v3.85 the MAIL panel talks to main directly (renderer/mail.js)
  setFallback: (on) => api.prefs?.set({ fallback: on }).then((p) => sidebar.setFallback(p?.fallback)).catch((e) => console.error(e)),
  setSleep: (minutes) => api.prefs?.set({ sleepMinutes: minutes }).then((p) => sidebar.setSleep(p?.sleepMinutes)).catch((e) => console.error(e)),
  setEconomy: (v) => api.prefs?.set({ economy: v }).then((p) => sidebar.setEconomy(p?.economy)).catch((e) => console.error(e)),
  setKeepAwake: (v) => api.prefs?.set({ keepAwake: v }).then((p) => sidebar.setKeepAwake(p?.keepAwake)).catch((e) => console.error(e)),
  setTheme: setThemeSetting,
  setLook: (v) => setAppearance({ look: v }),
  setMode: (v) => setAppearance({ mode: v }),
  openUsage: (p) => usagePanel?.show(p),
  skillPacks: {
    list: (projectId) => (api.skillPacks ? api.skillPacks.list(projectId).catch(() => null) : Promise.resolve(null)),
    set: (id, on) => skillPackChange(() => api.skillPacks?.set(id, on)),
    setProject: (projectId, values) => skillPackChange(() => api.projects.setSkillPacks?.(projectId, values)),
  },
  mcp: { list: (id) => api.mcp.list(id).catch(() => null), add: (f) => mcpChange(() => api.mcp.add(f)), get: (id) => api.mcp.get(id).catch(() => null), update: (id, f) => mcpChange(() => api.mcp.update(id, f)), getFile: (pid, where, name) => api.mcp.getFile(pid, where, name).catch(() => null), updateFile: (pid, where, name, f) => api.mcp.updateFile(pid, where, name, f).catch(() => ({ ok: false, error: 'failed' })), remove: (id) => mcpChange(() => api.mcp.remove(id)), apps: () => api.mcp.apps?.().catch(() => null), scope: (id, scope) => mcpChange(() => api.mcp.scope(id, scope)) },   // apps/scope: v3.82
});

login = mountLogin(document.body, { getTheme: () => termTheme(), onClose: () => focusActive() });

// Antigravity's login (contract v3.24): one per user, agy itself in the 'login:agy' pty. Log out = /logout at its prompt.
function setAgyAuth(a) { if (a) sidebar.setAgyAuth(a); }
function openAgy(mode) {
  if (!api.agy) return;
  login.open({ id: 'agy', label: 'Antigravity' }, {
    start: () => api.agy.login(),
    hint: () => t(mode === 'logout' ? 'login.agyLogoutHint' : 'login.agyHint'),
    title: () => t(mode === 'logout' ? 'login.agyLogoutTitle' : 'login.title', { label: 'Antigravity' }),
  });
}
api.agy?.onAuth(setAgyAuth);
api.agy?.auth().then(setAgyAuth, (e) => console.error(e));

// Command Code's login (contract v3.30): one per user, `commandcode login` in the 'login:cmd' pty.
function setCmdAuth(a) { if (a) sidebar.setCmdAuth(a); }
function openCmd() {
  if (!api.cmd) return;
  login.open({ id: 'cmd', label: 'Command Code' }, {
    start: () => api.cmd.login(),
    hint: () => t('login.cmdHint'),
    title: () => t('login.title', { label: 'Command Code' }),
  });
}
api.cmd?.onAuth(setCmdAuth);
api.cmd?.auth().then(setCmdAuth, (e) => console.error(e));

// OpenCode's logins (contract v3.40): 'console' (device code) or 'auth' (one provider) in the 'login:oc' pty, first
// asked of the user (the login chooser menu), and 'logout'. Not logged in is normal: its free models need no login.
function setOcAuth(a) { if (a) sidebar.setOcAuth(a); }
function openOc(mode) {
  if (!api.oc) return;
  login.open({ id: 'oc', label: 'OpenCode' }, {
    start: () => api.oc.login(mode),
    hint: () => t(mode === 'logout' ? 'login.ocLogoutHint' : 'login.ocHint'),
    title: () => t(mode === 'logout' ? 'login.ocLogoutTitle' : 'login.title', { label: 'OpenCode' }),
  });
}
api.oc?.onAuth(setOcAuth);
api.oc?.auth().then(setOcAuth, (e) => console.error(e));

// Add account → Google Antigravity / Command Code (contract v3.30) / OpenCode (v3.40): the row stays in Accounts (showAgyAccount /
// showCmdAccount); installed and not logged in → its login starts; not installed → the row shows the install line.
async function setEngineRow(key, on) {
  try { sidebar.setEngineRows(await api.prefs?.set({ [key]: on })); } catch (e) { console.error(e); }
}
async function addEngineAccount(kind) {
  const engine = kind === 'agy' ? api.agy : kind === 'oc' ? api.oc : api.cmd;
  if (!engine) return;
  await setEngineRow(kind === 'agy' ? 'showAgyAccount' : kind === 'oc' ? 'showOcAccount' : 'showCmdAccount', true);
  let a = null;
  try { a = await engine.auth(true); } catch (e) { console.error(e); }
  if (kind === 'agy') setAgyAuth(a); else if (kind === 'oc') setOcAuth(a); else setCmdAuth(a);
  // OpenCode needs no login (free models): adding its row only shows it; signing in is a button on the row
  if (kind === 'oc' || !a?.installed || a.state === 'in') return;
  if (kind === 'agy') openAgy('login'); else openCmd();
}

function setCollapsed(c) {
  document.body.classList.toggle('sidebar-collapsed', c);
  $('toggle-sidebar').title = c ? t('app.showSidebar') : t('app.hideSidebar');
  store.set('sidebarCollapsed', c ? '1' : '0');
  requestAnimationFrame(() => panes.get(activePty())?.term.fit());
}
$('settings').addEventListener('click', () => (studio?.isOn() ? studio.openSettings() : sidebar?.openSettings()));
$('toggle-sidebar').addEventListener('click', () => {
  setCollapsed(!document.body.classList.contains('sidebar-collapsed'));
  focusActive();
});
// bot color: user's choice, stored on this computer
function setBotColor(hex) {
  store.set('botColor', hex || '');
  office?.setBotColor?.(hex);
  sidebar.setBotColor(hex);
}

setCollapsed(store.get('sidebarCollapsed') === '1');

// ---- Appearance (v3.74): the setting lives in main (prefs look/mode); the last value is cached here so the page
// has it before prefs arrive (appearance-boot.js applies it before the first paint). Switching applies at once, no reload.
function adoptAppearance(p) {
  look = normalizeLook(p?.look);
  modeSetting = normalizeMode(p?.mode);
  store.set('look', look);
  store.set('mode', modeSetting);
  sidebar.setAppearance(look, modeSetting);
  applyAppearance();
}
let appearanceRequest = 0;
function setAppearance(p) {
  adoptAppearance({ look, mode: modeSetting, ...p });
  // only the latest request's reply is adopted: an older reply would roll a newer choice back for a moment
  const request = ++appearanceRequest;
  api.prefs?.set(p).then((r) => {
    if (request === appearanceRequest && r && (r.look !== look || r.mode !== modeSetting)) adoptAppearance(r);
  }).catch((e) => console.error(e));
}
adoptAppearance({ look: store.get('look'), mode: store.get('mode') });

// ---- Theme picker (v3.1): 'auto' picks by project (core.mjs), a name forces that theme for the whole office.
// The frame colours follow through onTheme → applyTheme; the bot color picker still wins over a theme's bot colours.
let officeThemes = {}; // gallery + user themes.json (main, office:themes)
let themeSetting = 'auto';
function applyThemeChoice() {
  sidebar.setThemes(themeChoices(officeThemes), themeSetting);
  try { office?.setTheme?.(effectiveTheme(themeSetting, officeThemes)); } catch (e) { console.error(e); }
}
function setThemeSetting(name) {
  themeSetting = name;
  applyThemeChoice();
  api.prefs?.set({ theme: name }).then((p) => {
    if (typeof p?.theme === 'string' && p.theme !== themeSetting) { themeSetting = p.theme; applyThemeChoice(); }
  }).catch((e) => console.error(e));
}

// ---- Language: title, empty state and hints; sidebar, office and panel redraw themselves ----
function applyStaticText() {
  $('title').textContent = (look === 'claude' ? t('app.appTitlePlain') : t('app.appTitle'));
  setVersionTitle();
  $('empty-title').textContent = t('app.emptyTitle');
  $('empty-add').textContent = t('app.emptyAdd');
  $('empty-add').title = t('app.emptyAddTitle', { mod: modLabel });
  $('empty-note').textContent = t('app.emptyNote');
  $('toggle-sidebar').title = document.body.classList.contains('sidebar-collapsed') ? t('app.showSidebar') : t('app.hideSidebar');
  $('settings').title = t('sidebar.settingsTitle');
  $('settings').setAttribute('aria-label', t('sidebar.settings'));
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.hint-close'))) b.title = t('app.close');
  setTitleProject();
  setStats(lastStats);
  renderTabs();
  if (updateVersion) showUpdate(updateVersion);
}
async function applyLanguage(li) {
  if (!li) return;
  await setLang(li.lang);
  // the office's drawn text (core.mjs) knows only English and Turkish; other languages get English
  try { office?.setLanguage?.(li.lang === 'tr' ? 'tr' : 'en'); } catch (e) { console.error(e); }
  sidebar.setLanguage(li);
}
onLang(applyStaticText);
onLang(() => { for (const p of panes.values()) p.chat?.texts(); syncChat(); });   // v3.80
applyStaticText();
// "Resume unfinished work" (contract v3.8): the sidebar button; the app menu's item sends its result as work:resumed
async function resumeUnfinished() {
  sidebar.setResuming(true);
  try { sidebar.showResumed(await api.work?.resumeUnfinished()); } catch (e) { console.error(e); }
  finally { sidebar.setResuming(false); }
}
api.work?.onResumed?.((r) => sidebar.showResumed(r));

// v3.85 mail: accounts and the outbox, then their changes
if (api.mail) {
  api.mail.accounts().then((v) => sidebar?.setMailAccounts(v)).catch(() => {});
  api.mail.outbox().then((v) => sidebar?.setMailOutbox(v)).catch(() => {});
  api.mail.onAccounts?.((v) => { sidebar?.setMailAccounts(v); loadStaff(); });
  api.mail.onOutbox?.((v) => sidebar?.setMailOutbox(v));
}
const prefsReady = api.prefs?.get().then((p) => {
  sidebar.setResume(p?.resume);
  sidebar.setResumeWork(p?.resumeWork);
  sidebar.setManager(p?.manager);
  sidebar.setShareMcp(p?.shareMcp);
  sidebar.setReloadMcp(p?.reloadMcp);
  applyChatView(p);
  applyExperience(p);
  applyOffice3d(p);
  loadStaff();
  api.staff?.desks?.().then((d) => { deskList = Array.isArray(d) ? d : []; sidebar.setDesks?.(d); }).catch(() => {});
  sidebar.setFallback(p?.fallback);
  sidebar.setSleep(p?.sleepMinutes);
  sidebar.setKeepAwake(p?.keepAwake);
  sidebar.setEconomy(p?.economy);
  sidebar.setEngineRows(p);
  if (typeof p?.theme === 'string') themeSetting = p.theme;
  applyThemeChoice();
  adoptAppearance(p);
}).catch((e) => console.error(e));

$('empty-add').addEventListener('click', addProject);
$('tab-add').addEventListener('click', () => addTab(activeId));

// ⌘V (Ctrl+Shift+V on Linux; from the menu): smart paste into the focused terminal; normal paste outside it (e.g. account name).
// v3.112 a chat input with the focus takes Finder files and images itself first (renderer/chat.js paste()).
api.clipboard.onPaste?.(async () => {
  const chat = [...panes.values()].find((p) => p.chat && p.el.contains(document.activeElement))?.chat;
  if (chat && await chat.paste().catch(() => false)) return;
  if (!(await pasteIntoFocused())) api.clipboard.nativePaste();
});

// v3.120 Studio keys (src/studio-keys.mjs): ⌘⇧E (Ctrl+Shift+E) switches Office / Studio; in Studio only, ⌘N new
// session, ⌘K the command palette and ⌘1…9 its sessions (the Office's ⌘1…9 below stays as it is). Registered first, so it wins.
window.addEventListener('keydown', (e) => {
  const k = studioKey({ mac: isMac, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, code: e.code }, experience);
  if (!k || (k.type !== 'toggle' && !studio)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (k.type === 'toggle') setExperience(otherExperience(experience));
  else if (k.type === 'new') studio?.newSession();
  else if (k.type === 'newWorktree') studio?.newWorktreeSession();
  else if (k.type === 'focus') { if (!studio?.focusStart()) focusActive(); }   // ⌘L the composer
  else if (k.type === 'search') studio?.openPalette();   // ⌘K: the command palette (renderer/studio.js)
  else if (k.type === 'settings') studio?.openSettings();   // v3.122 ⌘, Studio's Settings page
  else studio?.selectIndex(k.index);
}, true);

// ⌘O / ⌘1…9 (Ctrl+Shift+O / Ctrl+Shift+1…9 on Linux). A captured key does not reach the terminal (xterm).
window.addEventListener('keydown', (e) => {
  // tabs: on macOS ⇧⌘T new git worktree, ⇧⌘[ and ⇧⌘] previous/next; on Linux Shift is part of the
  // modifier, so previous/next is Ctrl+Shift+PageUp/PageDown (worktree from the "+" menu)
  if (isMac && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
    if (e.code === 'KeyT') { e.preventDefault(); e.stopPropagation(); addTab(activeId, 'worktree'); return; }
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') { e.preventDefault(); e.stopPropagation(); cycleTab(e.code === 'BracketLeft' ? -1 : 1); return; }
    return;
  }
  if (!isMac && e.ctrlKey && e.shiftKey && !e.altKey && (e.code === 'PageUp' || e.code === 'PageDown')) {
    e.preventDefault(); e.stopPropagation(); cycleTab(e.code === 'PageUp' ? -1 : 1); return;
  }
  if (!isModKey(e)) return;
  const key = keyOf(e);
  // ⌘T / Ctrl+Shift+T: new tab (in a git repo, main asks: same folder or worktree)
  if (key === 't') { e.preventDefault(); e.stopPropagation(); addTab(activeId); return; }
  if (key === 'o') { e.preventDefault(); e.stopPropagation(); addProject(); return; }
  if (/^[1-9]$/.test(key)) {
    const p = shownOrder(projects)[Number(key) - 1];   // v3.86 the list's order (groups, no personal workspaces)
    if (p) { e.preventDefault(); e.stopPropagation(); userSelect(); selectProject(p.id); }
  }
}, true);

// a click on the window's empty parts gives the keys back to the terminal (or chat); never one on something that takes
// typing or clicks itself (a text box, a popup, the HQ board and its routine editor, a panel)
document.addEventListener('mouseup', (e) => {
  const el = /** @type {HTMLElement} */ (e.target);
  if (el.isContentEditable || el.closest('button, select, input, textarea, label, a, [role="dialog"], .sb-modal-backdrop, #sidebar, #login-overlay, #hq-board')
    || window.getSelection()?.toString()) return;
  focusActive();
});

let sceneInit = () => {};   // set by the splitter block below; run once the office is mounted
// Draggable splitter: terminal height.
{
  const div = $('divider');
  const saved = Number(store.get('termHeight'));
  if (saved) root.style.setProperty('--term-h', saved + 'px');
  // The drag must always end, even when the pointerup never reaches the bar: a context menu, an OS
  // gesture (pointercancel), losing pointer capture, switching apps mid-drag (blur) or the button
  // already being released when a move arrives. Text selection (document and xterm) is suppressed
  // while dragging, and the panes under the cursor get pointer-events:none via body.dragging.
  /** @type {null | (() => void)} */
  let endDrag = null;
  div.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || endDrag) return;
    if (document.body.classList.contains('office-hidden') || document.body.classList.contains('studio')   // v3.136 Studio's strip has a fixed height
      || /** @type {HTMLElement} */ (e.target).closest('#scene-toggle')) return;
    e.preventDefault(); // no native text selection starting from the bar
    const pointerId = e.pointerId;
    try { div.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
    document.body.classList.add('dragging');
    window.getSelection()?.removeAllRanges();
    const term = panes.get(activePty())?.term;
    const termHadSelection = !!term?.hasSelection?.();
    let lastH = 0;
    const move = (/** @type {PointerEvent} */ ev) => {
      if (ev.pointerId !== pointerId) return;
      if ((ev.buttons & 1) === 0) { end(); return; } // the release was lost somewhere
      const max = window.innerHeight * 0.8;
      lastH = Math.round(Math.min(max, Math.max(120, window.innerHeight - ev.clientY - 8)));
      root.style.setProperty('--term-h', lastH + 'px');
    };
    const onPointerEnd = (/** @type {PointerEvent} */ ev) => { if (ev.pointerId === pointerId) end(); };
    const onVisibility = () => { if (document.hidden) end(); };
    const end = () => {
      if (endDrag !== end) return;
      endDrag = null;
      div.removeEventListener('pointermove', move);
      div.removeEventListener('pointerup', onPointerEnd);
      div.removeEventListener('pointercancel', onPointerEnd);
      div.removeEventListener('lostpointercapture', onPointerEnd);
      window.removeEventListener('pointerup', onPointerEnd, true);
      window.removeEventListener('blur', end);
      document.removeEventListener('visibilitychange', onVisibility);
      try { if (div.hasPointerCapture(pointerId)) div.releasePointerCapture(pointerId); } catch { /* ignore */ }
      document.body.classList.remove('dragging');
      if (lastH) store.set('termHeight', lastH);
      // drop any selection the drag may have started (document or the active xterm)
      window.getSelection()?.removeAllRanges();
      try { if (!termHadSelection) term?.clearSelection?.(); } catch { /* ignore */ }
      focusActive();
    };
    endDrag = end;
    div.addEventListener('pointermove', move);
    div.addEventListener('pointerup', onPointerEnd);
    div.addEventListener('pointercancel', onPointerEnd);
    div.addEventListener('lostpointercapture', onPointerEnd);
    window.addEventListener('pointerup', onPointerEnd, true);
    window.addEventListener('blur', end);
    document.addEventListener('visibilitychange', onVisibility);
  });
  // hide / show the pixel office (the thin bar stays); the state is kept per viewer like the terminal height
  const btn = $('scene-toggle');
  const setSceneHidden = (hidden) => {
    document.body.classList.toggle('office-hidden', hidden);
    store.set('officeHidden', hidden ? '1' : '0');
    btn.textContent = hidden ? '\u25BC' : '\u25B2';
    btn.title = btn.ariaLabel = hidden ? t('app.showOffice') : t('app.hideOffice');
    if (hidden) { try { agentPanel?.hide(); } catch (e) { console.error(e); } }
    syncScenes();
    api.scene?.sendHidden(hidden);
    requestAnimationFrame(() => panes.get(activePty())?.term.fit());
  };
  const toggleScene = () => setSceneHidden(!document.body.classList.contains('office-hidden'));
  btn.addEventListener('click', toggleScene);
  div.addEventListener('dblclick', (e) => { if (!(/** @type {HTMLElement} */ (e.target).closest('#scene-toggle'))) toggleScene(); });
  api.scene?.onToggle(toggleScene);
  sceneInit = () => { if (store.get('officeHidden') === '1') setSceneHidden(true); else setSceneHidden(false); };
}

// ---- Agent details: right-hand panel when a bot is clicked in the office (agent-panel.js) ----
let agentPanel = null;
function selectAgent(id) {
  if (!agentPanel) return;
  if (id) agentPanel.show(id);
  else agentPanel.hide(); // onClose clears the selection
  try { office?.setSelected?.(id || null); } catch (e) { console.error(e); }
}
try {
  const { mountAgentPanel } = await import('./agent-panel.js');
  agentPanel = mountAgentPanel($('agent-panel'), {
    anchor: $('office'),
    onClose: () => { try { office?.setSelected?.(null); } catch {} },
    onSelect: (id) => { try { office?.setSelected?.(id); } catch {} },
    loadToday: () => api.office.today?.() ?? Promise.resolve(null),
    // from panel to terminal: activate that project and focus its terminal
    onOpenProject: (name) => {
      const p = projects.find((x) => x.name === name);
      if (!p) return;
      selectProject(p.id);
      setTimeout(focusActive, 50);
    },
  });
} catch (e) {
  console.warn('Ajan paneli yüklenemedi:', e.message);
}

// ---- Token usage of a project (usage-panel.js, v3.13): opened from the "≈ $… today" line in its row ----
let usagePanel = null;
try {
  const { mountUsagePanel } = await import('./usage-panel.js');
  usagePanel = mountUsagePanel($('usage-panel'), {
    anchor: $('office'),
    load: (id) => api.tokens?.report(id) ?? Promise.resolve(null),
    onClose: () => { studio?.hidePanel(); focusActive(); },
  });
} catch (e) {
  console.warn('Kullanım paneli yüklenemedi:', e.message);
}
api.tokens?.onBrief?.((list) => sidebar.setTokenBriefs(list));

// ---- Office: separate module; without it only the terminal runs ----
try {
  const { mountOffice } = await import('./office-view.js');
  office = mountOffice(/** @type {HTMLCanvasElement} */ ($('office')), { onTheme: applyTheme, onSelect: (id) => selectAgent(id) });
  setBotColor(store.get('botColor') || null);
  office.set3d?.(office3dOn);
  api.office.themes().then((t) => {
    officeThemes = t && typeof t === 'object' ? t : {};
    office.setThemes?.(officeThemes);
    applyThemeChoice();
  }).catch(() => {});
} catch (e) {
  console.warn('Ofis görünümü yüklenemedi:', e.message);
  document.body.classList.add('no-office');
}
try {
  const { mountStudioScene } = await import('./studio-scene.js');
  studioScene = mountStudioScene(/** @type {HTMLCanvasElement} */ ($('studio-scene')), { onSelect: (id) => selectAgent(id) });
  // dev-only hook for visual checks (set localStorage 'sceneDebug' to '1' and reload); off for every normal run
  try { if (localStorage.getItem('sceneDebug') === '1') /** @type {any} */ (window).__studioScene = studioScene; } catch { /* no storage */ }
} catch (e) {
  console.warn('Studio scene could not load:', e.message);
  document.body.classList.add('no-studio-scene');
}
new MutationObserver(syncScenes).observe(document.body, { attributes: true, attributeFilter: ['class'] });
syncScenes();
sceneInit();
onLang(() => sceneInit());

// v3.28: this user's other Agent Offices (renderer/devices.js): Devices section, remote projects, remote desks
let machines = null;
const devices = mountDevices($('sidebar'), api, { onMachines: () => machines?.toggle() });
// v3.32 Machines panel (renderer/machines.js): every machine's resources and projects, over the office like the others
try {
  const { mountMachines } = await import('./machines.js');
  machines = mountMachines($('machines-panel'), { api, view: () => devices.view(), anchor: $('office'), onClose: () => { studio?.hidePanel(); focusActive(); },
    onLogin: (device, account) => login?.openRemote({ api, device, account, view: () => devices.view() }) });   // v3.34 login relay
  devices.onView(() => { machines?.render(); login?.updateRemote(); });
  if (new URLSearchParams(location.search).has('machines')) setTimeout(() => machines?.show(), 300);
} catch (e) {
  console.warn('Makineler paneli yüklenemedi:', e.message);
}
api.office.onData((local) => {
  const d = withStaff(mergeRemote(local, devices.view()));
  setStats(d);
  sidebar.setStats(d?.projects);
  try { office?.setData(d); } catch (e) { console.error(e); }
  try { studioScene?.setData(d); } catch (e) { console.error(e); }
  try { agentPanel?.update(d); } catch (e) { console.error(e); }
});

api.language?.onChange?.(applyLanguage);
applyLanguage(initialLang);

api.projects.onChange(applyProjects);
api.accounts.onChange?.(setAccounts);
// Backup account at the usage limit (v3.17): main moved the project (its terminals start over in the same
// conversations) or found no account to move to; the notice shows over each of its terminals.
api.accounts.onFallback?.((ev) => {
  const proj = projects.find((p) => p.id === ev?.projectId);
  const ids = proj ? ptyIdsOf(proj) : [ev?.projectId];
  if (ev?.kind === 'switched' || ev?.kind === 'returned') for (const id of ids) panes.get(id)?.term.reset({ restarting: true });
  for (const id of ids) hint(id, ev?.text || '');
});
setStats(null);
try { setAccounts(await api.accounts.list()); } catch (e) { console.error(e); }
try { applyProjects(await api.projects.list()); } catch (e) { console.error(e); render(); }

// Files dropped outside the terminal must not navigate the window to that file.
for (const ev of ['dragover', 'drop']) document.addEventListener(ev, (e) => e.preventDefault());

// v3.46 HQ: the pinned row above PROJECTS, the Board in place of the office, paired devices' projects in the list
/**
 * v3.131 a chat card on the board opens its session: the tab that runs it (Office or Studio), else, in Studio, the
 * recent session by its id (studio:open), else the card's project.
 */
async function openBoardChat(card) {
  const p = projects.find((x) => x.id === card?.projectId);
  if (!p) return;
  const tab = card.ptyId === p.id ? MAIN_TAB : tabsOf(p).find((x) => tabPtyId(p.id, x.n) === card.ptyId)?.n || 0;
  leaveBoard();
  if (tab) { selectProject(p.id); selectTab(p.id, tab); return; }
  const r = studioOn && card.sessionId ? await api.studio?.open(p.id, { sessionId: card.sessionId }).catch(() => null) : null;
  selectProject(r?.ok ? r.projectId : p.id);
  if (r?.ok) selectTab(r.projectId, r.n);
}
hqUi = mountHq({ sidebar: $('sidebar'), office: $('office'), api, t, onSelect: () => selectProject(HQ_ROW.id), isMac, link: devices, openChat: (card) => { openBoardChat(card); }, fillHq: (text) => fillHq(text), onBack: () => { leaveBoard(); selectProject(HQ_ROW.id); },
  openBoard: () => { if (document.body.classList.contains('studio')) document.body.classList.add('studio-board'); } });   // v3.135 the Orders strip opens a card on the board

// v3.120 Studio: its sidebar and start screen (renderer/studio.js); the main region is the Office's own #terminal
const leaveBoard = () => document.body.classList.remove('studio-board');
studio = mountStudio({ api, t, modLabel, hooks: {
  selectSession: (projectId, n) => { userSelect(); leaveBoard(); selectProject(projectId); selectTab(projectId, n); },
  newSession: (projectId) => { userSelect(); leaveBoard(); selectProject(projectId); addTab(projectId, 'same'); },
  closeSession: (projectId, n) => { closeTab(projectId, n); },
  selectProject: (projectId) => { userSelect(); leaveBoard(); selectProject(projectId); },
  selectHq: () => { userSelect(); leaveBoard(); selectProject(HQ_ROW.id); },
  openBoard: (tab) => { userSelect(); selectProject(HQ_ROW.id); document.body.classList.add('studio-board'); hqUi?.showBoard(tab === 'reports' ? 'reports' : 'board'); },   // v3.131 the board (renderer/board-view.js): Board, Reports; Routines
  openOfficeSettings: () => sidebar?.openSettings(),
  sidebar: () => sidebar,
  showPanel: (sel) => Boolean(studio?.showPanel(sel)),
  openFloat: (sel) => openFloatPanel(sel),   // v3.122 Usage and Machines over Studio: the Office's own show()
  closeFloat: (sel) => { if (sel === '#usage-panel') usagePanel?.hide(); else if (sel === '#machines-panel') machines?.hide(); },
  appInfo: () => ({ version: appVersion, ready: updateVersion }),
  openWhatsNew: () => openWhatsNew(),   // v3.123 Studio Settings → About
  openDesk: (projectId, staffId) => { leaveBoard(); return openDesk(projectId, staffId); },
  // v3.122 the start screen's Who?: the Office's desk-start path, then the prompt in exactly that desk's session
  // (never the active one): a bounded retry while its chat starts, 'ok' required, any other answer is a failure
  startDesk: async (projectId, staffId, text) => {
    leaveBoard();
    const pty = deskTarget(await openDesk(projectId, staffId), projectId);
    return deskSend({ pty, text, send: (id, x) => api.chat.send(id, x), wait: () => new Promise((r) => setTimeout(r, 400)) });
  },
  installUpdate: () => { if (confirm(t('app.updateConfirm'))) api.update?.install(); },
  toggle: () => setExperience(otherExperience(experience)),
  activePty,
  hasSession: () => Boolean(activePty()),
  commands: (projectId) => studioCommands(projectId),
  // v3.124 the Team page: the same calls as the member popup's (staff:save / staff:remove, then the list again)
  saveMember: (form) => api.staff.save(form).then(async (r) => { await loadStaff(); return r; }).catch(() => ({ ok: false, error: 'failed' })),
  removeMember: (id) => api.staff.remove(id).then(async (r) => { await loadStaff(); return r; }).catch(() => ({ ok: false, error: 'failed' })),
  reloadTeam: () => loadStaff(),
  teamTools: () => (api.mcp?.apps ? api.mcp.apps().then((r) => r?.servers || []).catch(() => []) : Promise.resolve([])),
  startSession: (projectId, plan, text) => startStudioSession(projectId, plan, text),
  projectSettings: (projectId) => studioCommands(projectId).find((c) => c.id === 'projectSettings')?.run(),
  showAccounts: () => studioCommands(studio?.currentProject() || '').find((c) => c.id === 'accounts')?.run(),
  isMac,
} });
mountKeepAwake({ button: $('keep-awake'), t, control: () => sidebar?.settingControl('keepAwake') || null });
// v3.133 the leaf next to it: the global economy switch (the same checkbox as Settings), and the budget banner
mountEconomy({ button: $('economy'), t, control: () => sidebar?.settingControl('economy') || null });
mountBudgetBanner({ api, t, names: () => new Map((sidebar?.projectList?.() || []).map((/** @type {any} */ p) => [p.id, p.name])) });
/**
 * v3.120 Studio's ⌘K palette: every Office feature Studio has no button for. Each one calls the Office's own handler
 * or shows the Office's own panel (studio.showPanel: the sidebar panel on its own over Studio), never a copy.
 * @param {string} projectId the project Studio acts on (src/studio-view.mjs currentProjectId)
 */
/**
 * v3.134 Fills HQ's composer with a template's text: the chat input, or a bracketed paste into HQ's terminal. It never
 * sends: the person edits it and sends it, so the send is their own typed order.
 */
function fillHq(/** @type {string} */ text) {
  leaveBoard();
  selectProject(HQ_ROW.id);
  window.setTimeout(() => {
    const id = activePty();
    const p = id ? panes.get(id) : null;
    if (!p) return;
    if (p.chatOn && p.chat?.setDraft) p.chat.setDraft(text);
    else p.term?.insert?.(text);
  }, 80);
}
function studioCommands(projectId) {
  const p = projects.find((x) => x.id === projectId) || null;
  const act = activeProject();
  const n = act && act.id !== HQ_ROW.id ? tabOf(act) : MAIN_TAB;
  const cmd = (id, run, when = true) => (when ? [{ id, label: t(`studio.cmd.${id}`), keywords: t(`studio.cmdKeys.${id}`), run }] : []);
  const panel = (sel, fallback) => () => { if (!studio?.showPanel(sel)) fallback?.(); };
  return [
    ...cmd('team', () => studio?.openTeam()),
    ...cmd('runTemplate', () => { paletteRows(fillHq).then((rows) => studio?.openPalette(rows, t('templates.paletteHint'))).catch((e) => console.error(e)); }),   // v3.134   // v3.124 the Team page (team mode off: its own switch)
    ...cmd('worktree', () => { leaveBoard(); addTab(p.id, 'worktree'); }, Boolean(p)),
    ...cmd('newTab', () => { leaveBoard(); addTab(p.id); }, Boolean(p)),   // main's "+" menu: same folder, worktree, a desk, a shell
    ...cmd('closeTab', () => closeTab(act.id, n), Boolean(act) && act.id !== HQ_ROW.id && n !== MAIN_TAB),
    ...cmd('accounts', panel('.sb-accounts')),
    ...cmd('projectAccount', () => sidebar?.openProjectSettings(p.id), Boolean(p)),
    ...cmd('mcp', panel('#sb-panel-mcp')),
    ...cmd('skills', () => studio?.openSettings('mcp')),
    ...cmd('voice', () => studio?.openSettings('voice')),
    ...cmd('pair', panel('#sb-devices')),
    ...cmd('machines', panel('#machines-panel')),   // v3.122 the Office's floating panels (studio.js FLOATS)
    ...cmd('usage', panel('#usage-panel'), Boolean(p)),
    ...cmd('mail', panel('#sb-panel-mail')),   // the MAIL panel, when mail is on (showPanel is false without it)
    ...cmd('remoteTask', () => { userSelect(); selectProject(HQ_ROW.id); document.body.classList.add('studio-board'); }),   // HQ's board: send-as-task to any target
    ...cmd('addProject', () => addProject()),
    ...cmd('projectSettings', () => sidebar?.openProjectSettings(p.id), Boolean(p)),
    ...cmd('openFolder', () => api.projects.openFolder?.(p.id).catch((e) => console.error(e)), Boolean(p)),
    ...cmd('removeProject', () => removeProject(p), Boolean(p)),
    ...cmd('projects', panel('#sb-panel-projects')),
    ...cmd('settings', () => studio?.openSettings()),
    ...cmd('office', () => setExperience('office')),
    ...cmd('whatsNew', () => openWhatsNew()),   // v3.123
  ];
}
studio?.setOn(studioOn);


/** v3.122 a floating Office panel opened for Studio: Usage of Studio's current project, or Machines; false when absent. */
function openFloatPanel(/** @type {string} */ sel) {
  if (sel === '#machines-panel') { if (!machines) return false; if (!machines.shown()) machines.show(); return true; }
  if (sel !== '#usage-panel' || !usagePanel) return false;
  const p = projects.find((x) => x.id === studio?.currentProject());
  if (!p) return false;
  if (usagePanel.shownId() !== p.id) usagePanel.show(p);   // show() on the shown project would close it
  return true;
}

// ---- v3.123 What's new (renderer/whats-new.js): once after an update, and from Help → What's new, ⌘K and
// Settings → About. "Try it" runs one of these fixed actions (src/whats-new.js ACTIONS); each returns the selector to
// spotlight when the item names none.
/** An Office sidebar panel opened (in Studio: shown on its own over Studio); its selector, or '' when it is not there. */
function whatsNewPanel(/** @type {string} */ sel) {
  if (studioOn) return studio?.showPanel(sel) ? sel : '';
  const panel = /** @type {HTMLElement | null} */ (document.querySelector(sel));
  if (!panel || panel.hidden) return '';
  if (panel.tagName === 'DETAILS') /** @type {HTMLDetailsElement} */ (panel).open = true;
  return sel;
}
/** open-settings:<section> in Studio: [its Settings page section, the row there] (src/settings-model.mjs SETTINGS) */
/** @type {Record<string, [string, string]>} */
const WHATS_NEW_STUDIO_ROWS = {
  experience: ['general', '.st-set-row[data-key="experience"]'],
  language: ['general', '.st-set-row[data-key="lang"]'],
  'keep-awake': ['sessions', '.st-set-row[data-key="keepAwake"]'],
  economy: ['sessions', '.st-set-row[data-key="economy"]'],
  about: ['about', '.st-set-version'],
};
/** @type {Record<string, (arg: string) => string>} */
const whatsNewActions = {
  spotlight: () => '',   // only the item's target
  'open-studio': () => { setExperience('studio'); return '#experience-switch'; },
  'open-office': () => { setExperience('office'); return '#experience-switch'; },
  // in Studio its Settings page (v3.122) at the section holding that row; in the Office the popup
  'open-settings': (arg) => {
    if (studioOn && studio) {
      const at = WHATS_NEW_STUDIO_ROWS[arg] || ['general', ''];
      studio.openSettings(at[0]);
      return at[1] ? `#studio-settings ${at[1]}` : '#studio-settings';
    }
    sidebar?.openSettings();
    return arg ? `[data-settings-section="${arg}"]` : '';
  },
  'open-studio-settings': () => { if (experience !== 'studio') setExperience('studio'); studio?.openSettings(); return '#studio-settings .st-set-nav'; },
  'open-start-screen': () => { if (experience !== 'studio') setExperience('studio'); studio?.newSession(); return '.st-start-who'; },
  'open-palette': () => { if (experience !== 'studio') setExperience('studio'); window.setTimeout(() => studio?.openPalette(), 60); return ''; },
  'open-devices': () => whatsNewPanel('#sb-devices'),
  // in Studio the Team page (v3.124; team mode off: its own switch); in the Office the Team panel or the popup
  'open-team': () => {
    if (studioOn) { studio?.openTeam(); return '#studio-team .st-set-top'; }   // v3.124 the Team page
    return whatsNewPanel('#sb-panel-team') || (sidebar?.openSettings(), '');
  },
  // v3.124 Studio's Team page at its Roles tab, switching to Studio
  'open-board': () => {   // v3.131 the board of orders and conversations, in either experience
    if (experience === 'studio') { studio?.openBoard('board'); return '#hq-board .bv-tabs'; }
    selectProject(HQ_ROW.id); hqUi?.showBoard('board'); return '#hq-board .bv-tabs';
  },
  'open-team-page': () => { if (experience !== 'studio') setExperience('studio'); studio?.openTeam('roles'); return '#studio-team .st-team-tabs'; },
  'focus-composer': () => { if (!studio?.focusStart()) focusActive(); return ''; },
};
const whatsNew = mountWhatsNew({
  t,
  lang: getLang,
  experience: () => (experience === 'studio' ? 'studio' : 'office'),
  run: (action) => { const { id, arg } = splitAction(action); return Object.hasOwn(whatsNewActions, id) ? whatsNewActions[id](arg) || '' : ''; },
});
function openWhatsNew() {
  api.whatsNew?.all().then((entries) => whatsNew.show(entries)).catch((e) => console.error(e));
}
api.whatsNew?.onOpen(() => openWhatsNew());
onLang(() => whatsNew.redraw());   // v3.144 the open card follows a language change
// v3.138 the title bar's gift: the same card again, for when it was closed before it was read
{
  const btn = $('whats-new-btn');
  if (btn) {
    btn.replaceChildren(icon('gift', 15));
    const label = () => { btn.title = t('app.whatsNewTitle'); btn.setAttribute('aria-label', btn.title); };
    label();
    btn.addEventListener('click', () => openWhatsNew());
    onLang(label);
  }
}
// after the experience is known, so the card has its look and its items
Promise.resolve(prefsReady).catch(() => {}).then(() => window.setTimeout(() => {
  api.whatsNew?.pending().then((entries) => { if (Array.isArray(entries) && entries.length) whatsNew.show(entries); }).catch((e) => console.error(e));
}, 600));
