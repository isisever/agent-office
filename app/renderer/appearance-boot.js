// Appearance before the first paint (contract v3.74). A classic script in <head>: the page's CSP runs no inline
// script, and app.js (a module) starts only after its imports, then waits for the language. Without this a light
// mode user would see the dark 8-bit frame first. Reads what app.js cached in localStorage: `look`, `mode`
// ('system' is resolved with the OS scheme here too) and, for the 8-bit look, the four frame colours of that mode.
(() => {
  try {
    const root = document.documentElement;
    const look = localStorage.getItem('look') === 'claude' ? 'claude' : 'pixel';
    const stored = localStorage.getItem('mode');
    const mode = stored === 'light' || stored === 'dark' ? stored : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    root.dataset.look = look;
    root.dataset.mode = mode;
    root.style.colorScheme = mode;
    if (look !== 'pixel') return; // the Claude look's colours are in style.css
    const chrome = JSON.parse(localStorage.getItem('chrome') || 'null');
    if (!chrome || chrome.mode !== mode) return;
    for (const [name, key] of [['--frame', 'frame'], ['--accent', 'accent'], ['--status-bg', 'statusBg'], ['--status-text', 'statusText']]) {
      if (/^#[0-9a-f]{6}$/i.test(chrome[key])) root.style.setProperty(name, chrome[key]);
    }
  } catch { /* no storage: app.js applies the appearance a moment later */ }
})();
