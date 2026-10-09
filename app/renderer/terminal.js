// xterm.js terminal for the real claude CLI; each project uses its own terminal and pty.
// app.js routes incoming pty data (write/exit); input, resize and restart are per project.
import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { t } from './i18n.js';
import { isMac, isModKey, keyOf } from './platform.js';

// Text lives in locales/*.json (terminal.exited). A line already written to the terminal is not rewritten on a language change.

const xtermTheme = (t = {}) => ({
  background: t.statusBg || '#231815',
  foreground: t.statusText || '#f3ead8',
  cursor: t.accent || '#3fb6a8',
  cursorAccent: t.statusBg || '#231815',
  selectionBackground: (t.accent || '#3fb6a8') + '66',
});

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

  // Depending on clipboard content: image → Ctrl+V (Claude Code reads the image from the clipboard itself), files
  // copied from Finder → quoted paths, text → xterm's (bracketed) paste.
  async function paste() {
    if (dead) return;
    let clip = null;
    try { clip = await window.agentOffice.clipboard.read(); } catch { return; }
    if (clip.files?.length) pty.write(projectId, clip.files.map(quote).join(' ') + ' ');
    else if (clip.hasImage) pty.write(projectId, '\x16');
    else if (clip.text) term.paste(clip.text);
    term.focus();
  }

  // File drag-and-drop: write the paths (quoting those with spaces) to the terminal.
  const quote = (p) => (/[\s'"\\$`!&;()<>|*?]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p);
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
    if (paths.length && !dead) pty.write(projectId, paths.map(quote).join(' ') + ' ');
    term.focus();
  });

  // ⌘V in the terminal is caught here: Chromium's own paste would send empty text for images/files.
  // Linux: Ctrl+Shift+V pastes (Ctrl+V goes to claude, which reads the image from the clipboard); Ctrl+Shift+C/X
  // are not passed to xterm (it would send ^C) and are left to Copy/Cut in the menu.
  term.attachCustomKeyEventHandler((ev) => {
    // macOS: ⌘V and ⌘⇧V (Shift optional, as before); Linux: Ctrl+Shift
    const mod = isMac ? ev.metaKey && !ev.ctrlKey && !ev.altKey : isModKey(ev);
    if (ev.type !== 'keydown' || !mod) return true;
    const key = keyOf(ev);
    if (!isMac && (key === 'c' || key === 'x')) return false;
    if (key !== 'v') return true;
    ev.preventDefault();
    if (once()) paste();
    return false;
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
      if (needSize) { needSize = false; resize(); }
      term.write(d);
    },
    /** pty exited: Enter restarts it (if not restartable, it stops quietly). */
    exit() {
      dead = true;
      if (!restartable || quietExit) { quietExit = false; return; }
      term.write(`\r\n\x1b[2m${t('terminal.exited')}\x1b[0m\r\n`);
    },
    setTheme(t) { term.options.theme = xtermTheme(t); },
    focus() { term.focus(); },
    fit: resize,
    /** Clears the terminal; restarting: the pty is being restarted by main. */
    reset({ restarting = false } = {}) { dead = false; quietExit = restarting; term.reset(); needSize = true; resize(); },
    destroy() { terminals.delete(self); ro.disconnect(); term.dispose(); },
  };
}
