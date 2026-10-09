// OS differences (macOS / Linux): pure functions (no Electron; tested with node --test).
// macOS behavior is unchanged; Linux uses the equivalents.

const isMac = (platform = process.platform) => platform === 'darwin';

// Shell for project and login ptys: $SHELL, else zsh on macOS, bash on Linux.
const defaultShell = (env = process.env, platform = process.platform) =>
  env.SHELL || (isMac(platform) ? '/bin/zsh' : '/bin/bash');

// Files that Linux file managers put on the clipboard: text/uri-list or GNOME/Nautilus's
// x-special/gnome-copied-files format (a "copy" / "cut" line, then file:// URLs).
// Only local file:// URLs become paths; other lines (comments, http, actions) are skipped.
function filesFromUriList(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('file://')) continue;
    try {
      const u = new URL(line);
      if (u.host && u.host !== 'localhost') continue;
      const p = decodeURIComponent(u.pathname);
      if (p.startsWith('/')) out.push(p);
    } catch {}
  }
  return out;
}

// Commands to try (in order) for reading files from the clipboard on Linux: wl-paste on Wayland, xclip on X11.
// Each is { cmd, args } plus the format it reads; the first non-empty result is used.
function linuxClipboardCommands(env = process.env) {
  const types = ['x-special/gnome-copied-files', 'text/uri-list'];
  const wl = types.map((t) => ({ cmd: 'wl-paste', args: ['--no-newline', '--type', t] }));
  const x = types.map((t) => ({ cmd: 'xclip', args: ['-selection', 'clipboard', '-o', '-t', t] }));
  return env.WAYLAND_DISPLAY ? [...wl, ...x] : [...x, ...wl];
}

// Keyboard shortcuts. macOS: ⌘ (metaKey). Linux: Ctrl+Shift, because keys such as Ctrl+V, Ctrl+O, Ctrl+C
// go to Claude Code in the terminal (e.g. Ctrl+V pastes an image, Ctrl+O opens the transcript).
const shortcuts = (platform = process.platform) => (isMac(platform)
  ? { paste: 'CmdOrCtrl+V', copy: null, cut: null }               // null: the role's own shortcut
  : { paste: 'Ctrl+Shift+V', copy: 'Ctrl+Shift+C', cut: 'Ctrl+Shift+X' });

module.exports = { isMac, defaultShell, filesFromUriList, linuxClipboardCommands, shortcuts };
