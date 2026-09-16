/**
 * next-paint - hidden-tab-safe "run this after the next frame" scheduling.
 *
 * WHY THIS EXISTS. `requestAnimationFrame` is the correct way to defer work until after the
 * browser has painted - but Chrome PAUSES animation frames entirely while
 * `document.visibilityState === "hidden"` (a background tab, an occluded window, a headless
 * capture). A bare rAF used as a ONE-SHOT gate therefore never fires there: no error, no
 * rejection, no timeout - the callback simply never runs, and whatever it was going to reveal
 * stays hidden with no way for the user to un-stick it. A `document.hidden` check at call time
 * does not cover it: a visible tab that is occluded (or captured headless) still reports
 * `hidden === false` while producing no frames.
 *
 * THE CONTRACT: race the frame against a timer and let whichever arrives first win, exactly once.
 * A painting tab is unchanged - rAF fires in ~16ms, far inside the fallback, so the callback still
 * runs after a real paint. A tab that never paints falls through to the timer instead of hanging.
 *
 * Use this instead of a bare `requestAnimationFrame` for any one-shot gate whose result the user
 * must eventually see. A bare rAF is still correct for continuous animation loops and for
 * coalescing repeated work (scroll/resize sync), where "paused while nobody is looking" is the
 * desired behavior - this helper is deliberately not a blanket replacement.
 *
 * Local port of the shared UI kit's `lib/motion/next-paint` helper. This app does not depend on
 * the kit package, so the helper is vendored here rather than imported; keep the behavior
 * identical so callers need no change if it is ever swapped for the kit import.
 */

/** Fallback delay. Comfortably longer than a 60Hz frame (~16ms) so a visible tab always wins. */
const NEXT_PAINT_FALLBACK_MS = 200;

/**
 * Run `callback` after the next paint, or after `fallbackMs` if frames are paused.
 * Runs at most once. Returns a cancel function (safe to call after it has already run).
 */
export function onNextPaint(callback: () => void, fallbackMs: number = NEXT_PAINT_FALLBACK_MS): () => void {
  if (typeof window === "undefined") {
    // No DOM, so there is no paint to wait for - run synchronously.
    callback();
    return () => {};
  }

  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
  };

  const runOnce = (): void => {
    if (done) return;
    done = true;
    cancel();
    callback();
  };

  frame = window.requestAnimationFrame(runOnce);
  timer = setTimeout(runOnce, fallbackMs);

  return () => {
    done = true;
    cancel();
  };
}
