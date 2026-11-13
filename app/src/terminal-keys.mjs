// Key translations and paste helpers for the claude terminal that xterm.js does not do by itself (pure; tested in main.test.cjs).

// Claude Code's send-now key (chat:sendNow) is ctrl+enter, which it reads as the CSI u sequence ESC [13;5u even
// when the kitty keyboard protocol was not negotiated. xterm.js sends a bare CR for Enter whatever the modifiers.
export const CTRL_ENTER = '\x1b[13;5u';

// Shift+Enter starts a new line in the prompt instead of sending it (v3.75). xterm.js sends a bare CR for it; the
// app sends ESC CR (Meta+Enter, what Option+Enter already sends), which Claude Code and the other engines read as
// a newline without any keyboard protocol or /terminal-setup.
export const SHIFT_ENTER = '\x1b\r';

// macOS Option as Meta (macOptionIsMeta) makes xterm send ESC+key, but on TR/DE/… layouts Option is how @ { [ ] } \ | ~
// are typed. An ASCII symbol the layout composes with Option is typed as that character; letters, digits, non-ASCII
// results (US Option+p is π) and keys without a character (arrows, Backspace, Enter) stay Meta for claude's alt+ keys.
const OPTION_SYMBOL = /^[!-/:-@[-`{-~]$/;

/**
 * The bytes to send instead of xterm's own for this keydown, or null to leave it to xterm.
 * Cmd+Enter (macOS) and Ctrl+Enter send ctrl+enter, so a queued message is sent now as in other terminals.
 * Shift+Enter alone sends a newline (SHIFT_ENTER).
 * macOS Option+key that the layout turns into an ASCII symbol sends that symbol, not ESC+key.
 * An IME composition keeps its keys (Enter there commits the text).
 * @param {{ key?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, isComposing?: boolean }} ev
 * @param {boolean} isMac
 */
export function translateKey(ev, isMac) {
  if (ev.isComposing) return null;
  if (isMac && ev.altKey && !ev.metaKey && !ev.ctrlKey) return OPTION_SYMBOL.test(ev.key || '') ? ev.key : null;
  if (ev.key !== 'Enter' || ev.altKey) return null;
  if (ev.shiftKey) return ev.metaKey || ev.ctrlKey ? null : SHIFT_ENTER;
  const cmd = isMac && ev.metaKey && !ev.ctrlKey;
  const ctrl = ev.ctrlKey && !ev.metaKey;
  return cmd || ctrl ? CTRL_ENTER : null;
}

// Claude Code's image paste key (chat:imagePaste): Ctrl+V on macOS and Linux, Alt+V (ESC v) on Windows.
// The app sends it when the clipboard holds an image, and Claude Code reads the image from the clipboard itself.
/** @param {string} platform process.platform */
export const imagePasteKey = (platform) => (platform === 'win32' ? '\x1bv' : '\x16');

/**
 * A pasted or dropped file path as the terminal gets it. macOS and Linux: shell-style single quotes when the path
 * has spaces or shell characters. Windows: double quotes when it has spaces or such characters ("C:\a b\c.png");
 * a backslash alone needs none there.
 * @param {string} p @param {string} platform process.platform
 */
export function quotePath(p, platform) {
  if (platform === 'win32') return /[\s"'&()^%!;,=`$]/.test(p) ? `"${p.replace(/"/g, '')}"` : p;
  return /[\s'"\\$`!&;()<>|*?]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
}

/**
 * Is this key event the terminal's paste key (v3.19)? macOS: ⌘V (⌘⇧V too). Linux: Ctrl+Shift+V (Ctrl+V goes to
 * claude, whose image paste key is Ctrl+V there). Windows: Ctrl+V and Ctrl+Shift+V. Claude Code binds no Ctrl+V on
 * native Windows (its image key is Alt+V, because Ctrl+V is the terminal's paste, as in Windows Terminal); xterm would
 * send ^V and nothing would happen. AltGr (Ctrl+Alt on Windows) is not paste. The letter comes from `code` off macOS,
 * so other layouts (Turkish F, Cyrillic) paste with the key in V's place, as Windows Terminal does.
 * @param {{ key?: string, code?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean }} ev
 * @param {string} platform process.platform
 */
export function isPasteKey(ev, platform) {
  if (platform === 'darwin') return Boolean(ev.metaKey && !ev.ctrlKey && !ev.altKey) && (ev.key || '').toLowerCase() === 'v';
  const v = ev.code ? ev.code === 'KeyV' : (ev.key || '').toLowerCase() === 'v';
  if (!v || !ev.ctrlKey || ev.metaKey || ev.altKey) return false;
  return platform === 'win32' ? true : Boolean(ev.shiftKey);
}

/**
 * What a paste writes to claude, from main's clipboard:read answer: { pty } bytes to write as they are (quoted file
 * paths, space-separated with a trailing space; or Claude Code's image paste key, which makes it read the image from
 * the clipboard itself), { text } for xterm's (bracketed) paste, or null for nothing.
 * Files come first everywhere. macOS and Linux: an image before text (unchanged). Windows: text before an image, as
 * Windows Terminal's Ctrl+V does: Excel, Word and browsers put a picture next to copied text, and a screenshot has
 * no text.
 * @param {{ files?: string[], hasImage?: boolean, text?: string } | null | undefined} clip
 * @param {string} platform process.platform
 * @returns {{ pty: string } | { text: string } | null}
 */
export function pasteAction(clip, platform) {
  if (!clip) return null;
  const files = (clip.files || []).filter(Boolean);
  if (files.length) return { pty: files.map((p) => quotePath(p, platform)).join(' ') + ' ' };
  const image = clip.hasImage ? { pty: imagePasteKey(platform) } : null;
  const text = clip.text ? { text: clip.text } : null;
  return (platform === 'win32' ? text || image : image || text) || null;
}
