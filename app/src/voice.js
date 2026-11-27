// Voice input (contract v3.119): the main side. Keeps each recording's PCM16 chunks in memory (never on disk), downloads
/* global AbortSignal, FormData */
// the model on first use (sha256 checked), runs whisper.cpp's whisper-server on 127.0.0.1 at a free port (spawned
// without a shell, stopped after IDLE_MS without use) and turns a recording into text. Pure parts: src/voice-core.js.
'use strict';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const VC = require('./voice-core.js');

/** A free TCP port on 127.0.0.1 (the OS picks one). */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const port = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(port)); });
  });
}

/**
 * @param {{ userData: string, binary: string, emit: (payload: object) => void, uiLang: () => string, settings: () => ReturnType<typeof VC.normalizeSettings> }} o
 *   emit: progress to the renderer ('voice:progress'); binary: whisper-server's path
 */
function createVoice({ userData, binary, emit, uiLang, settings }) {
  const modelsDir = path.join(userData, 'voice', 'models');
  /** @type {Map<string, { chunks: Buffer[], bytes: number }>} */
  const recs = new Map();
  /** @type {{ proc: import('node:child_process').ChildProcess, port: number, model: string } | null} */
  let server = null;
  /** @type {Promise<any> | null} */
  let starting = null;
  /** @type {Map<string, Promise<string>>} */
  const downloads = new Map();
  let idleTimer = null;

  const modelPath = (id) => path.join(modelsDir, VC.MODELS[id].file);
  const hasBinary = () => { try { fs.accessSync(binary, fs.constants.X_OK); return true; } catch { return false; } };
  const modelPresent = (id) => { try { return fs.statSync(modelPath(id)).size === VC.MODELS[id].size; } catch { return false; } };

  function status() {
    const s = settings();
    return { enabled: s.enabled, binary: hasBinary(), models: Object.fromEntries(Object.keys(VC.MODELS).map((id) => [id, { present: modelPresent(id), size: VC.MODELS[id].size }])) };
  }

  /** Downloads the model (once at a time), checking size and sha256 before it takes its real name. */
  function ensureModel(id) {
    if (!VC.MODELS[id]) return Promise.reject(new Error('model'));
    if (modelPresent(id)) return Promise.resolve(modelPath(id));
    if (downloads.has(id)) return downloads.get(id);
    const p = (async () => {
      fs.mkdirSync(modelsDir, { recursive: true });
      const part = `${modelPath(id)}.part`;
      const m = VC.MODELS[id];
      const res = await fetch(VC.modelUrl(id), { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`download: HTTP ${res.status}`);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(part);
      let got = 0; let shown = -1;
      try {
        for await (const chunk of /** @type {any} */ (res.body)) {
          const b = Buffer.from(chunk);
          hash.update(b);
          got += b.length;
          if (!out.write(b)) await new Promise((r) => out.once('drain', () => r(undefined)));
          const pct = Math.floor((got / m.size) * 100);
          if (pct !== shown) { shown = pct; emit({ phase: 'download', model: id, got, total: m.size }); }
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
      if (got !== m.size || hash.digest('hex') !== m.sha256) { fs.rmSync(part, { force: true }); throw new Error('checksum'); }
      fs.renameSync(part, modelPath(id));
      emit({ phase: 'downloaded', model: id });
      return modelPath(id);
    })();
    downloads.set(id, p);
    p.finally(() => downloads.delete(id)).catch(() => {});
    return p;
  }

  function stopServer() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (server) { try { server.proc.kill(); } catch {} server = null; }
  }
  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stopServer, VC.IDLE_MS);
    idleTimer.unref?.();
  }

  async function ensureServer(id) {
    if (server && server.model === id && server.proc.exitCode === null) return server;
    if (starting) return starting;
    starting = (async () => {
      stopServer();
      const file = await ensureModel(id);
      if (!hasBinary()) throw new Error('no-binary');
      emit({ phase: 'starting' });
      const port = await freePort();
      const proc = spawn(binary, VC.serverArgs({ modelPath: file, port, threads: os.cpus().length - 1 }), { shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      proc.stderr?.on('data', (d) => { err = (err + d).slice(-2000); });
      const s = { proc, port, model: id };
      proc.on('exit', () => { if (server === s) server = null; });
      const deadline = Date.now() + 120000;   // the large model takes a while to load
      for (;;) {
        if (proc.exitCode !== null) throw new Error(`server exited: ${err.split('\n').slice(-3).join(' ')}`);
        try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); break; } catch {}
        if (Date.now() > deadline) { proc.kill(); throw new Error('server did not start'); }
        await new Promise((r) => setTimeout(r, 300));
      }
      server = s;
      return s;
    })();
    try { return await starting; } finally { starting = null; }
  }

  async function infer(s, wav, language) {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    form.append('language', language);
    const res = await fetch(`http://127.0.0.1:${s.port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`inference: HTTP ${res.status}`);
    return res.json();
  }

  return {
    status,
    ensureModel,
    begin() {
      const id = crypto.randomUUID();
      recs.set(id, { chunks: [], bytes: 0 });
      return id;
    },
    chunk(id, data) {
      const r = recs.get(id);
      if (!r || !(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) return;
      const b = Buffer.from(/** @type {any} */ (data));
      if (r.bytes + b.length > VC.MAX_PCM_BYTES) return;
      r.chunks.push(b);
      r.bytes += b.length;
    },
    cancel(id) { recs.delete(id); },
    /** Ends a recording and transcribes it; the audio is dropped whatever happens. */
    async finish(id) {
      const r = recs.get(id);
      recs.delete(id);
      if (!r) return { ok: false, error: 'unknown' };
      if (r.bytes < VC.SAMPLE_RATE * 2 * 0.3) return { ok: true, text: '' };   // under 0.3 s: nothing said
      const wav = VC.toWav(r.chunks);
      r.chunks.length = 0;
      const set = settings();
      try {
        const s = await ensureServer(set.model);
        emit({ phase: 'transcribing' });
        let json = await infer(s, wav, VC.requestLanguage(set.language));
        const again = VC.retryLanguage(set.language, json?.language || json?.detected_language, uiLang());
        if (again) json = await infer(s, wav, again);
        touch();
        return { ok: true, text: VC.transcriptOf(json) };
      } catch (e) {
        const msg = String(e?.message || e);
        return { ok: false, error: msg === 'no-binary' || msg === 'checksum' ? msg : 'failed', detail: msg };
      } finally {
        emit({ phase: 'idle' });
      }
    },
    stop: stopServer,
  };
}

module.exports = { createVoice, freePort };
