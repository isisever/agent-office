// Voice input (contract v3.119): the AudioWorklet. Down-samples the microphone to 16 kHz mono PCM16 and posts blocks of
/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// about 100 ms to the page (renderer/voice.js), which sends them to main. Nothing is stored here.
import { Downsampler, floatToPcm16, TARGET_RATE } from '../src/voice-input.mjs';

class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ds = new Downsampler(sampleRate, TARGET_RATE);
    /** @type {Float32Array[]} */
    this.pending = [];
    this.count = 0;
    // 'flush' (the page stops): what is pending goes out now, then 'flushed'
    this.port.onmessage = (e) => { if (e.data === 'flush') { this.send(); this.port.postMessage('flushed'); } };
  }
  send() {
    if (!this.count) return;
    const all = new Float32Array(this.count);
    let o = 0;
    for (const p of this.pending) { all.set(p, o); o += p.length; }
    const pcm = floatToPcm16(all);
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    this.pending = []; this.count = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch && ch.length) {
      const out = this.ds.push(ch);
      if (out.length) { this.pending.push(out); this.count += out.length; }
      if (this.count >= TARGET_RATE / 10) this.send();
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
