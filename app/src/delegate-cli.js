// ao-delegate CLI (contract v3.56): the project's claude boss runs `ao-delegate <label|id> [-m model] -- <task...>`
// from Bash. It reads the per-session manifest (env AGENT_OFFICE_DELEGATE_MANIFEST → a JSON file main.js wrote:
// { delegates:[{id,label,engine,model,configDir}], repoTop, keyDir }), resolves the requested account, makes a
// throwaway git worktree on a throwaway branch (delegate.js worktreeAddArgs), runs the chosen account's agent in it
// (delegate.js delegateLaunch — the ONLY place the 0600 key file is read), then — because the delegate agent itself
// has NO git permissions — commits the result on the boss's behalf and prints the branch, the worktree path and
// `git diff --stat <base>..HEAD` so the boss can cherry-pick. The key is never printed or logged.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const D = require('./delegate.js');

const MANIFEST_ENV = 'AGENT_OFFICE_DELEGATE_MANIFEST';

/** argv (without node + script) → { accountRef, model, task }. Throws a clear Error on a malformed call. */
function parseArgs(argv) {
  const a = Array.isArray(argv) ? argv.slice() : [];
  const sep = a.indexOf('--');
  const head = sep >= 0 ? a.slice(0, sep) : a;
  const task = (sep >= 0 ? a.slice(sep + 1) : []).join(' ').trim();
  let accountRef = null;
  let model = null;
  for (let i = 0; i < head.length; i++) {
    const x = head[i];
    if (x === '-m' || x === '--model') { model = head[++i] || null; continue; }
    if (x.startsWith('-')) throw new Error(`unknown option: ${x}`);
    if (accountRef === null) accountRef = x;
    else throw new Error(`unexpected argument: ${x} (use \`-- <task>\` for the task)`);
  }
  if (!accountRef) throw new Error('usage: ao-delegate <account> [-m model] -- <task>');
  if (!task) throw new Error('no task given — everything after `--` is the task');
  return { accountRef, model, task };
}

/** Read + parse the per-session manifest file. Throws if it is missing, unreadable, or malformed. */
function readManifest(env, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  const file = env && env[MANIFEST_ENV];
  if (!file) throw new Error(`delegation is off for this session (${MANIFEST_ENV} not set)`);
  let raw;
  try { raw = readFile(file); } catch { throw new Error('the delegate manifest could not be read'); }
  let obj;
  try { obj = JSON.parse(raw); } catch { throw new Error('the delegate manifest is not valid JSON'); }
  if (!obj || typeof obj.repoTop !== 'string' || !obj.repoTop) throw new Error('the delegate manifest has no repoTop');
  return {
    delegates: Array.isArray(obj.delegates) ? obj.delegates : [],
    repoTop: obj.repoTop,
    keyDir: typeof obj.keyDir === 'string' ? obj.keyDir : '',
    ocConfigHome: typeof obj.ocConfigHome === 'string' ? obj.ocConfigHome : '',
  };
}

/** Find the requested delegate account by id or (case-insensitive) label; throws a clear Error otherwise. */
function resolveAccount(delegates, ref) {
  const list = Array.isArray(delegates) ? delegates : [];
  const byId = list.find((d) => d && d.id === ref);
  if (byId) return byId;
  const low = String(ref).toLowerCase();
  const byLabel = list.filter((d) => d && String(d.label || '').toLowerCase() === low);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) throw new Error(`"${ref}" matches more than one delegate — use the account id`);
  const avail = list.map((d) => d.label || d.id).join(', ') || '(none)';
  throw new Error(`"${ref}" is not a delegatable account for this project. Available: ${avail}`);
}

/** Default git runner (git -C handles the cwd). Returns { status, stdout, stderr }. */
const defaultGit = (args) => {
  const r = cp.spawnSync('git', args, { encoding: 'utf8' });
  if (r.error) return { status: typeof r.status === 'number' ? r.status : 1, stdout: '', stderr: r.error.message };
  return { status: typeof r.status === 'number' ? r.status : 1, stdout: r.stdout || '', stderr: r.stderr || '' };
};
/** Default delegate child: inherits stdio so the boss sees the agent's output live. Returns its exit code. */
const defaultSpawn = ({ cmd, args, env, cwd }) => {
  const r = cp.spawnSync(cmd, args, { stdio: 'inherit', env, cwd });
  if (r.error) throw new Error(`could not start the delegate (${cmd}): ${r.error.message}`);
  return typeof r.status === 'number' ? r.status : 1;
};

/**
 * Run one delegation. Side effects (git, the delegate child) are injectable for tests; nothing here prints the key.
 * @param {{ argv?:string[], env?:Record<string,string|undefined>, out?:{write:(s:string)=>void}, deps?:any }} [o]
 */
function run({ argv, env = process.env, out = process.stdout, deps = {} } = {}) {
  const git = deps.git || defaultGit;
  const spawnChild = deps.spawn || defaultSpawn;
  const now = deps.now || (() => Date.now());

  const { accountRef, model, task } = parseArgs(argv);
  const man = readManifest(env, deps.readFile);
  const account = { ...resolveAccount(man.delegates, accountRef) };
  if (model) account.model = model; // `-m` overrides the manifest model for this run only

  // the project dir must be (inside) a git repo; resolve its top so the worktree is added against the real repo
  const top = git(['-C', man.repoTop, 'rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new Error(`not a git repository: ${man.repoTop}`);
  const repoTop = String(top.stdout).trim();
  const base = git(['-C', repoTop, 'rev-parse', 'HEAD']);
  if (base.status !== 0) throw new Error('could not read HEAD — is this an empty repository?');
  const baseSha = String(base.stdout).trim();

  // a random suffix so two delegations in the same millisecond cannot collide on the branch/worktree
  const stamp = `${now()}-${(deps.rand || (() => crypto.randomBytes(3).toString('hex')))()}`;
  const wt = D.worktreeAddArgs(repoTop, os.tmpdir(), stamp); // throwaway path OUTSIDE the repo, throwaway branch
  const add = git(wt.args);
  if (add.status !== 0) throw new Error(`git worktree add failed: ${String(add.stderr || '').trim()}`);

  // opencode delegates read their key from the manifest's keyFile (same sanitised name main.js wrote); claude use configDir
  const keyFile = account.engine === 'opencode'
    ? (account.keyFile || (man.keyDir && account.id ? path.join(man.keyDir, String(account.id).replace(/[^\w-]/g, '_')) : undefined))
    : undefined;
  const launch = D.delegateLaunch({ account, task, worktree: wt.path, keyFile, ocConfigHome: man.ocConfigHome, env, platform: process.platform });
  let code;
  let committed = false;
  let commitErr = '';
  try {
    code = spawnChild(launch);
  } finally {
    // the CLI owns git (the delegate agent has no git perms): stage + commit whatever it changed, on the boss's behalf
    git(['-C', wt.path, 'add', '-A']);
    const staged = git(['-C', wt.path, 'diff', '--cached', '--quiet']); // exit 1 = there ARE staged changes
    if (staged.status === 1) {
      const firstLine = task.split('\n')[0].slice(0, 72);
      const c = git(['-C', wt.path, '-c', 'user.email=agent-office@localhost', '-c', 'user.name=Agent Office', 'commit', '--no-verify', '-m', `ao-delegate: ${firstLine}`]);
      if (c.status === 0) committed = true; else commitErr = String(c.stderr || '').trim();
    }
  }

  out.write(`delegate exit: ${code}\n`);
  out.write(`branch: ${wt.branch}\n`);
  out.write(`worktree: ${wt.path}\n`);
  if (committed) {
    const stat = git(['-C', wt.path, 'diff', '--stat', `${baseSha}..HEAD`]);
    out.write(`diff --stat (${baseSha.slice(0, 12)}..HEAD):\n${String(stat.stdout || '').trim()}\n`);
    out.write(`to merge: git cherry-pick ${wt.branch}   (worktree left for review; cleaned by the next app startup / \`git worktree prune\`)\n`);
  } else if (commitErr) {
    out.write(`WARNING: the delegate changed files but the commit failed: ${commitErr}\nthe changes are staged in the worktree: ${wt.path}\n`);
  } else {
    out.write(`the delegate made no file changes (nothing to merge). worktree: ${wt.path}\n`);
  }
  return code;
}

if (require.main === module) {
  try {
    process.exitCode = run({ argv: process.argv.slice(2) });
  } catch (e) {
    process.stderr.write(`ao-delegate: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 2;
  }
}

module.exports = { parseArgs, readManifest, resolveAccount, run, MANIFEST_ENV };
