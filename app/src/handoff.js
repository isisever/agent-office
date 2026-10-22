// Project handoff (contract v3.29): the git and file parts. No Electron, no network: src/link.js carries the bytes,
// src/link-host.js runs the flow, main.js stops and starts the tabs. Tested in app/test/link.test.cjs.
//
// Sender: snapshotWip commits the working tree (tracked changes and untracked, not ignored, files) on a new branch
// `agent-office/handoff-<time>` through a temporary index, so the current branch, the real index and the working
// tree stay exactly as they were. prepareCode sends it as a git bundle over the link whenever the bundle fits the
// 200 MB cap; only a larger one is pushed to the project's remote (after the person confirms the URL), and that
// remote branch is deleted again once the receiver applied it. packSession gathers the project's Claude
// transcripts, memory, facts file and settings (never logins or env).
// Receiver: receiveCode fetches the branch (remote or bundle) into the chosen folder (a new folder is initialised),
// restoreWip puts the WIP back as uncommitted changes when the folder is clean and on the same commit, else leaves
// only the branch; writeSession writes the session files under the receiving account, old folder → new folder.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const C = require('./link-core.js');

const BRANCH_PREFIX = 'agent-office/handoff-';
const AREAS = ['projects', 'memory', 'facts'];
const TEXT = /\.(jsonl|json|md|txt)$/i;
const MAX_FILES = 5000;

const gitEnv = (env) => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', ...env });
/** Runs git synchronously in dir; throws on failure. */
function git(dir, args, { env = {}, timeout = 120000 } = {}) {
  return execFileSync('git', args, { cwd: dir, env: gitEnv(env), timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }).toString().trim();
}
const tryGit = (dir, args, o) => { try { return git(dir, args, o); } catch { return null; } };
/** Runs git without blocking (push and fetch may take long). Resolves true when it exits 0. */
const gitAsync = (dir, args, timeout = 300000) => new Promise((resolve) => {
  execFile('git', args, { cwd: dir, env: gitEnv({}), timeout, maxBuffer: 4 * 1024 * 1024 }, (err) => resolve(!err));
});

/** A remote URL without a password or token in it (https://user:token@host → https://host). */
const safeRemote = (url) => String(url || '').trim().replace(/^(https?:\/\/)[^@/]+@/i, '$1');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** Claude Code's folder name for a project path (config/projects/<slug>). */
const slugOf = (dir) => String(dir).normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-');
const stamp = (t) => new Date(t).toISOString().replace(/[^0-9]/g, '').slice(0, 17);

/** What git knows about a folder, or null when it is not in a git work tree. */
function gitInfo(dir) {
  if (!fs.existsSync(dir) || tryGit(dir, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const head = tryGit(dir, ['rev-parse', '--verify', '-q', 'HEAD']) || '';
  const branch = tryGit(dir, ['symbolic-ref', '--short', '-q', 'HEAD']) || '';
  const remoteName = (branch && tryGit(dir, ['config', `branch.${branch}.remote`])) || (tryGit(dir, ['remote']) || '').split('\n')[0] || '';
  const remote = remoteName ? safeRemote(tryGit(dir, ['remote', 'get-url', remoteName])) : '';
  const root = head ? (tryGit(dir, ['rev-list', '--max-parents=0', 'HEAD']) || '').split('\n').pop() || '' : '';
  const dirty = (tryGit(dir, ['status', '--porcelain']) || '') !== '';
  const top = tryGit(dir, ['rev-parse', '--show-toplevel']) || dir;
  return { head, branch, remoteName, remote, root, dirty, top };
}

/**
 * Commits the working tree on a new WIP branch without touching the current branch, index or files.
 * @returns {{ wip: string, commit: string, tree: string, base: string, branch: string, remote: string, remoteName: string, root: string, dirty: boolean, top: string } | null}
 */
function snapshotWip(dir, { now = Date.now } = {}) {
  const info = gitInfo(dir);
  if (!info) return null;
  const tree = worktreeTree(info);
  const ident = tryGit(info.top, ['config', 'user.email']) ? {} : { GIT_AUTHOR_NAME: 'Agent Office', GIT_AUTHOR_EMAIL: 'agent-office@localhost', GIT_COMMITTER_NAME: 'Agent Office', GIT_COMMITTER_EMAIL: 'agent-office@localhost' };
  const commit = git(info.top, ['commit-tree', tree, ...(info.head ? ['-p', info.head] : []), '-m', `Agent Office handoff: work in progress on ${info.branch || 'a detached HEAD'}`], { env: ident });
  const wip = `${BRANCH_PREFIX}${stamp(now())}`;
  git(info.top, ['update-ref', `refs/heads/${wip}`, commit]);
  return { wip, commit, tree, base: info.head, branch: info.branch, remote: info.remote, remoteName: info.remoteName, root: info.root, dirty: info.dirty, top: info.top };
}

/** The tree of the working tree as it is now (tracked and untracked, not ignored), through a temporary index. */
function worktreeTree(info) {
  const gitDir = git(info.top, ['rev-parse', '--absolute-git-dir']);
  const tmpIndex = path.join(gitDir, `agent-office-handoff-${process.pid}-${crypto.randomBytes(4).toString('hex')}.index`);
  try {
    const env = { GIT_INDEX_FILE: tmpIndex };
    if (info.head) git(info.top, ['read-tree', info.head], { env });
    git(info.top, ['add', '-A'], { env });
    return git(info.top, ['write-tree'], { env });
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

/** 'changed' when the folder's HEAD or files differ from the snapshot (work done during the transfer), else null. */
function changedSince(snap, dir) {
  const info = gitInfo(dir);
  if (!info || info.head !== snap.base) return 'changed';
  try { return worktreeTree(info) === snap.tree ? null : 'changed'; } catch { return 'changed'; }
}

/** Is dir the top of its git work tree (not a subfolder of a larger repository)? */
function isRepoRoot(dir) {
  const info = gitInfo(dir);
  if (!info) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(info.top) === real(dir);
}

/** Pushes the WIP branch to the project's remote (the repository's hooks run). Resolves false when there is none or it fails. */
function pushWip(snap) {
  if (!snap?.remoteName) return Promise.resolve(false);
  return gitAsync(snap.top, ['push', snap.remoteName, `refs/heads/${snap.wip}:refs/heads/${snap.wip}`]);
}
/** Deletes the pushed WIP branch from the remote again (after the receiver applied it). Best effort. */
function deleteRemoteWip(snap) {
  if (!snap?.remoteName || !snap.wip) return Promise.resolve(false);
  return gitAsync(snap.top, ['push', snap.remoteName, '--delete', `refs/heads/${snap.wip}`]);
}

/**
 * How the code travels: a bundle over the link whenever it fits maxBundle (nothing is pushed); else, only after
 * confirmPush(remote URL without credentials) says yes, a push of the WIP branch to the project's remote.
 * @param {any} snap @param {string} tmpDir @param {{ confirmPush: (url: string) => Promise<boolean> | boolean, maxBundle?: number }} o
 * @returns {Promise<{ mode: 'bundle' | 'remote', bundle: Buffer | null } | { reason: string }>}
 */
async function prepareCode(snap, tmpDir, { confirmPush, maxBundle = C.MAX_BUNDLE }) {
  const bundle = createBundle(snap, tmpDir, maxBundle);
  if (bundle) return { mode: 'bundle', bundle };
  if (!snap.remoteName || !snap.remote) return { reason: 'too-large' };
  if (!(await confirmPush(safeRemote(snap.remote)))) return { reason: 'push-declined' };
  if (!(await pushWip(snap))) return { reason: 'push-failed' };
  return { mode: 'remote', bundle: null };
}

/** The WIP branch (with its history) as a git bundle file's bytes; null when larger than maxBundle. */
function createBundle(snap, tmpDir, maxBundle = C.MAX_BUNDLE) {
  const file = path.join(tmpDir, `handoff-${crypto.randomBytes(6).toString('hex')}.bundle`);
  try {
    git(snap.top, ['bundle', 'create', file, `refs/heads/${snap.wip}`]);
    if (fs.statSync(file).size > maxBundle) return null;
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Is the folder the same repository as the offer's (same remote URL or same root commit)? */
function sameRepo(dir, g) {
  const info = gitInfo(dir);
  if (!info) return false;
  return Boolean((g.remote && info.remote && safeRemote(info.remote) === g.remote) || (g.root && info.root === g.root));
}
const isEmptyDir = (dir) => { try { return fs.readdirSync(dir).length === 0; } catch { return !fs.existsSync(dir); } };

/** The folder the receiver uses without asking: the sender's path when it is free or the same repository. */
function defaultTarget(offer) {
  const free = isEmptyDir(offer.dir) && fs.existsSync(path.dirname(offer.dir));   // another home layout: ask
  return free || sameRepo(offer.dir, offer.git) ? offer.dir : null;
}

/** Gets the WIP branch into dir: a missing or empty folder is initialised first (with the remote as origin). */
async function receiveCode(dir, g, bundleFile) {
  if (!gitInfo(dir)) {
    if (!isEmptyDir(dir)) throw new Error('not-empty');
    fs.mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q']);
    if (g.remote) git(dir, ['remote', 'add', 'origin', g.remote]);
  }
  const ref = `refs/heads/${g.wip}:refs/heads/${g.wip}`;
  if (bundleFile) {
    git(dir, ['bundle', 'verify', '-q', bundleFile]);
    git(dir, ['fetch', '-q', bundleFile, ref]);
  } else if (!(await gitAsync(dir, ['fetch', '-q', g.remote, ref]))) throw new Error('fetch-failed');
}

/**
 * Puts the WIP into the working tree when that is safe: a fresh folder gets the sender's branch at its base commit
 * with the WIP as uncommitted changes; a clean folder on the same commit gets the WIP as uncommitted changes;
 * anything else keeps only the branch.
 * @returns {'restored' | 'branch-only'}
 */
function restoreWip(dir, g) {
  const info = gitInfo(dir);
  if (!info) return 'branch-only';
  if (!info.head) {
    if (!g.base) { git(dir, ['checkout', '-q', g.wip]); return 'restored'; }
    git(dir, g.branch ? ['checkout', '-q', '-B', g.branch, g.base] : ['checkout', '-q', '--detach', g.base]);
  } else if (info.dirty || info.head !== g.base) return 'branch-only';
  git(dir, ['read-tree', '-u', '--reset', g.wip]);   // index and files = the WIP tree
  git(dir, ['reset', '-q']);                          // index back to HEAD: the WIP stays as uncommitted changes
  return 'restored';
}

// --- session data

/** A relative path that stays inside its base folder: no absolute path, no `..`, no backslash or NUL. */
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 300 || /[\\\0]/.test(rel) || path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split('/').every((s) => s && s !== '.' && s !== '..');
}
/** base/rel when it is inside base, else null. */
function inside(base, rel) {
  if (!safeRel(rel)) return null;
  const b = path.resolve(base);
  const p = path.resolve(b, ...rel.split('/'));
  return p.startsWith(b + path.sep) ? p : null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Text with every occurrence of the folder `from` (as a whole path, plain or JSON-escaped) replaced by `to`. */
function rewritePaths(text, from, to) {
  if (!from || from === to) return text;
  const pairs = new Map([[from, to], [JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)]]);
  let out = text;
  for (const [a, b] of pairs) out = out.replace(new RegExp(`${escapeRe(a)}(?=$|[\\\\/"'\\s:,;)\\]}])`, 'gm'), () => b);
  return out;
}

/** Regular files under dir (no links), as posix relative paths. */
function walk(dir, rel = '', out = [], depth = 6) {
  let names = [];
  try { names = fs.readdirSync(path.join(dir, rel)); } catch { return out; }
  for (const n of names) {
    const r = rel ? `${rel}/${n}` : n;
    const st = fs.lstatSync(path.join(dir, r));
    if (st.isDirectory() && depth > 0) walk(dir, r, out, depth - 1);
    else if (st.isFile()) out.push(r);
  }
  return out;
}

const SETTINGS = ['manager', 'bossModel', 'agentModel', 'contextCap', 'savings', 'engine'];
/** The project's Agent Office settings that travel (no account, no credentials); each value small and plain. */
function cleanSettings(s) {
  const out = {};
  for (const k of SETTINGS) {
    const v = s?.[k];
    if (v == null || typeof v === 'function') continue;
    const json = JSON.stringify(v);
    if (json && json.length <= 2000) out[k] = JSON.parse(json);
  }
  return out;
}

const validSid = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(s);

/**
 * The project's session data as one buffer: transcripts (and their <session>/ folders) of the given sessions, the
 * memory folder, the facts file and the settings.
 * @param {{ root: string, dir: string, sessionIds: string[], memoryDir?: string | null, factsFile?: string | null, settings?: any }} o
 */
function packSession(o) {
  const files = [];
  let size = 0;
  const add = (area, rel, file) => {
    if (files.length >= MAX_FILES) return;
    const data = fs.readFileSync(file);
    size += data.length;
    if (size > C.MAX_PACK) throw new Error('too-large');
    files.push({ area, rel, data: data.toString('base64') });
  };
  const sessionIds = (o.sessionIds || []).filter(validSid);
  const proj = path.join(o.root, 'projects', slugOf(o.dir));
  for (const sid of sessionIds) {
    const f = path.join(proj, `${sid}.jsonl`);
    if (fs.existsSync(f)) add('projects', `${sid}.jsonl`, f);
    for (const r of walk(path.join(proj, sid))) add('projects', `${sid}/${r}`, path.join(proj, sid, r));
  }
  if (o.memoryDir) for (const r of walk(o.memoryDir)) add('memory', r, path.join(o.memoryDir, r));
  if (o.factsFile && fs.existsSync(o.factsFile)) add('facts', 'facts.md', o.factsFile);
  const present = sessionIds.filter((sid) => files.some((f) => f.rel === `${sid}.jsonl`));
  return Buffer.from(JSON.stringify({ v: 1, dir: o.dir, settings: cleanSettings(o.settings), sessionIds: present, files }));
}

/** A received pack checked field by field; null when anything is off (one bad path rejects all of it). */
function parsePack(buf) {
  let p;
  try { p = JSON.parse(buf.toString('utf8')); } catch { return null; }
  if (!p || p.v !== 1 || typeof p.dir !== 'string' || !Array.isArray(p.files) || p.files.length > MAX_FILES || !Array.isArray(p.sessionIds)) return null;
  if (!p.sessionIds.every(validSid) || p.sessionIds.length > 50) return null;
  for (const f of p.files) {
    if (!f || !AREAS.includes(f.area) || !safeRel(f.rel) || typeof f.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) return null;
    if (f.area === 'facts' && f.rel !== 'facts.md') return null;
  }
  return { dir: p.dir, settings: cleanSettings(p.settings), sessionIds: p.sessionIds, files: p.files };
}

/**
 * Writes a parsed pack under the receiving account: transcripts to <root>/projects/<slug of the new folder>/,
 * memory to memoryDir, the facts file to factsFile; old folder → new folder inside text files. A file already there
 * is kept unless the incoming one continues it (starts with its content); a transcript gets the missing lines.
 * @param {{ files: any[] }} pack @param {{ from: string, to: string, root: string, memoryDir: string, factsFile: string }} o
 */
function writeSession(pack, o) {
  const bases = { projects: path.join(o.root, 'projects', slugOf(o.to)), memory: o.memoryDir };
  const out = { written: 0, kept: 0 };
  for (const f of pack.files) {
    const target = f.area === 'facts' ? o.factsFile : inside(bases[f.area], f.rel);
    if (!target) throw new Error('bad-path');
    let data = Buffer.from(f.data, 'base64');
    if (TEXT.test(f.rel)) data = Buffer.from(rewritePaths(data.toString('utf8'), o.from, o.to));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let old = null;
    try { old = fs.readFileSync(target); } catch { /* new file */ }
    if (!old || data.subarray(0, old.length).equals(old)) { fs.writeFileSync(target, data); out.written++; continue; }
    if (f.rel.endsWith('.jsonl')) {
      const have = new Set(old.toString('utf8').split('\n'));
      const add = data.toString('utf8').split('\n').filter((l) => l && !have.has(l));
      if (add.length) fs.appendFileSync(target, `${old.toString('utf8').endsWith('\n') ? '' : '\n'}${add.join('\n')}\n`);
      out.written++;
    } else out.kept++;
  }
  return out;
}

/**
 * Why this project cannot be handed off now, or null. Claude Code projects only, the top folder of a git repository
 * (a subfolder of a larger repository is refused), no busy tab, the device online.
 * A connection (contract v3.43, a project with `mcp`) is refused: its token and address stay on this machine.
 * @param {{ connection?: boolean, engine?: string, busy?: boolean, git?: boolean, subfolder?: boolean, online?: boolean }} o
 */
function refusal(o) {
  if (o.online === false) return 'offline';
  if (o.connection) return 'connection';
  if (o.engine !== 'claude') return 'engine';
  if (!o.git) return 'not-git';
  if (o.subfolder) return 'subfolder';
  if (o.busy) return 'busy';
  return null;
}

module.exports = {
  BRANCH_PREFIX, git, gitInfo, safeRemote, sha256, slugOf, snapshotWip, changedSince, isRepoRoot, pushWip, deleteRemoteWip, prepareCode, createBundle, sameRepo, defaultTarget,
  receiveCode, restoreWip, safeRel, inside, rewritePaths, cleanSettings, packSession, parsePack, writeSession, refusal,
};
