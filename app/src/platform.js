// OS differences (macOS / Linux / Windows): pure functions (no Electron; tested with node --test).
// macOS behavior is unchanged; Linux and Windows use the equivalents.
const path = require('path');
const { crc32, deflateSync } = require('zlib');

const isMac = (platform = process.platform) => platform === 'darwin';
const isWindows = (platform = process.platform) => platform === 'win32';

// Shell for project and login ptys: $SHELL, else zsh on macOS, bash on Linux.
const defaultShell = (env = process.env, platform = process.platform) =>
  env.SHELL || (isMac(platform) ? '/bin/zsh' : '/bin/bash');

// Files that Linux file managers put on the clipboard: text/uri-list or GNOME/Nautilus's
// x-special/gnome-copied-files format (a "copy" / "cut" line, then file:// URLs).
// Only local file:// URLs become paths; other lines (comments, http, actions) are skipped.
// platform 'win32': file:///C:/a%20b → C:\a b, file://server/share/x → \\server\share\x.
// v3.121 macOS: every file URL on the general pasteboard (JXA, `osascript -l JavaScript -e`). FileURLsOnly keeps the
// furl check: plain text never turns into a path. Prints a JSON array of POSIX paths ("[]" when no file was copied).
const MAC_CLIPBOARD_FILES_JXA = [
  "ObjC.import('AppKit');",
  '(() => {',
  '  const opts = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey);',
  '  const urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), opts);',
  '  const out = [];',
  '  const n = urls && !urls.isNil() ? urls.count : 0;',
  '  for (let i = 0; i < n; i++) { const u = urls.objectAtIndex(i); if (u.isFileURL) out.push(ObjC.unwrap(u.path)); }',
  '  return JSON.stringify(out);',
  '})();',
].join('\n');
const MAC_FILES_MAX = 200;
/**
 * v3.121 the JXA script's output → the copied files' absolute paths, in order, without repeats (at most
 * MAC_FILES_MAX). Anything that is not a JSON array of absolute paths gives [] (never a path made from text).
 * @param {string} out
 * @returns {string[]}
 */
function filesFromMacPasteboard(out) {
  let list;
  try { list = JSON.parse(String(out || '').trim()); } catch { return []; }
  if (!Array.isArray(list)) return [];
  /** @type {string[]} */
  const files = [];
  for (const p of list) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0') || files.includes(p)) continue;
    files.push(p);
    if (files.length >= MAC_FILES_MAX) break;
  }
  return files;
}
function filesFromUriList(text, platform = 'linux') {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('file://')) continue;
    try {
      const u = new URL(line);
      const p = decodeURIComponent(u.pathname);
      if (platform === 'win32') {
        if (u.host && u.host !== 'localhost') out.push(`\\\\${u.host}${p.replace(/\//g, '\\')}`);
        else if (/^\/[A-Za-z]:\//.test(p)) out.push(p.slice(1).replace(/\//g, '\\'));
        continue;
      }
      if (u.host && u.host !== 'localhost') continue;
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

// Keyboard shortcuts. macOS: ⌘ (metaKey). Linux and Windows: Ctrl+Shift, because keys such as Ctrl+V, Ctrl+O, Ctrl+C
// go to Claude Code in the terminal (e.g. Ctrl+V pastes an image, Ctrl+O opens the transcript).
const shortcuts = (platform = process.platform) => (isMac(platform)
  ? { paste: 'CmdOrCtrl+V', copy: null, cut: null }               // null: the role's own shortcut
  : { paste: 'Ctrl+Shift+V', copy: 'Ctrl+Shift+C', cut: 'Ctrl+Shift+X' });

// The in-app updater: macOS (zip), Windows (NSIS installer, latest.yml) and the Linux AppImage. A .deb install is
// the package manager's job.
const canSelfUpdate = (platform = process.platform, env = process.env) =>
  platform === 'darwin' || platform === 'win32' || Boolean(env.APPIMAGE);

// ---- Windows. There is no login shell: claude is found on PATH and started directly in a ConPTY.
// The functions use path.win32, so they behave the same when tested on macOS or Linux.
const W = path.win32;

/** The value of an environment variable, ignoring case as Windows does (a copied env object keeps 'Path'). */
function envGet(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** A copy of env with dir appended to PATH (under the key the env already uses, e.g. 'Path'). */
function withPathDir(env, dir) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const cur = env[key] || '';
  const parts = cur.split(';').filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === dir.toLowerCase())) return { ...env };
  return { ...env, [key]: [...parts, dir].join(';') };
}

const RUNNABLE = ['.exe', '.cmd', '.bat', '.com'];

/**
 * Full path of a command on the Windows PATH (PATHEXT order, only .exe/.cmd/.bat/.com), else null.
 * exists(file) tells whether a file is there (fs.statSync(f).isFile() in main).
 */
function findOnPath(name, env, exists) {
  const exts = (envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
    .filter((e) => RUNNABLE.includes(e));
  const named = RUNNABLE.includes(W.extname(name).toLowerCase()) ? [''] : exts;
  for (const dir of String(envGet(env, 'PATH') || '').split(';')) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!d) continue;
    for (const ext of named) {
      const f = W.join(d, name + ext);
      if (exists(f)) return f;
    }
  }
  return null;
}

/**
 * Where claude is on Windows: PATH first (claude.exe from the native installer or WinGet, claude.cmd from npm),
 * then the native installer's and npm's default folders (in case the app's PATH predates the install). null: not installed.
 */
function findClaude(env, exists) {
  const found = findOnPath('claude', env, exists);
  if (found) return found;
  const home = envGet(env, 'USERPROFILE');
  const appData = envGet(env, 'APPDATA');
  const known = [home && W.join(home, '.local', 'bin', 'claude.exe'), appData && W.join(appData, 'npm', 'claude.cmd')];
  return known.find((f) => f && exists(f)) || null;
}

/** Where Antigravity's `agy` is on Windows (contract v3.22): on PATH, else null (not installed). */
const findAgy = (env, exists) => findOnPath('agy', env, exists);

/**
 * Where Command Code's CLI is on Windows (contract v3.25): `commandcode` on PATH, else null (not installed). Never
 * `cmd`, which there is the shell's own System32\cmd.exe.
 */
const findCommandCode = (env, exists) => findOnPath('commandcode', env, exists);

/** Where OpenCode's `opencode` is on Windows (contract v3.40): on PATH (npm's opencode.cmd, a native opencode.exe), else null. */
const findOpenCode = (env, exists) => findOnPath('opencode', env, exists);

/** One argument for a cmd.exe command line: bare if it is safe, else in double quotes. */
const cmdQuote = (a) => (/^[\w\-.:\\/=@+,]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`);

/**
 * How to start a Windows command with these arguments. An .exe starts directly; a .cmd/.bat (npm's claude.cmd)
 * cannot be started without cmd.exe, so it runs as `cmd.exe /d /s /c "<command line>"` with the line passed
 * verbatim (verbatim: true → node-pty gets args as one string, execFile gets windowsVerbatimArguments).
 * @param {string} file @param {string[]} args @param {Record<string, string | undefined>} env
 * @returns {{ file: string, args: string[], verbatim: boolean }}
 */
function windowsCommand(file, args, env) {
  if (!['.cmd', '.bat'].includes(W.extname(file).toLowerCase())) return { file, args, verbatim: false };
  const line = [file, ...args].map(cmdQuote).join(' ');
  return { file: envGet(env, 'ComSpec') || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/**
 * Git Bash, which Claude Code on Windows uses for status line commands (PowerShell when there is none):
 * CLAUDE_CODE_GIT_BASH_PATH, else next to git.exe on PATH (<Git>\\cmd\\git.exe → <Git>\\bin\\bash.exe), else the
 * default install folders. null: no Git Bash.
 */
function findGitBash(env, exists) {
  const set = envGet(env, 'CLAUDE_CODE_GIT_BASH_PATH');
  if (set && exists(set)) return set;
  const git = findOnPath('git.exe', env, exists);
  const cands = [];
  if (git) {
    const dir = W.dirname(git);
    cands.push(W.join(dir, '..', 'bin', 'bash.exe'), W.join(dir, 'bash.exe'), W.join(dir, '..', '..', 'bin', 'bash.exe'));
  }
  for (const root of [envGet(env, 'ProgramFiles'), envGet(env, 'ProgramFiles(x86)'), envGet(env, 'LOCALAPPDATA') && W.join(envGet(env, 'LOCALAPPDATA'), 'Programs')]) {
    if (root) cands.push(W.join(root, 'Git', 'bin', 'bash.exe'));
  }
  return cands.map((c) => W.normalize(c)).find((c) => exists(c)) || null;
}

// Files copied in Explorer. Electron 44 surfaces Windows clipboard formats without a MIME type as
// 'electron application/osclipboard;format="<name>"'; Explorer puts CF_HDROP (all files) and FileNameW (the first).

/** Paths in a DROPFILES block (CF_HDROP): a 20-byte header whose first DWORD is the list's offset, then
 *  NUL-terminated names (UTF-16LE when the fWide DWORD at 16 is set, else ANSI), ending with an empty one. */
function filesFromDropFiles(buf) {
  if (!buf || buf.length < 20) return [];
  const offset = buf.readUInt32LE(0);
  const wide = buf.readUInt32LE(16) !== 0;
  if (offset < 20 || offset >= buf.length) return [];
  const text = wide ? buf.subarray(offset, offset + ((buf.length - offset) & ~1)).toString('utf16le') : buf.subarray(offset).toString('latin1');
  const out = [];
  for (const name of text.split('\0')) {
    if (!name) break;
    out.push(name);
  }
  return out;
}

/** The path in FileNameW (UTF-16LE, NUL-terminated); [] if empty. */
function filesFromFileNameW(buf) {
  const name = buf ? buf.toString('utf16le').split('\0')[0] : '';
  return name ? [name] : [];
}

/** Which reader fits a clipboard item type: 'drop' (CF_HDROP), 'name' (FileNameW), 'uri' (text/uri-list) or null. */
function windowsClipboardKind(type) {
  const t = String(type);
  if (t === 'text/uri-list') return 'uri';
  const m = /^electron application\/osclipboard;format="?([^"]+)"?$/i.exec(t);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (name === 'cf_hdrop' || name === '15' || name === 'filedrop') return 'drop';
  if (name === 'filenamew') return 'name';
  return null;
}

/**
 * The files to paste from what main read per kind (v3.19): CF_HDROP or text/uri-list name every copied file, Explorer's
 * FileNameW only the first, so a list from FileNameW alone is not `complete` (main then asks PowerShell for the whole
 * list and keeps the FileNameW one if that gives nothing). `clipboard.read()` lists item types in no set order.
 * @param {{ drop?: string[], uri?: string[], name?: string[] }} found
 * @returns {{ files: string[], complete: boolean }}
 */
function pickWindowsFiles(found) {
  for (const k of /** @type {const} */ (['drop', 'uri'])) if (found[k]?.length) return { files: found[k], complete: true };
  if (found.name?.length) return { files: found.name, complete: false };
  return { files: [], complete: true };
}

// Image formats on the Windows clipboard: Chromium's MIME types, or the raw formats a screenshot (Win+Shift+S,
// PrtSc), Paint or a browser's "Copy image" put there (CF_DIB 8, CF_DIBV5 17, CF_BITMAP 2, the registered "PNG").
const WIN_IMAGE_FORMATS = new Set(['png', 'cf_dib', 'cf_dibv5', 'cf_bitmap', '8', '17', '2', 'image/png', 'image/bmp']);
/** Does this `clipboard.read()` item type hold an image on Windows? */
function windowsImageType(type) {
  const t = String(type);
  if (/^image\//i.test(t)) return true;
  const m = /^electron application\/osclipboard;format="?([^"]+)"?$/i.exec(t);
  return Boolean(m && WIN_IMAGE_FORMATS.has(m[1].toLowerCase()));
}

// PowerShell fallback when Electron shows no file formats: one full path per line.
const POWERSHELL_FILES = ['-NoProfile', '-NonInteractive', '-Command',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'];
/** Absolute Windows paths, one per line, from the PowerShell output. */
const filesFromLines = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(?:[A-Za-z]:\\|\\\\)/.test(l));

/**
 * A size×size PNG of a filled circle (the taskbar overlay badge on Windows: the Dock badge's stand-in).
 * @param {number} size @param {number} rgb 0xRRGGBB
 */
function dotPng(size, rgb) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const dx = x + (sx + 0.5) / 4 - r, dy = y + (sy + 0.5) / 4 - r;
        if (dx * dx + dy * dy <= r * r) cover++;
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = (rgb >> 16) & 255; raw[o + 1] = (rgb >> 8) & 255; raw[o + 2] = rgb & 255;
      raw[o + 3] = Math.round((cover / 16) * 255);
    }
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tb));
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = {
  isMac, isWindows, defaultShell, filesFromUriList, MAC_CLIPBOARD_FILES_JXA, filesFromMacPasteboard, linuxClipboardCommands, shortcuts, canSelfUpdate,
  envGet, withPathDir, findOnPath, findClaude, findAgy, findCommandCode, findOpenCode, cmdQuote, windowsCommand, findGitBash,
  filesFromDropFiles, filesFromFileNameW, windowsClipboardKind, pickWindowsFiles, windowsImageType, POWERSHELL_FILES, filesFromLines, dotPng,
};
