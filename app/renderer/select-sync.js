// A native <select> redrawn by a poll without closing its open dropdown: see selectPlan in src/composer.mjs.
import { optionsKey, selectPlan } from '../src/composer.mjs';

/** @typedef {{ value: string, label: string, title?: string, disabled?: boolean, hidden?: boolean }} SelectOption */

/**
 * Brings a picker to these options and this value, touching it only when something changed and never while it is
 * focused (force: the person's own choice just ended, e.g. a refused setting going back).
 * @param {HTMLSelectElement} sel @param {SelectOption[]} options @param {string} want @param {{ force?: boolean }} [o]
 */
export function syncSelect(sel, options, want, { force = false } = {}) {
  const key = optionsKey(options);
  const plan = selectPlan({ shownKey: sel.dataset.optionsKey, key, focused: document.activeElement === sel, value: sel.value, want, force });
  if (plan.rebuild) {
    sel.dataset.optionsKey = key;
    sel.replaceChildren(...options.map((o) => {
      const op = document.createElement('option');
      op.value = o.value;
      op.textContent = o.label;
      if (o.title) op.title = o.title;
      if (o.disabled) op.disabled = true;
      if (o.hidden) op.hidden = true;
      return op;
    }));
  }
  if (plan.setValue && sel.value !== want) sel.value = want;
}

/** Sets an element property only when it differs (a same-value write can still count as a change to the native menu). */
export function setProp(/** @type {any} */ el, /** @type {string} */ key, /** @type {any} */ value) {
  if (el[key] !== value) el[key] = value;
}
