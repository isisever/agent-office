// A desk's worktree gets the project's local permission rules (contract v3.92): no Electron; tested in
// test/desk-rules.test.cjs.
// In a parallel project a staff desk works in a git worktree under the app's userData. The project's untracked
// `.claude/settings.local.json` (the person's own allow/deny rules for that project) is not in that worktree, so the
// desk would ask for everything the project tab does not. Only the rules cross: `permissions.allow`, `.deny` and
// `.ask` as bounded string arrays, merged into the desk's own file (its other keys and its own rules stay). Nothing
// else in the project's file (env, hooks, apiKeyHelper, defaultMode, additionalDirectories, MCP approvals, unknown
// keys) ever reaches the desk. The file is written only where git does not track it and reports it ignored.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REL = '.claude/settings.local.json';
const MAX_BYTES = 256 * 1024;
const KINDS = ['allow', 'deny', 'ask'];
const MAX_RULES = 500;        // per array taken from the project's file
const MAX_RULE_CHARS = 2000;  // a longer rule is dropped, never cut (a cut rule is another rule)
const EXCLUDE_NOTE = '# Agent Office: a desk worktree gets the project\'s local permission rules; never committed';

/** Does this tab get the project's rules? Only a staff desk in a worktree of its own; never a personal workspace, never a member with a mail account (the mail guard decides there). */
function wanted({ project, tab, hasMail }) {
  return Boolean(project && tab && tab.staffId && tab.worktree && tab.worktree.root && typeof tab.dir === 'string' && tab.dir
    && !project.hq && !project.staffOwner && !hasMail);
}

const lstat = (f) => { try { return fs.lstatSync(f); } catch { return null; } };
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * A settings file → its JSON object, or null: missing, not a regular file, a symlink (never followed), over the cap or
 * not a JSON object. `follow`: a symlink is followed (v3.94, an account's own settings.json, which is only ever read).
 */
function readSettings(file, { follow = false } = {}) {
  let st = lstat(file);
  if (follow && st && st.isSymbolicLink()) { try { st = fs.statSync(file); } catch { st = null; } }
  if (!st || !st.isFile() || st.size > MAX_BYTES) return null;
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (follow ? 0 : fs.constants.O_NOFOLLOW || 0));
    const now = fs.fstatSync(fd);
    if (!now.isFile() || now.size > MAX_BYTES) return null;
    const data = fs.readFileSync(fd);
    if (data.length > MAX_BYTES) return null;
    const json = JSON.parse(data.toString('utf8'));
    return isObj(json) ? json : null;
  } catch { return null; } finally { if (fd !== null) try { fs.closeSync(fd); } catch {} }
}

/** The usable rules of a list: non-empty strings within the length cap, each once, at most `max`. */
function ruleList(list, max = Infinity) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    if (typeof r !== 'string' || !r || r.length > MAX_RULE_CHARS || out.includes(r)) continue;
    if (out.length >= max) break;
    out.push(r);
  }
  return out;
}

/** The rules of a parsed settings file → { allow, deny, ask } (bounded string arrays), or null when it has none. */
function rulesOf(settings) {
  const perms = isObj(settings) && isObj(settings.permissions) ? settings.permissions : {};
  const rules = { allow: ruleList(perms.allow, MAX_RULES), deny: ruleList(perms.deny, MAX_RULES), ask: ruleList(perms.ask, MAX_RULES) };
  return KINDS.some((k) => rules[k].length) ? rules : null;
}

/**
 * The desk's settings with the project's rules added: every key the desk has is kept, the three arrays are the
 * project's rules followed by the desk's own, each rule once. Nothing else is taken from the project.
 */
function merge(rules, desk) {
  const own = isObj(desk) ? desk : {};
  const perms = isObj(own.permissions) ? own.permissions : {};
  const next = { ...perms };
  for (const k of KINDS) {
    const all = ruleList([...rules[k], ...ruleList(perms[k])]);
    if (all.length || k in perms) next[k] = all;
  }
  return { ...own, permissions: next };
}

// ---- v3.94 the project account's user-level rules for a desk that runs on another account

const MAX_ARG_CHARS = 32 * 1024;   // a longer --settings JSON is passed as a file (one argument has a size limit)

/**
 * Does this tab get the project account's user-level rules? Only a staff desk of a project whose session runs on
 * another account than the project's (`projectConfigDir` / `deskConfigDir`: null for Default); never HQ, a personal
 * workspace or a member with a mail account (the mail guard decides there).
 */
function accountRulesWanted({ project, tab, hasMail, projectConfigDir, deskConfigDir }) {
  return Boolean(project && tab && tab.staffId && !project.hq && !project.staffOwner && !hasMail
    && (projectConfigDir || '') !== (deskConfigDir || ''));
}

/**
 * The `--settings` JSON of a session with an account's rules added: every key the JSON has is kept, and only
 * `permissions.allow` / `deny` / `ask` of the account's parsed settings.json are taken (rulesOf: bounded string
 * arrays), ahead of the JSON's own. Never `defaultMode`, env, hooks or any other key. No usable rules → the JSON as given.
 */
function withAccountRules(json, accountSettings) {
  const rules = rulesOf(accountSettings);
  if (!rules) return json || null;
  let own = {};
  try { own = json ? JSON.parse(json) : {}; } catch { own = {}; }
  return JSON.stringify(merge(rules, own));
}

/** Where the rules go, or null when the desk's `.claude` or the file itself is something this never writes through (a symlink, a folder, a missing desk folder). */
function target(deskDir) {
  const root = lstat(deskDir);
  if (!root || !root.isDirectory()) return null;
  const dir = path.join(deskDir, '.claude');
  const d = lstat(dir);
  if (d && !d.isDirectory()) return null;
  const file = path.join(deskDir, REL);
  const f = lstat(file);
  if (f && !f.isFile()) return null;
  return { dir, file, exists: Boolean(f) };
}

/**
 * What a sync would write → { status: 'write', dir, file, text } | { status: 'current' | 'no-source' | 'no-target' }.
 * Decided by content: 'current' when the desk's file already holds the merged result. A desk file that is there but
 * is not a JSON object (or is over the cap) is the desk's own and is left alone ('no-target').
 */
function plan(projectDir, deskDir) {
  if (path.resolve(projectDir) === path.resolve(deskDir)) return { status: 'no-target' };
  const rules = rulesOf(readSettings(path.join(projectDir, REL)));
  if (!rules) return { status: 'no-source' };
  const to = target(deskDir);
  if (!to) return { status: 'no-target' };
  const desk = to.exists ? readSettings(to.file) : {};
  if (!desk) return { status: 'no-target' };
  const next = merge(rules, desk);
  if (to.exists && JSON.stringify(next) === JSON.stringify(desk)) return { status: 'current' };
  return { status: 'write', dir: to.dir, file: to.file, text: `${JSON.stringify(next, null, 2)}\n` };
}

/** Is there something to write: usable rules in the project's file that the desk's file does not hold yet. */
const needsSync = (projectDir, deskDir) => plan(projectDir, deskDir).status === 'write';

/**
 * Writes the merged rules into the desk's file. The caller has checked that git does not track the file there and
 * reports it ignored. The temp file is made outside the worktree (`tmpDir`, on the worktree's filesystem: the app's
 * own data folder) and renamed over the name, so nothing half-written or stray is ever in the desk's folder.
 * → 'written' | 'current' | 'no-source' | 'no-target' | 'failed'
 */
function write(projectDir, deskDir, { tmpDir = os.tmpdir() } = {}) {
  const p = plan(projectDir, deskDir);
  if (p.status !== 'write') return p.status;
  const tmp = path.join(tmpDir, `ao-desk-rules-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmp, p.text, { mode: 0o600, flag: 'wx' });
    fs.mkdirSync(p.dir, { recursive: true });
    fs.renameSync(tmp, p.file);   // replaces the name itself: never writes through a link
    return 'written';
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return 'failed';
  }
}

/** What to append to the exclude file's text so it ignores the rules file → the lines, or null when a line for it is already there. */
function excludeAddition(text) {
  const cur = String(text || '');
  if (cur.split(/\r?\n/).some((l) => l.trim() === REL || l.trim() === `/${REL}`)) return null;
  return `${cur && !cur.endsWith('\n') ? '\n' : ''}${EXCLUDE_NOTE}\n${REL}\n`;
}

/** Makes sure the repository's shared `info/exclude` (in its common git dir) has a line for the rules file: appended, what is there is never rewritten. → false when it could not be written. */
function ensureExcluded(commonDir) {
  const d = lstat(commonDir);
  if (!d || !d.isDirectory()) return false;
  const file = path.join(commonDir, 'info', 'exclude');
  try {
    const f = lstat(file);
    if (f && !f.isFile()) return false;
    const add = excludeAddition(f ? fs.readFileSync(file, 'utf8') : '');
    if (add === null) return true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, add);
    return true;
  } catch { return false; }
}

/**
 * The whole sync for one desk. `git(args)` → { ok, stdout } runs git (main.js passes its own; no shell).
 * Nothing is written when git tracks the file in the worktree or cannot say, and nothing unless git reports the file
 * ignored there: when it is not, one line goes into the shared info/exclude and git is asked again (a `.gitignore`
 * that re-includes the file wins over info/exclude: then nothing is written).
 * → 'written' | 'current' | 'no-source' | 'no-target' | 'tracked' | 'not-ignored' | 'failed'
 */
async function sync(projectDir, deskDir, { git, tmpDir }) {
  const p = plan(projectDir, deskDir);
  if (p.status !== 'write') return p.status;
  const tracked = await git(['-C', deskDir, 'ls-files', '--', REL]);
  if (!tracked.ok || tracked.stdout.trim()) return 'tracked';
  const ignored = async () => (await git(['-C', deskDir, 'check-ignore', '-q', '--', REL])).ok;
  if (!(await ignored())) {
    const common = await git(['-C', deskDir, 'rev-parse', '--git-common-dir']);
    if (!common.ok || !common.stdout.trim() || !ensureExcluded(path.resolve(deskDir, common.stdout.trim()))) return 'not-ignored';
    if (!(await ignored())) return 'not-ignored';   // never a file the desk could commit
  }
  return write(projectDir, deskDir, { tmpDir });
}

module.exports = { REL, MAX_BYTES, MAX_RULES, MAX_RULE_CHARS, MAX_ARG_CHARS, accountRulesWanted, withAccountRules, wanted, readSettings, rulesOf, merge, plan, needsSync, write, excludeAddition, ensureExcluded, sync };
