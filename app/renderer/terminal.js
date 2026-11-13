// xterm.js terminal for the real claude CLI; each project uses its own terminal and pty.
// app.js routes incoming pty data (write/exit); input, resize and restart are per project.
import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { t } from './i18n.js';
import { platform, isMac, isModKey, keyOf } from './platform.js';
import { translateKey, isPasteKey, pasteAction } from '../src/terminal-keys.mjs';
import { terminalTheme } from '../src/appearance.mjs';

// Text lives in locales/*.json (terminal.exited). A line already written to the terminal is not rewritten on a language change.

// The theme is an xterm theme built by app.js for the look and mode (src/appearance.mjs terminalTheme, v3.74);
// without one the terminal has the 8-bit dark default.
/** @param {{ background?: string } | null} [t] */
const xtermTheme = (t) => (t && t.background ? t : terminalTheme('pixel', 'dark'));

// Open terminals: Paste (⌘V) in the menu goes to the focused terminal (pasteIntoFocused).
const terminals = new Set();
// ⌘V can arrive three ways (keydown in the terminal, Chromium's paste event, the menu); one press pastes once.
let lastPaste = 0;
const once = () => { const now = Date.now(); if (now - lastPaste < 400) return false; lastPaste = now; return true; };

/** ⌘V: if focus is in a terminal, pastes the clipboard there and returns true; otherwise false (normal paste). */
export async function pasteIntoFocused() {
  const t = [...terminals].find((x) => x.el.contains(document.activeElement));
  if (!t) return false;
  if (once()) await t.paste();
  return true;
}

// restartable: false → no "Enter ile yeniden başlat" when the pty exits (login terminals, `login:<account>`).
/**
 * @param {HTMLElement} el
 * @param {{ projectId?: string, theme?: Record<string, string>, restartable?: boolean }} [opts]
 */
export function mountTerminal(el, { projectId, theme, restartable = !String(projectId).startsWith('login:') } = {}) {
  const { pty } = window.agentOffice;
  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
    fontSize: 13,
    lineHeight: 1.1,
    cursorBlink: true,
    allowProposedApi: true,
    macOptionIsMeta: true,
    scrollback: 5000,
    theme: xtermTheme(theme),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  let dead = false;
  let needSize = false; // report the size again when the new pty sends its first data
  let quietExit = false; // account switch: the old pty's exit message is not shown
  let asleep = false; // claude was put to sleep: the banner stays until the resumed claude draws
  const visible = () => el.getClientRects().length > 0 && el.clientWidth > 0 && el.clientHeight > 0;
  const resize = () => {
    if (!visible()) return; // hidden terminal: resized once visible
    try { fit.fit(); } catch { return; }
    if (term.cols > 0 && term.rows > 0) pty.resize(projectId, term.cols, term.rows);
  };
  const ro = new ResizeObserver(() => requestAnimationFrame(resize));
  ro.observe(el);
  resize();
  document.fonts?.ready.then(resize);

  term.onData((d) => {
    if (!dead) return pty.write(projectId, d);
    if (restartable && d === '\r') { dead = false; term.reset(); pty.restart(projectId); needSize = true; resize(); }
  });

  // Depending on clipboard content (pasteAction): files copied from Finder / a file manager / Explorer → quoted
  // paths, image → Claude Code's image paste key (Ctrl+V; Alt+V on Windows: it reads the image from the clipboard
  // itself), text → xterm's (bracketed) paste. Windows takes text before an image (v3.19).
  async function paste() {
    if (dead) return;
    let clip = null;
    try { clip = await window.agentOffice.clipboard.read(); } catch { return; }
    const act = pasteAction(clip, platform);
    if (act && 'pty' in act) pty.write(projectId, act.pty);
    else if (act && 'text' in act) term.paste(act.text);
    term.focus();
  }

  // File drag-and-drop: write the paths (quoting those with spaces) to the terminal. The path comes from
  // webUtils.getPathForFile in the preload (File.path is gone in Electron 32+); Windows quotes with "…" (quotePath).
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  el.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; el.classList.add('drop'); } });
  el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('drop'); } });
  el.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  el.addEventListener('drop', (e) => {
    depth = 0;
    el.classList.remove('drop');
    if (!hasFiles(e)) return;
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => window.agentOffice.pathForFile(f)).filter(Boolean);
    const act = pasteAction({ files: paths }, platform);
    if (act && 'pty' in act && !dead) pty.write(projectId, act.pty);
    term.focus();
  });

  // ⌘V in the terminal is caught here: Chromium's own paste would send empty text for images/files.
  // Linux: Ctrl+Shift+V pastes (Ctrl+V goes to claude, which reads the image from the clipboard). Windows: Ctrl+V and
  // Ctrl+Shift+V paste (claude has no Ctrl+V there; its image key is Alt+V, which paste() sends for an image; v3.19).
  // Linux and Windows: Ctrl+Shift+C/X are not passed to xterm (it would send ^C) and are left to Copy/Cut in the menu.
  // Cmd+Enter / Ctrl+Enter: xterm would send a bare CR; claude gets ctrl+enter (send a queued message now).
  // macOS Option+Q (TR @) and other ASCII symbols the layout composes with Option: xterm would send ESC+key (Meta).
  term.attachCustomKeyEventHandler((ev) => {
    const seq = translateKey(ev, isMac);
    if (seq) {
      if (ev.type === 'keydown') { ev.preventDefault(); term.input(seq); }
      return false;
    }
    // macOS: ⌘V and ⌘⇧V (Shift optional, as before); Linux: Ctrl+Shift+V; Windows: Ctrl+V and Ctrl+Shift+V
    if (isPasteKey(ev, platform)) {
      if (ev.type === 'keydown') { ev.preventDefault(); if (once()) paste(); }
      return false;
    }
    if (ev.type !== 'keydown' || isMac || !isModKey(ev)) return true;
    const key = keyOf(ev);
    return !(key === 'c' || key === 'x');
  });
  el.addEventListener('paste', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (once()) paste();
  }, true);

  const self = { el, paste };
  terminals.add(self);

  return {
    /** Data from the pty (written even while hidden, so history is kept). */
    write(d) {
      dead = false;
      quietExit = false;
      if (asleep) { asleep = false; term.reset(); }
      if (needSize) { needSize = false; resize(); }
      term.write(d);
    },
    /** pty exited: Enter restarts it (if not restartable, it stops quietly). */
    exit() {
      dead = true;
      if (!restartable || quietExit) { quietExit = false; return; }
      term.write(`\r\n\x1b[2m${t('terminal.exited')}\x1b[0m\r\n`);
    },
    /** claude was ended to save memory: the history is dropped too (it is the biggest part of a terminal's memory;
     * the resumed claude draws the conversation again) and a dim line says so. */
    sleep() {
      term.reset();
      term.write(`\x1b[2m${t('terminal.asleep')}\x1b[0m\r\n`);
      asleep = true;
      needSize = true;
    },
    /** claude was restarted in its session because its MCP servers changed (v3.11): the resumed claude draws the
     * conversation again below a dim line that says so. */
    reloaded() {
      dead = false;
      quietExit = true;
      term.reset();
      term.write(`\x1b[2m${t('terminal.mcpReloaded')}\x1b[0m\r\n`);
      needSize = true;
      resize();
    },
    setTheme(t) { term.options.theme = xtermTheme(t); },
    focus() { term.focus(); },
    fit: resize,
    /** Clears the terminal; restarting: the pty is being restarted by main. */
    reset({ restarting = false } = {}) { dead = false; quietExit = restarting; term.reset(); needSize = true; resize(); },
    destroy() { terminals.delete(self); ro.disconnect(); term.dispose(); },
  };
}
