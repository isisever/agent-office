// QR encoder (src/qrcodegen, vendored): node --test app/test/qrcodegen.test.mjs
// Structural invariants of the symbols it draws (finder, timing, format and version areas) and the standard
// format / version bit vectors. The encoder was also checked by decoding its output with a real decoder (jsQR).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeText, toSvg, formatBits, versionBits, numDataCodewords, alignmentPositions } from '../src/qrcodegen/qrcodegen.mjs'

const PAIR_URL = 'agentoffice://pair?v=1&c=apple-banana-cherry-delta-echo&n=' + encodeURIComponent('Savaş’ın MacBook Pro')
  + '&k=' + 'ab'.repeat(32) + '&caps=ctl'

/** The 15 format bits read back from the first copy (around the top-left finder), bit 14 first. */
function readFormat(m) {
  const at = (x, y) => (m[y][x] ? 1 : 0)
  const bits = []
  for (let i = 0; i <= 5; i++) bits[i] = at(8, i)
  bits[6] = at(8, 7); bits[7] = at(8, 8); bits[8] = at(7, 8)
  for (let i = 9; i < 15; i++) bits[i] = at(14 - i, 8)
  return bits.reduce((acc, b, i) => acc | (b << i), 0)
}
/** The same bits from the second copy (split between the other two finders). */
function readFormat2(m) {
  const size = m.length
  let v = 0
  for (let i = 0; i < 8; i++) v |= (m[8][size - 1 - i] ? 1 : 0) << i
  for (let i = 8; i < 15; i++) v |= (m[size - 15 + i][8] ? 1 : 0) << i
  return v
}
function assertFinder(m, x0, y0) {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
      assert.equal(m[y0 + dy][x0 + dx], ring !== 2, `finder at ${x0},${y0} module ${dx},${dy}`)
    }
  }
}

test('format and version bit vectors match the standard tables', () => {
  // ISO/IEC 18004 Table C.1, level M: mask 0 → 101010000010010, mask 5 → 100000011001110
  assert.equal(formatBits(0), 0b101010000010010)
  assert.equal(formatBits(5), 0b100000011001110)
  // Table D.1: version 7 → 0x07C94, version 15 → 0x0F928
  assert.equal(versionBits(7), 0x07C94)
  assert.equal(versionBits(15), 0x0F928)
})

test('capacity and alignment positions', () => {
  // level M data codewords: v1 16, v7 124, v10 216, v15 415
  assert.deepEqual([1, 7, 10, 15].map(numDataCodewords), [16, 124, 216, 415])
  assert.deepEqual(alignmentPositions(1), [])
  assert.deepEqual(alignmentPositions(2), [6, 18])
  assert.deepEqual(alignmentPositions(7), [6, 22, 38])
  assert.deepEqual(alignmentPositions(15), [6, 26, 48, 70])
})

test('the version is the smallest that holds the bytes', () => {
  assert.equal(encodeText('').version, 1)
  assert.equal(encodeText('x'.repeat(14)).version, 1) // 4 + 8 + 14*8 = 124 ≤ 128
  assert.equal(encodeText('x'.repeat(15)).version, 2)
  assert.throws(() => encodeText('x'.repeat(413)), RangeError)
  assert.equal(encodeText('x'.repeat(412)).version, 15)
})

for (const text of ['A', 'hello world', PAIR_URL, 'x'.repeat(300)]) {
  test(`structure: ${text.slice(0, 24)}… (${text.length} chars)`, () => {
    const q = encodeText(text)
    const m = q.modules
    const size = q.size
    assert.equal(size, q.version * 4 + 17)
    assert.equal(m.length, size)
    for (const row of m) assert.equal(row.length, size)
    assertFinder(m, 0, 0)
    assertFinder(m, size - 7, 0)
    assertFinder(m, 0, size - 7)
    // separators: light
    for (let i = 0; i < 8; i++) {
      assert.equal(m[7][i], false); assert.equal(m[i][7], false)
      assert.equal(m[7][size - 1 - i], false); assert.equal(m[i][size - 8], false)
      assert.equal(m[size - 8][i], false); assert.equal(m[size - 1 - i][7], false)
    }
    // timing patterns alternate between the finders
    for (let i = 8; i < size - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0, `timing row ${i}`)
      assert.equal(m[i][6], i % 2 === 0, `timing col ${i}`)
    }
    assert.equal(m[size - 8][8], true, 'dark module')
    assert.equal(readFormat(m), formatBits(q.mask))
    assert.equal(readFormat2(m), formatBits(q.mask))
    if (q.version >= 7) {
      const vb = versionBits(q.version)
      for (let i = 0; i < 18; i++) {
        const bit = ((vb >>> i) & 1) === 1
        const a = size - 11 + (i % 3)
        const b = Math.floor(i / 3)
        assert.equal(m[b][a], bit, `version bit ${i} (top right)`)
        assert.equal(m[a][b], bit, `version bit ${i} (bottom left)`)
      }
    }
    // alignment patterns: dark center, light ring
    const pos = alignmentPositions(q.version)
    for (const y of pos) for (const x of pos) {
      if ((x === 6 && y === 6) || (x === 6 && y === pos.at(-1)) || (x === pos.at(-1) && y === 6)) continue
      assert.equal(m[y][x], true)
      assert.equal(m[y - 1][x], false)
      assert.equal(m[y][x + 1], false)
      assert.equal(m[y + 2][x + 2], true)
    }
  })
}

test('the pairing URL fits and the SVG has a 4-module quiet zone', () => {
  const q = encodeText(PAIR_URL)
  assert.ok(q.version <= 10)
  const svg = toSvg(q.modules)
  const dim = q.size + 8
  assert.ok(svg.startsWith('<svg'))
  assert.ok(svg.includes(`viewBox="0 0 ${dim} ${dim}"`))
  assert.ok(svg.includes('M4,4h1v1h-1z'), 'the top-left finder starts at the quiet zone edge')
  assert.ok(!/M[0-3],|,[0-3]h/.test(svg), 'nothing is drawn inside the quiet zone')
})
