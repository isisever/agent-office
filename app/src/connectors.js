// Connectors (contract v3.43): a remote MCP server (address + token) the user works with in its own Claude Code session.
// A connector is a project (src/projects.js) with an `mcp: { label, url }` field, so it gets the boss, tabs, accounts,
// sleep, resume and the office like any project. Pure helpers (no Electron); main.js keeps the token (safeStorage).
const fs = require('fs');
const path = require('path');

// Turkish letters NFKD does not decompose (ı, İ) or that should read as their base letter: 'Kişisel' → 'kisisel'.
const TR = { ı: 'i', İ: 'I', ş: 's', Ş: 'S', ğ: 'g', Ğ: 'G', ü: 'u', Ü: 'U', ö: 'o', Ö: 'O', ç: 'c', Ç: 'C' };
/** A folder-safe name: 'My Notion!' → 'my-notion', 'Kişisel Notlar' → 'kisisel-notlar'. */
const slug = (s) => String(s || '').replace(/[ıİşŞğĞüÜöÖçÇ]/g, (c) => TR[/** @type {keyof typeof TR} */ (c)]).normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase() || 'connector';

/** The address when it is a usable http(s) URL, else ''. */
function cleanUrl(v) {
  try {
    const u = new URL(String(v || '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch { return ''; }
}

/**
 * state.json field: { label, url } or nothing (→ {}).
 * @returns {{ mcp?: { label: string, url: string } }}
 */
function withMcp(v) {
  const url = cleanUrl(v?.url);
  const label = typeof v?.label === 'string' ? v.label.trim().slice(0, 60) : '';
  return url && label ? { mcp: { label, url } } : {};
}

/** Error code for a form ('name' | 'url') or null when it can be saved. */
function validate({ label, url }) {
  if (!String(label || '').trim()) return 'name';
  if (!cleanUrl(url)) return 'url';
  return null;
}

/** The token as typed: trimmed, a pasted leading 'Bearer ' dropped (the header adds it; no 'Bearer Bearer x'). */
const cleanToken = (v) => (typeof v === 'string' ? v.trim().replace(/^bearer\s+/i, '').trim() : '');

/** The server's name inside the session (`/mcp` lists it by this). */
const serverName = (label) => `conn-${slug(label)}`;

/** The claude MCP entry: remote HTTP server, the token as a bearer header. Lives only in the tab's 0600 MCP file. */
function serverConfig(url, token) {
  return { type: 'http', url: cleanUrl(url), ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) };
}

/** `{ name: config }` for a project's session, or null (not a connector, or no usable address). */
function serverFor(project, token) {
  const m = withMcp(project?.mcp).mcp;
  return m ? { [serverName(m.label)]: serverConfig(m.url, token) } : null;
}

/**
 * The default folder for a connector: <root>/<slug>, or <slug>-2, -3… when another project already uses it. An existing
 * folder nobody uses is taken again (a connector added again finds its old session history).
 * @param {string} root @param {string} label @param {(dir: string) => boolean} taken another project has this folder
 */
function defaultDir(root, label, taken) {
  const base = slug(label);
  for (let i = 1; i < 100; i++) {
    const dir = path.join(root, i === 1 ? base : `${base}-${i}`);
    if (!taken(dir)) return dir;
  }
  return path.join(root, `${base}-${Date.now()}`);
}

/**
 * The token store (contract v3.43): one file per project id under `dir`, encrypted with `safe` (Electron safeStorage);
 * a 0600 plain file only where no keyring exists. `save` returns false when the token could not be written: the old
 * token (if any) is then kept, and the caller does not change the connection.
 * @param {string} dir
 * @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} safe
 * @param {typeof fs} [fsx]
 */
function tokenStore(dir, safe, fsx = fs) {
  const file = (/** @type {string} */ id, /** @type {string} */ ext) => path.join(dir, `${String(id).replace(/[^\w-]/g, '_')}.${ext}`);
  const remove = (/** @type {string} */ id, exts = ['bin', 'txt']) => { for (const ext of exts) try { fsx.rmSync(file(id, ext), { force: true }); } catch {} };
  return {
    /** @param {string} id @param {string} token */
    save(id, token) {
      if (!token) { remove(id); return true; }
      try {
        fsx.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const enc = safe.isEncryptionAvailable();
        fsx.writeFileSync(file(id, enc ? 'bin' : 'txt'), enc ? safe.encryptString(token) : token, { mode: 0o600 });
        remove(id, [enc ? 'txt' : 'bin']);
        return true;
      } catch { return false; }
    },
    /** @param {string} id */
    load(id) {
      try { return safe.decryptString(fsx.readFileSync(file(id, 'bin'))); } catch {}
      try { return fsx.readFileSync(file(id, 'txt'), 'utf8'); } catch {}
      return '';
    },
    /** @param {string} id */
    has: (id) => fsx.existsSync(file(id, 'bin')) || fsx.existsSync(file(id, 'txt')),
    remove,
  };
}

module.exports = { tokenStore, slug, cleanUrl, withMcp, validate, serverName, serverConfig, serverFor, defaultDir, cleanToken };
