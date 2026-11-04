'use strict';
// Per-project persistent main model (contract: stop `/model` leaking across same-account projects). Pure fs/path, no
// Electron, so it runs under `node --test`. Claude Code's in-session `/model` ("saved as your default for new sessions")
// writes the account-scope <CLAUDE_CONFIG_DIR>/settings.json `model` key, which every project of that account shares. We
// MOVE that choice into the owning project's own <projectDir>/.claude/settings.json (which outranks the account file) and
// DELETE it from the account file, so sibling Auto projects stop inheriting it.
//
// LOOP INVARIANT: captureAccountModel/stripAccountModel only ever DELETE `model` from the account file, never write one
// there; after a strip the next read sees no `model` and both are no-ops. Nothing in this module writes a model into the
// account file.
const fs = require('fs');
const path = require('path');

/** A project's own Claude Code user-scope settings file. */
const projFile = (dir) => path.join(dir, '.claude', 'settings.json');

const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Merge-write ONE key via `mutate`, never clobbering other keys; atomic temp+rename, mode preserved (new file 0o600).
// `mutate` returns the next object, or null to signal "no change". Returns true only when the file was rewritten.
function mergeWrite(file, mutate) {
  const cur = read(file);
  const base = isObj(cur) ? cur : {};
  const next = mutate({ ...base });
  if (next === null) return false; // no-op signal
  if (JSON.stringify(next) === JSON.stringify(isObj(cur) ? cur : undefined)) return false;
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.agent-office-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode });
  fs.renameSync(tmp, file);
  return true;
}

/** Write the `/model` choice into the project file, preserving every other key. No-op when unchanged. */
function setProjectModel(dir, model) {
  return mergeWrite(projFile(dir), (o) => { if (o.model === model) return null; o.model = model; return o; });
}

/** Remove `model` from the account settings file, keeping everything else. Returns the removed value (string) or null. */
function stripAccountModel(accountSettingsFile) {
  const cur = read(accountSettingsFile);
  if (!isObj(cur) || !('model' in cur)) return null;
  const model = cur.model;
  mergeWrite(accountSettingsFile, (o) => { delete o.model; return o; });
  return typeof model === 'string' ? model : null;
}

/** Move the account `model` into the project settings.json, then delete it from the account file. Returns the moved value or null. */
function captureAccountModel(accountSettingsFile, projectDir) {
  const cur = read(accountSettingsFile);
  if (!isObj(cur) || typeof cur.model !== 'string' || !cur.model) return null;
  setProjectModel(projectDir, cur.model);
  stripAccountModel(accountSettingsFile);
  return cur.model;
}

module.exports = { projFile, setProjectModel, stripAccountModel, captureAccountModel };
