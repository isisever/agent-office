// Theme picker logic (contract v3.1), pure: shared by main (merging) and the renderer (picker options).
// No Node APIs here: main reads the files and passes their parsed contents in.

/** Built-in themes of core.mjs (THEMES), always offered first. */
export const BUILTIN_THEMES = ['classic', 'forest'];
/** The setting that keeps today's behaviour: a theme whose `match` fits the project, else colours from its name. */
export const AUTO = 'auto';
const MAX_NAME = 100;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Gallery files (themes/*.json, each a themes.json fragment) → one map. `match` is dropped: a gallery theme
 * applies only when picked, never because a project name happens to contain it.
 * @param {unknown[]} files parsed JSON of each file, in order (a later file wins on a name clash)
 * @returns {Record<string, any>}
 */
export function galleryThemes(files) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const f of files ?? []) {
    if (!isObj(f)) continue;
    for (const [name, t] of Object.entries(f)) {
      if (!isObj(t)) continue;
      const rest = { ...t };
      delete rest.match;
      out[name] = { ...rest, colors: isObj(rest.colors) ? { ...rest.colors } : {} };
    }
  }
  return out;
}

/**
 * The themes passed to the office: the gallery, then the user's themes.json over it. On a name clash the user's
 * fields win (colours merged key by key), so a user can tweak a gallery theme or give it a `match` of their own.
 * @param {Record<string, any>} gallery output of galleryThemes
 * @param {unknown} user parsed ~/.claude/agent-office/themes.json ({} when missing or broken)
 * @returns {Record<string, any>}
 */
export function mergeThemes(gallery, user) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [name, t] of Object.entries(gallery ?? {})) out[name] = { ...t, colors: { ...t.colors } };
  if (!isObj(user)) return out;
  for (const [name, t] of Object.entries(user)) {
    if (!isObj(t)) continue;
    const base = out[name];
    out[name] = base
      ? { ...base, ...t, colors: { ...base.colors, ...(isObj(t.colors) ? t.colors : {}) } }
      : { ...t };
  }
  return out;
}

/**
 * Picker options after "Auto": the built-in themes, then every other theme in the merged map, in its order.
 * description: the theme's own one-liner, if it has one (built-ins get theirs from the locale files).
 * @param {Record<string, any>} themes output of mergeThemes
 * @returns {{ name: string, description: string, isBuiltin: boolean }[]}
 */
export function themeChoices(themes) {
  const desc = (name) => (typeof themes?.[name]?.description === 'string' ? themes[name].description : '');
  const extra = Object.keys(themes ?? {}).filter((n) => !BUILTIN_THEMES.includes(n) && isObj(themes[n]));
  return [
    ...BUILTIN_THEMES.map((name) => ({ name, description: desc(name), isBuiltin: true })),
    ...extra.map((name) => ({ name, description: desc(name), isBuiltin: false })),
  ];
}

/**
 * The stored setting: 'auto' or a theme name. Anything else (missing, empty, too long, not a string) is 'auto'.
 * A name that no longer exists is kept (themes.json may come back); see effectiveTheme.
 * @param {unknown} v
 */
export function normalizeThemeSetting(v) {
  if (typeof v !== 'string') return AUTO;
  const s = v.trim();
  return s && s.length <= MAX_NAME ? s : AUTO;
}

/**
 * The theme to force in the office ('' = pick by project, as core.mjs setTheme expects): the setting when it names
 * a theme on offer, otherwise ''.
 * @param {unknown} setting
 * @param {Record<string, any>} themes output of mergeThemes
 */
export function effectiveTheme(setting, themes) {
  const s = normalizeThemeSetting(setting);
  if (s === AUTO) return '';
  return themeChoices(themes).some((c) => c.name === s) ? s : '';
}
