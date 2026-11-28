/**
 * v3.163 Studio: the account picker in the project header. Pure logic: which accounts the menu lists, which one is
 * current, and whether a click is a change worth sending to main. No DOM and no IPC here.
 */

/**
 * @param {{ id: string, label?: string, state?: string, engine?: string }[]} accounts the configured accounts
 * @param {string} current the project's account as the header shows it (its label, or the id)
 * @returns {{ id: string, label: string, current: boolean, signedOut: boolean }[]}
 */
export function accountChoices(accounts, current) {
  const list = Array.isArray(accounts) ? accounts : [];
  return list
    .filter((a) => a && typeof a.id === 'string' && a.id)
    .map((a) => {
      const label = String(a.label || a.id);
      return { id: a.id, label, current: Boolean(current) && (a.label === current || a.id === current), signedOut: a.state === 'out' };
    });
}

/**
 * The account id to send for a click, or null when nothing changes (unknown id, or already the project's account).
 * @param {{ id: string, current: boolean }[]} choices from accountChoices
 * @param {unknown} id
 * @returns {string | null}
 */
export function accountToSet(choices, id) {
  if (typeof id !== 'string') return null;
  const hit = choices.find((c) => c.id === id);
  return hit && !hit.current ? hit.id : null;
}

/** Is a picker worth showing? One account has nothing to choose between. */
export const pickerUseful = (/** @type {{ id: string }[]} */ choices) => choices.length > 1;
