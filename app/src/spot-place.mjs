// Placement of the What's-new spotlight ring and its tooltip (contract v3.150). Pure: a target box and the viewport in,
// fixed-position styles out, so the overlay can be recomputed whenever the target moves (resize, scroll, a panel opening).

/** @typedef {{ left: number, top: number, width: number, height: number, bottom: number }} Box */

const PAD = 6;
const TIP_W = 260;
const TIP_H = 60;

/**
 * @param {Box} box the target's getBoundingClientRect()
 * @param {number} vw viewport width
 * @param {number} vh viewport height
 * @returns {{ ring: { left: number, top: number, width: number, height: number },
 *   tip: { left: number, top?: number, bottom?: number } }}
 */
export function placeSpot(box, vw, vh) {
  const ring = { left: box.left - PAD, top: box.top - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2 };
  const left = Math.max(8, Math.min(vw - TIP_W - 8, box.left));
  const below = box.bottom + TIP_H < vh;
  if (below) return { ring, tip: { left, top: Math.max(8, Math.min(box.bottom + PAD + 8, vh - TIP_H)) } };
  // above: keep the tooltip on screen even when the target starts above the viewport
  return { ring, tip: { left, bottom: Math.max(8, Math.min(vh - 8 - 24, vh - box.top + PAD + 8)) } };
}

/** True when two placements differ by at least one pixel (so a tracking loop only writes styles on a real move). */
export function movedSpot(a, b) {
  if (!a || !b) return true;
  return ['left', 'top', 'width', 'height'].some((k) => Math.abs(a.ring[k] - b.ring[k]) >= 1);
}
