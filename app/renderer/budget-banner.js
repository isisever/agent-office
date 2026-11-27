// v3.133 the "budget reached" banner (Office and Studio): one line per project whose token budget is used up, with
// Raise (every limit x1.5, main's budget.js raiseBudget) and Ignore today. HQ tasks and routines into the project wait
// meanwhile; the person's own typing is never blocked. Fed by main's tokens:brief push (about once a minute).

import { bannersOf, meterView, amountText } from '../src/economy-view.mjs';

/**
 * @param {{ api: any, t: (key: string, vars?: Record<string, any>) => string, names: () => Map<string, string> }} o
 */
export function mountBudgetBanner({ api, t, names }) {
  const box = document.createElement('div');
  box.className = 'budget-banner';
  box.setAttribute('role', 'alert');
  box.hidden = true;
  document.body.append(box);
  /** @type {Set<string>} closed with × until the next brief that is no longer blocked */
  const dismissed = new Set();
  /** @type {any[]} */
  let last = [];
  function draw() {
    const list = bannersOf(last, dismissed);
    box.hidden = !list.length;
    box.replaceChildren(...list.map((b) => {
      const v = /** @type {NonNullable<ReturnType<typeof meterView>>} */ (meterView(b));
      const row = document.createElement('div');
      row.className = 'bb-row';
      const text = document.createElement('span');
      text.textContent = t('app.budgetReached', { project: b.name || names().get(b.id) || '', used: amountText(v.used, v.unit), limit: amountText(v.limit, v.unit), period: t(`sidebar.budget_${v.period}`) });
      const btn = (/** @type {string} */ label, /** @type {() => void} */ fn) => {
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = label;
        x.addEventListener('click', fn);
        return x;
      };
      const act = (/** @type {string} */ action) => () => {
        dismissed.add(b.id);
        draw();
        Promise.resolve(api.projects?.budgetAct?.(b.id, action)).catch((/** @type {any} */ e) => console.error(e));
      };
      row.append(text, btn(t('app.budgetRaise'), act('raise')), btn(t('app.budgetIgnore'), act('ignore')),
        btn(t('app.budgetClose'), () => { dismissed.add(b.id); draw(); }));
      return row;
    }));
  }
  const take = (/** @type {any} */ list) => {
    last = Array.isArray(list) ? list : [];
    for (const id of [...dismissed]) if (!bannersOf(last).some((b) => b.id === id)) dismissed.delete(id);
    draw();
  };
  api.tokens?.onBrief?.(take);
  Promise.resolve(api.tokens?.brief?.()).then(take).catch(() => {});
  return { take };
}
