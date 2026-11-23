// Moving a session to another computer: the file and git work (Node only, no Electron; see transfer.js for the format).
// main.js asks the questions and calls these; a sync feature can call them the same way. git never asks for a
// password (GIT_TERMINAL_PROMPT=0), never pushes and never changes an existing branch.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const T = require('./transfer.js');
const P = require('./projects.js');
const M = require('./memory.js');

/**
 * Runs git; never throws. stdout is a Buffer (patches and bundles are binary), text its trimmed string.
 * @param {string[]} args @param {{ cwd?: string, env?: Record<string, string>, timeout?: number }} [o]
 * @returns {Promise<{ ok: boolean, stdout: Buffer, text: string, stderr: string }>}
 */
function runGit(args, { cwd, env = {}, timeout = 300000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd, timeout, encoding: 'buffer', maxBuffer: 1 << 30, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', ...env },
    }, (err, stdout, stderr) => {
      const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || ''));
      resolve({ ok: !err, stdout: out, text: out.toString('utf8').trim(), stderr: String(stderr || '').trim() || (err ? err.message : '') });
    });
  });
}

const realOr = (d) => { try { return fs.realpathSync(d); } catch { return d; } };
const claudeRoot = (configDir, home) => configDir || path.join(home, '.claude');
const officeSessionFile = (home, id) => path.join(home, '.claude', 'agent-office', 'sessions', `${id}.json`);
const isFile = (f) => { try { return fs.lstatSync(f).isFile(); } catch { return false; } };
/** Claude Code keys a session folder by the real path of its cwd (tried: /tmp/x → -private-tmp-x on macOS). */
const historyDirOf = (dir, configDir, home) => P.historyDir(realOr(dir).normalize('NFC'), configDir, home);

/** Regular files under root (links skipped), as [{ rel: 'a/b.txt', abs }]; at most depth levels deep. */
function walkFiles(root, depth = 4, rel = '') {
  let names;
  try { names = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of names) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isFile()) out.push({ rel: r, abs: path.join(root, ...r.split('/')) });
    else if (d.isDirectory() && depth > 1) out.push(...walkFiles(root, depth - 1, r));
  }
  return out;
}

/** Every <config>/projects/<slug>/<id>.jsonl of this account (claude --resume <id> finds a session in any of them). */
function findSessionFiles(id, configDir, home) {
  const root = path.join(claudeRoot(configDir, home), 'projects');
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return []; }
  return dirs.map((d) => path.join(root, d, `${id}.jsonl`)).filter(isFile);
}

/** The transcript of the session: the project's own folder first (as given, then real path), else any project folder. */
function findTranscript(dir, id, configDir, home) {
  for (const h of [P.historyDir(dir, configDir, home), historyDirOf(dir, configDir, home)]) {
    const f = path.join(h, `${id}.jsonl`);
    if (isFile(f)) return { historyDir: h, file: f };
  }
  const any = findSessionFiles(id, configDir, home)[0];
  return any ? { historyDir: path.dirname(any), file: any } : null;
}

/** v3.118 the folders Claude Code keeps a project folder's sessions in (as typed and with links resolved). */
const historyDirsOf = (dir, configDir, home) => [...new Set([P.historyDir(dir, configDir, home), historyDirOf(dir, configDir, home)])];

/** The newest session of the folder (for a tab whose claude is not running), or null. */
function newestSession(dir, configDir, home) {
  let best = null;
  for (const h of new Set([P.historyDir(dir, configDir, home), historyDirOf(dir, configDir, home)])) {
    let names = [];
    try { names = fs.readdirSync(h).filter((n) => /^[A-Za-z0-9][A-Za-z0-9-]*\.jsonl$/.test(n)); } catch {}
    for (const n of names) {
      try {
        const t = fs.statSync(path.join(h, n)).mtimeMs;
        if (!best || t > best.t) best = { id: n.slice(0, -6), t };
      } catch {}
    }
  }
  return best ? best.id : null;
}

/** The project's memory folder in ~/.claude (memory.js: the one every account uses in the app), or null for hashed slugs. */
function memoryDirOf(dir, home) {
  const slug = M.memorySlug(M.memoryBase(dir));
  return slug ? path.join(home, '.claude', 'projects', slug, 'memory') : null;
}

const HANDOFF_ENV = {
  GIT_AUTHOR_NAME: 'Agent Office', GIT_AUTHOR_EMAIL: 'agent-office@localhost',
  GIT_COMMITTER_NAME: 'Agent Office', GIT_COMMITTER_EMAIL: 'agent-office@localhost',
};

/**
 * The code side of an export. null if dir is not in a git repository (or it has no commit yet: noCommits).
 * The uncommitted work becomes one commit object on top of HEAD, built in a copy of the index (the user's index,
 * branches and stash are not touched); a temporary ref names it for `git bundle` and is deleted right after.
 */
async function gitExport(dir, sessionId, tmp) {
  const top0 = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
  if (!top0.ok || !top0.text) return null;
  const top = top0.text;
  const g = (args, env) => runGit(args, { cwd: top, env });
  const head = await g(['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head.ok) return { noCommits: true };
  const branch = (await g(['symbolic-ref', '--short', '-q', 'HEAD'])).text || null;
  const remotes = [];
  for (const name of (await g(['remote'])).text.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const u = await g(['remote', 'get-url', name]);
    if (u.ok && u.text) remotes.push({ name, url: T.redactRemote(u.text) });
  }
  const up = await g(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = up.ok && up.text ? up.text : null;
  const upRemote = upstream && remotes.find((r) => upstream.startsWith(`${r.name}/`));
  const remote = (upRemote || remotes.find((r) => r.name === 'origin') || remotes[0] || null)?.url || null;
  const subdir = path.relative(realOr(top), realOr(dir)).split(path.sep).join('/');

  // untracked files that look like secrets stay out (the user is told)
  const others = (await g(['ls-files', '--others', '--exclude-standard', '-z'])).stdout.toString('utf8').split('\0').filter(Boolean);
  const skipped = others.filter((f) => T.isSecretFile(f));
  const index = path.join(tmp, 'index');
  const real = (await g(['rev-parse', '--git-path', 'index'])).text;
  const realIndex = real ? path.resolve(top, real) : '';
  if (realIndex && isFile(realIndex)) fs.copyFileSync(realIndex, index);
  else await g(['read-tree', 'HEAD'], { GIT_INDEX_FILE: index });
  const env = { GIT_INDEX_FILE: index };
  const add = await g(['add', '-A', '--', '.'], env);
  if (!add.ok) throw new T.TransferError('gitFailed', add.stderr);
  for (let i = 0; i < skipped.length; i += 100) await g(['rm', '--cached', '-q', '--ignore-unmatch', '--', ...skipped.slice(i, i + 100)], env);
  const tree = (await g(['write-tree'], env)).text;
  const headTree = (await g(['rev-parse', 'HEAD^{tree}'])).text;
  let handoff = null;
  let patch = null;
  let changed = 0;
  if (tree && tree !== headTree) {
    const c = await g(['commit-tree', '--no-gpg-sign', '-p', head.text, '-m', `Agent Office handoff of session ${sessionId}`, tree], HANDOFF_ENV);
    if (!c.ok) throw new T.TransferError('gitFailed', c.stderr);
    handoff = c.text;
    patch = (await g(['diff', '--binary', head.text, handoff])).stdout;
    changed = (await g(['diff', '--name-only', head.text, handoff])).text.split('\n').filter(Boolean).length;
  }
  const unpushed = Number((await g(['rev-list', '--count', 'HEAD', '--not', '--remotes'])).text) || 0;
  let bundle = null;
  let bundleRef = null;
  if (handoff || unpushed > 0) {
    bundleRef = `${T.BUNDLE_REF_PREFIX}${sessionId}`;
    const file = path.join(tmp, 'handoff.bundle');
    await g(['update-ref', bundleRef, handoff || head.text]);
    try {
      const b = await g(['bundle', 'create', file, bundleRef, '--not', '--remotes']);
      if (!b.ok) throw new T.TransferError('gitFailed', b.stderr);
      bundle = fs.readFileSync(file);
    } finally {
      await g(['update-ref', '-d', bundleRef]);
    }
  }
  return {
    top,
    git: { remote, remotes, branch, head: head.text, upstream, subdir, unpushed, handoff, bundleRef, changed, hasRemote: remotes.length > 0 },
    bundle, patch, skipped,
  };
}

/**
 * Everything an export needs → { manifest, entries, notes }. Throws TransferError('noTranscript') if the session's
 * transcript is not found. o: { dir, sessionId, configDir, home, appVersion, claudeVersion, accountLabel,
 * platform?, hostname?, now? }
 */
async function collectExport(o) {
  const { dir, sessionId: id, configDir, home } = o;
  const t = findTranscript(dir, id, configDir, home);
  if (!t) throw new T.TransferError('noTranscript', id);
  const entries = [{ name: `transcript/${id}.jsonl`, data: fs.readFileSync(t.file) }];
  for (const f of walkFiles(path.join(t.historyDir, id))) {
    if (!T.isClaudeSecret(f.rel) && T.safeEntryName(`transcript/${id}/${f.rel}`)) entries.push({ name: `transcript/${id}/${f.rel}`, data: fs.readFileSync(f.abs) });
  }
  const memoryDir = memoryDirOf(dir, home);
  let memory = 0;
  if (memoryDir) {
    for (const f of walkFiles(memoryDir, 1)) {
      if (!f.rel.endsWith('.md') || !T.safeEntryName(`memory/${f.rel}`)) continue;
      entries.push({ name: `memory/${f.rel}`, data: fs.readFileSync(f.abs) });
      memory++;
    }
  }
  const office = officeSessionFile(home, id);
  const hasOffice = isFile(office);
  if (hasOffice) entries.push({ name: `office/${id}.json`, data: fs.readFileSync(office) });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-export-'));
  let code;
  try { code = await gitExport(dir, id, tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (code?.bundle) entries.push({ name: 'git/handoff.bundle', data: code.bundle });
  if (code?.patch) entries.push({ name: 'git/changes.patch', data: code.patch });

  const now = o.now ?? Date.now();
  const manifest = {
    format: T.FORMAT, version: T.VERSION,
    createdAt: new Date(now).toISOString(),
    app: { version: o.appVersion || null },
    claude: { version: o.claudeVersion || null },
    source: {
      platform: o.platform || process.platform, hostname: o.hostname ?? os.hostname(),
      projectDir: dir, realDir: realOr(dir), projectName: path.basename(dir),
      gitTop: code?.top || null, historyDir: t.historyDir, memoryDir,
    },
    account: { label: o.accountLabel || null },
    session: { id },
    git: code?.git || null,
    contents: { sidecarFiles: entries.filter((e) => e.name.startsWith(`transcript/${id}/`)).length, memoryFiles: memory, office: hasOffice },
  };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  return {
    manifest, entries,
    notes: { noGit: !code, noCommits: Boolean(code?.noCommits), skipped: code?.skipped || [], memorySkipped: !memoryDir },
  };
}

const writeArchive = (file, entries) => fs.writeFileSync(file, T.packArchive(entries, Math.floor(Date.now() / 1000)));
/** A .agentoffice file → readArchive(...) parts (TransferError on anything odd). */
function loadArchive(file) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > 2 * 1024 * 1024 * 1024) throw new T.TransferError('tooLarge');
  return T.readArchive(T.unpackArchive(fs.readFileSync(file)));
}

/**
 * What the chosen folder is (import step 2). → { isRepo, top, remotes, remoteMatches, head, isClean, branches,
 * plan } (plan: transfer.js planCheckout; null without git in the file or the folder).
 */
async function inspectTarget(parsed, targetDir) {
  const gm = parsed.manifest.git;
  const top0 = await runGit(['rev-parse', '--show-toplevel'], { cwd: targetDir });
  if (!top0.ok || !top0.text) return { isRepo: false, top: null, remotes: [], remoteMatches: false, head: null, isClean: true, branches: [], plan: null };
  const top = top0.text;
  const g = (args) => runGit(args, { cwd: top });
  const remotes = [];
  for (const name of (await g(['remote'])).text.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const u = await g(['remote', 'get-url', name]);
    if (u.ok && u.text) remotes.push({ name, url: u.text });
  }
  const head = (await g(['rev-parse', '--verify', '-q', 'HEAD'])).text || null;
  const isClean = (await g(['status', '--porcelain', '--untracked-files=no'])).text === '';
  const branches = (await g(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).text.split('\n').filter(Boolean);
  const remoteMatches = gm ? T.remotesMatch((gm.remotes || []).map((r) => r.url).concat(gm.remote || []), remotes.map((r) => r.url)) : false;
  const plan = gm ? T.planCheckout({ head, base: gm.head, isClean, branches, sourceBranch: gm.branch, sessionId: parsed.manifest.session.id }) : null;
  return { isRepo: true, top, remotes, remoteMatches, head, isClean, branches, plan };
}

/** Clones the file's remote into an empty folder (no password prompt: a private repository needs a credential helper). */
async function cloneInto(url, dir) {
  fs.mkdirSync(dir, { recursive: true });
  return runGit(['clone', '--', url, dir], { cwd: dir, timeout: 900000 });
}

/**
 * Makes the recorded commits present in the target: the bundle (unpushed commits and the uncommitted work), else
 * the remotes (fetched when a commit is missing: fetch only, never push). → { ok, error? }
 */
async function prepareGit(parsed, top) {
  const gm = parsed.manifest.git;
  const g = (args) => runGit(args, { cwd: top, timeout: 900000 });
  const has = async (sha) => sha && (await g(['cat-file', '-e', `${sha}^{commit}`])).ok;
  const fetchRemotes = async () => {
    for (const name of (await g(['remote'])).text.split('\n').map((s) => s.trim()).filter(Boolean)) await g(['fetch', '-q', name]);
  };
  const want = gm.handoff || gm.head;
  if (await has(want) && await has(gm.head)) return { ok: true };
  if (parsed.bundle && gm.bundleRef) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-import-'));
    try {
      const file = path.join(tmp, 'handoff.bundle');
      fs.writeFileSync(file, parsed.bundle);
      let v = await g(['bundle', 'verify', '-q', file]);
      if (!v.ok) { await fetchRemotes(); v = await g(['bundle', 'verify', '-q', file]); }
      if (!v.ok) return { ok: false, error: v.stderr };
      const f = await g(['fetch', '-q', '--no-tags', file, gm.bundleRef]);
      if (!f.ok) return { ok: false, error: f.stderr };
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  } else {
    await fetchRemotes();
  }
  if (await has(want) && await has(gm.head)) return { ok: true };
  return { ok: false, error: `commit ${want.slice(0, 12)} not found` };
}

/**
 * Brings the working tree to the session's code (after prepareGit): on plan 'branch' a new branch at the recorded
 * commit first; then the uncommitted work is laid on top as uncommitted changes (`read-tree -m -u` refuses to touch
 * changed or untracked files in the way; then the index is reset to HEAD). → { ok, error?, branch? }
 */
async function applyGit(parsed, top, plan) {
  const gm = parsed.manifest.git;
  const g = (args) => runGit(args, { cwd: top });
  if (!plan || plan.action === 'dirty') return { ok: false, error: 'dirty' };
  if (plan.action === 'branch') {
    const c = await g(['checkout', '-q', '-b', plan.branch, gm.head]);
    if (!c.ok) return { ok: false, error: c.stderr };
    // the source's upstream, if this repository knows that remote branch (tracking only: nothing is pushed)
    if (gm.upstream && plan.branch === gm.branch && (await g(['rev-parse', '--verify', '-q', `refs/remotes/${gm.upstream}`])).ok) {
      await g(['branch', '-q', `--set-upstream-to=${gm.upstream}`, plan.branch]);
    }
  }
  if (gm.handoff) {
    const r = await g(['read-tree', '-m', '-u', 'HEAD', gm.handoff]);
    if (!r.ok) return { ok: false, error: r.stderr };
    const reset = await g(['reset', '-q']);
    if (!reset.ok) return { ok: false, error: reset.stderr };
  }
  return { ok: true, branch: plan.action === 'branch' ? plan.branch : null };
}

/** Writes a file that must not exist yet (never overwrites); creates its folder. */
function writeNew(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { flag: 'wx' });
}

/**
 * Puts the session where Claude Code looks for it in the target account, with the paths moved to the new folder.
 * o: { targetDir, configDir, home, gitTop?, newId? }. The session id stays unless newId is given (an id that already
 * exists on this machine is refused: TransferError('sessionExists')). Nothing existing is overwritten; memory is
 * merged with memory.js mergeMemory (existing files win). → { sessionId, transcript, historyDir, memoryCopied,
 * memorySkipped }
 */
function placeSession(parsed, o) {
  const { manifest } = parsed;
  const from = manifest.session.id;
  const id = o.newId || from;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(id)) throw new T.TransferError('badManifest', 'session id');
  if (findSessionFiles(id, o.configDir, o.home).length) throw new T.TransferError('sessionExists', id);
  const real = realOr(o.targetDir).normalize('NFC');
  if (!M.memorySlug(real)) throw new T.TransferError('longPath', real);
  const historyDir = historyDirOf(o.targetDir, o.configDir, o.home);
  const memoryDir = memoryDirOf(o.targetDir, o.home);
  const rw = T.makeRewriter(T.moveMaps(manifest.source, { projectDir: real, historyDir, memoryDir, gitTop: o.gitTop ? realOr(o.gitTop) : null }, { from, to: id }), T.pathStyle(process.platform));
  const ids = { from, to: id };
  const transcript = path.join(historyDir, `${id}.jsonl`);
  writeNew(transcript, T.rewriteJsonl(parsed.transcript.toString('utf8'), rw, ids));
  const base = path.join(historyDir, id);
  for (const { rel, data } of parsed.sidecar) {
    const dest = path.join(base, ...rel.split('/'));
    const r = path.relative(base, dest);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) continue;
    const text = /\.(jsonl|json)$/.test(rel) ? T.rewriteJsonl(data.toString('utf8'), rw, ids) : /\.(txt|md|log)$/.test(rel) ? rw.text(data.toString('utf8')) : data;
    writeNew(dest, text);
  }
  let memoryCopied = [];
  if (memoryDir && parsed.memory.length) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-memory-'));
    try {
      for (const m of parsed.memory) if (!m.name.includes('/') && !m.name.includes('\\')) fs.writeFileSync(path.join(tmp, m.name), m.data);
      memoryCopied = M.mergeMemory(tmp, memoryDir);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  if (parsed.office) {
    try {
      const obj = JSON.parse(parsed.office.toString('utf8'));
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        obj.project = path.basename(o.targetDir);
        const f = officeSessionFile(o.home, id);
        if (!fs.existsSync(f)) writeNew(f, JSON.stringify(obj));
      }
    } catch {}
  }
  return { sessionId: id, transcript, historyDir, memoryCopied, memorySkipped: !memoryDir && parsed.memory.length > 0 };
}

module.exports = {
  historyDirsOf,
  runGit, walkFiles, findSessionFiles, findTranscript, newestSession, memoryDirOf, historyDirOf, officeSessionFile,
  gitExport, collectExport, writeArchive, loadArchive, inspectTarget, cloneInto, prepareGit, applyGit, placeSession,
};
