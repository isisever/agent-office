// What's new (contract v3.123): a calm step-through card after an update, one item at a time, with Back / Next /
// "Try it" / Skip all and a page indicator. "Try it" closes the card, runs one of a fixed set of actions (app.js) and
// may spotlight the item's `target` for a moment. The Office's modal look; in Studio, studio.css restyles it.

import { stepsFor, textOf } from '../src/whats-new-ui.mjs';
export { stepsFor, splitAction, textOf } from '../src/whats-new-ui.mjs';

/** @typedef {import('../src/whats-new-ui.mjs').WhatsNewItem} WhatsNewItem @typedef {import('../src/whats-new-ui.mjs').WhatsNewEntry} WhatsNewEntry @typedef {import('../src/whats-new-ui.mjs').WhatsNewStep} WhatsNewStep */

/**
 * @param {{ t: (key: string, vars?: object) => string, lang: () => string, experience: () => 'office' | 'studio',
 *   run: (action: string) => string | void }} o run performs a "Try it" action; it may return a selector to spotlight
 *   when the item has no target of its own
 */
export function mountWhatsNew({ t, lang, experience, run }) {
  /** @type {HTMLElement | null} */
  let back = null;
  /** @type {WhatsNewStep[]} */
  let steps = [];
  let at = 0;
  /** @type {(() => void) | null} */
  let endSpot = null;

  /** @param {string} tag @param {Record<string, any>} [props] @param {...(Node | string)} kids */
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : String(v));
    }
    n.append(...kids);
    return n;
  }

  function close() {
    back?.remove();
    back = null;
  }

  function draw() {
    if (!back) return;
    const { version, item } = steps[at];
    const l = lang();
    const last = at === steps.length - 1;
    const card = el('div', { class: 'wn-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wn-title', tabindex: '-1' },
      el('div', { class: 'wn-eyebrow' }, t('whatsNew.title', { version })),
      el('h2', { class: 'wn-title', id: 'wn-title' }, textOf(item.title, l)),
      el('p', { class: 'wn-body' }, textOf(item.body, l)),
      el('div', { class: 'wn-foot' },
        el('div', { class: 'wn-dots', role: 'img', 'aria-label': t('whatsNew.page', { n: at + 1, total: steps.length }) },
          ...steps.map((_, i) => el('span', { class: 'wn-dot' + (i === at ? ' on' : '') }))),
        el('button', { class: 'wn-btn wn-skip', onclick: () => close() }, t('whatsNew.skipAll')),
        el('span', { class: 'wn-gap' }),
        ...(at > 0 ? [el('button', { class: 'wn-btn', onclick: () => go(-1) }, t('whatsNew.back'))] : []),
        ...(item.try ? [el('button', { class: 'wn-btn', onclick: () => tryIt(item) }, textOf(item.try.label, l) || t('whatsNew.tryIt'))] : []),
        el('button', { class: 'wn-btn primary', onclick: () => (last ? close() : go(1)) }, last ? t('whatsNew.done') : t('whatsNew.next'))));
    back.replaceChildren(card);
    /** @type {HTMLElement | null} */ (card.querySelector('.wn-btn.primary'))?.focus();
  }

  /** @param {number} d */
  function go(d) {
    at = Math.max(0, Math.min(steps.length - 1, at + d));
    draw();
  }

  /** @param {WhatsNewItem} item */
  function tryIt(item) {
    close();
    let target = item.target || '';
    try { target = run(item.try?.action || '') || target; } catch (e) { console.error(e); }
    if (item.target) target = item.target;
    if (target) spotlight(target, textOf(item.title, lang()));
  }

  /**
   * A short pulse around the element with a tooltip; the element may appear a moment later (a popup opening).
   * @param {string} selector @param {string} text
   */
  function spotlight(selector, text) {
    endSpot?.();
    let tries = 0;
    /** @type {number | undefined} */
    let timer;
    /** @type {HTMLElement[]} */
    const parts = [];
    const end = () => { clearTimeout(timer); for (const p of parts) p.remove(); document.removeEventListener('mousedown', end, true); if (endSpot === end) endSpot = null; };
    endSpot = end;
    const find = () => {
      /** @type {HTMLElement | null} */
      let target = null;
      try { target = document.querySelector(selector); } catch { return end(); }
      const r = target?.getBoundingClientRect();
      if (!target || !r || (!r.width && !r.height)) {
        if (++tries < 12) timer = window.setTimeout(find, 150);
        else end();
        return;
      }
      target.scrollIntoView?.({ block: 'nearest' });
      const box = target.getBoundingClientRect();
      const pad = 6;
      const ring = el('div', { class: 'wn-spot', 'aria-hidden': 'true' });
      Object.assign(ring.style, { left: `${box.left - pad}px`, top: `${box.top - pad}px`, width: `${box.width + pad * 2}px`, height: `${box.height + pad * 2}px` });
      const tip = el('div', { class: 'wn-tip', role: 'status' }, text);
      const below = box.bottom + 60 < window.innerHeight;
      Object.assign(tip.style, { left: `${Math.max(8, Math.min(window.innerWidth - 268, box.left))}px`, top: below ? `${box.bottom + pad + 8}px` : '', bottom: below ? '' : `${window.innerHeight - box.top + pad + 8}px` });
      parts.push(ring, tip);
      document.body.append(ring, tip);
      document.addEventListener('mousedown', end, true);
      timer = window.setTimeout(end, 4500);
    };
    timer = window.setTimeout(find, 200);
  }

  /** @param {KeyboardEvent} e */
  function onKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  }

  return {
    /** Show these entries (newest first); nothing to show does nothing. @param {WhatsNewEntry[]} entries */
    show(entries) {
      steps = stepsFor(entries, experience());
      if (!steps.length) return false;
      at = 0;
      close();
      back = el('div', { class: 'wn-backdrop', onmousedown: (/** @type {MouseEvent} */ e) => { if (e.target === back) close(); }, onkeydown: onKey });
      document.body.append(back);
      draw();
      return true;
    },
    close,
    isOpen: () => Boolean(back),
  };
}
