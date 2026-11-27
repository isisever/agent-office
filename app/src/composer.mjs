// Studio's composer (contract v3.121): attachment chips and the model / permission pickers. Pure logic only; the DOM is
// renderer/chat.js. Main checks the same picker values (src/gui-session.js) before it writes a control request.

/** The models a GUI chat can switch to mid-session ('' = the one the session started with). */
export const MODEL_OPTIONS = ['', 'opus', 'sonnet', 'haiku'];
/** Claude Code's permission modes a GUI chat can switch to; bypass is left out (it needs a start flag). */
export const MODE_OPTIONS = ['default', 'acceptEdits', 'plan'];

/** A byte count as people read it: "812 B", "4.2 KB", "13 MB" (1024-based, one decimal under 10). '' when unknown. */
export function formatSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)} ${units[i]}`;
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tif', 'tiff']);
const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cs',
  'php', 'sh', 'zsh', 'json', 'yml', 'yaml', 'toml', 'xml', 'html', 'css', 'scss', 'sql', 'lua']);
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'rtf']);
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'pages', 'numbers']);
const ARCHIVE_EXT = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);

/** A file's base name (either separator). */
export function baseName(path) {
  const s = String(path || '').replace(/[\\/]+$/, '');
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1) || s;
}

/** What a chip shows for a file: 'image' | 'code' | 'text' | 'document' | 'archive' | 'file' (by MIME type, else extension). */
export function fileKind(name, type = '') {
  const tp = String(type || '').toLowerCase();
  if (tp.startsWith('image/')) return 'image';
  if (tp === 'application/pdf') return 'document';
  const base = baseName(name).toLowerCase();
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (CODE_EXT.has(ext)) return 'code';
  if (TEXT_EXT.has(ext) || tp.startsWith('text/')) return 'text';
  if (DOC_EXT.has(ext)) return 'document';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  return 'file';
}

/**
 * A chip's texts: { name, kind, meta } — meta is the size when known, else the extension in capitals, else ''.
 * @param {{ path?: string, size?: number, type?: string, dir?: boolean }} [f]
 */
export function chipInfo({ path = '', size, type = '', dir = false } = {}) {
  const name = baseName(path);
  if (dir) return { name, kind: 'folder', meta: '' };
  const sz = formatSize(size);
  const dot = name.lastIndexOf('.');
  return { name, kind: fileKind(name, type), meta: sz || (dot > 0 ? name.slice(dot + 1).toUpperCase() : '') };
}

/**
 * v3.121 the composer's chips after adding `incoming`: the chips already there keep their place, the new ones follow
 * in the order given (drop, paste or picker order); a path already there (or twice in `incoming`) is added once, and
 * an entry without a path is skipped. Returns a new list; folders stay one chip (never expanded).
 * @template {{ path: string }} F @param {F[]} list @param {F[]} incoming @returns {F[]}
 */
export function addChips(list, incoming) {
  const out = (list || []).slice();
  const seen = new Set(out.map((f) => f.path));
  for (const f of incoming || []) {
    if (!f || typeof f.path !== 'string' || !f.path || seen.has(f.path)) continue;
    seen.add(f.path);
    out.push(f);
  }
  return out;
}

/** v3.121 the hint while files are dragged over the chat: "Drop 3 files" (one: "Drop 1 file"; count unknown: "Drop files here"). */
export function dropText(count, t) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  if (!n) return t('chat.drop.any');
  return n === 1 ? t('chat.drop.one') : t('chat.drop.many', { count: n });
}

/** One path as Claude Code reads a mention: @path, quoted when it has a space (the chat's own insertPaths format). */
export const mention = (p) => (/\s/.test(p) ? `@"${String(p).replace(/"/g, '')}"` : `@${p}`);

/** The text sent for a message with file chips: the typed text, then the files as @mentions on their own line. */
export function withMentions(text, paths) {
  const list = (paths || []).filter((p) => typeof p === 'string' && p);
  if (!list.length) return text;
  const body = String(text || '').replace(/\s+$/, '');
  return `${body}${body ? '\n\n' : ''}${list.map(mention).join(' ')}`;
}

/**
 * A sent message's text split for display: the trailing line of @mentions (as withMentions writes it) becomes file
 * chips. → { text, files }. A message with no such last line is left as it is.
 */
export function splitMentions(text) {
  const s = String(text ?? '');
  const lines = s.split('\n');
  const last = lines[lines.length - 1].trim();
  const re = /@"([^"]+)"|@(\S+)/g;
  if (!last || !/^(?:@"[^"]+"|@\S+)(?:\s+(?:@"[^"]+"|@\S+))*$/.test(last)) return { text: s, files: [] };
  const files = [...last.matchAll(re)].map((m) => m[1] || m[2]).filter((p) => /[\\/]/.test(p));
  if (!files.length) return { text: s, files: [] };
  return { text: lines.slice(0, -1).join('\n').replace(/\s+$/, ''), files };
}

/**
 * The pickers' state for a tab. gui: the chat's GUI info (null: a terminal tab), settings: what this chat last set.
 * → { enabled, model, mode, why } — why: '' | 'terminal' (a terminal tab: /model there) | 'busy' (a turn runs: wait).
 */
export function pickerState(gui, settings = {}) {
  const model = MODEL_OPTIONS.includes(settings?.model) ? settings.model : '';
  const mode = MODE_OPTIONS.includes(settings?.mode) ? settings.mode : 'default';
  if (!gui || gui.ended) return { enabled: false, model, mode, why: 'terminal' };
  if (gui.live?.busy || (gui.asks || []).length) return { enabled: false, model, mode, why: 'busy' };
  return { enabled: true, model, mode, why: '' };
}
