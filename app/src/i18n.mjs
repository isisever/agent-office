// Shared string formatter for the app's locale files (app/locales/<code>.json), used by the renderer
// (renderer/i18n.js) and the main process (main.js). Pure ES module: no Node or DOM APIs.
//
// A locale file is a JSON object of namespaces ("app", "sidebar", "panel", ...); a key is a dotted path
// ("sidebar.working"). Values are strings with named placeholders ("{n} working"), nested objects, or a
// plural group: an object whose keys are CLDR plural categories, with "other" required
// ({ "one": "1 tool call", "other": "{n} tool calls" }). A plural group is chosen by vars.n with
// Intl.PluralRules for the file's language. Keys starting with "_" are metadata ("_name": the language's
// own name, shown in the language picker).

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];

/** @param {unknown} v @returns {v is Record<string, string>} */
export const isPluralGroup = (v) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && 'other' in v
  && Object.keys(v).every((k) => PLURAL_CATEGORIES.includes(k));

/** The value at a dotted key, or undefined. @param {any} dict @param {string} key */
export function lookup(dict, key) {
  let v = dict;
  for (const part of key.split('.')) {
    if (v == null || typeof v !== 'object') return undefined;
    v = v[part];
  }
  return v;
}

/** "{name}" → vars.name; an unknown placeholder is left as it is. @param {string} s @param {Record<string, unknown>} [vars] */
export const format = (s, vars) =>
  s.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));

/** Placeholder names in a string or plural group (sorted, unique). @param {unknown} v @returns {string[]} */
export function placeholders(v) {
  const texts = typeof v === 'string' ? [v] : isPluralGroup(v) ? Object.values(v) : [];
  return [...new Set(texts.flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort();
}

/**
 * @typedef {((key: string, vars?: Record<string, unknown>) => string) & { has: (key: string) => boolean }} Translate
 */

/**
 * t(key, vars) for one language: `dict` is that language's file, `fallback` the English one (used for keys
 * the language lacks), `lang` its code (for the plural rules). A missing key returns the key itself.
 * @param {any} dict @param {any} fallback @param {string} lang @returns {Translate}
 */
export function translator(dict, fallback, lang) {
  let rules;
  try { rules = new Intl.PluralRules(lang); } catch { rules = new Intl.PluralRules('en'); }
  const usable = (v) => typeof v === 'string' || isPluralGroup(v);
  const resolve = (key) => {
    const v = lookup(dict, key);
    return usable(v) ? v : lookup(fallback, key);
  };
  /** @type {Translate} */
  const t = (key, vars) => {
    let v = resolve(key);
    if (isPluralGroup(v)) v = v[rules.select(Number(vars?.n))] ?? v.other;
    return typeof v === 'string' ? format(v, vars) : key;
  };
  t.has = (key) => usable(resolve(key));
  return t;
}
