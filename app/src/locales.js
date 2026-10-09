// The app's languages: app/locales/<code>.json files (each holds all strings, "_name" is its name in its own language).
// A new language = a new file; the language picker and 'auto' resolution take the list from here. Formatter: src/i18n.mjs.
const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const FALLBACK = 'en';
// File names in BCP 47 form: en, tr, pt-BR, zh-Hans
const CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Language files in the folder: { [code]: strings }. An unreadable file is skipped. */
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

/** The list in the language picker: [{ code, name }], sorted by code. */
const languagesOf = (locales) =>
  Object.keys(locales).sort().map((code) => ({ code, name: typeof locales[code]?._name === 'string' ? locales[code]._name : code }));

/** System language tag ('tr-TR', 'pt_BR', 'de') → a code that has a file; exact match, then base language, else 'en'. */
function resolveLang(tag, codes) {
  const want = String(tag || '').replace(/_/g, '-').toLowerCase();
  const exact = codes.find((c) => c.toLowerCase() === want);
  if (exact) return exact;
  const base = want.split('-')[0];
  return codes.find((c) => c.toLowerCase() === base) || FALLBACK;
}

module.exports = { LOCALES_DIR, FALLBACK, loadLocales, languagesOf, resolveLang };
