// Chat view (v3.80) and Studio (v3.120): whether a tab's pane shows its chat and whether the Chat button is offered
// over its terminal. Pure so it can be tested; renderer/app.js gives it the tab's facts.
//
// isGui is main's status for the tab: its claude runs as a GUI chat, or (stopped) would start as one. A GUI chat has
// no terminal of its own, so such a tab always shows its chat, in either experience: otherwise the pane would be an
// empty terminal where keys go nowhere.

/**
 * @typedef {{ chatView: boolean, studio: boolean, win?: boolean, isGui: boolean, chatOff: boolean, hq?: boolean }} ChatFacts
 * chatView: the chat view setting; studio: Studio is on; win: Windows (unused since v3.161); chatOff: the person
 * switched this tab to its terminal from the chat.
 */

/** Is the tab in chat mode (its chat shown unless the person switched it to its terminal)? @param {ChatFacts} f */
export function chatShownFor({ chatView, studio, isGui }) {
  // v3.161 Studio always opens in the chat view, on every platform (Windows included): the terminal shows only after the
  // person switches to it (chatOff). `win` and `hq` no longer decide it.
  return chatView || isGui || studio;   // HQ's chat is the view of its transcript (v3.80)
}

/**
 * Is the Chat button offered over the tab's terminal? With the chat view (or a tab switched from its chat) when the
 * person switched it to the terminal; in Studio also over any Claude Code tab running in a terminal (it moves only on
 * that click). HQ switches the view only, so in Studio it gets the button only when switched from its chat.
 * @param {ChatFacts & { capable: boolean, hq: boolean }} f
 */
export function chatButtonFor(f) {
  if (!f.capable) return false;
  if (chatShownFor(f) && f.chatOff) return true;
  return f.studio && !f.isGui && !f.hq;
}
