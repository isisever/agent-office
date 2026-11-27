// Studio experience (contract v3.120): the keyboard shortcuts, pure so they can be tested.
// ⌘⇧E (Ctrl+Shift+E on Linux and Windows) switches between the Office and Studio in both experiences. In Studio only:
// ⌘N new session, ⌘K search, ⌘1…9 the n-th session in the sidebar (Ctrl+Shift+… elsewhere, like the app's other keys).
// Outside Studio nothing but the toggle is taken, so the Office's keys stay as they are.

/**
 * @param {{ mac: boolean, meta?: boolean, ctrl?: boolean, shift?: boolean, alt?: boolean, code?: string }} e
 * @param {string} experience 'office' | 'studio'
 * @returns {null | { type: 'toggle' } | { type: 'new' } | { type: 'newWorktree' } | { type: 'search' } | { type: 'focus' } | { type: 'settings' } | { type: 'session', index: number }}
 */
export function studioKey(e, experience) {
  const { mac, meta = false, ctrl = false, shift = false, alt = false, code = '' } = e;
  const toggle = mac ? meta && shift && !ctrl && !alt : ctrl && shift && !meta && !alt;
  if (toggle && code === 'KeyE') return { type: 'toggle' };
  if (experience !== 'studio') return null;
  // v3.122 ⌘, (Ctrl+, elsewhere): Studio's Settings page
  if (code === 'Comma' && (mac ? meta && !ctrl && !alt && !shift : ctrl && !meta && !alt && !shift)) return { type: 'settings' };
  // v3.120 Studio UX: ⌘⇧N a new session in a new worktree (Ctrl+Shift+Alt+N elsewhere, as Ctrl+Shift+N is ⌘N there)
  if (code === 'KeyN' && (mac ? meta && shift && !ctrl && !alt : ctrl && shift && alt && !meta)) return { type: 'newWorktree' };
  const mod = mac ? meta && !ctrl && !alt && !shift : ctrl && shift && !meta && !alt;
  if (!mod) return null;
  if (code === 'KeyN') return { type: 'new' };
  if (code === 'KeyK') return { type: 'search' };
  if (code === 'KeyL') return { type: 'focus' };   // v3.120 Studio UX: ⌘L the composer
  const m = /^Digit([1-9])$/.exec(code);
  return m ? { type: 'session', index: Number(m[1]) - 1 } : null;
}

/** The other experience. */
export const otherExperience = (experience) => (experience === 'studio' ? 'office' : 'studio');

/**
 * v3.120 the title bar's Studio switch: on in Studio, and the hotkey its tooltip names.
 * @param {string} experience 'office' | 'studio'
 * @param {boolean} mac
 * @returns {{ checked: boolean, ariaChecked: 'true' | 'false', hotkey: string }}
 */
export function experienceSwitch(experience, mac) {
  const checked = experience === 'studio';
  return { checked, ariaChecked: checked ? 'true' : 'false', hotkey: mac ? '⌘⇧E' : 'Ctrl+Shift+E' };
}
