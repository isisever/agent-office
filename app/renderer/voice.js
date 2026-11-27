// Voice input (contract v3.119): push-to-talk in the window. A mic button next to a composer (chat input, HQ command
/* global HTMLTextAreaElement, AudioContext, AudioWorkletNode */
// box) and a held talk key (default Ctrl+Space, Esc cancels). The microphone goes through an AudioWorklet
// (voice-worklet.js) to 16 kHz PCM16 chunks for main (agentOffice.voice); the transcript goes into the text field that
// had focus, never into a terminal's pty, and is sent only when "Send after speaking" is on.
import { t, onLang } from './i18n.js';
import { matchShortcut, spliceText } from '../src/voice-input.mjs';

const api = () => window.agentOffice?.voice || null;
/** @type {{ enabled: boolean, language: string, model: string, sendAfter: boolean, shortcut: string, status?: any }} */
let settings = { enabled: true, language: 'auto', model: 'large-v3-turbo-q5_0', sendAfter: false, shortcut: 'ctrl+space' };
/** @type {WeakMap<HTMLElement, () => void>} a composer's own send */
const composers = new WeakMap();
/** 'idle' | 'starting' | 'rec' | 'busy' */
let phase = 'idle';
/** @type {{ id: string, target: HTMLElement | null, stream: MediaStream, ctx: AudioContext, byKey: boolean } | null} */
let rec = null;
let stopWanted = false;
let cancelWanted = false;
const buttons = new Set();
let hud = null;
let hudText = null;
let hudCopy = null;
let hudTimer = null;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  el.append(...kids.filter((x) => x !== null && x !== undefined));
  return el;
}

/** A field a transcript may go into: a textarea or a text input, enabled, not the terminal's own key catcher. */
function isTextField(el) {
  if (!(el instanceof HTMLElement) || el.classList.contains('xterm-helper-textarea')) return false;
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLInputElement) return ['text', 'search', ''].includes(el.type) && !el.disabled && !el.readOnly;
  return false;
}

function showHud(text, { copy = '', ms = 0 } = {}) {
  if (!hud) {
    hudText = h('span', {});
    hudCopy = h('button', { class: 'sb-btn', type: 'button', onclick: () => { navigator.clipboard?.writeText(hudCopy.dataset.text || '').catch(() => {}); hideHud(); } });
    hud = h('div', { id: 'voice-hud', role: 'status' }, hudText, hudCopy);
    document.body.append(hud);
  }
  clearTimeout(hudTimer);
  hudText.textContent = text;
  hudCopy.hidden = !copy;
  hudCopy.dataset.text = copy;
  hudCopy.textContent = t('voice.copy');
  hud.hidden = false;
  if (ms) hudTimer = setTimeout(hideHud, ms);
}
function hideHud() { if (hud) hud.hidden = true; }

function setPhase(p) {
  phase = p;
  document.body.classList.toggle('voice-recording', p === 'rec');
  for (const b of buttons) {
    if (!b.isConnected) { buttons.delete(b); continue; }
    b.classList.toggle('on', p === 'rec');
    b.classList.toggle('busy', p === 'busy' || p === 'starting');
  }
}

function teardown() {
  if (!rec) return;
  for (const tr of rec.stream.getTracks()) tr.stop();
  rec.ctx.close().catch(() => {});
}

/** Starts a recording for `target` (the field the transcript goes into; null = none, shown in the HUD). */
async function start(target, byKey) {
  const v = api();
  if (!v || phase !== 'idle' || !settings.enabled) return;
  setPhase('starting');
  stopWanted = false; cancelWanted = false;
  const r = await v.start().catch(() => ({ ok: false, error: 'failed' }));
  if (!r?.ok) { setPhase('idle'); showHud(t(`voice.err.${r?.error || 'failed'}`), { ms: 6000 }); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(new URL('./voice-worklet.js', import.meta.url).href);
    const node = new AudioWorkletNode(ctx, 'voice-capture');
    node.port.onmessage = (e) => { if (rec?.id === r.id) v.chunk(r.id, e.data); };
    const mute = ctx.createGain();
    mute.gain.value = 0;   // the worklet must be pulled by the graph; nothing is heard
    ctx.createMediaStreamSource(stream).connect(node);
    node.connect(mute).connect(ctx.destination);
    rec = { id: r.id, target, stream, ctx, byKey };
  } catch (e) {
    console.error(e);
    v.cancel(r.id);
    setPhase('idle');
    showHud(t('voice.err.mic'), { ms: 6000 });
    return;
  }
  setPhase('rec');
  showHud(t(byKey ? 'voice.listeningKey' : 'voice.listening'));
  if (cancelWanted) cancel(); else if (stopWanted) stop();
}

function cancel() {
  if (phase === 'starting') { cancelWanted = true; return; }
  if (phase !== 'rec' || !rec) return;
  teardown();
  api()?.cancel(rec.id);
  rec = null;
  setPhase('idle');
  showHud(t('voice.cancelled'), { ms: 1500 });
}

async function stop() {
  if (phase === 'starting') { stopWanted = true; return; }
  if (phase !== 'rec' || !rec) return;
  const { id, target } = rec;
  teardown();
  rec = null;
  setPhase('busy');
  showHud(t('voice.transcribing'));
  const r = await api().stop(id).catch(() => ({ ok: false, error: 'failed' }));
  setPhase('idle');
  if (!r?.ok) { showHud(t(`voice.err.${r?.error || 'failed'}`), { ms: 8000 }); return; }
  if (!r.text) { showHud(t('voice.nothing'), { ms: 2500 }); return; }
  if (target && target.isConnected && isTextField(target)) {
    insert(/** @type {HTMLInputElement | HTMLTextAreaElement} */ (target), r.text);
    hideHud();
  } else {
    showHud(t('voice.noTarget', { text: r.text }), { copy: r.text, ms: 20000 });
  }
}

function insert(el, text) {
  const { value, caret } = spliceText(el.value, el.selectionStart, el.selectionEnd, text);
  el.value = value;
  el.focus();
  try { el.setSelectionRange(caret, caret); } catch {}
  el.dispatchEvent(new Event('input', { bubbles: true }));
  if (!settings.sendAfter) return;
  const send = composers.get(el);
  if (send) send();
  else el.form?.requestSubmit();
}

/** Registers a composer's own send, used when "Send after speaking" is on. */
export function registerComposer(input, send) { composers.set(input, send); }

/** A mic button for `input`: hold to talk, or click to start and click again to stop. Null without the bridge. */
export function micButton(input, send) {
  if (!api()) return null;
  if (send) registerComposer(input, send);
  let downAt = 0;
  const b = h('button', { class: 'chat-attach voice-mic', type: 'button', title: t('voice.mic'), 'aria-label': t('voice.mic'),
    onmousedown: (e) => e.preventDefault(),   // the field keeps focus and its selection
    onpointerdown: () => {
      if (phase === 'rec' || phase === 'starting') { stop(); downAt = 0; return; }
      downAt = Date.now();
      start(input, false);
    },
    onpointerup: () => { if (downAt && Date.now() - downAt > 350) stop(); downAt = 0; },
  }, '🎙');
  b.hidden = !settings.enabled;
  buttons.add(b);
  return b;
}

function applySettings(s) {
  if (!s || typeof s !== 'object') return;
  settings = { ...settings, ...s };
  for (const b of buttons) b.hidden = !settings.enabled;
  renderRows();
}

/** Wires the talk key, progress and settings; once at startup (renderer/app.js). */
export function initVoice() {
  const v = api();
  if (!v) return;
  v.settings().then(applySettings).catch(() => {});
  v.onProgress((p) => {
    if (p?.phase === 'download') showHud(t('voice.downloading', { pct: Math.floor((p.got / p.total) * 100) }));
    else if (p?.phase === 'starting') showHud(t('voice.starting'));
    else if (p?.phase === 'transcribing') showHud(t('voice.transcribing'));
    else if (p?.phase === 'downloaded') { v.settings().then(applySettings).catch(() => {}); }
    renderModelStatus(p);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (phase === 'rec' || phase === 'starting')) { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    if (!settings.enabled || !matchShortcut(settings.shortcut, e)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.repeat || phase !== 'idle') return;
    const el = document.activeElement;
    start(isTextField(el) ? /** @type {HTMLElement} */ (el) : null, true);
  }, true);
  window.addEventListener('keyup', (e) => {
    if (phase !== 'rec' && phase !== 'starting') return;
    if (!(rec?.byKey ?? true)) return;
    if (e.code === 'Space' || ['Control', 'Alt', 'Shift'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); stop(); }
  }, true);
  window.addEventListener('blur', () => { if (rec?.byKey) stop(); });
  onLang(() => { for (const b of buttons) b.title = t('voice.mic'); renderRows(); });
}

// --- the rows in the Settings popup (renderer/sidebar.js)
const MODELS = ['large-v3-turbo-q5_0', 'small-q5_1'];
const LANGS = ['auto', 'tr', 'en'];
const SHORTCUTS = ['ctrl+space', 'alt+space', 'ctrl+shift+space', 'off'];
let rows = null;

function save(p) { api()?.setSettings(p).then(applySettings).catch((e) => console.error(e)); }

function renderModelStatus(p) {
  if (!rows) return;
  if (p?.phase === 'download' && p.model === settings.model) {
    rows.modelState.textContent = t('voice.downloading', { pct: Math.floor((p.got / p.total) * 100) });
    rows.download.hidden = true;
    return;
  }
  const st = settings.status?.models?.[settings.model];
  rows.modelState.textContent = !settings.status?.binary ? t('voice.err.no-binary') : st?.present ? t('voice.settings.modelReady') : t('voice.settings.modelMissing', { mb: Math.round((st?.size || 0) / 1e6) });
  rows.download.hidden = Boolean(st?.present) || !settings.status?.binary;
}

function renderRows() {
  if (!rows) return;
  rows.enabledLabel.textContent = t('voice.settings.enabled');
  rows.enabledRow.title = t('voice.settings.enabledTitle');
  rows.enabled.checked = settings.enabled;
  rows.langLabel.textContent = t('voice.settings.language');
  rows.lang.replaceChildren(...LANGS.map((v) => h('option', { value: v, selected: v === settings.language }, t(`voice.lang.${v}`))));
  rows.modelLabel.textContent = t('voice.settings.model');
  rows.model.replaceChildren(...MODELS.map((v) => h('option', { value: v, selected: v === settings.model }, t(`voice.model.${v}`))));
  rows.download.textContent = t('voice.settings.download');
  rows.sendLabel.textContent = t('voice.settings.sendAfter');
  rows.sendRow.title = t('voice.settings.sendAfterTitle');
  rows.send.checked = settings.sendAfter;
  rows.keyLabel.textContent = t('voice.settings.shortcut');
  rows.keyRow.title = t('voice.settings.shortcutTitle');
  rows.key.replaceChildren(...SHORTCUTS.map((v) => h('option', { value: v, selected: v === settings.shortcut }, t(`voice.key.${v.replace(/\+/g, '-')}`))));
  renderModelStatus(null);
}

/** The voice rows for the Settings popup (built once, kept up to date). */
export function voiceSettingsRows() {
  if (!api()) return [];
  if (!rows) {
    const enabledLabel = h('span', {});
    const enabled = h('input', { type: 'checkbox', class: 'sb-check', onchange: (e) => save({ enabled: e.target.checked }) });
    const langLabel = h('span', {});
    const lang = h('select', { class: 'sb-acct sb-lang', onchange: (e) => save({ language: e.target.value }) });
    const modelLabel = h('span', {});
    const model = h('select', { class: 'sb-acct sb-lang', onchange: (e) => save({ model: e.target.value }) });
    const modelState = h('span', { class: 'dim voice-model-state' });
    const download = h('button', { class: 'sb-btn', type: 'button', onclick: () => {
      download.disabled = true;
      api().downloadModel(settings.model).then((r) => { if (!r?.ok) modelState.textContent = t(`voice.err.${r?.error || 'failed'}`); })
        .finally(() => { download.disabled = false; api().settings().then(applySettings).catch(() => {}); });
    } });
    const sendLabel = h('span', {});
    const send = h('input', { type: 'checkbox', class: 'sb-check', onchange: (e) => save({ sendAfter: e.target.checked }) });
    const keyLabel = h('span', {});
    const key = h('select', { class: 'sb-acct sb-lang', onchange: (e) => save({ shortcut: e.target.value }) });
    rows = {
      enabledLabel, enabled, langLabel, lang, modelLabel, model, modelState, download, sendLabel, send, keyLabel, key,
      enabledRow: h('label', { class: 'sb-botcolor sb-langrow' }, enabledLabel, enabled),
      langRow: h('div', { class: 'sb-botcolor sb-langrow' }, langLabel, lang),
      modelRow: h('div', { class: 'sb-botcolor sb-langrow' }, modelLabel, model),
      modelStateRow: h('div', { class: 'sb-botcolor sb-langrow' }, modelState, download),
      sendRow: h('label', { class: 'sb-botcolor sb-langrow' }, sendLabel, send),
      keyRow: h('div', { class: 'sb-botcolor sb-langrow' }, keyLabel, key),
    };
  }
  api().settings().then(applySettings).catch(() => {});
  renderRows();
  return [rows.enabledRow, rows.langRow, rows.modelRow, rows.modelStateRow, rows.sendRow, rows.keyRow];
}
