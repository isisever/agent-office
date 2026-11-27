// v3.133 the title bar's economy leaf (Office and Studio), next to the keep-awake cup: a switch that drives the
// Office's own economy checkbox (sidebar.settingControl('economy')), so it is the same value and handler as Settings.
// Filled and in the accent colour while on; the tooltip says what economy sets.

import { icon } from './studio-icons.js';

const SYNC_MS = 1500;

/**
 * @param {{ button: HTMLElement | null, t: (key: string, vars?: Record<string, any>) => string,
 *   control: () => { label: HTMLElement, control: any } | null }} o
 */
export function mountEconomy({ button, t, control }) {
  if (!button) return null;
  button.replaceChildren(icon('leaf', 15));
  function sync() {
    const c = control();
    button.hidden = !c;
    if (!c) return;
    const on = c.control.checked === true;
    button.classList.toggle('active', on);
    button.setAttribute('aria-checked', String(on));
    button.title = t(on ? 'app.economyOnTitle' : 'app.economyOffTitle');
    button.setAttribute('aria-label', button.title);
  }
  button.addEventListener('click', () => {
    const c = control();
    if (!c) return;
    c.control.checked = !c.control.checked;
    c.control.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
  });
  sync();
  setInterval(sync, SYNC_MS);
  return { sync };
}
