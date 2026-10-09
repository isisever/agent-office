// İşletim sistemi farkları (renderer): başlık çubuğu ve klavye kısayolları.
// Electron'da preload'un agentOffice.platform'u; düz tarayıcıda (dev-mock) ?platform=linux ile denenir.
// macOS: ⌘ kısayolları, başlık çubuğunda trafik ışıklarına yer. Linux: pencerenin normal çerçevesi ve
// Ctrl+Shift kısayolları (Ctrl+V, Ctrl+O, Ctrl+1… terminalde Claude Code'a gider).
const fromQuery = new URLSearchParams(location.search).get('platform');
export const platform = window.agentOffice?.platform || fromQuery || 'darwin';
export const isMac = platform === 'darwin';

// <html class="platform-darwin|platform-linux">: style.css başlık çubuğunu buna göre düzenler
document.documentElement.classList.add(`platform-${isMac ? 'darwin' : 'linux'}`);

/** Kısayol ipucu öneki: '⌘' (macOS) ya da 'Ctrl+Shift+' (Linux); ör. modLabel + 'O'. */
export const modLabel = isMac ? '⌘' : 'Ctrl+Shift+';

/** Uygulama kısayolu mu (⌘X / Ctrl+Shift+X)? Başka değiştirici tuş basılıysa değil. */
export const isModKey = (/** @type {KeyboardEvent} */ e) => (isMac
  ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
  : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey);

/**
 * Basılan harf ya da rakam, klavye düzeninden ve Shift'ten bağımsız ('o', '1'); yoksa e.key küçük harfle.
 * Linux'ta Ctrl+Shift+1'in e.key'i '!' olur, e.code 'Digit1' kalır.
 */
export function keyOf(/** @type {KeyboardEvent} */ e) {
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code || '');
  if (!isMac && m) return (m[1] || m[2]).toLowerCase();
  return (e.key || '').toLowerCase();
}
