'use strict';
// The model a project's boss really runs on when its boss model is Auto (contract v3.53). Auto passes no --model, so
// claude takes, in its own order: ANTHROPIC_MODEL in its environment, then the `model` key of the project's
// .claude/settings.local.json, the project's .claude/settings.json, the account's settings.json (written by `/model`:
// "saved as your default for new sessions"). Without any of them it is Claude Code's own default (null here).
// Read on demand (the project's settings popup opens), so a `/model` change shows the next time; read errors → null.
const fs = require('fs');
const { settingsPaths } = require('./usage.js');

const SOURCES = ['project', 'project', 'account']; // settingsPaths order: local, project, account

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

/**
 * Pure: the effective model from the env and the settings objects in claude's order.
 * @param {{ env?: Record<string, string | undefined>, settings?: Array<{ source: string, json: any }> }} input
 * @returns {{ model: string, family: string | null, source: string } | null}
 */
function effectiveModel({ env = {}, settings = [] } = {}) {
  const fromEnv = modelValue(env.ANTHROPIC_MODEL);
  if (fromEnv) return { model: fromEnv, family: modelFamily(fromEnv), source: 'env' };
  for (const s of settings) {
    const m = s && s.json && typeof s.json === 'object' ? modelValue(s.json.model) : null;
    if (m) return { model: m, family: modelFamily(m), source: s.source };
  }
  return null;
}

/**
 * Reads the files: projectDir may be null (account only); configDir null = the default account (~/.claude).
 * @param {{ projectDir?: string | null, configDir?: string | null, home: string, env?: Record<string, string | undefined>,
 *   read?: (file: string) => string }} input
 */
function readEffectiveModel({ projectDir = null, configDir = null, home, env = {}, read = (f) => fs.readFileSync(f, 'utf8') }) {
  try {
    const paths = settingsPaths(projectDir || '', configDir, home);
    const settings = [];
    paths.forEach((file, i) => {
      if (i < 2 && !projectDir) return;
      let json;
      try { json = JSON.parse(read(file)); } catch { json = undefined; }
      settings.push({ source: SOURCES[i], json });
    });
    return effectiveModel({ env, settings });
  } catch {
    return null;
  }
}

module.exports = { modelValue, modelFamily, effectiveModel, readEffectiveModel };
