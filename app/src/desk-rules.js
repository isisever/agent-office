// A desk's worktree gets the project's local permission rules (contract v3.92): no Electron; tested in
// test/desk-rules.test.cjs.
// In a parallel project a staff desk works in a git worktree under the app's userData. The project's untracked
// `.claude/settings.local.json` (the person's own allow/deny rules for that project) is not in that worktree, so the
// desk would ask for everything the project tab does not. This copies that one file, and nothing else, into the
// worktree; main.js asks git whether the file is tracked there (then it is never written) and keeps it out of commits.
const fs = require('fs');
const path = require('path');

const REL = '.claude/settings.local.json';
const MAX_BYTES = 256 * 1024;
const EXCLUDE_NOTE = '# Agent Office: a desk worktree gets a copy of the project\'s local permission rules; never committed';

/** Does this tab get the project's rules? Only a staff desk in a worktree of its own; never a personal workspace, never a member with a mail account (the mail guard decides there). */
function wanted({ project, tab, hasMail }) {
  return Boolean(project && tab && tab.staffId && tab.worktree && tab.worktree.root && typeof tab.dir === 'string' && tab.dir
    && !project.hq && !project.staffOwner && !hasMail);
}

const lstat = (f) => { try { return fs.lstatSync(f); } catch { return null; } };

/** The project's rules file → { data, mtimeMs }, or null: missing, not a regular file, a symlink (never followed) or over the cap. */
function readSource(projectDir) {
  const file = path.join(projectDir, REL);
  const st = lstat(file);
  if (!st || !st.isFile() || st.size > MAX_BYTES) return null;
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const now = fs.fstatSync(fd);
    if (!now.isFile() || now.size > MAX_BYTES) return null;
    const data = fs.readFileSync(fd);
    return data.length > MAX_BYTES ? null : { data, mtimeMs: now.mtimeMs };
  } catch { return null; } finally { if (fd !== null) try { fs.closeSync(fd); } catch {} }
}

/** Where the copy goes, or null when the desk's `.claude` or the file itself is something this never writes through (a symlink, a folder, a missing desk folder). */
function target(deskDir) {
  const root = lstat(deskDir);
  if (!root || !root.isDirectory()) return null;
  const dir = path.join(deskDir, '.claude');
  const d = lstat(dir);
  if (d && !d.isDirectory()) return null;
  const file = path.join(deskDir, REL);
  const f = lstat(file);
  if (f && !f.isFile()) return null;
  return { dir, file, mtimeMs: f ? f.mtimeMs : null };
}

/** Is there something to copy: a usable source, and no copy yet or one older than the source. */
function needsCopy(projectDir, deskDir) {
  if (path.resolve(projectDir) === path.resolve(deskDir)) return false;
  const st = lstat(path.join(projectDir, REL));
  if (!st || !st.isFile() || st.size > MAX_BYTES) return false;
  const to = target(deskDir);
  return Boolean(to && (to.mtimeMs === null || st.mtimeMs > to.mtimeMs));
}

/**
 * Copies the project's rules file into the desk's folder. The caller has checked that git does not track the file
 * there. → 'copied' | 'current' | 'no-source' | 'no-target' | 'failed'
 */
function copy(projectDir, deskDir) {
  if (path.resolve(projectDir) === path.resolve(deskDir)) return 'no-target';
  const src = readSource(projectDir);
  if (!src) return 'no-source';
  const to = target(deskDir);
  if (!to) return 'no-target';
  if (to.mtimeMs !== null && src.mtimeMs <= to.mtimeMs) return 'current';
  const tmp = path.join(to.dir, `.settings.local.json.${process.pid}.tmp`);
  try {
    fs.mkdirSync(to.dir, { recursive: true });
    fs.writeFileSync(tmp, src.data, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, to.file);   // replaces the name itself: never writes through a link
    return 'copied';
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return 'failed';
  }
}

/** The exclude file's text with the rules file's line added → the new text, or null when a line for it is already there. */
function excludeText(text) {
  const cur = String(text || '');
  if (cur.split(/\r?\n/).some((l) => l.trim() === REL || l.trim() === `/${REL}`)) return null;
  return `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${EXCLUDE_NOTE}\n${REL}\n`;
}

/** Makes sure the repository's shared `info/exclude` (in its common git dir) ignores the rules file. → false when it could not be written. */
function ensureExcluded(commonDir) {
  const d = lstat(commonDir);
  if (!d || !d.isDirectory()) return false;
  const file = path.join(commonDir, 'info', 'exclude');
  try {
    const f = lstat(file);
    if (f && !f.isFile()) return false;
    const next = excludeText(f ? fs.readFileSync(file, 'utf8') : '');
    if (next === null) return true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
    return true;
  } catch { return false; }
}

module.exports = { REL, MAX_BYTES, wanted, needsCopy, copy, excludeText, ensureExcluded };
