// What's new (contract v3.123): the renderer's pure helpers (renderer/whats-new.js), kept here so tests can load them.

/**
 * @typedef {{ en: string, tr: string, [lang: string]: string }} Texts
 * @typedef {{ id: string, title: Texts, body: Texts, experience?: 'office' | 'studio' | 'both', target?: string,
 *   try?: { label: Texts, action: string } }} WhatsNewItem
 * @typedef {{ version: string, items: WhatsNewItem[] }} WhatsNewEntry
 * @typedef {{ version: string, item: WhatsNewItem }} WhatsNewStep
 */

/**
 * The steps to show, newest version first: items for the other experience are left out, unless that would leave
 * nothing (then every item is shown).
 * @param {WhatsNewEntry[]} entries @param {'office' | 'studio'} experience
 * @returns {WhatsNewStep[]}
 */
export function stepsFor(entries, experience) {
  const all = (entries || []).flatMap((e) => (e.items || []).map((item) => ({ version: e.version, item })));
  const fits = all.filter((s) => !s.item.experience || s.item.experience === 'both' || s.item.experience === experience);
  return fits.length ? fits : all;
}

/** 'open-settings:about' → { id: 'open-settings', arg: 'about' } @param {string} action */
export function splitAction(action) {
  const [id, arg = ''] = String(action || '').split(':');
  return { id, arg };
}

/** A text in the current language, English when that one is missing. @param {Texts | undefined} texts @param {string} lang */
export function textOf(texts, lang) {
  if (!texts) return '';
  return texts[lang] || texts[String(lang).split('-')[0]] || texts.en || '';
}

