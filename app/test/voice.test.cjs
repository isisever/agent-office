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
