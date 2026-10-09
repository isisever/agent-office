// UI language: one of the app/locales/<code>.json files ('en', 'tr', ...). The setting ('auto' or a code) lives in
// main's state.json; 'auto' is the system language. The language list comes from main (LanguageInfo.languages).
// Strings: t('sidebar.working', { n: 2 }) → "2 working" (formatter ../src/i18n.mjs, shared with main).
// A key missing from the file falls back to English. On a language change the file is loaded, then onLang
// subscribers are notified; modules redraw themselves (the window is not reloaded).
import { translator } from '../src/i18n.mjs';

const FALLBACK = 'en';
const CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/** @type {Map<string, Promise<any>>} */
const files = new Map();
/** locales/<code>.json; {} if unreadable (every key falls back to English). @param {string} code */
function load(code) {
  if (!files.has(code)) {
    files.set(code, fetch(new URL(`../locales/${code}.json`, import.meta.url))
      .then((r) => (r.ok ? r.json() : {}))
      .catch((e) => { console.error(`locales/${code}.json:`, e); return {}; }));
  }
  return /** @type {Promise<any>} */ (files.get(code));
}

const base = await load(FALLBACK);
let lang = FALLBACK;
let tr = translator(base, base, FALLBACK);
let seq = 0;
const subs = new Set();

export const getLang = () => lang;
/** Changes the language (once its file has loaded). @param {string} l */
export async function setLang(l) {
  const next = typeof l === 'string' && CODE.test(l) ? l : FALLBACK;
  const my = ++seq;
  const dict = next === FALLBACK ? base : await load(next);
  if (my !== seq) return; // another language was requested in the meantime
  document.documentElement.lang = next;
  if (next === lang) return;
  lang = next;
  tr = translator(dict, base, next);
  for (const f of subs) { try { f(lang); } catch (e) { console.error('dil değişimi:', e); } }
}
export const onLang = (f) => { subs.add(f); return () => subs.delete(f); };
/** Text in the current language. @param {string} key @param {Record<string, unknown>} [vars] */
export const t = (key, vars) => tr(key, vars);
/** Whether the key exists in the current language (or in English). @param {string} key */
export const hasText = (key) => tr.has(key);
/** Locale for date/time formats (language code). */
export const locale = () => lang;
