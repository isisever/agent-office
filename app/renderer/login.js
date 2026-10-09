// Hesap girişi katmanı: uygulamanın üstünde ortalanmış panel, `login:<hesapId>` pty'sine bağlı xterm
// (main orada `claude auth login` çalıştırır). pty kapanınca hesap 'in' olursa kendiliğinden kapanır.
import { mountTerminal } from './terminal.js';
import { onLang, pick } from './i18n.js';

// Metinler (bkz. i18n.js): pick(S).anahtar, her kullanımda okunur.
const S = {
  en: {
    done: 'Done',
    exitCode: (c) => `Exit code ${c}`,
    loggedIn: 'logged in',
    notLoggedIn: ' · not logged in',
    starting: 'Starting login…',
    inProgress: 'Logging in…',
    failedToStart: (m) => `Could not start: ${m}`,
    close: 'Close (Esc)',
    hint: 'If a browser opens, approve there; if the terminal asks something, answer here.',
    retry: 'Try again',
    title: (label) => `Log in to ${label}`,
    checking: 'checking login…',
  },
  tr: {
    done: 'Tamamlandı',
    exitCode: (c) => `Çıkış kodu ${c}`,
    loggedIn: 'giriş yapıldı',
    notLoggedIn: ' · giriş yapılmadı',
    starting: 'Giriş başlatılıyor…',
    inProgress: 'Giriş sürüyor…',
    failedToStart: (m) => `Başlatılamadı: ${m}`,
    close: 'Kapat (Esc)',
    hint: 'Tarayıcı açılırsa orada onayla; terminal soru sorarsa burada yanıtla.',
    retry: 'Tekrar dene',
    title: (label) => `${label} hesabına giriş`,
    checking: 'giriş denetleniyor…',
  },
};
const t = () => pick(S);

const CLOSE_AFTER = 1500; // başarıdan sonra kapanma gecikmesi
const AUTH_WAIT = 6000; // kapanıştan sonra main'in giriş denetimini bekleme süresi

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

export function mountLogin(parent, { getTheme = () => ({}), onClose = () => {} } = {}) {
  let accounts = [];
  let cur = null; // { id, ptyId, root, title, label, x, hint, status, statusText, retry, term, exited, code, updated, timers }

  // text: metni üreten işlev (dil değişince yeniden çağrılır)
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

  /** pty kapandıktan sonra hesabın durumuna bak: 'in' → kapan, aksi halde "Tekrar dene". */
  function evaluate(force = false) {
    const c = cur;
    if (!c || !c.exited || c.closing || c.code == null) return;
    const auth = accounts.find((a) => a.id === c.id)?.auth;
    const code = c.code;
    const done = () => (code === 0 ? t().done : t().exitCode(code));
    if (auth?.state === 'in') {
      c.closing = true;
      clearTimers(c);
      c.retry.hidden = true;
      setStatus(() => `${done()} · ${auth.email || t().loggedIn}`, 'ok');
      c.timers.push(setTimeout(() => { if (cur === c) close(); }, CLOSE_AFTER));
      return;
    }
    if (!force && (!c.updated || auth?.state === 'checking')) return; // main'in denetimini bekle
    clearTimers(c);
    const why = () => (auth?.state === 'error' && auth.error ? ` · ${auth.error}` : t().notLoggedIn);
    setStatus(() => done() + why(), 'err');
    c.retry.hidden = false;
  }

  function start() {
    const c = cur;
    if (!c) return;
    clearTimers(c);
    Object.assign(c, { exited: false, code: null, updated: false, closing: false });
    c.retry.hidden = true;
    setStatus(() => t().starting);
    c.term.reset(); // ilk veriyle boyut yeniden bildirilir
    requestAnimationFrame(() => { c.term.fit(); c.term.focus(); });
    window.agentOffice.accounts.login(c.id).then(
      () => { if (cur === c && !c.exited) setStatus(() => t().inProgress); },
      (e) => {
        if (cur !== c) return;
        c.exited = true;
        setStatus(() => t().failedToStart(e?.message || e), 'err');
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
    x.title = t().close;
    x.addEventListener('click', () => close());
    head.append(title, x);
    const hintEl = h('p', 'lo-hint', t().hint);
    const host = h('div', 'term-host lo-term');
    const foot = h('div', 'lo-foot');
    const status = h('span', 'lo-status');
    const retry = h('button', 'lo-retry', t().retry);
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
    cur.title.textContent = t().title(label);
  }

  function close() {
    const c = cur;
    if (!c) return;
    cur = null;
    clearTimers(c);
    // Yarıda kapatılan giriş: pty'yi durdur (Ctrl+C), sonraki "Giriş yap" temiz başlasın.
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

  // dil değişince açık katmanın metinleri yenilenir
  onLang(() => {
    if (!cur) return;
    cur.x.title = t().close;
    cur.hint.textContent = t().hint;
    cur.retry.textContent = t().retry;
    cur.title.textContent = t().title(cur.label);
    cur.status.textContent = (cur.statusText && cur.statusText()) || '';
  });

  return {
    open,
    close,
    isOpen: () => !!cur,
    focus() { cur?.term.focus(); },
    /** pty verisi: yalnızca açık katmanın kimliğine gider, diğerleri atılır. */
    write(ptyId, d) { if (cur?.ptyId === ptyId) cur.term.write(d); },
    exit(ptyId, code) {
      const c = cur;
      if (!c || c.ptyId !== ptyId) return;
      c.term.exit();
      c.exited = true;
      c.code = Number.isFinite(code) ? code : 0;
      const n = c.code;
      setStatus(() => `${n === 0 ? t().done : t().exitCode(n)} · ${t().checking}`);
      c.timers.push(setTimeout(() => evaluate(true), AUTH_WAIT));
      evaluate();
    },
    setAccounts(list) {
      accounts = list || [];
      if (!cur) return;
      const a = accounts.find((x) => x.id === cur.id);
      if (!a) return close(); // hesap kaldırıldı
      setLabel(a.label);
      if (cur.exited) { cur.updated = true; evaluate(); }
    },
    setTheme(t) { cur?.term.setTheme(t); },
  };
}
