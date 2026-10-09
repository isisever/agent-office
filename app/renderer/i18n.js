// Arayüz dili: app/locales/<kod>.json dosyalarından biri ('en', 'tr', ...). Ayar ('auto' ya da bir kod) main'de
// state.json'da durur; 'auto' sistem dilidir. Dil listesi main'den gelir (LanguageInfo.languages).
// Metinler: t('sidebar.working', { n: 2 }) → "2 working" (biçimlendirici ../src/i18n.mjs, main ile ortak).
// Dosyada olmayan anahtar İngilizceye düşer. Dil değişince dosya yüklenir, sonra onLang abonelerine haber verilir;
// modüller kendini yeniden çizer (pencere yeniden yüklenmez).
import { translator } from '../src/i18n.mjs';

const FALLBACK = 'en';
const CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/** @type {Map<string, Promise<any>>} */
const files = new Map();
/** locales/<kod>.json; okunamazsa {} (her anahtar İngilizceye düşer). @param {string} code */
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
/** Dili değiştirir (dosyası yüklenince). @param {string} l */
export async function setLang(l) {
  const next = typeof l === 'string' && CODE.test(l) ? l : FALLBACK;
  const my = ++seq;
  const dict = next === FALLBACK ? base : await load(next);
  if (my !== seq) return; // arada başka bir dil istendi
  document.documentElement.lang = next;
  if (next === lang) return;
  lang = next;
  tr = translator(dict, base, next);
  for (const f of subs) { try { f(lang); } catch (e) { console.error('dil değişimi:', e); } }
}
export const onLang = (f) => { subs.add(f); return () => subs.delete(f); };
/** O anki dilde metin. @param {string} key @param {Record<string, unknown>} [vars] */
export const t = (key, vars) => tr(key, vars);
/** Anahtar o anki dilde (ya da İngilizcede) var mı. @param {string} key */
export const hasText = (key) => tr.has(key);
/** Tarih/saat biçimleri için yerel ayar (dil kodu). */
export const locale = () => lang;
