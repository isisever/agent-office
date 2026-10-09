// Gerçek claude CLI'ı için xterm.js terminali; her proje kendi terminalini ve pty'sini kullanır.
// Gelen pty verisini app.js yönlendirir (write/exit); yazma, boyut ve yeniden başlatma projeye özeldir.
import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';

const xtermTheme = (t = {}) => ({
  background: t.statusBg || '#231815',
  foreground: t.statusText || '#f3ead8',
  cursor: t.accent || '#3fb6a8',
  cursorAccent: t.statusBg || '#231815',
  selectionBackground: (t.accent || '#3fb6a8') + '66',
});

// restartable: false → pty kapanınca "Enter ile yeniden başlat" yok (giriş terminalleri, `login:<hesap>`).
export function mountTerminal(el, { projectId, theme, restartable = !String(projectId).startsWith('login:') } = {}) {
  const { pty } = window.agentOffice;
  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
    fontSize: 13,
    lineHeight: 1.1,
    cursorBlink: true,
    allowProposedApi: true,
    macOptionIsMeta: true,
    scrollback: 5000,
    theme: xtermTheme(theme),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  let dead = false;
  let needSize = false; // yeni pty ilk veriyi gönderince boyutu tekrar bildir
  let quietExit = false; // hesap değişimi: eski pty'nin kapanış mesajı gösterilmez
  const visible = () => el.getClientRects().length > 0 && el.clientWidth > 0 && el.clientHeight > 0;
  const resize = () => {
    if (!visible()) return; // gizli terminal: görünür olunca boyutlanır
    try { fit.fit(); } catch { return; }
    if (term.cols > 0 && term.rows > 0) pty.resize(projectId, term.cols, term.rows);
  };
  const ro = new ResizeObserver(() => requestAnimationFrame(resize));
  ro.observe(el);
  resize();
  document.fonts?.ready.then(resize);

  term.onData((d) => {
    if (!dead) return pty.write(projectId, d);
    if (restartable && d === '\r') { dead = false; term.reset(); pty.restart(projectId); needSize = true; resize(); }
  });

  // Panoda görsel varsa Ctrl+V gönder; Claude Code görseli panodan kendisi okur.
  el.addEventListener('paste', async (e) => {
    const types = [...(e.clipboardData?.types || [])];
    const sync = types.some((t) => t.startsWith('image/'));
    if (!sync && types.includes('text/plain')) return; // metin: xterm'in kendi (bracketed) yapıştırması
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!dead && (sync || await window.agentOffice.clipboard.hasImage())) pty.write(projectId, '\x16');
  }, true);

  // Dosya sürükle-bırak: yolları (boşluk içerenleri tırnaklı) terminale yaz.
  const quote = (p) => (/[\s'"\\$`!&;()<>|*?]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p);
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  el.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; el.classList.add('drop'); } });
  el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('drop'); } });
  el.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  el.addEventListener('drop', (e) => {
    depth = 0;
    el.classList.remove('drop');
    if (!hasFiles(e)) return;
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => window.agentOffice.pathForFile(f)).filter(Boolean);
    if (paths.length && !dead) pty.write(projectId, paths.map(quote).join(' ') + ' ');
    term.focus();
  });

  return {
    /** pty'den gelen veri (gizliyken de yazılır, geçmiş korunur). */
    write(d) {
      dead = false;
      quietExit = false;
      if (needSize) { needSize = false; resize(); }
      term.write(d);
    },
    /** pty kapandı: Enter ile yeniden başlatılır (restartable değilse sessizce durur). */
    exit() {
      dead = true;
      if (!restartable || quietExit) { quietExit = false; return; }
      term.write('\r\n\x1b[2m— Claude kapandı — yeniden başlatmak için Enter —\x1b[0m\r\n');
    },
    setTheme(t) { term.options.theme = xtermTheme(t); },
    focus() { term.focus(); },
    fit: resize,
    /** Terminali temizler; restarting: pty main tarafından yeniden başlatılıyor. */
    reset({ restarting = false } = {}) { dead = false; quietExit = restarting; term.reset(); needSize = true; resize(); },
    destroy() { ro.disconnect(); term.dispose(); },
  };
}
