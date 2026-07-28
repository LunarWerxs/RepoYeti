// Chrome-URL-bar behavior for a header that sits above a scroll area: it gets out of the way as
// you read down, and comes back when you deliberately pull up.
//
// The distinction that matters is between "scrolling up" and "asking for the header back". Reveal
// on ANY upward pixel and the header flickers in and out during ordinary reading — a wheel notch,
// a trackpad wobble, the rubber-band at the end of a flick all move the scroller up a few px. So
// upward movement ACCUMULATES and only crosses the line after a real gesture, and any downward
// movement resets that accumulator to zero. That is the "pull a certain way" feel: one committed
// swipe up brings it back, drifting does not.
//
// Being at the top is treated as its own reveal condition, not as an accumulated pull: arriving at
// the top of a list and finding the header still hidden reads as broken.
import { onBeforeUnmount, ref, watch, type Ref } from "vue";

export interface AutoHideOptions {
  /** Scroll depth (px) before hiding is allowed at all. Below this the header always shows, so a
   *  list barely taller than its viewport never plays hide-and-seek. */
  hideAfter?: number;
  /** Cumulative upward travel (px) in ONE gesture that counts as asking for the header back. */
  pullToReveal?: number;
  /** Within this many px of the top the header is always shown, regardless of direction. */
  topReveal?: number;
  /** Ignore movements smaller than this. Momentum tails and sub-pixel scroll deltas otherwise
   *  register as direction changes and reset the pull accumulator mid-gesture. */
  minDelta?: number;
}

export interface AutoHideApi {
  /** True while the header should be collapsed. Starts FALSE: a fresh panel (and any screenshot
   *  of one) shows the header, and hiding is something the reader has to cause. */
  hidden: Ref<boolean>;
  /** Force it back into view — for a programmatic scroll-to-top, or a fresh data load. */
  reveal(): void;
}

/**
 * Watch `el` and derive a `hidden` flag from how it is being scrolled. Re-attaches when the
 * element changes (the History panel's scroller unmounts with the section), and detaches on
 * unmount. The listener is passive and does nothing but arithmetic — no layout reads, so it
 * cannot cause scroll-linked jank.
 */
export function useAutoHideOnScroll(
  el: Ref<HTMLElement | null | undefined>,
  options: AutoHideOptions = {},
): AutoHideApi {
  const hideAfter = options.hideAfter ?? 48;
  const pullToReveal = options.pullToReveal ?? 90;
  const topReveal = options.topReveal ?? 8;
  const minDelta = options.minDelta ?? 2;

  const hidden = ref(false);
  let lastTop = 0;
  let pulledUp = 0;

  function reveal(): void {
    hidden.value = false;
    pulledUp = 0;
  }

  function onScroll(): void {
    const node = el.value;
    if (!node) return;
    const top = node.scrollTop;
    const delta = top - lastTop;
    lastTop = top;

    // At (or near) the top the header always belongs on screen.
    if (top <= topReveal) {
      pulledUp = 0;
      hidden.value = false;
      return;
    }
    if (Math.abs(delta) < minDelta) return;

    if (delta > 0) {
      // Reading downward: hide once past the depth threshold, and drop any partial pull — a
      // gesture interrupted by downward movement was not a request for the header.
      pulledUp = 0;
      if (top > hideAfter) hidden.value = true;
      return;
    }

    pulledUp += -delta;
    if (pulledUp >= pullToReveal) reveal();
  }

  watch(
    el,
    (node, previous) => {
      previous?.removeEventListener("scroll", onScroll);
      pulledUp = 0;
      lastTop = node?.scrollTop ?? 0;
      // A remount starts over rather than inheriting the last session's collapsed state.
      hidden.value = false;
      node?.addEventListener("scroll", onScroll, { passive: true });
    },
    { immediate: true, flush: "post" },
  );

  onBeforeUnmount(() => el.value?.removeEventListener("scroll", onScroll));

  return { hidden, reveal };
}
