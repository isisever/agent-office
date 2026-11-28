// Contract v3.164: a usage-limit error the session went on after is history, not a live failure (pure logic).
// An account fallback copies the transcript to the new account, so the stopped account's limit error stays in the
// chat above the carry-on prompt and the work that followed; shown as a red error it reads as "this account is full".

const LIMIT_TEXT = /^you(?:'|’)(?:ve|re) (?:hit|reached) your [a-z0-9' .-]{0,40}?limit\b|^usage limit reached\b/i;

/** Is this chat item one of Claude Code's usage-limit error bubbles? */
export function isLimitError(it) {
  return Boolean(it) && it.kind === 'error' && LIMIT_TEXT.test(String(it.text || '').trim());
}

/** Does this item show the session working after a stop (an answer or a tool call)? */
export function showsProgress(it) {
  return Boolean(it) && ((it.kind === 'assistant' && String(it.text || '').trim() !== '') || it.kind === 'tool');
}

/**
 * Reads one batch of items. open: the keys of limit errors with no progress after them yet (from earlier batches).
 * → { open: keys still without progress, superseded: keys of limit errors the session went on after }.
 */
export function limitFlow(open, items) {
  let pending = Array.isArray(open) ? [...open] : [];
  const superseded = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (isLimitError(it)) pending.push(String(it.key ?? ''));
    else if (showsProgress(it) && pending.length) { superseded.push(...pending); pending = []; }
  }
  return { open: pending, superseded };
}
