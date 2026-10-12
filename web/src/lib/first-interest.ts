import type { Ref } from "vue";
import { nextTick } from "vue";

/**
 * Keep a hover or menu overlay out of its row until the first interest with it.
 *
 * A reka-ui Tooltip, ContextMenu or DropdownMenu mounts its whole tree (root, trigger, portal content)
 * the moment its row renders, though it shows nothing until someone hovers or clicks. A list of N rows
 * holds N idle overlays. The wrappers built on this render the bare trigger until the first pointer enter
 * or focus on it, then the real overlay, which stays mounted after that.
 *
 * pointerenter, not pointerdown: a touch pointer enters before it goes down, so the overlay is mounted
 * before the press lands and a tap that reveals it still sees its own pointerdown.
 *
 * Mounting swaps the bare trigger for a new element, which drops keyboard focus. Call this just before
 * flipping the flag, then call the function it returns: it hands focus back to the trigger if it had it.
 */
export function keepFocusAcrossMount(root: Ref<HTMLElement | null>): () => void {
  const hadFocus = root.value?.contains(document.activeElement) ?? false;
  return () => {
    if (!hadFocus) return;
    void nextTick(() => root.value?.querySelector<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")?.focus());
  };
}
