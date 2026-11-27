// Voice input (contract v3.119): pure parts of the main side (no Electron; tested with node --test app/test/voice.test.cjs).
// Settings, the model table (pinned URLs and sha256), the WAV header for the PCM16 audio the renderer sends, the
// whisper-server arguments, the language choice and the microphone permission rule.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_RATE = 16000;
/** At most this much audio is kept for one recording (5 minutes of 16 kHz PCM16); the rest is dropped. */
const MAX_PCM_BYTES = SAMPLE_RATE * 2 * 300;
/** One chunk from the renderer is ~100 ms (3.2 KB); anything over 1 s of audio in one message is refused. */
const MAX_CHUNK_BYTES = SAMPLE_RATE * 2;
/** whisper-server is stopped after this long without a transcription. */
const IDLE_MS = 5 * 60 * 1000;

// The models, from the official whisper.cpp model repository at a pinned revision (sizes and sha256 from its LFS index).
const HF_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
const MODELS = {
  'large-v3-turbo-q5_0': { file: 'ggml-large-v3-turbo-q5_0.bin', size: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
  'small-q5_1': { file: 'ggml-small-q5_1.bin', size: 190085487, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' },
};
const modelUrl = (id) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/${HF_REVISION}/${MODELS[id].file}`;

const LANGUAGES = ['auto', 'tr', 'en'];
const SHORTCUTS = ['ctrl+space', 'alt+space', 'ctrl+shift+space', 'off'];
const DEFAULTS = { enabled: true, language: 'auto', model: 'large-v3-turbo-q5_0', sendAfter: false, shortcut: 'ctrl+space' };

/** The stored voice settings; anything unknown or missing is the default. */
function normalizeSettings(v) {
  const o = v && typeof v === 'object' ? v : {};
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULTS.enabled,
    language: LANGUAGES.includes(o.language) ? o.language : DEFAULTS.language,
    model: Object.hasOwn(MODELS, o.model) ? o.model : DEFAULTS.model,
    sendAfter: o.sendAfter === true,
    shortcut: SHORTCUTS.includes(o.shortcut) ? o.shortcut : DEFAULTS.shortcut,
  };
}

/** A 44-byte RIFF/WAVE header for `dataBytes` of mono PCM16 at `rate`. */
function wavHeader(dataBytes, rate = SAMPLE_RATE) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);        // fmt chunk size
  b.writeUInt16LE(1, 20);         // PCM
  b.writeUInt16LE(1, 22);         // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);  // byte rate
  b.writeUInt16LE(2, 32);         // block align
  b.writeUInt16LE(16, 34);        // bits per sample
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

/** The chunks of one recording as one WAV file in memory (an odd trailing byte is dropped). */
function toWav(chunks) {
  let pcm = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  if (pcm.length % 2) pcm = pcm.subarray(0, pcm.length - 1);
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}

/**
 * whisper-server's argument list (no shell). `host` is a unix socket path ending in `.sock` (macOS, Linux: whisper-server
 * binds AF_UNIX for such a host and ignores the port) or 127.0.0.1 with a port (Windows).
 */
function serverArgs({ modelPath, host = '127.0.0.1', port = 8080, threads }) {
  const sock = host.endsWith('.sock');
  if (!sock && host !== '127.0.0.1') throw new Error('host');
  if (sock && !path.isAbsolute(host)) throw new Error('host');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port');
  return ['-m', modelPath, '--host', host, '--port', String(port), '-t', String(Math.max(1, Math.min(8, threads | 0 || 4))), '-nt'];
}

/** A unix socket path must fit sockaddr_un (104 bytes on macOS, 108 on Linux; with room for the NUL). */
const SOCKET_PATH_MAX = 100;

/** Did whisper-server's output say it could not bind (the only start failure worth another try)? */
const bindFailed = (log) => /couldn't bind to (server|unix) socket/.test(String(log || ''));

/** A multipart/form-data body (fields, then one file) for http.request. */
function multipartBody(fields, file) {
  const boundary = `----agentoffice${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(Buffer.from(file.data));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** The language sent with the first request: the setting itself ('auto' lets whisper detect it). */
const requestLanguage = (setting) => (LANGUAGES.includes(setting) ? setting : 'auto');

/**
 * "Auto (tr/en)": whisper may detect a third language on a short or noisy clip. Then the clip is transcribed once more
 * as Turkish when the app speaks Turkish, else English. Returns that language, or null when no second pass is needed.
 */
function retryLanguage(setting, detected, uiLang) {
  if (setting !== 'auto' || !detected) return null;
  const d = String(detected).toLowerCase();
  if (d === 'tr' || d === 'turkish' || d === 'en' || d === 'english') return null;
  return uiLang === 'tr' ? 'tr' : 'en';
}

/** whisper-server's JSON answer → the text, trimmed, with blank-audio markers removed. */
function transcriptOf(json) {
  const text = typeof json?.text === 'string' ? json.text : '';
  return text.replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]|\((silence|music)\)/gi, '').replace(/\s+/g, ' ').trim();
}

/** The sha256 of a file, read as a stream. */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Is `file` the model `id`: the right size and sha256? */
async function modelOk(file, id) {
  const m = MODELS[id];
  if (!m) return false;
  try { if (fs.statSync(file).size !== m.size) return false; } catch { return false; }
  return (await sha256File(file)) === m.sha256;
}

/**
 * The microphone rule for the window's permission handler: `media` is allowed only for audio, only for the app's own
 * page (a file:// URL in the app's renderer folder). Other permissions are not this rule's business (null).
 */
function mediaDecision({ permission, mediaTypes, requestingUrl, rendererDir }) {
  if (permission !== 'media') return null;
  const types = Array.isArray(mediaTypes) ? mediaTypes : [];
  if (!types.length || types.some((t) => t !== 'audio')) return false;
  let file;
  try {
    const u = new URL(String(requestingUrl || ''));
    if (u.protocol !== 'file:') return false;
    file = decodeURIComponent(u.pathname);
  } catch { return false; }
  if (process.platform === 'win32' && /^\/[a-z]:/i.test(file)) file = file.slice(1);
  const rel = path.relative(path.resolve(rendererDir), path.resolve(file));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Where whisper-server is: Resources/whisper in the packaged app, app/vendor/whisper/<os>-<arch> otherwise. */
function binaryPath({ packaged, resourcesPath, appDir, platform, arch }) {
  const exe = platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
  const o = { darwin: 'mac', win32: 'win', linux: 'linux' }[platform] || platform;
  return packaged ? path.join(resourcesPath, 'whisper', exe) : path.join(appDir, 'vendor', 'whisper', `${o}-${arch}`, exe);
}

module.exports = {
  SAMPLE_RATE, MAX_PCM_BYTES, MAX_CHUNK_BYTES, IDLE_MS, HF_REVISION, MODELS, LANGUAGES, SHORTCUTS, DEFAULTS,
  modelUrl, normalizeSettings, wavHeader, toWav, serverArgs, SOCKET_PATH_MAX, bindFailed, multipartBody, requestLanguage, retryLanguage, transcriptOf,
  sha256File, modelOk, mediaDecision, binaryPath,
};
