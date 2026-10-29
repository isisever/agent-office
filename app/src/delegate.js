// Account delegate core (contract v3.56): pure helpers (no Electron, no network). The boss (engine claude) hands a
// scoped job to an agent under ANOTHER account via the `ao-delegate` CLI. This module builds the project state value,
// the key-less manifest, the child launch ({cmd,args,env,cwd}) and the throwaway-worktree git args. Decrypting a
// FixCloud key happens in main.js only; delegateLaunch merely reads the 0600 key file it is handed.
const fs = require('fs');
const path = require('path');
const { ocEnv } = require('./engine');
const { FIXCLOUD, FIXCLOUD_KEY_ENV } = require('./fixcloud');

const DELEGATE_ENV = 'AGENT_OFFICE_DELEGATES';
const AO_DELEGATE_CMD = 'ao-delegate';
const MAX_DELEGATES = 16;
const DELEGATE_AGENT = 'ao-delegate';
const BRANCH_PREFIX = 'ao-delegate/';

/** Known ids only, deduped, capped. @param {unknown} v @param {Set<string>} knownIds @returns {string[]} */
function delegatesValue(v, knownIds) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (typeof x === 'string' && knownIds && knownIds.has(x) && !out.includes(x)) out.push(x);
    if (out.length >= MAX_DELEGATES) break;
  }
  return out;
}
/** {delegates:[...]} or {} (never store an empty list). */
const withDelegates = (v, knownIds) => {
  const d = delegatesValue(v, knownIds);
  return d.length ? { delegates: d } : {};
};

/** Engine an account runs on: FixCloud/opencode -> 'opencode', everything else 'claude'. */
const engineOf = (account) => (account && (account.provider === FIXCLOUD || account.provider === 'opencode' || account.engine === 'opencode') ? 'opencode' : 'claude');

/**
 * The manifest the boss session sees (AGENT_OFFICE_DELEGATES): NO keys, only labels/engine/model/configDir.
 * @param {Array<{id:string,label?:string,provider?:string,engine?:string,model?:string,configDir?:string}>} accounts
 * @param {{delegates?: string[]}} project
 */
function manifest(accounts, project) {
  const ids = Array.isArray(project?.delegates) ? project.delegates : [];
  const byId = new Map((accounts || []).map((a) => [a.id, a]));
  const out = [];
  for (const id of ids) {
    const a = byId.get(id);
    if (!a) continue;
    out.push({ id: a.id, label: a.label || a.id, engine: engineOf(a), model: a.model || '', configDir: a.configDir || '' });
  }
  return out;
}

/** env without AGENT_OFFICE_*, CLAUDE_*, ANTHROPIC_* (the boss's own login must not leak into the delegate). */
function cleanBase(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== 'string' || /^(AGENT_OFFICE|CLAUDE|ANTHROPIC)/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The child process for one delegated job.
 * @param {{account:{engine?:string,provider?:string,model?:string,configDir?:string}, task:string, worktree:string, keyFile?:string, ocConfigHome?:string, env?:Record<string,string|undefined>, platform?:string}} o
 * @returns {{cmd:string,args:string[],env:Record<string,string>,cwd:string}}
 */
function delegateLaunch({ account, task, worktree, keyFile, ocConfigHome, env = process.env, platform = process.platform }) {
  if (engineOf(account) === 'opencode') {
    const key = keyFile ? fs.readFileSync(keyFile, 'utf8').trim() : '';
    const extra = { OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_CLAUDE_CODE_MCP: '1' };
    if (key) extra[FIXCLOUD_KEY_ENV] = key;
    const e = ocEnv(env, platform, extra);
    delete e.CLAUDE_CONFIG_DIR;
    // Isolated opencode config home (main.js writes the fixcloud provider + the restricted ao-delegate agent def there,
    // so --agent resolves and the deny-by-default permission guard applies; never the user's own ~/.config/opencode).
    if (ocConfigHome) e.XDG_CONFIG_HOME = ocConfigHome;
    return { cmd: 'opencode', args: ['run', task, '-m', `${FIXCLOUD}/${account.model}`, '--agent', DELEGATE_AGENT], env: e, cwd: worktree };
  }
  const e = cleanBase(env);
  if (account.configDir) e.CLAUDE_CONFIG_DIR = account.configDir;
  return {
    cmd: 'claude',
    args: ['-p', task, '--model', account.model || 'sonnet', '--permission-mode', 'acceptEdits', '--add-dir', worktree],
    env: e,
    cwd: worktree,
  };
}

/** Restricted opencode agent (frontmatter permission block is honored; bash is deny-by-default + allowlist). */
const OC_DELEGATE_AGENT = `---
description: Restricted delegate agent (Agent Office ao-delegate)
mode: primary
permission:
  edit: allow
  webfetch: deny
  bash:
    "*": deny
    "git status*": allow
    "git diff*": allow
    "git log*": allow
    "git add*": allow
    "git push*": deny
    "rm -rf*": deny
    "npm test*": allow
    "cargo build*": allow
---
Work only in the current git worktree. Do not touch files outside it, do not push, and do not take outward-facing
or destructive actions. Finish the task, then summarise what you changed.
`;

/** `git worktree add` args for a throwaway worktree OUTSIDE repoTop, on a throwaway branch (so the boss can cherry-pick). */
function worktreeAddArgs(repoTop, tmpBase, stamp) {
  const wt = path.join(tmpBase, 'agent-office-delegate', String(stamp));
  const rel = path.relative(path.resolve(repoTop), wt);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('delegate worktree must be outside the repository');
  const branch = BRANCH_PREFIX + stamp;
  return { path: wt, branch, args: ['-C', repoTop, 'worktree', 'add', '-b', branch, wt, 'HEAD'] };
}
const worktreeRemoveArgs = (wtPath) => ['worktree', 'remove', '--force', wtPath];

module.exports = {
  DELEGATE_ENV, AO_DELEGATE_CMD, MAX_DELEGATES, DELEGATE_AGENT, OC_DELEGATE_AGENT,
  delegatesValue, withDelegates, manifest, delegateLaunch, worktreeAddArgs, worktreeRemoveArgs,
};
