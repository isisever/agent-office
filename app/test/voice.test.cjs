// Voice input (contract v3.119): node --test app/test/voice.test.cjs
// Pure parts only (src/voice-core.js, src/voice-input.mjs) plus source-text checks of the wiring; no microphone, no model.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const VC = require('../src/voice-core.js');

const appDir = path.join(__dirname, '..');
const input = () => import('../src/voice-input.mjs');

test('normalizeSettings: defaults, known values pass, unknown ones fall back', () => {
  assert.deepEqual(VC.normalizeSettings(undefined), { enabled: true, language: 'auto', model: 'large-v3-turbo-q5_0', sendAfter: false, shortcut: 'ctrl+space' });
  assert.deepEqual(VC.normalizeSettings({ enabled: false, language: 'tr', model: 'small-q5_1', sendAfter: true, shortcut: 'off' }),
    { enabled: false, language: 'tr', model: 'small-q5_1', sendAfter: true, shortcut: 'off' });
  const bad = VC.normalizeSettings({ enabled: 'yes', language: 'de', model: 'toString', sendAfter: 1, shortcut: 'cmd+space' });
  assert.deepEqual(bad, VC.normalizeSettings({}));
});

test('models: pinned revision, official file names, sizes and sha256', () => {
  assert.match(VC.HF_REVISION, /^[0-9a-f]{40}$/);
  for (const [id, m] of Object.entries(VC.MODELS)) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.ok(m.size > 100e6);
    assert.equal(VC.modelUrl(id), `https://huggingface.co/ggerganov/whisper.cpp/resolve/${VC.HF_REVISION}/${m.file}`);
  }
  assert.equal(VC.MODELS['large-v3-turbo-q5_0'].file, 'ggml-large-v3-turbo-q5_0.bin');
  assert.equal(VC.MODELS['small-q5_1'].file, 'ggml-small-q5_1.bin');
});

test('modelOk: size and sha256 must both match', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));
  try {
    const data = Buffer.from('not a model');
    const file = path.join(dir, 'm.bin');
    fs.writeFileSync(file, data);
    assert.equal(await VC.sha256File(file), crypto.createHash('sha256').update(data).digest('hex'));
    assert.equal(await VC.modelOk(file, 'small-q5_1'), false);          // wrong size
    assert.equal(await VC.modelOk(path.join(dir, 'none'), 'small-q5_1'), false);
    assert.equal(await VC.modelOk(file, 'nope'), false);
    VC.MODELS.fake = { file: 'm.bin', size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
    try {
      assert.equal(await VC.modelOk(file, 'fake'), true);
      VC.MODELS.fake.sha256 = '0'.repeat(64);
      assert.equal(await VC.modelOk(file, 'fake'), false);
    } finally { delete VC.MODELS.fake; }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('WAV header: 44 bytes, mono 16-bit 16 kHz, sizes', () => {
  const h = VC.wavHeader(32000);
  assert.equal(h.length, 44);
  assert.equal(h.toString('ascii', 0, 4), 'RIFF');
  assert.equal(h.readUInt32LE(4), 36 + 32000);
  assert.equal(h.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(h.readUInt16LE(20), 1);
  assert.equal(h.readUInt16LE(22), 1);
  assert.equal(h.readUInt32LE(24), 16000);
  assert.equal(h.readUInt32LE(28), 32000);
  assert.equal(h.readUInt16LE(32), 2);
  assert.equal(h.readUInt16LE(34), 16);
  assert.equal(h.toString('ascii', 36, 40), 'data');
  assert.equal(h.readUInt32LE(40), 32000);
  const wav = VC.toWav([new Int16Array([1, -1]).buffer, Buffer.from([5, 0, 7])]);
  assert.equal(wav.length, 44 + 6);   // the odd byte is dropped
  assert.equal(wav.readUInt32LE(40), 6);
  assert.equal(wav.readInt16LE(46), -1);
});

test('serverArgs: 127.0.0.1 only, the port and model, no shell strings', () => {
  const a = VC.serverArgs({ modelPath: '/m/ggml small.bin', port: 4567, threads: 32 });
  assert.deepEqual(a, ['-m', '/m/ggml small.bin', '--host', '127.0.0.1', '--port', '4567', '-t', '8', '-nt']);
  assert.equal(VC.serverArgs({ modelPath: 'x', port: 1, threads: 0 })[7], '4');
  assert.throws(() => VC.serverArgs({ modelPath: 'x', port: 0, threads: 2 }));
  assert.throws(() => VC.serverArgs({ modelPath: 'x', port: 70000, threads: 2 }));
});

test('language: the setting goes in; Auto retries only for a third language', () => {
  assert.equal(VC.requestLanguage('tr'), 'tr');
  assert.equal(VC.requestLanguage('auto'), 'auto');
  assert.equal(VC.requestLanguage('xx'), 'auto');
  assert.equal(VC.retryLanguage('auto', 'english', 'tr'), null);
  assert.equal(VC.retryLanguage('auto', 'turkish', 'en'), null);
  assert.equal(VC.retryLanguage('auto', 'tr', 'en'), null);
  assert.equal(VC.retryLanguage('auto', 'german', 'tr'), 'tr');
  assert.equal(VC.retryLanguage('auto', 'azerbaijani', 'en'), 'en');
  assert.equal(VC.retryLanguage('tr', 'german', 'tr'), null);
  assert.equal(VC.retryLanguage('auto', undefined, 'tr'), null);
});

test('transcriptOf: trims and drops blank-audio markers', () => {
  assert.equal(VC.transcriptOf({ text: ' Hello,  world.\n' }), 'Hello, world.');
  assert.equal(VC.transcriptOf({ text: '[BLANK_AUDIO]' }), '');
  assert.equal(VC.transcriptOf(null), '');
});

test('mediaDecision: audio only, only the app page; other permissions untouched', () => {
  const rendererDir = path.join(appDir, 'renderer');
  const page = new URL(`file://${path.join(rendererDir, 'index.html')}`).href;
  assert.equal(VC.mediaDecision({ permission: 'media', mediaTypes: ['audio'], requestingUrl: page, rendererDir }), true);
  assert.equal(VC.mediaDecision({ permission: 'media', mediaTypes: ['video'], requestingUrl: page, rendererDir }), false);
  assert.equal(VC.mediaDecision({ permission: 'media', mediaTypes: ['audio', 'video'], requestingUrl: page, rendererDir }), false);
  assert.equal(VC.mediaDecision({ permission: 'media', mediaTypes: [], requestingUrl: page, rendererDir }), false);
  assert.equal(VC.mediaDecision({ permission: 'media', mediaTypes: ['audio'], requestingUrl: 'https://example.com/', rendererDir }), false);
  assert.equal(VC.mediaDecision({ permission: 'media', mediaTypes: ['audio'], requestingUrl: 'file:///etc/x.html', rendererDir }), false);
  assert.equal(VC.mediaDecision({ permission: 'media', mediaTypes: ['audio'], requestingUrl: 'not a url', rendererDir }), false);
  assert.equal(VC.mediaDecision({ permission: 'notifications', requestingUrl: page, rendererDir }), null);
});

test('binaryPath: Resources/whisper packaged, vendor/<os>-<arch> in development', () => {
  assert.equal(VC.binaryPath({ packaged: true, resourcesPath: '/R', appDir: '/A', platform: 'darwin', arch: 'arm64' }), path.join('/R', 'whisper', 'whisper-server'));
  assert.equal(VC.binaryPath({ packaged: false, resourcesPath: '/R', appDir: '/A', platform: 'darwin', arch: 'arm64' }), path.join('/A', 'vendor', 'whisper', 'mac-arm64', 'whisper-server'));
  assert.equal(VC.binaryPath({ packaged: true, resourcesPath: '/R', appDir: '/A', platform: 'win32', arch: 'x64' }), path.join('/R', 'whisper', 'whisper-server.exe'));
});

test('Downsampler: 48 kHz → 16 kHz keeps the length and the level, across block edges', async () => {
  const { Downsampler, TARGET_RATE } = await input();
  for (const rate of [48000, 44100, 22050, 16000]) {
    const ds = new Downsampler(rate);
    let n = 0;
    const blocks = 100;
    for (let b = 0; b < blocks; b++) {
      const out = ds.push(new Float32Array(128).fill(0.5));
      for (const v of out) assert.ok(Math.abs(v - 0.5) < 1e-6);
      n += out.length;
    }
    const expect = (blocks * 128 * TARGET_RATE) / rate;
    assert.ok(Math.abs(n - expect) <= 1, `${rate}: ${n} vs ${expect}`);
  }
  assert.throws(() => new Downsampler(8000));
  assert.throws(() => new Downsampler(0));
});

test('Downsampler: a 1 kHz tone survives the box filter at 48 kHz', async () => {
  const { Downsampler } = await input();
  const ds = new Downsampler(48000);
  const inp = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / 48000));
  const out = ds.push(inp);
  const peak = Math.max(...out.map(Math.abs));
  assert.ok(peak > 0.9 && peak <= 1, String(peak));
});

test('floatToPcm16 clamps and scales', async () => {
  const { floatToPcm16 } = await input();
  assert.deepEqual([...floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]))], [0, 32767, -32768, 32767, -32768, 16384]);
});

test('matchShortcut: only the chosen combination, never with Cmd', async () => {
  const { matchShortcut } = await input();
  const ev = (o) => ({ code: 'Space', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });
  assert.equal(matchShortcut('ctrl+space', ev({ ctrlKey: true })), true);
  assert.equal(matchShortcut('ctrl+space', ev({ ctrlKey: true, shiftKey: true })), false);
  assert.equal(matchShortcut('ctrl+space', ev({ ctrlKey: true, metaKey: true })), false);
  assert.equal(matchShortcut('alt+space', ev({ altKey: true })), true);
  assert.equal(matchShortcut('ctrl+shift+space', ev({ ctrlKey: true, shiftKey: true })), true);
  assert.equal(matchShortcut('off', ev({ ctrlKey: true })), false);
  assert.equal(matchShortcut('ctrl+space', ev({ ctrlKey: true, code: 'KeyA' })), false);
});

test('spliceText: replaces the selection, adds a space after a word, caret after the text', async () => {
  const { spliceText } = await input();
  assert.deepEqual(spliceText('', 0, 0, ' hello '), { value: 'hello', caret: 5 });
  assert.deepEqual(spliceText('run', 3, 3, 'tests'), { value: 'run tests', caret: 9 });
  assert.deepEqual(spliceText('run ', 4, 4, 'tests'), { value: 'run tests', caret: 9 });
  assert.deepEqual(spliceText('a XX b', 2, 4, 'yy'), { value: 'a yy b', caret: 4 });
  assert.deepEqual(spliceText('abc', 1, 1, ''), { value: 'abc', caret: 1 });
});

test('wiring: no shell, local-only server, audio never written, entitlements and Info.plist', () => {
  const voice = fs.readFileSync(path.join(appDir, 'src', 'voice.js'), 'utf8');
  assert.match(voice, /spawn\(binary, VC\.serverArgs\(/);
  assert.match(voice, /shell: false/);
  assert.doesNotMatch(voice, /writeFile|appendFile/);   // only the model download writes, through a stream to models/
  const main = fs.readFileSync(path.join(appDir, 'main.js'), 'utf8');
  for (const ch of ['voice:settings', 'voice:setSettings', 'voice:start', 'voice:chunk', 'voice:stop', 'voice:cancel', 'voice:downloadModel']) assert.ok(main.includes(`'${ch}'`), ch);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /askForMediaAccess\('microphone'\)/);
  const plist = fs.readFileSync(path.join(appDir, 'build', 'entitlements.mac.plist'), 'utf8');
  assert.match(plist, /com\.apple\.security\.device\.audio-input/);
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  assert.ok(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription);
  assert.ok(pkg.build.extraResources.some((r) => r.from === 'vendor/whisper/${os}-${arch}' && r.to === 'whisper'));
  for (const f of ['en', 'tr']) {
    const j = JSON.parse(fs.readFileSync(path.join(appDir, 'locales', `${f}.json`), 'utf8'));
    assert.ok(j.voice?.settings?.sendAfter && j.voice?.err?.['mic-denied'], f);
  }
});

// --- createVoice with a fake whisper-server (no binary, no network)
const { EventEmitter } = require('node:events');
const { createVoice, probeBinary } = require('../src/voice.js');

function fakeProc({ listen = true, exitAtOnce = false } = {}) {
  return (bin, args) => {
    const p = new EventEmitter();
    p.args = args; p.exitCode = null; p.signalCode = null; p.killed = false;
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.kill = () => { if (p.exitCode !== null) return; p.killed = true; p.exitCode = 143; setImmediate(() => p.emit('exit', 143)); };
    const port = args[args.indexOf('--port') + 1];
    setImmediate(() => {
      if (exitAtOnce) { p.exitCode = 1; p.stderr.emit('data', 'bind failed\n'); p.emit('exit', 1); return; }
      if (listen) p.stderr.emit('data', `whisper server listening at http://127.0.0.1:${port}\n`);
    });
    return p;
  };
}

function rig(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-rig-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); delete VC.MODELS.fake; });
  const data = Buffer.from('fake model bytes');
  VC.MODELS.fake = { file: 'fake.bin', size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  fs.mkdirSync(path.join(dir, 'voice', 'models'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'voice', 'models', 'fake.bin'), data);
  const spawned = [];
  const spawnImpl = over.spawn || fakeProc();
  let port = 40000;
  const calls = { modelOk: 0, infer: 0 };
  const v = createVoice({
    userData: dir, binary: '/bin/whisper-server', emit: () => {}, uiLang: () => 'en',
    settings: () => ({ enabled: true, language: 'auto', model: 'fake', sendAfter: false, shortcut: 'off' }),
    deps: {
      spawn: (b, a, o) => { const p = spawnImpl(b, a, o); spawned.push(p); return p; },
      freePort: async () => ++port,
      probeBinary: async () => over.binary || 'ok',
      modelOk: async () => { calls.modelOk++; return over.modelOk ?? true; },
      fetch: over.fetch || (async () => { calls.infer++; return { ok: true, json: async () => ({ text: ' hello there ', language: 'english' }) }; }),
      idleMs: over.idleMs ?? 60000, startMs: over.startMs ?? 2000,
    },
  });
  t.after(() => v.stop());
  return { v, dir, spawned, calls, data };
}
const second = () => Buffer.alloc(VC.SAMPLE_RATE * 2);   // 1 s of silence

test('createVoice: one recording at a time, chunk size cap, cancel', async (t) => {
  const { v } = rig(t);
  const a = v.begin();
  const b = v.begin();
  v.chunk(a, second());                                  // the replaced recording takes nothing
  v.chunk(b, Buffer.alloc(VC.MAX_CHUNK_BYTES + 2));       // too big for one chunk
  assert.equal(v._state().rec.bytes, 0);
  v.chunk(b, second());
  assert.equal(v._state().rec.bytes, VC.SAMPLE_RATE * 2);
  assert.deepEqual(await v.finish(a), { ok: false, error: 'unknown' });
  v.cancel(b);
  assert.equal(v._state().rec, null);
  assert.deepEqual(await v.finish(b), { ok: false, error: 'unknown' });
  const c = v.begin();
  assert.deepEqual(await v.finish(c), { ok: true, text: '' });   // under 0.3 s
});

test('createVoice: transcribes through our own child, reuses it, sha checked once per run, idle timer after', async (t) => {
  const { v, spawned, calls } = rig(t);
  let id = v.begin(); v.chunk(id, second());
  assert.deepEqual(await v.finish(id), { ok: true, text: 'hello there' });
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args.slice(2, 6), ['--host', '127.0.0.1', '--port', '40001']);
  assert.equal(v._state().idle, true);
  id = v.begin(); v.chunk(id, second());
  assert.equal((await v.finish(id)).text, 'hello there');
  assert.equal(spawned.length, 1);
  assert.equal(calls.modelOk, 1);
  v.stop();
  assert.equal(spawned[0].killed, true);
  assert.equal(v._state().server, null);
});

test('createVoice: the idle timer stops the server', async (t) => {
  const { v, spawned } = rig(t, { idleMs: 30 });
  const id = v.begin(); v.chunk(id, second());
  await v.finish(id);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(spawned[0].killed, true);
  assert.equal(v._state().server, null);
});

test('createVoice: stop() during start kills the starting process; the transcription is cancelled', async (t) => {
  const { v, spawned } = rig(t, { spawn: fakeProc({ listen: false }) });
  const id = v.begin(); v.chunk(id, second());
  const done = v.finish(id);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawned.length, 1);
  v.stop();
  const r = await done;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'cancelled');
  assert.equal(spawned[0].killed, true);
  assert.equal(v._state().startingProc, null);
});

test('createVoice: a port lost before the bind is retried on another port; a silent server times out', async (t) => {
  let n = 0;
  const flaky = (b, a, o) => fakeProc({ exitAtOnce: n++ === 0 })(b, a, o);
  const { v, spawned } = rig(t, { spawn: flaky });
  const id = v.begin(); v.chunk(id, second());
  assert.equal((await v.finish(id)).ok, true);
  assert.equal(spawned.length, 2);
  assert.notEqual(spawned[0].args[5], spawned[1].args[5]);
  const slow = rig(t, { spawn: fakeProc({ listen: false }), startMs: 30 });
  const id2 = slow.v.begin(); slow.v.chunk(id2, second());
  assert.equal((await slow.v.finish(id2)).error, 'failed');
  assert.ok(slow.spawned.every((p) => p.killed));
});

test('createVoice: without the bound line, our child is accepted only by whisper-server\'s page and when it stays alive', async (t) => {
  const page = (html) => async (url) => (String(url).endsWith('/inference')
    ? { ok: true, json: async () => ({ text: 'ok' }) }
    : { ok: true, text: async () => html });
  const good = rig(t, { spawn: fakeProc({ listen: false }), fetch: page('<title>Whisper.cpp Server</title>') });
  let id = good.v.begin(); good.v.chunk(id, second());
  assert.deepEqual(await good.v.finish(id), { ok: true, text: 'ok' });
  const foreign = rig(t, { spawn: fakeProc({ listen: false }), fetch: page('<title>nginx</title>'), startMs: 900 });
  id = foreign.v.begin(); foreign.v.chunk(id, second());
  assert.equal((await foreign.v.finish(id)).error, 'failed');
  // the page answers, but our child exits (the port was someone else's): another port is tried
  let n = 0;
  const dies = (b, a, o) => { const p = fakeProc({ listen: false })(b, a, o); if (n++ === 0) setTimeout(() => { p.exitCode = 1; p.emit('exit', 1); }, 350); return p; };
  const raced = rig(t, { spawn: dies, fetch: page('<title>Whisper.cpp Server</title>') });
  id = raced.v.begin(); raced.v.chunk(id, second());
  assert.equal((await raced.v.finish(id)).ok, true);
  assert.equal(raced.spawned.length, 2);
});

test('createVoice: an answer that is not whisper-server\'s is refused', async (t) => {
  const { v } = rig(t, { fetch: async () => ({ ok: true, json: async () => ({ hello: 'other server' }) }) });
  const id = v.begin(); v.chunk(id, second());
  assert.equal((await v.finish(id)).error, 'failed');
});

test('createVoice: binary states and a bad model file', async (t) => {
  for (const b of ['no-binary', 'broken-binary']) {
    const { v, spawned } = rig(t, { binary: b });
    const id = v.begin(); v.chunk(id, second());
    assert.equal((await v.finish(id)).error, b);
    assert.equal(spawned.length, 0);
    assert.equal((await v.status()).binaryState, b);
  }
  // the model on disk fails its sha256: removed and downloaded again; a damaged download leaves no .part
  const bad = rig(t, { modelOk: false, fetch: async () => ({ ok: true, body: [Buffer.from('X'.repeat(16))] }) });
  const id = bad.v.begin(); bad.v.chunk(id, second());
  const r = await bad.v.finish(id);
  assert.equal(r.error, 'checksum');
  assert.deepEqual(fs.readdirSync(path.join(bad.dir, 'voice', 'models')), []);
  assert.equal(bad.spawned.length, 0);
});

test('probeBinary: missing → no-binary, present but not runnable → broken-binary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bin-'));
  try {
    assert.equal(await probeBinary(path.join(dir, 'none')), 'no-binary');
    const f = path.join(dir, 'whisper-server');
    fs.writeFileSync(f, Buffer.from([0, 1, 2, 3, 4, 5]));
    fs.chmodSync(f, 0o755);
    assert.equal(await probeBinary(f), 'broken-binary');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fetch-whisper copyBinDir: library symlinks land as files under the link names, DLLs from elsewhere too', { skip: process.platform === 'win32' }, async () => {
  const { copyBinDir } = await import('../scripts/fetch-whisper.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-copy-'));
  try {
    const src = path.join(dir, 'x', 'bin');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(path.join(dir, 'x', 'other'));
    fs.writeFileSync(path.join(src, 'whisper-server'), 'srv');
    fs.writeFileSync(path.join(src, 'libwhisper.so.1.9.6'), 'lib');
    fs.symlinkSync('libwhisper.so.1.9.6', path.join(src, 'libwhisper.so.1'));
    fs.symlinkSync('missing.so', path.join(src, 'libdangling.so'));
    fs.writeFileSync(path.join(src, 'whisper-cli'), 'not wanted');
    fs.writeFileSync(path.join(dir, 'x', 'other', 'ggml.dll'), 'dll');
    const dest = path.join(dir, 'out');
    copyBinDir(path.join(src, 'whisper-server'), dest, path.join(dir, 'x'));
    assert.deepEqual(fs.readdirSync(dest).sort(), ['ggml.dll', 'libwhisper.so.1', 'libwhisper.so.1.9.6', 'whisper-server']);
    assert.equal(fs.lstatSync(path.join(dest, 'libwhisper.so.1')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(dest, 'libwhisper.so.1'), 'utf8'), 'lib');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('send after speaking only through a registered composer; voice:* only from the main window', () => {
  const r = fs.readFileSync(path.join(appDir, 'renderer', 'voice.js'), 'utf8');
  assert.doesNotMatch(r, /requestSubmit/);
  assert.match(r, /composers\.get\(el\)\?\.\(\)/);
  const hq = fs.readFileSync(path.join(appDir, 'renderer', 'hq-board.js'), 'utf8');
  assert.match(hq, /micButton\(input, \(\) => input\.form\?\.requestSubmit\(\)\)/);
  const main = fs.readFileSync(path.join(appDir, 'main.js'), 'utf8');
  const handlers = main.split('\n').filter((l) => /ipcMain\.(handle|on)\('voice:/.test(l));
  assert.equal(handlers.length, 7);
  const body = main.slice(main.indexOf("ipcMain.handle('voice:settings'"), main.indexOf("ipcMain.handle('prefs:get'"));
  assert.equal((body.match(/fromWin\(e\)/g) || []).length, 7);
});
