'use strict';
// The model a project's boss really runs on when its boss model is Auto (contract v3.53). Auto passes no --model, so
// claude takes, in its own order: managed settings (env.ANTHROPIC_MODEL, then model), ANTHROPIC_MODEL of the env the pty
// gets (the login shell's, rc files included), env.ANTHROPIC_MODEL of the settings files (local, project, account), then
// the `model` key of the local settings, the project's and the account's settings.json (written by `/model`: "saved as
// your default for new sessions"). Without any of them it is Claude Code's own default (null here).
// Read on demand (the project's settings popup opens), async, so a `/model` change shows the next time; errors → null.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { settingsPaths } = require('./usage.js');

const SOURCES = ['project', 'project', 'account']; // settingsPaths order: local, project, account

/** Claude Code's managed settings file per platform (highest priority, set by an administrator). */
/** @param {string} [platform] */
function managedSettingsPath(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') return 'C:\\ProgramData\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

/** A usable model name from a settings object or an env value; 'default' and blanks are no choice. */
function modelValue(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 200 || s.toLowerCase() === 'default') return null;
  return s;
}

/** 'haiku' | 'sonnet' | 'opus' for an alias or full name ('opusplan', 'claude-haiku-4-5', 'sonnet[1m]'), else null. */
function modelFamily(model) {
  const m = /(haiku|sonnet|opus)/i.exec(String(model || ''));
  return m ? m[1].toLowerCase() : null;
}

const isObj = (j) => !!j && typeof j === 'object';
const hit = (model, source) => ({ model, family: modelFamily(model), source });

/**
 * Pure: the effective model in claude's order. `managed` is the managed settings object; `env` the env the pty gets;
 * `settings` the files in priority order (local, project, account) as { source, json }.
 * Order: managed env.ANTHROPIC_MODEL, managed model, env ANTHROPIC_MODEL, settings env.ANTHROPIC_MODEL, settings model.
 * @param {{ env?: Record<string, string | undefined>, managed?: any, settings?: Array<{ source: string, json: any }> }} input
 * @returns {{ model: string, family: string | null, source: string } | null}
 */
function effectiveModel({ env = {}, managed, settings = [] } = {}) {
  if (isObj(managed)) {
    const m = modelValue(isObj(managed.env) ? managed.env.ANTHROPIC_MODEL : null) || modelValue(managed.model);
    if (m) return hit(m, 'managed');
  }
  const fromEnv = modelValue(env.ANTHROPIC_MODEL);
  if (fromEnv) return hit(fromEnv, 'env');
  for (const s of settings) {
    const m = isObj(s && s.json) && isObj(s.json.env) ? modelValue(s.json.env.ANTHROPIC_MODEL) : null;
    if (m) return hit(m, s.source);
  }
  for (const s of settings) {
    const m = isObj(s && s.json) ? modelValue(s.json.model) : null;
    if (m) return hit(m, s.source);
  }
  return null;
}

const readFile = (f) => fs.promises.readFile(f, 'utf8');

/**
 * Reads the files: projectDir may be null (account only); configDir null = the default account (~/.claude).
 * @param {{ projectDir?: string | null, configDir?: string | null, home: string, env?: Record<string, string | undefined>,
 *   platform?: string, read?: (file: string) => Promise<string> | string }} input
 */
async function readEffectiveModel({ projectDir = null, configDir = null, home, env = {}, platform = process.platform, read = readFile }) {
  try {
    const parse = async (file) => { try { return JSON.parse(await read(file)); } catch { return undefined; } };
    const paths = settingsPaths(projectDir || '', configDir, home);
    const [managed, ...jsons] = await Promise.all([parse(managedSettingsPath(platform)), ...paths.map(parse)]);
    const settings = [];
    paths.forEach((_f, i) => { if (i >= 2 || projectDir) settings.push({ source: SOURCES[i], json: jsons[i] }); });
    return effectiveModel({ env, managed, settings });
  } catch {
    return null;
  }
}

/**
 * The IPC body: null for a non-Claude engine or a project whose folder is not here (remote/P2P); else the model plus
 * the project's effective manager mode. `isLocalDir` is async (a stat); `env` the env the pty gets.
 */
/** @param {{ project: any, engine: string, manager: boolean, configDir?: string | null, home: string, env?: Record<string, string | undefined>,
 *   platform?: string, read?: (file: string) => Promise<string> | string, isLocalDir: (dir: string) => Promise<boolean> }} input */
async function effectiveModelForProject({ project, engine, manager, configDir = null, home, env = {}, platform, read, isLocalDir }) {
  try {
    if (!project || engine !== 'claude') return null;
    const dir = typeof project.dir === 'string' ? project.dir : '';
    if (!dir || !path.isAbsolute(dir) || !(await isLocalDir(dir))) return null;
    const eff = await readEffectiveModel({ projectDir: dir, configDir, home, env, platform, read });
    return eff ? { ...eff, manager: manager === true } : null;
  } catch {
    return null;
  }
}

const isDirAsync = async (d) => { try { return (await fs.promises.stat(d)).isDirectory(); } catch { return false; } };

// ANTHROPIC_MODEL as the pty gets it: claude starts in a login interactive shell, so ~/.zshrc exports reach it while a
// Finder-launched app lacks them. Asked of the same shell, once a minute (the rc files may be slow), never throws.
let shellCache = null;
const MARK = '__AO_MODEL__';
function loginShellModel({ shell = process.env.SHELL, platform = process.platform, base = process.env, run = execFile, now = Date.now } = {}) {
  if (platform === 'win32' || !shell) return Promise.resolve(modelValue(base.ANTHROPIC_MODEL) ? { ANTHROPIC_MODEL: base.ANTHROPIC_MODEL } : {});
  if (shellCache && now() - shellCache.at < 60000) return shellCache.p;
  const p = new Promise((resolve) => {
    const fallback = modelValue(base.ANTHROPIC_MODEL) ? { ANTHROPIC_MODEL: base.ANTHROPIC_MODEL } : {};
    // an interactive shell may ignore SIGTERM: SIGKILL on timeout, and a timer of our own so the promise always settles
    const guard = setTimeout(() => resolve(fallback), 6000);
    const done = (v) => { clearTimeout(guard); resolve(v); };
    try {
      // between markers: rc banners, a missing newline or a logout file's output never become the value
      run(shell, ['-l', '-i', '-c', `printf '\\n${MARK}%s${MARK}\\n' "$ANTHROPIC_MODEL"`], { timeout: 5000, killSignal: 'SIGKILL', env: { ...base, TERM: 'dumb' }, maxBuffer: 65536 }, (err, out) => {
        const m = err ? null : new RegExp(`${MARK}([^\\n]*?)${MARK}`).exec(String(out || ''));
        done(m ? { ANTHROPIC_MODEL: m[1].trim() } : fallback);
      });
    } catch { done(fallback); }
  });
  shellCache = { at: now(), p };
  return p;
}

module.exports = { modelValue, modelFamily, managedSettingsPath, effectiveModel, readEffectiveModel, effectiveModelForProject, isDirAsync, loginShellModel };
