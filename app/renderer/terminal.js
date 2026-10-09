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

// Açık terminaller: menüdeki Yapıştır (⌘V) odaktaki terminale gider (pasteIntoFocused).
const terminals = new Set();
// ⌘V üç yoldan gelebilir (terminalde keydown, Chromium'un paste olayı, menü); aynı basış bir kez yapıştırılır.
let lastPaste = 0;
const once = () => { const now = Date.now(); if (now - lastPaste < 400) return false; lastPaste = now; return true; };

/** ⌘V: odak bir terminaldeyse panoyu ona yapıştırır ve true döner; değilse false (normal yapıştırma). */
export async function pasteIntoFocused() {
  const t = [...terminals].find((x) => x.el.contains(document.activeElement));
  if (!t) return false;
  if (once()) await t.paste();
  return true;
}

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

  // Panodaki içeriğe göre: görsel → Ctrl+V (Claude Code görseli panodan kendisi okur), Finder'dan
  // kopyalanmış dosyalar → tırnaklı yollar, metin → xterm'in (bracketed) yapıştırması.
  async function paste() {
    if (dead) return;
    let clip = null;
    try { clip = await window.agentOffice.clipboard.read(); } catch { return; }
    if (clip.files?.length) pty.write(projectId, clip.files.map(quote).join(' ') + ' ');
    else if (clip.hasImage) pty.write(projectId, '\x16');
    else if (clip.text) term.paste(clip.text);
    term.focus();
  }

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

  // ⌘V terminaldeyken burada yakalanır: Chromium'un kendi yapıştırması görsel/dosya için boş metin gönderirdi.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.metaKey || ev.ctrlKey || ev.altKey || ev.key.toLowerCase() !== 'v') return true;
    ev.preventDefault();
    if (once()) paste();
    return false;
  });
  el.addEventListener('paste', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (once()) paste();
  }, true);

  const self = { el, paste };
  terminals.add(self);

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
    destroy() { terminals.delete(self); ro.disconnect(); term.dispose(); },
  };
}
