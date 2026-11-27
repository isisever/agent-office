// v3.122 the title bar's keep-awake control (Office and Studio): a cup icon whose menu holds the keepAwake setting's
// options. It drives the Office's own keepAwake select (sidebar.settingControl), so it is the same value and handler as
// Settings. Filled and in the accent colour while active; the label hides at narrow widths (style.css).

import { keepAwakeView } from '../src/settings-model.mjs';
import { icon } from './studio-icons.js';

const SYNC_MS = 1500;

/**
 * @param {{ button: HTMLElement | null, t: (key: string, vars?: Record<string, any>) => string,
 *   control: () => { label: HTMLElement, control: any } | null }} o
 */
export function mountKeepAwake({ button, t, control }) {
  if (!button) return null;
  const label = document.createElement('span');
  label.className = 'ka-label';
  button.replaceChildren(icon('coffee', 15), label);
  const menu = document.createElement('div');
  menu.className = 'ka-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.append(menu);

  const view = () => {
    const c = control();
    if (!c) return null;
    const opts = [...c.control.options].map((o) => ({ value: o.value, text: o.textContent || o.value }));
    return { c, v: keepAwakeView(opts, c.control.value) };
  };
  function sync() {
    const x = view();
    button.hidden = !x;
    if (!x) return;
    const name = (x.c.label.textContent || '').trim() || t('app.keepAwake');
    button.classList.toggle('active', x.v.active);
    button.title = t('app.keepAwakeTitle', { label: name, state: x.v.currentText });
    button.setAttribute('aria-label', button.title);
    label.textContent = t('app.keepAwake');
  }
  function closeMenu(focus = false) { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); if (focus) button.focus(); }
  function openMenu() {
    const x = view();
    if (!x) return;
    menu.replaceChildren(...x.v.items.map((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ka-item';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(it.checked));
      b.textContent = it.text;
      b.addEventListener('click', () => {
        x.c.control.value = it.value;
        x.c.control.dispatchEvent(new Event('change', { bubbles: true }));
        closeMenu(true);
        sync();
      });
      return b;
    }));
    const r = button.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    /** @type {HTMLElement | null} */ (menu.querySelector('[aria-checked="true"]') || menu.firstElementChild)?.focus();
  }
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  menu.addEventListener('keydown', (e) => {
    const items = /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('.ka-item')]);
    const i = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Tab') closeMenu();
  });
  document.addEventListener('mousedown', (e) => { if (!menu.hidden && e.target instanceof Node && !menu.contains(e.target) && !button.contains(e.target)) closeMenu(); });
  sync();
  setInterval(sync, SYNC_MS);
  return { sync };
}
