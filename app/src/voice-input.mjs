// Voice input (contract v3.119): pure parts of the renderer side (no DOM; tested with node --test app/test/voice.test.cjs).
// The streaming down-sampler the AudioWorklet uses (any input rate → 16 kHz mono PCM16), the talk-key match and how a
// transcript goes into a text field.

export const TARGET_RATE = 16000;

/** Float samples (-1..1) → PCM16, clamped. */
export function floatToPcm16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/**
 * A streaming down-sampler: each output sample is the mean of the input samples it covers (a box low-pass, enough for
 * speech), the fractional position carries over from one block to the next so block edges leave no seams.
 */
export class Downsampler {
  /** @param {number} inRate @param {number} [outRate] */
  constructor(inRate, outRate = TARGET_RATE) {
    if (!(inRate > 0) || !(outRate > 0) || outRate > inRate) throw new Error('rate');
    this.ratio = inRate / outRate;
    this.next = this.ratio;   // where the output sample in progress ends, in input samples from this block's start
    this.acc = 0;             // sum and count of the input samples taken for it so far
    this.n = 0;
  }
  /** @param {Float32Array} input @returns {Float32Array} */
  push(input) {
    const out = [];
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.n++;
      if (i + 1 >= this.next) { out.push(this.acc / this.n); this.acc = 0; this.n = 0; this.next += this.ratio; }
    }
    this.next -= input.length;
    return Float32Array.from(out);
  }
}

/** Does a key event match the talk key setting ('ctrl+space' | 'alt+space' | 'ctrl+shift+space' | 'off')? */
export function matchShortcut(setting, e) {
  if (!e || e.code !== 'Space' || e.metaKey) return false;
  if (setting === 'ctrl+space') return e.ctrlKey && !e.altKey && !e.shiftKey;
  if (setting === 'alt+space') return e.altKey && !e.ctrlKey && !e.shiftKey;
  if (setting === 'ctrl+shift+space') return e.ctrlKey && e.shiftKey && !e.altKey;
  return false;
}

/** The field's text with `text` put in place of the selection, a space before it when needed; and the caret after it. */
export function spliceText(value, start, end, text) {
  const v = String(value ?? '');
  const a = Math.max(0, Math.min(v.length, start ?? v.length));
  const b = Math.max(a, Math.min(v.length, end ?? a));
  const t = String(text ?? '').trim();
  if (!t) return { value: v, caret: b };
  const sep = a > 0 && !/\s$/.test(v.slice(0, a)) ? ' ' : '';
  const ins = sep + t;
  return { value: v.slice(0, a) + ins + v.slice(b), caret: a + ins.length };
}
