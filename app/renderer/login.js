// Account login overlay: a panel centered over the app, with an xterm attached to the `login:<accountId>` pty
// (main runs `claude auth login` there). Closes itself if the account is 'in' when the pty exits.
import { mountTerminal } from './terminal.js';
import { onLang, t } from './i18n.js';

// Strings live in locales/*.json (under "login"), read on every use: t('login.key').

const CLOSE_AFTER = 1500; // close delay after success
const AUTH_WAIT = 6000; // how long to wait for main's login check after exit

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

export function mountLogin(parent, { getTheme = () => ({}), onClose = () => {} } = {}) {
  let accounts = [];
  let cur = null; // { id, ptyId, root, title, label, x, hint, status, statusText, retry, term, exited, code, updated, timers }

  // text: function that produces the text (called again when the language changes)
  function setStatus(text, kind = '') {
    if (!cur) return;
    cur.statusText = text;
    cur.status.textContent = (text && text()) || '';
    cur.status.className = 'lo-status' + (kind ? ' ' + kind : '');
  }

  function clearTimers(c) {
    for (const id of c.timers) clearTimeout(id);
    c.timers = [];
  }

  /** After the pty exits, check the account's state: 'in' → close, otherwise "Tekrar dene". */
  function evaluate(force = false) {
    const c = cur;
    if (!c || !c.exited || c.closing || c.code == null) return;
    const auth = accounts.find((a) => a.id === c.id)?.auth;
    const code = c.code;
    const done = () => (code === 0 ? t('login.done') : t('login.exitCode', { code }));
    if (auth?.state === 'in') {
      c.closing = true;
      clearTimers(c);
      c.retry.hidden = true;
      setStatus(() => `${done()} · ${auth.email || t('login.loggedIn')}`, 'ok');
      c.timers.push(setTimeout(() => { if (cur === c) close(); }, CLOSE_AFTER));
      return;
    }
    if (!force && (!c.updated || auth?.state === 'checking')) return; // wait for main's check
    clearTimers(c);
    const why = () => (auth?.state === 'error' && auth.error ? ` · ${auth.error}` : t('login.notLoggedIn'));
    setStatus(() => done() + why(), 'err');
    c.retry.hidden = false;
  }

  function start() {
    const c = cur;
    if (!c) return;
    clearTimers(c);
    Object.assign(c, { exited: false, code: null, updated: false, closing: false });
    c.retry.hidden = true;
    setStatus(() => t('login.starting'));
    c.term.reset(); // size is reported again with the first data
    requestAnimationFrame(() => { c.term.fit(); c.term.focus(); });
    window.agentOffice.accounts.login(c.id).then(
      () => { if (cur === c && !c.exited) setStatus(() => t('login.inProgress')); },
      (e) => {
        if (cur !== c) return;
        c.exited = true;
        setStatus(() => t('login.failedToStart', { error: e?.message || e }), 'err');
        c.retry.hidden = false;
      },
    );
  }

  function open(account) {
    if (!account) return;
    if (cur?.id === account.id) return cur.term.focus();
    close();
    const root = h('div', 'login-overlay');
    root.id = 'login-overlay';
    const panel = h('div', 'lo-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const head = h('div', 'lo-head');
    const title = h('span', 'lo-title');
    const x = h('button', 'lo-x', '×');
    x.title = t('login.close');
    x.addEventListener('click', () => close());
    head.append(title, x);
    const hintEl = h('p', 'lo-hint', t('login.hint'));
    const host = h('div', 'term-host lo-term');
    const foot = h('div', 'lo-foot');
    const status = h('span', 'lo-status');
    const retry = h('button', 'lo-retry', t('login.retry'));
    retry.hidden = true;
    retry.addEventListener('click', () => start());
    foot.append(status, retry);
    panel.append(head, hintEl, host, foot);
    root.append(panel);
    parent.append(root);

    const ptyId = `login:${account.id}`;
    const term = mountTerminal(host, { projectId: ptyId, theme: getTheme(), restartable: false });
    cur = { id: account.id, ptyId, root, title, x, hint: hintEl, status, retry, term, timers: [] };
    setLabel(account.label);
    start();
  }

  function setLabel(label) {
    if (!cur) return;
    cur.label = label;
    cur.title.textContent = t('login.title', { label });
  }

  function close() {
    const c = cur;
    if (!c) return;
    cur = null;
    clearTimers(c);
    // Login closed midway: stop the pty (Ctrl+C) so the next "Giriş yap" starts clean.
    if (!c.exited) { try { window.agentOffice.pty.write(c.ptyId, '\x03'); } catch {} }
    c.term.destroy();
    c.root.remove();
    onClose();
  }

  window.addEventListener('keydown', (e) => {
    if (!cur || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }, true);

  // the open overlay's strings are refreshed when the language changes
  onLang(() => {
    if (!cur) return;
    cur.x.title = t('login.close');
    cur.hint.textContent = t('login.hint');
    cur.retry.textContent = t('login.retry');
    cur.title.textContent = t('login.title', { label: cur.label });
    cur.status.textContent = (cur.statusText && cur.statusText()) || '';
  });

  return {
    open,
    close,
    isOpen: () => !!cur,
    focus() { cur?.term.focus(); },
    /** pty data: only the open overlay's id gets through, the rest is dropped. */
    write(ptyId, d) { if (cur?.ptyId === ptyId) cur.term.write(d); },
    exit(ptyId, code) {
      const c = cur;
      if (!c || c.ptyId !== ptyId) return;
      c.term.exit();
      c.exited = true;
      c.code = Number.isFinite(code) ? code : 0;
      const n = c.code;
      setStatus(() => `${n === 0 ? t('login.done') : t('login.exitCode', { code: n })} · ${t('login.checking')}`);
      c.timers.push(setTimeout(() => evaluate(true), AUTH_WAIT));
      evaluate();
    },
    setAccounts(list) {
      accounts = list || [];
      if (!cur) return;
      const a = accounts.find((x) => x.id === cur.id);
      if (!a) return close(); // account was removed
      setLabel(a.label);
      if (cur.exited) { cur.updated = true; evaluate(); }
    },
    setTheme(t) { cur?.term.setTheme(t); },
  };
}
