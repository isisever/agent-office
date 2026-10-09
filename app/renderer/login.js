// Hesap girişi katmanı: uygulamanın üstünde ortalanmış panel, `login:<hesapId>` pty'sine bağlı xterm
// (main orada `claude auth login` çalıştırır). pty kapanınca hesap 'in' olursa kendiliğinden kapanır.
import { mountTerminal } from './terminal.js';

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
  let cur = null; // { id, ptyId, root, title, status, retry, term, exited, code, updated, timers }

  function setStatus(text, kind = '') {
    if (!cur) return;
    cur.status.textContent = text || '';
    cur.status.className = 'lo-status' + (kind ? ' ' + kind : '');
  }

  function clearTimers(c) {
    for (const t of c.timers) clearTimeout(t);
    c.timers = [];
  }

  /** pty kapandıktan sonra hesabın durumuna bak: 'in' → kapan, aksi halde "Tekrar dene". */
  function evaluate(force = false) {
    const c = cur;
    if (!c || !c.exited || c.closing || c.code == null) return;
    const auth = accounts.find((a) => a.id === c.id)?.auth;
    const done = c.code === 0 ? 'Tamamlandı' : `Çıkış kodu ${c.code}`;
    if (auth?.state === 'in') {
      c.closing = true;
      clearTimers(c);
      c.retry.hidden = true;
      setStatus(`${done} · ${auth.email || 'giriş yapıldı'}`, 'ok');
      c.timers.push(setTimeout(() => { if (cur === c) close(); }, CLOSE_AFTER));
      return;
    }
    if (!force && (!c.updated || auth?.state === 'checking')) return; // main'in denetimini bekle
    clearTimers(c);
    const why = auth?.state === 'error' && auth.error ? ` · ${auth.error}` : ' · giriş yapılmadı';
    setStatus(done + why, 'err');
    c.retry.hidden = false;
  }

  function start() {
    const c = cur;
    if (!c) return;
    clearTimers(c);
    Object.assign(c, { exited: false, code: null, updated: false, closing: false });
    c.retry.hidden = true;
    setStatus('Giriş başlatılıyor…');
    c.term.reset(); // ilk veriyle boyut yeniden bildirilir
    requestAnimationFrame(() => { c.term.fit(); c.term.focus(); });
    window.agentOffice.accounts.login(c.id).then(
      () => { if (cur === c && !c.exited) setStatus('Giriş sürüyor…'); },
      (e) => {
        if (cur !== c) return;
        c.exited = true;
        setStatus(`Başlatılamadı: ${e?.message || e}`, 'err');
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
    x.title = 'Kapat (Esc)';
    x.addEventListener('click', () => close());
    head.append(title, x);
    const hintEl = h('p', 'lo-hint', 'Tarayıcı açılırsa orada onayla; terminal soru sorarsa burada yanıtla.');
    const host = h('div', 'term-host lo-term');
    const foot = h('div', 'lo-foot');
    const status = h('span', 'lo-status');
    const retry = h('button', 'lo-retry', 'Tekrar dene');
    retry.hidden = true;
    retry.addEventListener('click', () => start());
    foot.append(status, retry);
    panel.append(head, hintEl, host, foot);
    root.append(panel);
    parent.append(root);

    const ptyId = `login:${account.id}`;
    const term = mountTerminal(host, { projectId: ptyId, theme: getTheme(), restartable: false });
    cur = { id: account.id, ptyId, root, title, status, retry, term, timers: [] };
    setLabel(account.label);
    start();
  }

  function setLabel(label) {
    if (cur) cur.title.textContent = `${label} hesabına giriş`;
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
      setStatus(c.code === 0 ? 'Tamamlandı · giriş denetleniyor…' : `Çıkış kodu ${c.code} · giriş denetleniyor…`);
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
