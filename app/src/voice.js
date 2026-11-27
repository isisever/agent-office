// Voice input (contract v3.119): the main side. Keeps the one active recording's PCM16 chunks in memory (never on
// disk), downloads the model on first use (size and sha256 checked; the file on disk is checked again once per run),
// runs whisper.cpp's whisper-server on 127.0.0.1 at a free port (spawned without a shell, stopped after IDLE_MS without
// use) and turns a recording into text. Pure parts: src/voice-core.js.
/* global AbortSignal, FormData */
'use strict';
const childProcess = require('node:child_process');
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

/** Runs `whisper-server --help`: 'ok', 'no-binary' (not there) or 'broken-binary' (there but does not run). */
function probeBinary(binary) {
  if (!fs.existsSync(binary)) return Promise.resolve('no-binary');
  return new Promise((resolve) => {
    try {
      childProcess.execFile(binary, ['--help'], { timeout: 15000, windowsHide: true, shell: false }, (err) => resolve(err ? 'broken-binary' : 'ok'));
    } catch { resolve('broken-binary'); }   // ENOEXEC and the like are thrown, not passed on
  });
}

/** whisper-server's own line once it has bound the port: only our child prints it on its stderr. */
const listeningRe = (port) => new RegExp(`listening at http://127\\.0\\.0\\.1:${port}\\b`);

/**
 * @param {{ userData: string, binary: string, emit: (payload: object) => void, uiLang: () => string,
 *   settings: () => ReturnType<typeof VC.normalizeSettings>, deps?: any }} o
 *   deps (tests): { spawn, fetch, freePort, probeBinary, modelOk, idleMs, startMs }
 */
function createVoice({ userData, binary, emit, uiLang, settings, deps = {} }) {
  const spawn = deps.spawn || childProcess.spawn;
  const doFetch = deps.fetch || fetch;
  const getPort = deps.freePort || freePort;
  const probe = deps.probeBinary || probeBinary;
  const checkModel = deps.modelOk || VC.modelOk;
  const idleMs = deps.idleMs ?? VC.IDLE_MS;
  const startMs = deps.startMs ?? 120000;
  const graceMs = deps.graceMs ?? 400;
  const modelsDir = path.join(userData, 'voice', 'models');
  /** the one active recording */
  let rec = null;
  /** @type {{ proc: any, port: number, model: string } | null} */
  let server = null;
  /** the process being started, and a token a stop() invalidates */
  let startingProc = null;
  let generation = 0;
  /** @type {Promise<any> | null} */
  let starting = null;
  /** @type {Map<string, Promise<string>>} */
  const downloads = new Map();
  const verified = new Set();   // models whose sha256 was checked this run
  let binaryState = null;       // 'ok' | 'no-binary' | 'broken-binary', once per run
  let idleTimer = null;

  const modelPath = (id) => path.join(modelsDir, VC.MODELS[id].file);
  const modelPresent = (id) => { try { return fs.statSync(modelPath(id)).size === VC.MODELS[id].size; } catch { return false; } };
  const alive = (p) => p && p.exitCode === null && p.signalCode == null && !p.killed;
  async function binaryOk() {
    if (!binaryState) binaryState = await probe(binary);
    return binaryState;
  }

  async function status() {
    const s = settings();
    const b = await binaryOk();
    return { enabled: s.enabled, binary: b === 'ok', binaryState: b, models: Object.fromEntries(Object.keys(VC.MODELS).map((id) => [id, { present: modelPresent(id), size: VC.MODELS[id].size }])) };
  }

  /** Downloads the model (once at a time); size and sha256 are checked before it takes its real name. */
  function ensureModel(id) {
    if (!VC.MODELS[id]) return Promise.reject(new Error('model'));
    if (modelPresent(id)) return Promise.resolve(modelPath(id));
    if (downloads.has(id)) return downloads.get(id);
    const p = (async () => {
      fs.mkdirSync(modelsDir, { recursive: true });
      const part = `${modelPath(id)}.part`;
      const m = VC.MODELS[id];
      try {
        const res = await doFetch(VC.modelUrl(id), { redirect: 'follow' });
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
          await new Promise((r) => out.end(() => r(undefined)));
        }
        if (got !== m.size || hash.digest('hex') !== m.sha256) throw new Error('checksum');
        fs.renameSync(part, modelPath(id));
      } catch (e) {
        fs.rmSync(part, { force: true });
        throw e;
      }
      verified.add(id);
      emit({ phase: 'downloaded', model: id });
      return modelPath(id);
    })();
    downloads.set(id, p);
    p.finally(() => downloads.delete(id)).catch(() => {});
    return p;
  }

  /** The model file, its sha256 checked once per run (a damaged file is removed and downloaded again). */
  async function verifiedModel(id) {
    const file = await ensureModel(id);
    if (verified.has(id)) return file;
    if (await checkModel(file, id)) { verified.add(id); return file; }
    fs.rmSync(file, { force: true });
    const again = await ensureModel(id);
    if (!(await checkModel(again, id))) { fs.rmSync(again, { force: true }); throw new Error('checksum'); }
    verified.add(id);
    return again;
  }

  /** Stops the server, also one still starting (that start then fails with 'cancelled'). */
  function stopServer() {
    clearTimeout(idleTimer);
    idleTimer = null;
    generation++;
    if (startingProc) { try { startingProc.kill(); } catch {} startingProc = null; }
    if (server) { try { server.proc.kill(); } catch {} server = null; }
  }
  function touch() {
    clearTimeout(idleTimer);
    if (!server) return;
    idleTimer = setTimeout(stopServer, idleMs);
    idleTimer.unref?.();
  }

  /**
   * One try at a port. Resolves when OUR child has the port: it printed that it bound it (seen only when its output is
   * not buffered), or the port answers with whisper-server's own page AND the child is still running a moment later
   * (if someone else held the port, our child fails to bind and exits). Rejects when it exits or takes too long.
   */
  function launch(file, port, gen) {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, VC.serverArgs({ modelPath: file, port, threads: os.cpus().length - 1 }), { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      startingProc = proc;
      let log = '';
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (startingProc === proc) startingProc = null;
        if (err) { try { proc.kill(); } catch {} reject(err); } else resolve(proc);
      };
      const timer = setTimeout(() => finish(new Error('server did not start')), startMs);
      const onData = (d) => {
        log = (log + d).slice(-4000);
        if (listeningRe(port).test(log)) finish(gen === generation ? null : new Error('cancelled'));
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      (async () => {
        while (!done) {
          await new Promise((r) => setTimeout(r, 300));
          if (done) return;
          let page = '';
          try { const res = await doFetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); page = await res.text(); } catch { continue; }
          if (!/Whisper\.cpp Server/.test(page)) continue;
          await new Promise((r) => setTimeout(r, graceMs));
          if (!done && alive(proc)) finish(gen === generation ? null : new Error('cancelled'));
        }
      })();
      proc.on('error', (e) => finish(e));
      proc.on('exit', () => finish(new Error(gen === generation ? `server exited: ${log.split('\n').slice(-3).join(' ')}` : 'cancelled')));
    });
  }

  async function ensureServer(id) {
    if (server && server.model === id && alive(server.proc)) return server;
    if (starting) return starting;
    starting = (async () => {
      if (server) { try { server.proc.kill(); } catch {} server = null; }
      const b = await binaryOk();
      if (b !== 'ok') throw new Error(b);
      const gen = generation;
      const file = await verifiedModel(id);
      if (gen !== generation) throw new Error('cancelled');
      emit({ phase: 'starting' });
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {   // a port taken between freePort and the bind: try another
        const port = await getPort();
        try {
          const proc = await launch(file, port, gen);
          const s = { proc, port, model: id };
          proc.on('exit', () => { if (server === s) server = null; });
          server = s;
          return s;
        } catch (e) {
          lastErr = e;
          if (String(e?.message) === 'cancelled' || gen !== generation) throw new Error('cancelled');
        }
      }
      throw lastErr || new Error('server did not start');
    })();
    try { return await starting; } finally { starting = null; }
  }

  async function infer(s, wav, language) {
    if (!alive(s.proc) || server !== s) throw new Error('server gone');
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    form.append('language', language);
    const res = await doFetch(`http://127.0.0.1:${s.port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`inference: HTTP ${res.status}`);
    const json = await res.json();
    if (!json || typeof json !== 'object' || typeof json.text !== 'string') throw new Error('not whisper-server');
    return json;
  }

  return {
    status,
    ensureModel,
    /** Starts a recording; an earlier one still open is dropped (one at a time). */
    begin() {
      rec = { id: crypto.randomUUID(), chunks: [], bytes: 0 };
      return rec.id;
    },
    chunk(id, data) {
      if (!rec || rec.id !== id || !(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) return;
      const b = Buffer.from(/** @type {any} */ (data));
      if (b.length > VC.MAX_CHUNK_BYTES || rec.bytes + b.length > VC.MAX_PCM_BYTES) return;
      rec.chunks.push(b);
      rec.bytes += b.length;
    },
    cancel(id) { if (rec?.id === id) rec = null; },
    /** Ends the recording and transcribes it; the audio is dropped whatever happens. */
    async finish(id) {
      if (!rec || rec.id !== id) return { ok: false, error: 'unknown' };
      const r = rec;
      rec = null;
      if (r.bytes < VC.SAMPLE_RATE * 2 * 0.3) return { ok: true, text: '' };   // under 0.3 s: nothing said
      const wav = VC.toWav(r.chunks);
      r.chunks.length = 0;
      const set = settings();
      clearTimeout(idleTimer);
      idleTimer = null;
      try {
        let s = await ensureServer(set.model);
        emit({ phase: 'transcribing' });
        let json;
        try { json = await infer(s, wav, VC.requestLanguage(set.language)); } catch (e) {
          if (String(e?.message) !== 'server gone') throw e;
          s = await ensureServer(set.model);   // it died between start and use: once more
          json = await infer(s, wav, VC.requestLanguage(set.language));
        }
        const again = VC.retryLanguage(set.language, json?.language || json?.detected_language, uiLang());
        if (again) json = await infer(s, wav, again);
        return { ok: true, text: VC.transcriptOf(json) };
      } catch (e) {
        const msg = String(e?.message || e);
        return { ok: false, error: ['no-binary', 'broken-binary', 'checksum', 'cancelled'].includes(msg) ? msg : 'failed', detail: msg };
      } finally {
        touch();
        emit({ phase: 'idle' });
      }
    },
    stop: stopServer,
    /** tests */
    _state: () => ({ server, startingProc, idle: Boolean(idleTimer), rec }),
  };
}

module.exports = { createVoice, freePort, probeBinary, listeningRe };
