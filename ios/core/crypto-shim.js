// The part of Node's `crypto` that app/src/link-core.js uses, built on sodium-native so it runs inside a Bare
// worklet (no Node crypto there): createHash('sha256'), createHmac('sha256'), scryptSync, randomBytes, timingSafeEqual.
// Proven against Node crypto by app/test/crypto-shim.test.cjs.
'use strict';
const sodium = require('sodium-native');
const b4a = require('b4a');

const toBytes = (data, enc) => (typeof data === 'string' ? b4a.from(data, enc || 'utf8') : b4a.isBuffer(data) ? data : b4a.from(data.buffer, data.byteOffset, data.byteLength));
const out = (buf, enc) => (enc ? b4a.toString(buf, enc) : buf);

function sha256(data) {
  const res = b4a.alloc(sodium.crypto_hash_sha256_BYTES);
  sodium.crypto_hash_sha256(res, toBytes(data));
  return res;
}

const BLOCK = 64;
function hmacSha256(key, data) {
  let k = toBytes(key);
  if (k.length > BLOCK) k = sha256(k);
  const ipad = b4a.alloc(BLOCK, 0x36);
  const opad = b4a.alloc(BLOCK, 0x5c);
  for (let i = 0; i < k.length; i++) { ipad[i] ^= k[i]; opad[i] ^= k[i]; }
  return sha256(b4a.concat([opad, sha256(b4a.concat([ipad, toBytes(data)]))]));
}

class Hash {
  constructor(alg, key) {
    if (String(alg).toLowerCase() !== 'sha256') throw new Error(`crypto-shim: unsupported algorithm ${alg}`);
    this.key = key === undefined ? null : toBytes(key);
    this.parts = [];
  }
  update(data, enc) { this.parts.push(toBytes(data, enc)); return this; }
  digest(enc) {
    const data = b4a.concat(this.parts);
    return out(this.key ? hmacSha256(this.key, data) : sha256(data), enc);
  }
}

const createHash = (alg) => new Hash(alg);
const createHmac = (alg, key) => new Hash(alg, key);

function randomBytes(n) {
  const buf = b4a.alloc(n);
  sodium.randombytes_buf(buf);
  return buf;
}

function timingSafeEqual(a, b) {
  if (a.byteLength !== b.byteLength) throw new RangeError('Input buffers must have the same byte length');
  return sodium.sodium_memcmp(toBytes(a), toBytes(b));
}

// --- scrypt (RFC 7914). libsodium only exposes scrypt with a fixed 32-byte salt and ops/mem limits, while
// link-core uses a 25-byte salt and explicit N/r/p, so ROMix runs here in JS and PBKDF2 on sodium's SHA-256.

function pbkdf2Sha256Once(password, salt, dkLen) {
  const res = b4a.alloc(dkLen);
  const idx = b4a.alloc(4);
  for (let i = 1, off = 0; off < dkLen; i++, off += 32) {
    idx[0] = (i >>> 24) & 0xff; idx[1] = (i >>> 16) & 0xff; idx[2] = (i >>> 8) & 0xff; idx[3] = i & 0xff;
    const u = hmacSha256(password, b4a.concat([salt, idx]));
    res.set(u.subarray(0, Math.min(32, dkLen - off)), off);
  }
  return res;
}

function salsa208(B, x) {
  for (let i = 0; i < 16; i++) x[i] = B[i];
  for (let i = 8; i > 0; i -= 2) {
    let u;
    u = x[0] + x[12]; x[4] ^= (u << 7) | (u >>> 25); u = x[4] + x[0]; x[8] ^= (u << 9) | (u >>> 23);
    u = x[8] + x[4]; x[12] ^= (u << 13) | (u >>> 19); u = x[12] + x[8]; x[0] ^= (u << 18) | (u >>> 14);
    u = x[5] + x[1]; x[9] ^= (u << 7) | (u >>> 25); u = x[9] + x[5]; x[13] ^= (u << 9) | (u >>> 23);
    u = x[13] + x[9]; x[1] ^= (u << 13) | (u >>> 19); u = x[1] + x[13]; x[5] ^= (u << 18) | (u >>> 14);
    u = x[10] + x[6]; x[14] ^= (u << 7) | (u >>> 25); u = x[14] + x[10]; x[2] ^= (u << 9) | (u >>> 23);
    u = x[2] + x[14]; x[6] ^= (u << 13) | (u >>> 19); u = x[6] + x[2]; x[10] ^= (u << 18) | (u >>> 14);
    u = x[15] + x[11]; x[3] ^= (u << 7) | (u >>> 25); u = x[3] + x[15]; x[7] ^= (u << 9) | (u >>> 23);
    u = x[7] + x[3]; x[11] ^= (u << 13) | (u >>> 19); u = x[11] + x[7]; x[15] ^= (u << 18) | (u >>> 14);
    u = x[0] + x[3]; x[1] ^= (u << 7) | (u >>> 25); u = x[1] + x[0]; x[2] ^= (u << 9) | (u >>> 23);
    u = x[2] + x[1]; x[3] ^= (u << 13) | (u >>> 19); u = x[3] + x[2]; x[0] ^= (u << 18) | (u >>> 14);
    u = x[5] + x[4]; x[6] ^= (u << 7) | (u >>> 25); u = x[6] + x[5]; x[7] ^= (u << 9) | (u >>> 23);
    u = x[7] + x[6]; x[4] ^= (u << 13) | (u >>> 19); u = x[4] + x[7]; x[5] ^= (u << 18) | (u >>> 14);
    u = x[10] + x[9]; x[11] ^= (u << 7) | (u >>> 25); u = x[11] + x[10]; x[8] ^= (u << 9) | (u >>> 23);
    u = x[8] + x[11]; x[9] ^= (u << 13) | (u >>> 19); u = x[9] + x[8]; x[10] ^= (u << 18) | (u >>> 14);
    u = x[15] + x[14]; x[12] ^= (u << 7) | (u >>> 25); u = x[12] + x[15]; x[13] ^= (u << 9) | (u >>> 23);
    u = x[13] + x[12]; x[14] ^= (u << 13) | (u >>> 19); u = x[14] + x[13]; x[15] ^= (u << 18) | (u >>> 14);
  }
  for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
}

// X (32r words) -> X, using Y (32r words) and t (16 words) as scratch
function blockMix(X, Y, t, x, r) {
  const last = (2 * r - 1) * 16;
  for (let i = 0; i < 16; i++) t[i] = X[last + i];
  for (let i = 0; i < 2 * r; i++) {
    for (let j = 0; j < 16; j++) t[j] ^= X[i * 16 + j];
    salsa208(t, x);
    const dst = ((i & 1) * r + (i >> 1)) * 16;   // even blocks first, then odd ones
    for (let j = 0; j < 16; j++) Y[dst + j] = t[j];
  }
  X.set(Y);
}

function roMix(block, r, N) {
  const words = 32 * r;
  const X = new Uint32Array(words);
  const Y = new Uint32Array(words);
  const V = new Uint32Array(words * N);
  const t = new Uint32Array(16);
  const x = new Uint32Array(16);
  for (let i = 0; i < words; i++) {
    const o = i * 4;
    X[i] = (block[o] | (block[o + 1] << 8) | (block[o + 2] << 16) | (block[o + 3] << 24)) >>> 0;
  }
  for (let i = 0; i < N; i++) { V.set(X, i * words); blockMix(X, Y, t, x, r); }
  for (let i = 0; i < N; i++) {
    const j = X[(2 * r - 1) * 16] & (N - 1);
    const base = j * words;
    for (let k = 0; k < words; k++) X[k] ^= V[base + k];
    blockMix(X, Y, t, x, r);
  }
  for (let i = 0; i < words; i++) {
    const o = i * 4;
    const w = X[i];
    block[o] = w & 0xff; block[o + 1] = (w >>> 8) & 0xff; block[o + 2] = (w >>> 16) & 0xff; block[o + 3] = (w >>> 24) & 0xff;
  }
}

function scryptSync(password, salt, keylen, opts = {}) {
  const N = opts.N ?? opts.cost ?? 16384;
  const r = opts.r ?? opts.blockSize ?? 8;
  const p = opts.p ?? opts.parallelization ?? 1;
  if (N < 2 || (N & (N - 1)) !== 0) throw new RangeError('crypto-shim: N must be a power of two > 1');
  const pw = toBytes(password);
  const B = pbkdf2Sha256Once(pw, toBytes(salt), 128 * r * p);
  for (let i = 0; i < p; i++) roMix(B.subarray(i * 128 * r, (i + 1) * 128 * r), r, N);
  return pbkdf2Sha256Once(pw, B, keylen);
}

module.exports = { createHash, createHmac, scryptSync, randomBytes, timingSafeEqual };
