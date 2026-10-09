// Uygulamanın dilleri: app/locales/<kod>.json dosyaları (her biri tüm metinler, "_name" kendi dilindeki adı).
// Yeni bir dil = yeni bir dosya; dil seçici ve 'auto' çözümü listeyi buradan alır. Biçimlendirici: src/i18n.mjs.
const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const FALLBACK = 'en';
// BCP 47 biçiminde dosya adı: en, tr, pt-BR, zh-Hans
const CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Klasördeki dil dosyaları: { [kod]: metinler }. Okunamayan dosya atlanır. */
function loadLocales(dir = LOCALES_DIR) {
  /** @type {Record<string, any>} */
  const out = {};
  let files = [];
  try { files = fs.readdirSync(dir); } catch {}
  for (const f of files.sort()) {
    const code = f.endsWith('.json') ? f.slice(0, -5) : '';
    if (!CODE.test(code)) continue;
    try {
      const dict = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (dict && typeof dict === 'object' && !Array.isArray(dict)) out[code] = dict;
    } catch (e) { console.error(`locales/${f}:`, e); }
  }
  return out;
}

/** Dil seçicideki liste: [{ code, name }], koda göre sıralı. */
const languagesOf = (locales) =>
  Object.keys(locales).sort().map((code) => ({ code, name: typeof locales[code]?._name === 'string' ? locales[code]._name : code }));

/** Sistem dili etiketi ('tr-TR', 'pt_BR', 'de') → dosyası olan bir kod; tam eşleşme, sonra ana dil, yoksa 'en'. */
function resolveLang(tag, codes) {
  const want = String(tag || '').replace(/_/g, '-').toLowerCase();
  const exact = codes.find((c) => c.toLowerCase() === want);
  if (exact) return exact;
  const base = want.split('-')[0];
  return codes.find((c) => c.toLowerCase() === base) || FALLBACK;
}

module.exports = { LOCALES_DIR, FALLBACK, loadLocales, languagesOf, resolveLang };
