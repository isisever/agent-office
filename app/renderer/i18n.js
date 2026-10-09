// Arayüz dili: 'en' | 'tr'. Ayar ('auto' | 'en' | 'tr') main'de state.json'da durur; 'auto' sistem dilidir.
// Her modül kendi metin tablosunu tutar: const S = { en: {...}, tr: {...} }; pick(S).anahtar
// Dil değişince onLang abonelerine haber verilir; modüller kendini yeniden çizer (pencere yeniden yüklenmez).
let lang = 'en';
const subs = new Set();

export const getLang = () => lang;
export function setLang(l) {
  const next = l === 'tr' ? 'tr' : 'en';
  document.documentElement.lang = next;
  if (next === lang) return;
  lang = next;
  for (const f of subs) { try { f(lang); } catch (e) { console.error('dil değişimi:', e); } }
}
export const onLang = (f) => { subs.add(f); return () => subs.delete(f); };
/** O anki dilin tablosu. */
export const pick = (table) => table[lang] || table.en;
/** Tarih/saat biçimleri için yerel ayar. */
export const locale = () => (lang === 'tr' ? 'tr-TR' : 'en-US');
