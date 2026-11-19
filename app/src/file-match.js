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

/**
 * May this path be shown in Finder for the tab? Only an existing file or folder inside the tab's folder (after links
 * are resolved). → the real path, or '' when not.
 */
function insidePath(dir, p, fsx = fs) {
  if (typeof p !== 'string' || !p || p.length > 4096 || !dir) return '';
  try {
    const root = fsx.realpathSync(dir);
    const real = fsx.realpathSync(path.isAbsolute(p) ? p : path.join(dir, p));
    const rel = path.relative(root, real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? real : '';
  } catch { return ''; }
}

module.exports = { FILES_MAX, parseGitFiles, walkFiles, rankFiles, mention, insidePath };
