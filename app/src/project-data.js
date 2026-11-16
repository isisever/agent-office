// A project's Claude Code data follows it to another account (contract v3.16; no Electron; tested with node --test).
//
// Every account is its own CLAUDE_CONFIG_DIR, and Claude Code keeps a project's conversations and state in the
// config folder: a project moved to another account started with no conversation to --resume or --continue, no
// trust or tool approvals, no local MCP servers, no up-arrow history, and an empty token usage panel (it reads the
// transcripts). When a project's account changes, main calls moveProjectData before its tabs start again: the
// project's data is copied from the old account's folder into the new one and merged with what is there. Copied,
// not moved: the old account keeps its copy, so switching back loses nothing and nothing is deleted.
//
// What is copied (Claude Code 2.1.300 layout, read from a real ~/.claude):
// - <config>/projects/<slug>/** for the project's folder, its tab folders and its worktrees (token-usage.js
//   projectFolders; the slug of the path as given and of its real path): <session>.jsonl transcripts and the
//   <session>/ folders beside them (subagents, tool results). The memory/ folder is left out when the app keeps
//   the project's memory in ~/.claude (memory.js): the old account's own memories are merged there instead
//   (mergeMemory, which never brings back a memory the user deleted).
// - per session (the transcripts' ids): file-history/<session>/ (checkpoints for /rewind), tasks/<session>/ and
//   todos/<session>-*.json.
// - history.jsonl lines whose `project` is one of the project's folders (the prompt history), and the
//   paste-cache/<hash>.txt files those lines name.
// - the `projects[<folder>]` entries of the account's .claude.json (trust, allowed tools, local MCP servers,
//   .mcp.json approvals, onboarding counters). Nothing else in .claude.json is read into the new account.
//
// Merge, never lose: a file the new account lacks is copied; a transcript both have is kept when it already holds
// the other's lines, replaced by the other when the other holds all of its lines (a conversation continued
// elsewhere), else the other's missing lines are appended (Claude Code transcripts are a tree of uuid/parentUuid
// records, so a union is a valid transcript and --resume picks the newest leaf); any other file is replaced only by
// a newer one. A .claude.json entry keeps the new account's values; what only the old one has is added, lists are
// joined, and an accepted trust dialog stays accepted.
//
// Acceptances the person already gave in the old account (contract v3.76; Claude Code 2.1.325), so that a moved
// tab starts without a start-up dialog. Only a decision the old account holds is carried, never a new one:
// - folder trust that the old account holds on a parent folder (Claude Code trusts a folder when its own entry or
//   any parent's has hasTrustDialogAccepted) is written as the project folder's own entry, never the parent's;
// - the bypass mode warning ("Claude Code running in Bypass Permissions mode"), kept per account in the user
//   settings (settings.json skipDangerousModePermissionPrompt; older versions: .claude.json
//   bypassPermissionsModeAccepted), only for a project with Skip permissions on (contract v3.72).
//
// Never copied: logins and per-account settings (.credentials.json, the keychain, .claude.json oauthAccount,
// primaryApiKey, userID and every other top-level field, every other settings.json key, skills, plugins, agents,
// commands), session-env/ (hook environments, remade at every start) and anything of another project.
const fs = require('fs');
const path = require('path');
const TU = require('./token-usage.js');
const M = require('./memory.js');

const SESSION_DIRS = ['file-history', 'tasks'];
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const names = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const realOr = (d) => { try { return fs.realpathSync(d).normalize('NFC'); } catch { return d; } };
const validId = (s) => /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(s);

/** The config folder of an account: its CLAUDE_CONFIG_DIR, or ~/.claude for Default (configDir null). */
const claudeRoot = (configDir, home) => configDir || path.join(home, '.claude');
/** Its .claude.json: <CLAUDE_CONFIG_DIR>/.claude.json, or ~/.claude.json for Default. */
const claudeJson = (configDir, home) => (configDir ? path.join(configDir, '.claude.json') : path.join(home, '.claude.json'));

/** The folders a project's data is keyed by: each as given and as its real path, unique, in order. */
function projectPaths(dirs) {
  const out = [];
  for (const d of dirs) if (typeof d === 'string' && d) out.push(d, realOr(d));
  return [...new Set(out)];
}

// ---- files

/** Sets dst's times to src's (a copied transcript keeps its age: --continue picks the newest). */
function keepTimes(src, dst) {
  try { const s = fs.statSync(src); fs.utimesSync(dst, s.atime, s.mtime); } catch {}
}

function copyNew(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
  keepTimes(src, dst);
}

/** Replaces dst with src through a temp file (a reader never sees half a file). */
function replace(src, dst) {
  const tmp = `${dst}.agent-office-${process.pid}`;
  fs.copyFileSync(src, tmp);
  keepTimes(src, tmp);
  fs.renameSync(tmp, dst);
}

const lines = (text) => text.split('\n').filter((l) => l.trim());

/**
 * Merges transcript src into dst (both exist). → 'same' | 'kept' (dst holds every line of src) | 'replaced' (src
 * holds every line of dst) | 'joined' (src's other lines appended to dst).
 */
function mergeJsonl(src, dst) {
  const a = fs.readFileSync(src, 'utf8');
  const b = fs.readFileSync(dst, 'utf8');
  if (a === b) return 'same';
  const la = lines(a);
  const lb = lines(b);
  const inB = new Set(lb);
  const missing = la.filter((l) => !inB.has(l));
  if (!missing.length) return 'kept';
  const inA = new Set(la);
  if (lb.every((l) => inA.has(l))) { replace(src, dst); return 'replaced'; }
  fs.appendFileSync(dst, (b.endsWith('\n') || !b ? '' : '\n') + missing.join('\n') + '\n');
  try {
    const s = fs.statSync(src);
    const d = fs.statSync(dst);
    if (s.mtimeMs > d.mtimeMs) fs.utimesSync(dst, d.atime, s.mtime);
  } catch {}
  return 'joined';
}

/** Merges one file; → what happened ('copied' | 'newer' | 'older' | mergeJsonl's result). */
function mergeFile(src, dst) {
  const d = lstat(dst);
  if (!d) { copyNew(src, dst); return 'copied'; }
  if (!d.isFile()) return 'older'; // a folder or link of the new account's: left alone
  if (src.endsWith('.jsonl')) return mergeJsonl(src, dst);
  const s = fs.statSync(src);
  // newer by more than the 1 ms a copied file's time can lose; the same bytes are never rewritten
  if (s.mtimeMs - d.mtimeMs <= 1 || (s.size === d.size && fs.readFileSync(src).equals(fs.readFileSync(dst)))) return 'older';
  replace(src, dst);
  return 'newer';
}

/**
 * Merges the tree under src into dst (regular files only; links are skipped). skip(rel): leave this entry out.
 * Returns the counts { copied, merged } (merged: a file both had that changed in dst).
 * @param {string} src
 * @param {string} dst
 * @param {{ skip?: (rel: string) => boolean, depth?: number }} [opts]
 * @param {string} [rel]
 * @param {{ copied: number, merged: number }} [out]
 * @returns {{ copied: number, merged: number }}
 */
function mergeTree(src, dst, { skip = () => false, depth = 8 } = {}, rel = '', out = { copied: 0, merged: 0 }) {
  let entries;
  try { entries = fs.readdirSync(path.join(src, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (skip(r)) continue;
    const s = path.join(src, ...r.split('/'));
    const d = path.join(dst, ...r.split('/'));
    if (e.isDirectory()) { if (depth > 1) mergeTree(src, dst, { skip, depth: depth - 1 }, r, out); continue; }
    if (!e.isFile()) continue;
    try {
      const how = mergeFile(s, d);
      if (how === 'copied') out.copied++;
      else if (how === 'newer' || how === 'replaced' || how === 'joined') out.merged++;
    } catch {}
  }
  return out;
}

// ---- .claude.json projects entries

const STICKY_TRUE = /^has/; // hasTrustDialogAccepted, hasCompletedProjectOnboarding, hasClaudeMdExternalIncludesApproved…

/** One projects[dir] entry: the new account's (into) values win; the old one's (from) fill the gaps. */
function mergeEntry(into, from) {
  if (!isObj(into)) return isObj(from) ? structuredClone(from) : into;
  if (!isObj(from)) return into;
  const out = { ...into };
  for (const [k, v] of Object.entries(from)) {
    const cur = out[k];
    if (cur === undefined || cur === null) out[k] = structuredClone(v);
    else if (Array.isArray(cur) && Array.isArray(v)) {
      const seen = new Set(cur.map((x) => JSON.stringify(x)));
      out[k] = [...cur, ...v.filter((x) => !seen.has(JSON.stringify(x)))];
    } else if (isObj(cur) && isObj(v)) out[k] = mergeEntry(cur, v);
    else if (STICKY_TRUE.test(k) && v === true && cur === false) out[k] = true;
  }
  return out;
}

const TRUST_KEY = 'hasTrustDialogAccepted';

/**
 * Whether Claude Code starts in dir without its trust dialog under this projects map: the folder's own entry or
 * any parent folder's has hasTrustDialogAccepted (checked against Claude Code 2.1.325).
 */
function trustedIn(projects, dir) {
  if (!isObj(projects) || typeof dir !== 'string' || !dir) return false;
  for (let d = dir; ; d = path.dirname(d)) {
    if (isObj(projects[d]) && projects[d][TRUST_KEY] === true) return true;
    if (path.dirname(d) === d) return false;
  }
}

/**
 * The new account's .claude.json object with the old account's projects[dir] entries merged in, for dirs only.
 * A folder the old account trusts through a parent folder's entry gets the trust on its own entry (v3.76); the
 * parent's entry is never copied. Every other field of `to` stays as it is; nothing outside `from.projects` is
 * read, and of the parents' entries only hasTrustDialogAccepted. → { config, changed }
 */
function mergeProjectEntries(to, from, dirs) {
  const src = isObj(from?.projects) ? from.projects : {};
  const base = isObj(to) ? to : {};
  const projects = isObj(base.projects) ? { ...base.projects } : {};
  let changed = false;
  for (const dir of dirs) {
    if (isObj(src[dir])) {
      const next = mergeEntry(projects[dir], src[dir]);
      if (JSON.stringify(next) !== JSON.stringify(projects[dir])) { projects[dir] = next; changed = true; }
    }
    if (trustedIn(src, dir) && !trustedIn(projects, dir)) {
      projects[dir] = { ...(isObj(projects[dir]) ? projects[dir] : {}), [TRUST_KEY]: true };
      changed = true;
    }
  }
  return { config: changed ? { ...base, projects } : base, changed };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** Writes a JSON file through a temp file beside it (mode kept, 0600 for a new file; a link's target is written). */
function writeJson(file, value) {
  let real = file; // the link's target as the file system names it (no NFC step: the write must land on the real file)
  try { real = fs.realpathSync(file); } catch {}
  let mode = 0o600;
  try { mode = fs.statSync(real).mode & 0o777; } catch {}
  fs.mkdirSync(path.dirname(real), { recursive: true });
  const tmp = `${real}.agent-office-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tmp, real);
}

/** Merges the entries into the new account's .claude.json file (read just before the write; atomic, mode kept). */
function mergeClaudeJson(fromFile, toFile, dirs) {
  const from = readJson(fromFile);
  if (!isObj(from?.projects)) return false;
  const exists = Boolean(lstat(toFile));
  const to = exists ? readJson(toFile) : {};
  if (exists && !isObj(to)) return false; // unreadable: never replace the account's config with a guess
  const { config, changed } = mergeProjectEntries(to, from, dirs);
  if (!changed) return false;
  writeJson(toFile, config);
  return true;
}

// ---- the bypass mode warning (contract v3.76)

const BYPASS_KEY = 'skipDangerousModePermissionPrompt';      // user settings.json; what Claude Code 2.1.325 writes
const BYPASS_KEY_LEGACY = 'bypassPermissionsModeAccepted';   // top level of .claude.json; older versions, still read

/** Whether the account has accepted Claude Code's bypass mode warning. configDir: null for Default. */
function bypassAccepted(configDir, home) {
  const settings = readJson(path.join(claudeRoot(configDir, home), 'settings.json'));
  if (isObj(settings) && settings[BYPASS_KEY] === true) return true;
  const config = readJson(claudeJson(configDir, home));
  return isObj(config) && config[BYPASS_KEY_LEGACY] === true;
}

/**
 * Carries the old account's acceptance of the bypass mode warning to the new account: that one key in the new
 * account's settings.json, written only when the old account has accepted and the new one has not. Every other
 * key stays as it is; a settings.json that does not parse is left alone. → whether the file was written
 */
function carryBypassAcceptance(from, to, home) {
  if (!bypassAccepted(from, home) || bypassAccepted(to, home)) return false;
  const file = path.join(claudeRoot(to, home), 'settings.json');
  const exists = Boolean(lstat(file));
  const settings = exists ? readJson(file) : {};
  if (!isObj(settings)) return false;
  writeJson(file, { ...settings, [BYPASS_KEY]: true });
  return true;
}

// ---- history.jsonl and paste-cache

/** The lines of the old history for the project's folders that the new one lacks, and the paste hashes they name. */
function historyLines(fromText, toText, dirs) {
  const want = new Set(dirs);
  const have = new Set(lines(toText || ''));
  const add = [];
  const pastes = new Set();
  for (const l of lines(fromText || '')) {
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (!isObj(o) || !want.has(o.project) || have.has(l)) continue;
    add.push(l);
    have.add(l);
    for (const p of Object.values(isObj(o.pastedContents) ? o.pastedContents : {})) {
      if (isObj(p) && typeof p.contentHash === 'string' && /^[A-Za-z0-9]+$/.test(p.contentHash)) pastes.add(p.contentHash);
    }
  }
  return { add, pastes: [...pastes] };
}

function mergeHistory(fromRoot, toRoot, dirs) {
  let fromText = '';
  try { fromText = fs.readFileSync(path.join(fromRoot, 'history.jsonl'), 'utf8'); } catch { return 0; }
  const file = path.join(toRoot, 'history.jsonl');
  let toText = '';
  try { toText = fs.readFileSync(file, 'utf8'); } catch {}
  const { add, pastes } = historyLines(fromText, toText, dirs);
  for (const h of pastes) {
    const src = path.join(fromRoot, 'paste-cache', `${h}.txt`);
    if (lstat(src)?.isFile() && !lstat(path.join(toRoot, 'paste-cache', `${h}.txt`))) {
      try { copyNew(src, path.join(toRoot, 'paste-cache', `${h}.txt`)); } catch {}
    }
  }
  if (!add.length) return 0;
  fs.mkdirSync(toRoot, { recursive: true });
  // appended, not rewritten: a running session of the new account may be writing it at the same moment
  fs.appendFileSync(file, (toText && !toText.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
  return add.length;
}

// ---- the whole move

/**
 * Copies a project's Claude Code data from one account to another and merges it with what the new account has.
 * from / to: the accounts' configDir (null for Default); home: the user's home; dirs: the project's folder first,
 * then its tab folders; otherDirs: the other projects' folders (their worktree-like folders are not this project's).
 * skipPermissions: the project starts its tabs in bypass mode (v3.72), so the old account's acceptance of the
 * bypass mode warning goes with it (v3.76).
 * → { folders, copied, merged, sessions, history, config, memory, bypass } (counts; config: .claude.json changed;
 * memory: the old account's memories merged into ~/.claude; bypass: the acceptance was written to the new
 * account's settings.json). Same folder on both sides: nothing to do.
 * @param {{ from: string | null, to: string | null, home: string, dirs: string[], otherDirs?: string[], skipPermissions?: boolean }} o
 */
function moveProjectData({ from, to, home, dirs, otherDirs = [], skipPermissions = false }) {
  const fromRoot = claudeRoot(from, home);
  const toRoot = claudeRoot(to, home);
  const result = { folders: 0, copied: 0, merged: 0, sessions: 0, history: 0, config: false, memory: 0, bypass: false };
  if (path.resolve(fromRoot) === path.resolve(toRoot) || !dirs.length) return result;
  const paths = projectPaths(dirs);
  const others = projectPaths(otherDirs);

  // memory (memory.js): kept in ~/.claude for every account; the old account's own memories are merged there
  const base = M.memoryBase(dirs[0]);
  const memSlug = M.memorySlug(base);
  if (from && memSlug) {
    try { result.memory = M.mergeMemory(M.accountMemoryDir({ configDir: from, base }), path.join(home, '.claude', 'projects', memSlug, 'memory')).length; } catch {}
  }

  // transcripts and the session folders beside them
  const fromProjects = path.join(fromRoot, 'projects');
  const toProjects = path.join(toRoot, 'projects');
  const folders = TU.projectFolders(names(fromProjects), paths, others.filter((d) => !paths.includes(d)));
  const sessions = new Set();
  for (const f of folders) {
    const src = path.join(fromProjects, f);
    if (!lstat(src)?.isDirectory()) continue;
    result.folders++;
    for (const n of names(src)) if (n.endsWith('.jsonl') && validId(n.slice(0, -6))) sessions.add(n.slice(0, -6));
    const skip = (rel) => rel === 'memory' && Boolean(memSlug);
    const r = mergeTree(src, path.join(toProjects, f), { skip });
    result.copied += r.copied;
    result.merged += r.merged;
  }

  // per-session state
  for (const sid of sessions) {
    for (const d of SESSION_DIRS) {
      const src = path.join(fromRoot, d, sid);
      if (!lstat(src)?.isDirectory()) continue;
      const r = mergeTree(src, path.join(toRoot, d, sid));
      result.copied += r.copied;
      result.merged += r.merged;
    }
    for (const n of names(path.join(fromRoot, 'todos'))) {
      if (!n.startsWith(`${sid}-`) || !n.endsWith('.json')) continue;
      try {
        const how = mergeFile(path.join(fromRoot, 'todos', n), path.join(toRoot, 'todos', n));
        if (how === 'copied') result.copied++; else if (how === 'newer') result.merged++;
      } catch {}
    }
  }
  result.sessions = sessions.size;

  try { result.history = mergeHistory(fromRoot, toRoot, paths); } catch {}
  try { result.config = mergeClaudeJson(claudeJson(from, home), claudeJson(to, home), paths); } catch {}
  if (skipPermissions === true) { try { result.bypass = carryBypassAcceptance(from, to, home); } catch {} }
  return result;
}

/**
 * How a tab of the moved project starts again under the new account: the conversation it was in (--resume <id>),
 * else for a tab that continues (main tab, worktree tab) the folder's newest one (--continue), else fresh
 * (mcp-reload.js restartOptions). A tab that was mid-turn also gets `prompt` (it goes only with a resume).
 * @param {{ sessionId?: string | null, continues?: boolean, busy?: boolean }} o @param {string} prompt
 */
function restartAfterMove({ sessionId = null, continues = false, busy = false } = {}, prompt = '') {
  const opts = require('./mcp-reload.js').restartOptions({ sessionId, continues });
  return busy && prompt && (opts.sessionId || opts.resume) ? { ...opts, prompt } : opts;
}

module.exports = {
  restartAfterMove, claudeRoot, claudeJson, projectPaths, mergeJsonl, mergeFile, mergeTree, mergeEntry, mergeProjectEntries, mergeClaudeJson,
  historyLines, mergeHistory, trustedIn, bypassAccepted, carryBypassAcceptance, moveProjectData,
};
