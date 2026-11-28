// v3.165 the account-switch notice shown in a Studio/GUI chat (the terminal hint is hidden there).
/**
 * An account:fallback event → { key, params } for the chat.accountFallback.* strings, or null when there is nothing to say.
 * switched: "<from> limit -> continuing on <to>"; stuck: no backup account is usable; returned: back on the home account.
 */
// Marks a translation key so the locale-usage test (test/locales.test.mjs) sees it.
const T = (key) => key;

export function fallbackNote(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const from = ev.fromName || '';
  const to = ev.toName || '';
  if (ev.kind === 'switched' && to) return { key: T('chat.accountFallback.switched'), params: { from, to } };
  if (ev.kind === 'returned' && to) return { key: T('chat.accountFallback.returned'), params: { to } };
  if (ev.kind === 'stuck') {
    const key = ev.reason === 'none' ? T('chat.accountFallback.none') : ev.reason === 'notLoggedIn' ? T('chat.accountFallback.notLoggedIn') : ev.reason === 'allLimited' ? T('chat.accountFallback.allLimited') : T('chat.accountFallback.stuck');
    return { key, params: { from } };
  }
  return null;
}

/** True when the event ends a "no switch" state (the chat resumed or the limit reset): the strip goes away. */
export function clearsFallback(ev) {
  return Boolean(ev) && typeof ev === 'object' && (ev.kind === 'resumed' || ev.kind === 'cleared');
}
