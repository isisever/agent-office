'use strict';
// Purpose binding for everything the app encrypts with Electron safeStorage (contract v3.102). safeStorage has one
// key for the whole app, so a file encrypted for one use decrypts just as well when it is moved to where another use
// reads it. Every plaintext therefore starts with a fixed header that names what it is for, `ao1:<purpose>\n`, and a
// reader takes the payload only when the header names exactly its own purpose. This stops file-moving attacks by a
// process of the same user; it is not a sandbox (such a process can still run the app itself).

const fs = require('fs');

/** One purpose per file kind. A new safeStorage use gets a new constant here, never an existing one. */
const PURPOSE = Object.freeze({
  LINK_KEYS: 'link-keys',               // userData/link/keys.bin
  LINK_OWN: 'link-own',                 // userData/link/own.bin
  MCP_TOKEN: 'mcp-token',               // userData/mcp-tokens/<id>.bin
  CONNECTOR_TOKEN: 'connector-token',   // userData/connector-tokens/<id>.bin (v3.43, migration only)
  MAIL_SECRET: 'mail-secret',           // userData/mail-secrets/<id>.bin
});

const PURPOSE_RE = /^[a-z0-9-]{1,40}$/;
const HEADER_RE = /^ao1:([a-z0-9-]{1,40})\n/;
/** A token or secret is one line of at most this many characters. */
const TOKEN_MAX = 8192;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isHex = (s, bytes) => typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]+$/.test(s);

/** @param {string} purpose */
function header(purpose) {
  if (typeof purpose !== 'string' || !PURPOSE_RE.test(purpose)) throw new Error('sealed: bad purpose');
  return `ao1:${purpose}\n`;
}
/** The plaintext that gets encrypted. @param {string} purpose @param {string} plaintext */
const wrap = (purpose, plaintext) => header(purpose) + String(plaintext);
/**
 * → { state: 'ok', payload } (the header names `purpose`), { state: 'purpose' } (it names another one) or
 * { state: 'legacy', payload } (no header: written before v3.102).
 * @param {string} purpose @param {string} text
 * @returns {{ state: 'ok' | 'legacy', payload: string } | { state: 'purpose' }}
 */
function unwrap(purpose, text) {
  const own = header(purpose);
  const s = String(text);
  if (s.startsWith(own)) return { state: 'ok', payload: s.slice(own.length) };
  if (HEADER_RE.test(s)) return { state: 'purpose' };
  return { state: 'legacy', payload: s };
}

/** The link keys file: this machine's key pair (hex) and the secrets of the paired devices. */
function isLinkKeys(k) {
  return isObj(k) && isHex(k.publicKey, 32) && isHex(k.secretKey, 64)
    && (k.secrets === undefined || k.secrets === null || isObj(k.secrets))
    && (k.own === undefined || Array.isArray(k.own));
}
/** The own record (v3.101): `{ v, own: [keys], paused: [keys] }`. */
function isOwnRecord(r) {
  return isObj(r) && Number.isInteger(r.v) && Array.isArray(r.own) && Array.isArray(r.paused);
}
const parsed = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
/** For the one-time migration of a headerless file: does the text parse to that kind's schema? */
const linkKeysText = (text) => isLinkKeys(parsed(text));
const ownRecordText = (text) => isOwnRecord(parsed(text));

/** A control character or a line / paragraph separator anywhere in the text. @param {string} text */
function hasControl(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}
/**
 * Why a text cannot be a token or a secret, or null when it can: one line, no control characters, at most TOKEN_MAX
 * characters, and never a JSON object or array (so the link keys or the own record can never be handed out as one).
 * @param {unknown} text
 * @returns {'type' | 'length' | 'control' | 'structured' | null}
 */
function tokenProblem(text) {
  if (typeof text !== 'string') return 'type';
  if (text.length > TOKEN_MAX) return 'length';
  if (hasControl(text)) return 'control';
  const first = text.trimStart()[0];
  if (first === '{' || first === '[') { const v = parsed(text); if (v && typeof v === 'object') return 'structured'; }
  return null;
}

// --- files: a single regular file, never through a symbolic link ---

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;   // not on Windows: the lstat below covers it there
const refused = (code, what) => Object.assign(new Error(`sealed: ${what}`), { code });
/** True when the path exists in any form (a dangling symbolic link too). @param {string} file */
function present(file, fsx = fs) { try { fsx.lstatSync(file); return true; } catch { return false; } }
/** A folder for sealed files is the folder itself: false when it is a symbolic link or not a directory. A missing one is fine. */
function plainDir(dir, fsx = fs) {
  try { return fsx.lstatSync(dir).isDirectory(); } catch (e) { return /** @type {any} */ (e)?.code === 'ENOENT'; }
}
/** Reads a regular file; a symbolic link (or anything else) throws (code ELOOP / EINVAL), a missing file ENOENT. */
function readPlain(file, fsx = fs) {
  if (!fsx.lstatSync(file).isFile()) throw refused('ELOOP', 'not a regular file');
  const fd = fsx.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    if (!fsx.fstatSync(fd).isFile()) throw refused('EINVAL', 'not a regular file');
    return fsx.readFileSync(fd);
  } finally { fsx.closeSync(fd); }
}
/**
 * Writes through a new temp file and a rename (0600): a half write never truncates the old file, and a symbolic link
 * planted at the path or at the temp name is replaced, never followed.
 */
function writePlain(file, data, fsx = fs) {
  const tmp = `${file}.tmp`;
  try {
    fsx.rmSync(tmp, { force: true });
    fsx.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
    fsx.renameSync(tmp, file);
  } catch (e) { try { fsx.rmSync(tmp, { force: true }); } catch { /* best effort */ } throw e; }
}

/**
 * seal / open bound to one safeStorage.
 * @param {{ encryptString(s: string): Buffer, decryptString(b: Buffer): string }} safe
 */
function sealer(safe, fsx = fs) {
  /** → the encrypted bytes of `plaintext`, bound to `purpose`. @param {string} purpose @param {string} plaintext */
  const seal = (purpose, plaintext) => safe.encryptString(wrap(purpose, plaintext));
  /** Decrypts and looks at the header (see `unwrap`). Throws when the bytes do not decrypt. @param {string} purpose @param {Buffer} bytes */
  const inspect = (purpose, bytes) => unwrap(purpose, String(safe.decryptString(bytes) ?? ''));
  /**
   * → the payload, or null when the header is missing or names another purpose. Throws when the bytes do not decrypt
   * (the keychain is locked, another build): that says nothing about the file, so the caller keeps it.
   * @param {string} purpose @param {Buffer} bytes
   */
  const open = (purpose, bytes) => {
    const r = inspect(purpose, bytes);
    return r.state === 'ok' ? r.payload : null;
  };
  /**
   * The one-time migration path: like `open`, and a headerless plaintext is taken when `shape(text)` says it has the
   * shape of this purpose. → { payload, legacy } or null. Never for a kind whose migration is done.
   * @param {string} purpose @param {Buffer} bytes @param {(text: string) => boolean} shape
   */
  const openLegacy = (purpose, bytes, shape) => {
    const r = inspect(purpose, bytes);
    if (r.state === 'ok') return { payload: r.payload, legacy: false };
    if (r.state === 'legacy' && shape(r.payload) === true) return { payload: r.payload, legacy: true };
    return null;
  };
  /** The marker next to a single sealed file: its kind was migrated, a headerless file there is refused from now on. */
  const markerOf = (file) => `${file}.ao1`;
  /**
   * Reads one sealed file (never through a symbolic link). → { payload, legacy } or null (refused). Throws when the
   * file cannot be read or decrypted.
   * @param {string} file @param {string} purpose @param {(text: string) => boolean} shape
   */
  const openFile = (file, purpose, shape) => {
    const bytes = readPlain(file, fsx);
    if (!present(markerOf(file), fsx)) return openLegacy(purpose, bytes, shape);
    const payload = open(purpose, bytes);
    return payload === null ? null : { payload, legacy: false };
  };
  /** Writes one sealed file with the header, then its migration marker. @param {string} file @param {string} purpose @param {string} plaintext */
  const writeFile = (file, purpose, plaintext) => {
    writePlain(file, seal(purpose, plaintext), fsx);
    if (!present(markerOf(file), fsx)) writePlain(markerOf(file), '', fsx);
  };
  return { seal, inspect, open, openLegacy, openFile, writeFile, markerOf };
}

module.exports = {
  PURPOSE, TOKEN_MAX, header, wrap, unwrap, isLinkKeys, isOwnRecord, linkKeysText, ownRecordText, tokenProblem,
  present, plainDir, readPlain, writePlain, sealer,
};
