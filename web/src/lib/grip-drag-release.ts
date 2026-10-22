// The resting height a grip-drag glide (lib/grip-drag.ts) lands on when a dragged viewport is released.
// Opt-in ("grip-drag-release" in kit.config): only an app whose glide resets a dragged height calls it.

/**
 * The height a scroll viewport will settle at once its explicit height is released: the content
 * extent, clamped to `cap` (the stylesheet's max-height). The glide needs this to be exact —
 * overshoot it and the reset still ends in the snap it exists to avoid.
 *
 * `scrollHeight` CANNOT answer this: it never reports less than the element's own clientHeight, so
 * a viewport dragged TALLER than its content just hands the drag height back. Measuring first
 * child's top to last child's bottom is independent of the viewport's current size, and the gaps
 * and margins between children fall inside the span for free.
 */
export function releasedHeight(el: HTMLElement | null | undefined, cap: number): number {
  if (!el) return cap;
  const kids = el.children;
  const first = kids[0]?.getBoundingClientRect();
  const last = kids[kids.length - 1]?.getBoundingClientRect();
  if (!first || !last) return Math.min(el.scrollHeight, cap);
  const style = getComputedStyle(el);
  const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  return Math.min(Math.ceil(last.bottom - first.top + padding), cap);
}
