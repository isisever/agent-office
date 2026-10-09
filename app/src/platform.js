// İşletim sistemi farkları (macOS / Linux): saf işlevler (Electron yok; node --test ile sınanır).
// macOS davranışı değişmez; Linux'ta karşılıkları kullanılır.

const isMac = (platform = process.platform) => platform === 'darwin';

// Proje ve giriş pty'lerinin kabuğu: $SHELL, yoksa macOS'ta zsh, Linux'ta bash.
const defaultShell = (env = process.env, platform = process.platform) =>
  env.SHELL || (isMac(platform) ? '/bin/zsh' : '/bin/bash');

// Linux dosya yöneticilerinin panoya koyduğu dosyalar: text/uri-list ya da GNOME/Nautilus'un
// x-special/gnome-copied-files biçimi ("copy" / "cut" satırı, ardından file:// adresleri).
// Yalnız yerel file:// adresleri yola çevrilir; diğer satırlar (yorum, http, eylem) atlanır.
function filesFromUriList(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('file://')) continue;
    try {
      const u = new URL(line);
      if (u.host && u.host !== 'localhost') continue;
      const p = decodeURIComponent(u.pathname);
      if (p.startsWith('/')) out.push(p);
    } catch {}
  }
  return out;
}

// Linux'ta panodan dosya okumak için denenecek komutlar (sırayla): Wayland'de wl-paste, X11'de xclip.
// Her biri { cmd, args } ve okunan biçim; ilk boş olmayan sonuç kullanılır.
function linuxClipboardCommands(env = process.env) {
  const types = ['x-special/gnome-copied-files', 'text/uri-list'];
  const wl = types.map((t) => ({ cmd: 'wl-paste', args: ['--no-newline', '--type', t] }));
  const x = types.map((t) => ({ cmd: 'xclip', args: ['-selection', 'clipboard', '-o', '-t', t] }));
  return env.WAYLAND_DISPLAY ? [...wl, ...x] : [...x, ...wl];
}

// Klavye kısayolları. macOS: ⌘ (metaKey). Linux: Ctrl+Shift, çünkü Ctrl+V, Ctrl+O, Ctrl+C gibi
// tuşlar terminalde Claude Code'a gider (ör. Ctrl+V görsel yapıştırır, Ctrl+O dökümü açar).
const shortcuts = (platform = process.platform) => (isMac(platform)
  ? { paste: 'CmdOrCtrl+V', copy: null, cut: null }               // null: rolün kendi kısayolu
  : { paste: 'Ctrl+Shift+V', copy: 'Ctrl+Shift+C', cut: 'Ctrl+Shift+X' });

module.exports = { isMac, defaultShell, filesFromUriList, linuxClipboardCommands, shortcuts };
