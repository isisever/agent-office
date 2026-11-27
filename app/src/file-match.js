// Chat view files (contract v3.109): pure, no Electron; tested in test/chat.test.cjs.
// "@" in the chat input lists the tab's project files (git's tracked and untracked-but-not-ignored files, else a
// bounded walk of the folder), ranked against what the person typed; the pick goes in as `@path`, which Claude Code
// attaches to the message (checked with Claude Code 2.1.311, also in the SDK protocol). A file path in a tool line
// can be shown in Finder: only a path inside the tab's folder that exists.
const fs = require('fs');
const path = require('path');

const FILES_MAX = 20000;           // paths kept per folder
const WALK_DEPTH = 8;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'release', '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'target', 'vendor']);

/** git ls-files output (NUL-separated) → relative paths, at most FILES_MAX. */
function parseGitFiles(out) {
  return String(out || '').split('\0').map((s) => s.trim()).filter((s) => s && !s.includes('\n')).slice(0, FILES_MAX);
}

/**
 * The folder's files without git: depth ≤ WALK_DEPTH, no dot folders and no SKIP_DIRS, no symbolic links followed,
 * at most FILES_MAX. → relative paths with `/`.
 */
function walkFiles(dir, fsx = fs) {
  const out = [];
  const visit = (rel, depth) => {
    if (out.length >= FILES_MAX || depth > WALK_DEPTH) return;
    let list;
    try { list = fsx.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (out.length >= FILES_MAX) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) visit(r, depth + 1); } else if (e.isFile()) out.push(r);
    }
  };
  visit('', 0);
  return out;
}

/**
 * Files matching what was typed after "@", best first: the file name starting with it, then containing it, then the
 * path containing it, then its letters in order; shorter paths first within a group. An empty query: the first `max`.
 */
function rankFiles(files, query, max = 30) {
  const q = String(query || '').toLowerCase().replace(/\\/g, '/');
  if (!q) return files.slice(0, max);
  const scored = [];
  for (const f of files) {
    const low = f.toLowerCase();
    const base = low.slice(low.lastIndexOf('/') + 1);
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (low.includes(q)) score = 2;
    else {
      let i = 0;
      for (const c of low) if (c === q[i]) i++;
      if (i === q.length) score = 3;
    }
    if (score >= 0) scored.push([score, f.length, f]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : 1));
  return scored.slice(0, max).map((x) => x[2]);
}

/** How a path goes into the message: `@path`, quoted when it holds a space. */
const mention = (p) => (/\s/.test(p) ? `@"${p.replace(/"/g, '')}"` : `@${p}`);

/** The real path (links resolved; on macOS also the letter case and /tmp → /private/tmp), or '' when it does not exist. */
function realOf(p, fsx) {
  try { return (fsx.realpathSync.native || fsx.realpathSync)(p); } catch { return ''; }
}
/** Is `real` the folder `root` or inside it (both real paths)? A name that only starts with ".." is inside. */
function within(root, real) {
  const rel = path.relative(root, real);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * v3.113 What "Show in Finder" shows for a tool line's file. `dirs`: the tab's folder first (a relative path is taken
 * from it), then the other folders the tab may show (the project's folder for a worktree or desk tab). Both sides are
 * compared as real paths, so /tmp vs /private/tmp and other linked roots match. A file that is gone: its nearest
 * existing parent folder inside one of the folders.
 * → { path, gone, root? } (root: the gone file's nearest folder is a root itself) or null when the path is outside every folder.
 * @param {string | string[]} dirs
 * @param {string} p
 */
function revealTarget(dirs, p, fsx = fs) {
  const list = (Array.isArray(dirs) ? dirs : [dirs]).filter((d) => typeof d === 'string' && d);
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || !list.length) return null;
  const roots = [...new Set(list.map((d) => realOf(d, fsx)).filter(Boolean))];
  if (!roots.length) return null;
  const abs = path.resolve(list[0], p);
  const real = realOf(abs, fsx);
  if (real) return roots.some((r) => within(r, real)) ? { path: real, gone: false } : null;
  // gone: walk up to the nearest folder that exists, and show it only when it is inside a root
  for (let up = path.dirname(abs), i = 0; i < 4096; up = path.dirname(up), i++) {
    const r = realOf(up, fsx);
    if (r) {
      if (!roots.some((root) => within(root, r))) return null;
      return roots.includes(r) ? { path: r, gone: true, root: true } : { path: r, gone: true };
    }
    if (path.dirname(up) === up) break;
  }
  return null;
}

/**
 * May this path be shown in Finder for the tab? Only an existing file or folder inside the tab's folder (after links
 * are resolved). → the real path, or '' when not.
 */
function insidePath(dir, p, fsx = fs) {
  const r = revealTarget(dir, p, fsx);
  return r && !r.gone ? r.path : '';
}

// v3.113 files picked with the attach button: images the API takes go as image blocks (GUI tab), the rest as @path
const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const PICK_IMAGE_MAX = 10 * 1024 * 1024;   // larger images are not read into the window (they go in as @path)
/** The image type of a picked file by its name, or '' when it is not an image the API takes. */
const imageType = (p) => IMAGE_EXT[path.extname(String(p)).toLowerCase()] || '';

/**
 * v3.121 what opening an attached file does: { path, action: 'open' | 'reveal' } or null (not an absolute path, or
 * gone). A file opens in its default app; anything that would run code when opened (an app or any other bundle, an
 * executable, a script, installer or launcher by its extension) is shown in Finder instead; a plain folder opens.
 * A symbolic link is never opened, only shown: its own name could hide what it points to (readme.txt → a .terminal).
 */
const RUNS_EXT = new Set([
  'app', 'command', 'tool', 'sh', 'zsh', 'bash', 'csh', 'fish', 'exe', 'bat', 'cmd', 'com', 'msi', 'ps1', 'vbs', 'js',
  'jar', 'pkg', 'mpkg', 'dmg', 'scpt', 'applescript', 'workflow', 'action', 'terminal', 'desktop', 'appimage', 'run',
  'bin', 'url', 'webloc', 'inetloc', 'fileloc', 'lnk', 'prefpane', 'kext', 'bundle', 'plugin', 'py', 'pl', 'rb',
]);
/** A folder that macOS treats as a bundle (an app, a plug-in, a preference pane, …): it has Contents/Info.plist. */
function isBundle(p, fsx = fs) {
  try { return fsx.statSync(path.join(p, 'Contents', 'Info.plist')).isFile(); } catch { return false; }
}
function openTarget(p, fsx = fs) {
  if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p)) return null;
  let st;
  try { st = fsx.lstatSync(p); } catch { return null; }
  if (st.isSymbolicLink()) {
    try { fsx.statSync(p); } catch { return null; }   // a dangling link: gone
    return { path: p, action: 'reveal' };
  }
  const ext = path.extname(p).slice(1).toLowerCase();
  if (RUNS_EXT.has(ext)) return { path: p, action: 'reveal' };
  if (st.isDirectory()) return { path: p, action: isBundle(p, fsx) ? 'reveal' : 'open' };
  if (!st.isFile() || (process.platform !== 'win32' && (st.mode & 0o111))) return { path: p, action: 'reveal' };
  return { path: p, action: 'open' };
}

module.exports = { openTarget, RUNS_EXT, FILES_MAX, parseGitFiles, walkFiles, rankFiles, mention, insidePath, revealTarget, imageType, PICK_IMAGE_MAX };
