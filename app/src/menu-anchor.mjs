/**
 * v3.157 Where a popup menu opens so it sits directly above its button: left edges aligned, the menu's bottom edge a
 * small gap above the button's top, kept inside the window (flips below the button only when there is no room above).
 * All numbers are viewport pixels. → { left, top }
 * @param {{ left: number, top: number, bottom: number }} anchor the button's bounding box
 * @param {{ width: number, height: number }} menu the menu's size
 * @param {{ width: number, height: number }} view the window's inner size
 * @param {number} [gap] @param {number} [margin] the least distance to the window's edges
 */
export function anchorAbove(anchor, menu, view, gap = 6, margin = 8) {
  const maxLeft = Math.max(margin, view.width - menu.width - margin);
  const left = Math.min(Math.max(anchor.left, margin), maxLeft);
  let top = anchor.top - gap - menu.height;
  if (top < margin) {
    const below = anchor.bottom + gap;
    top = below + menu.height + margin <= view.height ? below : margin;
  }
  top = Math.min(Math.max(top, margin), Math.max(margin, view.height - menu.height - margin));
  return { left, top };
}
