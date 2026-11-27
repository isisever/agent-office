/*
 * A small QR Code encoder, derived from Project Nayuki's QR Code generator library (TypeScript/JavaScript).
 * Copyright (c) Project Nayuki. (MIT License) — see LICENSE next to this file.
 * https://www.nayuki.io/page/qr-code-generator-library
 *
 * Reduced to what the pairing QR needs: byte mode (UTF-8), error correction level M, versions 1..15 chosen
 * automatically, all 8 masks tried with the standard penalty score. encodeText returns the module matrix
 * (rows of booleans, true = dark); toSvg draws it with a quiet zone.
 */

/* global TextEncoder */
const MIN_VERSION = 1;
const MAX_VERSION = 15;
const ECC_FORMAT_BITS_M = 0;
// Level M, indexed by version (index 0 unused)
const ECC_CODEWORDS_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24];
const NUM_ERROR_CORRECTION_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10];
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** @param {number} x @param {number} i */
const getBit = (x, i) => ((x >>> i) & 1) !== 0;

/** Number of data bits in a symbol of this version, function modules excluded. @param {number} ver */
export function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** Data codewords (8-bit) of this version at level M. @param {number} ver */
export function numDataCodewords(ver) {
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ver] * NUM_ERROR_CORRECTION_BLOCKS[ver];
}

/** Center coordinates of the alignment patterns of this version. @param {number} ver @returns {number[]} */
export function alignmentPositions(ver) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 17 - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** GF(2^8 / 0x11D) product. @param {number} x @param {number} y */
function rsMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** @param {number} degree @returns {number[]} */
function rsDivisor(degree) {
  /** @type {number[]} */
  const result = [];
  for (let i = 0; i < degree - 1; i++) result.push(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

/** @param {number[]} data @param {number[]} divisor @returns {number[]} */
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ /** @type {number} */ (result.shift());
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= rsMultiply(coef, factor); });
  }
  return result;
}

/** Splits the data codewords into blocks, adds each block's ECC and interleaves. @param {number[]} data @param {number} ver */
function addEccAndInterleave(data, ver) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  /** @type {number[][]} */
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  /** @type {number[]} */
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

/** The 15 format bits (level M) for a mask, BCH code and XOR mask applied. @param {number} mask */
export function formatBits(mask) {
  const data = (ECC_FORMAT_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (versions 7+). @param {number} ver */
export function versionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
  return (ver << 12) | rem;
}

class QrSymbol {
  /** @param {number} ver @param {number[]} codewords data codewords, padded */
  constructor(ver, codewords) {
    this.version = ver;
    this.size = ver * 4 + 17;
    /** @type {boolean[][]} */
    this.modules = [];
    /** @type {boolean[][]} */
    this.isFunction = [];
    for (let i = 0; i < this.size; i++) {
      this.modules.push(new Array(this.size).fill(false));
      this.isFunction.push(new Array(this.size).fill(false));
    }
    this.drawFunctionPatterns();
    this.drawCodewords(addEccAndInterleave(codewords, ver));
    let best = 0;
    let minPenalty = Infinity;
    for (let m = 0; m < 8; m++) {
      this.applyMask(m);
      this.drawFormatBits(m);
      const penalty = this.penaltyScore();
      if (penalty < minPenalty) { best = m; minPenalty = penalty; }
      this.applyMask(m); // XOR again: undo
    }
    this.mask = best;
    this.applyMask(best);
    this.drawFormatBits(best);
  }

  /** @param {number} x @param {number} y @param {boolean} dark */
  setFunction(x, y, dark) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  drawFunctionPatterns() {
    const size = this.size;
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    const pos = alignmentPositions(this.version);
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) this.drawAlignment(pos[i], pos[j]);
      }
    }
    this.drawFormatBits(0); // reserves the area; redrawn with the real mask later
    this.drawVersion();
  }

  /** @param {number} mask */
  drawFormatBits(mask) {
    const bits = formatBits(mask);
    const size = this.size;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, getBit(bits, i));
    this.setFunction(8, 7, getBit(bits, 6));
    this.setFunction(8, 8, getBit(bits, 7));
    this.setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, getBit(bits, i));
    this.setFunction(8, size - 8, true); // the dark module
  }

  drawVersion() {
    if (this.version < 7) return;
    const bits = versionBits(this.version);
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  }

  /** @param {number} x @param {number} y */
  drawFinder(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunction(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  /** @param {number} x @param {number} y */
  drawAlignment(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  /** @param {number[]} data all codewords, ECC included */
  drawCodewords(data) {
    const size = this.size;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  /** XORs the mask over the non-function modules (applying twice undoes it). @param {number} mask */
  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert && !this.isFunction[y][x]) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  penaltyScore() {
    const size = this.size;
    const m = this.modules;
    let result = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let runColor = false;
        let runLen = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          const c = pass === 0 ? m[a][b] : m[b][a];
          if (c === runColor) {
            runLen++;
            if (runLen === 5) result += PENALTY_N1;
            else if (runLen > 5) result++;
          } else {
            this.addHistory(runLen, history);
            if (!runColor) result += this.countFinderLike(history) * PENALTY_N3;
            runColor = c;
            runLen = 1;
          }
        }
        result += this.terminateAndCount(runColor, runLen, history) * PENALTY_N3;
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += PENALTY_N2;
      }
    }
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }

  /** @param {number[]} h */
  countFinderLike(h) {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  }

  /** @param {boolean} runColor @param {number} runLen @param {number[]} h */
  terminateAndCount(runColor, runLen, h) {
    if (runColor) { this.addHistory(runLen, h); runLen = 0; }
    runLen += this.size; // the light border
    this.addHistory(runLen, h);
    return this.countFinderLike(h);
  }

  /** @param {number} runLen @param {number[]} h */
  addHistory(runLen, h) {
    if (h[0] === 0) runLen += this.size; // the light border before the first run
    h.pop();
    h.unshift(runLen);
  }
}

/**
 * Encodes text (UTF-8, byte mode, level M) in the smallest version 1..15 that holds it.
 * @param {string} text
 * @returns {{ version: number, size: number, mask: number, modules: boolean[][] }}
 */
export function encodeText(text) {
  const bytes = new TextEncoder().encode(text);
  let ver = MIN_VERSION;
  for (; ; ver++) {
    if (ver > MAX_VERSION) throw new RangeError(`QR: ${bytes.length} bytes do not fit in version ${MAX_VERSION}`);
    const ccBits = ver < 10 ? 8 : 16;
    if (4 + ccBits + bytes.length * 8 <= numDataCodewords(ver) * 8) break;
  }
  /** @type {number[]} */
  const bits = [];
  /** @param {number} val @param {number} len */
  const append = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  append(0x4, 4);
  append(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) append(b, 8);
  const capacity = numDataCodewords(ver) * 8;
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xEC; bits.length < capacity; pad ^= 0xEC ^ 0x11) append(pad, 8);
  /** @type {number[]} */
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  const s = new QrSymbol(ver, codewords);
  return { version: ver, size: s.size, mask: s.mask, modules: s.modules };
}

/**
 * An SVG document for a module matrix: one path of unit squares, a light background and a quiet zone of
 * `border` modules. Only numbers go into the markup.
 * @param {boolean[][]} modules
 * @param {{ border?: number, dark?: string, light?: string }} [o]
 */
export function toSvg(modules, { border = 4, dark = '#000', light = '#fff' } = {}) {
  const size = modules.length;
  const dim = size + border * 2;
  const parts = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (modules[y][x]) parts.push(`M${x + border},${y + border}h1v1h-1z`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`
    + `<rect width="100%" height="100%" fill="${light}"/><path d="${parts.join('')}" fill="${dark}"/></svg>`;
}
