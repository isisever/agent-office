// OS differences (renderer): title bar and keyboard shortcuts.
// In Electron, the preload's agentOffice.platform; in a plain browser (dev-mock), try it with ?platform=linux.
// macOS: ⌘ shortcuts, room for traffic lights in the title bar. Linux: the window's normal frame and
// Ctrl+Shift shortcuts (Ctrl+V, Ctrl+O, Ctrl+1… go to Claude Code in the terminal).
const fromQuery = new URLSearchParams(location.search).get('platform');
export const platform = window.agentOffice?.platform || fromQuery || 'darwin';
export const isMac = platform === 'darwin';

// <html class="platform-darwin|platform-linux">: style.css lays out the title bar accordingly
document.documentElement.classList.add(`platform-${isMac ? 'darwin' : 'linux'}`);

/** Shortcut hint prefix: '⌘' (macOS) or 'Ctrl+Shift+' (Linux); e.g. modLabel + 'O'. */
export const modLabel = isMac ? '⌘' : 'Ctrl+Shift+';

/** Is this an app shortcut (⌘X / Ctrl+Shift+X)? Not if another modifier is pressed. */
export const isModKey = (/** @type {KeyboardEvent} */ e) => (isMac
  ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
  : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey);

/**
 * The pressed letter or digit, independent of keyboard layout and Shift ('o', '1'); otherwise e.key lowercased.
 * On Linux, Ctrl+Shift+1 gives e.key '!', while e.code stays 'Digit1'.
 */
export function keyOf(/** @type {KeyboardEvent} */ e) {
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code || '');
  if (!isMac && m) return (m[1] || m[2]).toLowerCase();
  return (e.key || '').toLowerCase();
}
