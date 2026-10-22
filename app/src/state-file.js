// state.json on disk (contract v3.44). Pure helpers over fs (no Electron).
//
// read: { raw, ok, corrupt, unreadable } — ok only when the file existed and parsed into an object. A file that does
// not parse is copied once to `<file>.corrupt` (never overwritten, so the first bad copy stays) and read as {}; while
// that copy is there nothing that trusts the state to be complete runs (the start's token sweep), since the next save
// replaces the bad file. A file that is there but cannot be read (any error but ENOENT: EACCES, EBUSY, EIO) is
// `unreadable`: read as {}, and for that run nothing may be saved over it and the sweep stays off (`trusted` false).
// cleanTemps: removes writeAtomic temp files a crash left (`<file>.<pid>.tmp` only, never this process's own).
// write: a temp file in the same folder, flushed to disk, then renamed over the old one, so a crash or a full disk
// half-way never leaves a truncated state.json.
const fs = require('fs');
const path = require('path');
/** @typedef {typeof import('fs')} Fs */

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const corruptPath = (/** @type {string} */ file) => `${file}.corrupt`;

/**
 * @param {string} file
 * @param {Fs} [fsx]
 * @returns {{ raw: any, ok: boolean, corrupt: boolean, unreadable: boolean }}
 */
function readState(file, fsx = fs) {
  let text;
  try { text = fsx.readFileSync(file, 'utf8'); } catch (e) {
    const missing = /** @type {any} */ (e)?.code === 'ENOENT';
    return { raw: {}, ok: false, corrupt: false, unreadable: !missing };
  }
  try {
    const raw = JSON.parse(text);
    if (isObj(raw)) return { raw, ok: true, corrupt: false, unreadable: false };
  } catch {}
  try { if (!fsx.existsSync(corruptPath(file))) fsx.copyFileSync(file, corruptPath(file)); } catch {}
  return { raw: {}, ok: false, corrupt: true, unreadable: false };
}

/**
 * True when state.json was read whole and no unrecovered bad copy of it is waiting.
 * @param {{ ok: boolean }} r
 * @param {string} file
 * @param {Fs} [fsx]
 */
const trusted = (r, file, fsx = fs) => r.ok && !fsx.existsSync(corruptPath(file));

/**
 * @param {string} file
 * @param {string} text
 * @returns {void}
 * @param {Fs} [fsx]
 */
function writeAtomic(file, text, fsx = fs) {
  fsx.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = fsx.openSync(tmp, 'w', 0o600);
    try { fsx.writeFileSync(fd, text); try { fsx.fsyncSync(fd); } catch {} } finally { fsx.closeSync(fd); }
    fsx.renameSync(tmp, file);
  } catch (e) { try { fsx.rmSync(tmp, { force: true }); } catch {} throw e; }
}

/**
 * @param {string} file
 * @param {Fs} [fsx]
 * @returns {number} how many were removed
 */
function cleanTemps(file, fsx = fs) {
  const dir = path.dirname(file), base = path.basename(file);
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}\\.(\\d+)\\.tmp$`);
  let n = 0, names = [];
  try { names = fsx.readdirSync(dir); } catch { return 0; }
  for (const f of names) {
    const m = re.exec(f);
    if (!m || Number(m[1]) === process.pid) continue;
    try { fsx.rmSync(path.join(dir, f), { force: true }); n++; } catch {}
  }
  return n;
}

module.exports = { readState, trusted, writeAtomic, cleanTemps, corruptPath };
