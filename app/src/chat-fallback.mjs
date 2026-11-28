// v3.165 the account-switch notice shown in a Studio/GUI chat (the terminal hint is hidden there).
/**
 * An account:fallback event → { key, params } for the chat.accountFallback.* strings, or null when there is nothing to say.
 * switched: "<from> limit -> continuing on <to>"; stuck: no backup account is usable; returned: back on the home account.
 */
export function fallbackNote(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const from = ev.fromName || '';
  const to = ev.toName || '';
  if (ev.kind === 'switched' && to) return { key: 'chat.accountFallback.switched', params: { from, to } };
  if (ev.kind === 'returned' && to) return { key: 'chat.accountFallback.returned', params: { to } };
  if (ev.kind === 'stuck') {
    const key = ev.reason === 'none' ? 'chat.accountFallback.none' : ev.reason === 'notLoggedIn' ? 'chat.accountFallback.notLoggedIn' : ev.reason === 'allLimited' ? 'chat.accountFallback.allLimited' : 'chat.accountFallback.stuck';
    return { key, params: { from } };
  }
  return null;
}
