/**
 * Bring an element into view by moving exactly ONE scroller.
 *
 * `Element.scrollIntoView()` is banned by lint here, and the reason is a live
 * defect from Phase 1: it scrolls *every* scrollable ancestor, so bringing a
 * line into a console's own box also scrolled the page — and, on a phone, the
 * horizontal one too, which is the sideways yank that made the terminal feel
 * broken. There is no option that turns that off; `block`/`inline: 'nearest'`
 * only changes how far each ancestor moves, not how many of them do.
 *
 * So: find the one scroller that actually owns this element, and set its
 * `scrollTop`. Nothing above it moves.
 *
 * The offset is measured from bounding rects rather than `offsetTop`, because
 * `offsetTop` is relative to the nearest positioned ancestor — which for a
 * virtualized row is the absolutely-positioned spacer, not the scroller, and
 * gives an answer that is right only by accident.
 */

/** The nearest ancestor that actually scrolls vertically, or null for the page. */
export function scrollerOf(el: Element): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const style = getComputedStyle(node);
    const scrolls = /auto|scroll|overlay/.test(style.overflowY);
    if (scrolls && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Centre `el` in its own scroller. A no-op when nothing needs to move.
 *
 * `block` mirrors the option people reach for on `scrollIntoView`: `center`
 * puts the element mid-viewport, `nearest` moves only if it is out of view —
 * which is the right default for a live log, where a jump on every append is
 * worse than a line sitting near an edge.
 */
export function scrollIntoScroller(el: Element, block: 'center' | 'nearest' = 'center'): void {
  const scroller = scrollerOf(el);
  if (!scroller) return;
  const box = scroller.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const above = rect.top - box.top;
  const below = rect.bottom - box.bottom;

  if (block === 'nearest') {
    if (above >= 0 && below <= 0) return;
    scroller.scrollTop += above < 0 ? above : below;
    return;
  }
  scroller.scrollTop += above - (scroller.clientHeight - rect.height) / 2;
}
