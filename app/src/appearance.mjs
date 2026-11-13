// Appearance (contract v3.74): the app chrome's look and light/dark mode. Pure; shared by main and the renderer
// the way src/themes.mjs is.
//   look: 'pixel' (the 8-bit look, chrome colours from the office theme) | 'claude' (fixed warm neutral palette)
//   mode: 'system' | 'light' | 'dark'

/** @typedef {{ frame: string, accent: string, statusBg: string, statusText: string }} Chrome */

export const LOOKS = ['pixel', 'claude'];
export const MODES = ['system', 'light', 'dark'];
export const DEFAULT_LOOK = 'pixel';
export const DEFAULT_MODE = 'system';

/** @param {unknown} v @returns {string} */
export const normalizeLook = (v) => (typeof v === 'string' && LOOKS.includes(v) ? v : DEFAULT_LOOK);
/** @param {unknown} v @returns {string} */
export const normalizeMode = (v) => (typeof v === 'string' && MODES.includes(v) ? v : DEFAULT_MODE);
/** 'system' resolved with the OS setting. @param {unknown} mode @param {boolean} systemDark @returns {'light' | 'dark'} */
export function effectiveMode(mode, systemDark) {
  const m = normalizeMode(mode);
  return m === 'light' || (m === 'system' && !systemDark) ? 'light' : 'dark';
}

// ---- colour maths (sRGB hex) ----
/** @param {unknown} hex @returns {[number, number, number] | null} */
export function parseHex(hex) {
  const m = typeof hex === 'string' ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim()) : null;
  if (!m) return null;
  const s = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
/** @param {number[]} rgb */
const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
/** a moved toward b by t (0..1). @param {string} a @param {string} b @param {number} t */
export function mix(a, b, t) {
  const x = parseHex(a) || [0, 0, 0];
  const y = parseHex(b) || [0, 0, 0];
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}
/** WCAG relative luminance. @param {string} hex */
export function luminance(hex) {
  const [r, g, b] = (parseHex(hex) || [0, 0, 0]).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio (1..21). @param {string} a @param {string} b */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** c darkened step by step until it reaches `ratio` against every colour in `against`. */
function darkenTo(c, against, ratio) {
  let out = c;
  for (let i = 0; i < 40 && against.some((bg) => contrast(out, bg) < ratio); i++) out = mix(out, '#000000', 0.08);
  return out;
}

/** The 8-bit look's built-in chrome (the classic office theme; app.js DEFAULT_THEME). @type {Chrome} */
export const PIXEL_DEFAULT = { frame: '#2b1d1a', accent: '#3fb6a8', statusBg: '#231815', statusText: '#f3ead8' };

/**
 * The 8-bit look's light chrome, derived from an office theme's four frame colours: a paper-like background from
 * the theme's lightest colour, panels a step lighter, the darkest colour as ink (>= 7:1) and the theme accent
 * darkened until it reads as text on both (>= 4.5:1).
 * @param {Partial<Chrome>} [theme]
 * @returns {Chrome}
 */
export function pixelLightChrome(theme = {}) {
  /** @type {Chrome} */
  const t = { ...PIXEL_DEFAULT };
  for (const k of /** @type {(keyof Chrome)[]} */ (Object.keys(PIXEL_DEFAULT))) if (parseHex(theme[k])) t[k] = /** @type {string} */ (theme[k]);
  const byLight = [t.frame, t.statusBg, t.statusText].sort((a, b) => luminance(b) - luminance(a));
  const frame = mix(byLight[0], '#ffffff', 0.55);     // the page: tinted paper
  const statusBg = mix(byLight[0], '#ffffff', 0.88);  // sidebar, terminal, popups: nearly white
  return {
    frame,
    statusBg,
    statusText: darkenTo(byLight[2], [frame, statusBg], 7),
    accent: darkenTo(t.accent, [frame, statusBg], 4.5),
  };
}

/** The Claude look: fixed warm neutrals, the office theme does not reach them. */
export const CLAUDE = {
  light: { frame: '#FAF9F5', statusBg: '#F0EEE6', raised: '#FFFFFF', statusText: '#141413', muted: '#6B6A64', border: 'rgba(31,30,29,.15)', accent: '#D97757', accentText: '#A8502F', onAccent: '#141413' },
  dark: { frame: '#262624', statusBg: '#1F1E1D', raised: '#30302E', statusText: '#FAF9F5', muted: '#C2C0B6', border: 'rgba(222,220,209,.15)', accent: '#D97757', accentText: '#D97757', onAccent: '#141413' },
};

/**
 * The four frame colours of the chrome for a look and an effective mode.
 * @param {unknown} look @param {'light' | 'dark'} mode @param {Partial<Chrome>} [theme] the office theme (pixel look)
 * @returns {Chrome}
 */
export function chromeFor(look, mode, theme = {}) {
  if (normalizeLook(look) === 'claude') {
    const c = CLAUDE[mode === 'light' ? 'light' : 'dark'];
    return { frame: c.frame, accent: c.accent, statusBg: c.statusBg, statusText: c.statusText };
  }
  return mode === 'light' ? pixelLightChrome(theme) : { ...PIXEL_DEFAULT, ...theme };
}

/** BrowserWindow background before the page paints (no flash at start). @param {unknown} look @param {unknown} mode @param {boolean} systemDark */
export const windowBackground = (look, mode, systemDark) => chromeFor(look, effectiveMode(mode, systemDark)).frame;

/** Status colours of light mode (style.css `:root[data-mode="light"]`): dark enough to be text on a light surface. */
export const LIGHT_STATUS = {
  '--ok': '#2a7230', '--err': '#c62828', '--amber': '#8a5c00', '--approval': '#9a5b00', '--online': '#18753a',
  '--danger': '#c62828', '--bad': '#b3261e', '--hint-warn': '#8a5a00', '--rt-warn': '#8a4a06',
};

/** ANSI colours that read on a light terminal background (xterm's defaults assume dark). */
export const LIGHT_ANSI = {
  black: '#24292f', red: '#b91c28', green: '#116329', yellow: '#7d4e00', blue: '#0550ae', magenta: '#7340c9', cyan: '#136870', white: '#5c6570',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#166b2e', brightYellow: '#633c01', brightBlue: '#0a5cc2', brightMagenta: '#6639ba', brightCyan: '#0f6c7a', brightWhite: '#4b535d',
};

/**
 * xterm theme for the chrome: background, foreground, cursor and selection follow it; light mode adds LIGHT_ANSI.
 * @param {unknown} look @param {'light' | 'dark'} mode @param {Partial<Chrome>} [theme]
 */
export function terminalTheme(look, mode, theme = {}) {
  const c = chromeFor(look, mode, theme);
  // Claude light: the darker clay, the plain one is too faint for a cursor on the light surface
  const cursor = normalizeLook(look) === 'claude' && mode === 'light' ? CLAUDE.light.accentText : c.accent;
  const base = { background: c.statusBg, foreground: c.statusText, cursor, cursorAccent: c.statusBg, selectionBackground: c.accent + (mode === 'light' ? '40' : '66') };
  return mode === 'light' ? { ...base, ...LIGHT_ANSI } : base;
}
