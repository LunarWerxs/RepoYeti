// The scroll rules behind the auto-hiding History activity overview. Worth pinning tightly,
// because the whole feel of it lives in the difference between "the list moved up a bit" and
// "the reader asked for the header back" — and a naive reveal-on-any-upward-pixel version
// flickers during ordinary reading, which is exactly what these thresholds prevent.
import { describe, expect, it } from "vitest";
import { defineComponent, h, ref, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { useAutoHideOnScroll, type AutoHideOptions } from "@/lib/auto-hide-scroll";

/** Mount the composable against a real element we can drive scrollTop on. */
function harness(options: AutoHideOptions = {}) {
  const el = ref<HTMLElement | null>(null);
  let api: ReturnType<typeof useAutoHideOnScroll>;
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useAutoHideOnScroll(el, options);
        return () => h("div", { ref: (r) => (el.value = r as HTMLElement) });
      },
    }),
    { attachTo: document.body },
  );
  // jsdom won't scroll a div with no overflow, so drive scrollTop directly and fire the event —
  // which is exactly what the composable listens to.
  const scrollTo = async (top: number) => {
    Object.defineProperty(el.value, "scrollTop", { value: top, writable: true, configurable: true });
    el.value!.dispatchEvent(new Event("scroll"));
    await nextTick();
  };
  // `api` is assigned synchronously in setup() above, which mount() has already run.
  return { wrapper, scrollTo, api: api!, el };
}

describe("useAutoHideOnScroll", () => {
  it("starts visible, so a fresh panel (or a screenshot of one) shows the header", () => {
    const { api, wrapper } = harness();
    expect(api.hidden.value).toBe(false);
    wrapper.unmount();
  });

  it("hides once you have read past the depth threshold", async () => {
    const { api, scrollTo, wrapper } = harness({ hideAfter: 48 });
    await scrollTo(30); // shallow — a list barely taller than its viewport must not play peekaboo
    expect(api.hidden.value).toBe(false);
    await scrollTo(200);
    expect(api.hidden.value).toBe(true);
    wrapper.unmount();
  });

  it("ignores small upward drift — the reason it doesn't flicker while reading", async () => {
    const { api, scrollTo, wrapper } = harness({ pullToReveal: 90 });
    await scrollTo(400);
    expect(api.hidden.value).toBe(true);
    // A wheel wobble / momentum tail: several small upward moves that never add up to a gesture.
    await scrollTo(390);
    await scrollTo(382);
    await scrollTo(375);
    expect(api.hidden.value).toBe(true);
    wrapper.unmount();
  });

  it("reveals on one committed pull upward", async () => {
    const { api, scrollTo, wrapper } = harness({ pullToReveal: 90 });
    await scrollTo(400);
    expect(api.hidden.value).toBe(true);
    await scrollTo(280); // 120px up in one go
    expect(api.hidden.value).toBe(false);
    wrapper.unmount();
  });

  it("resets a partial pull when you scroll back down", async () => {
    const { api, scrollTo, wrapper } = harness({ pullToReveal: 90 });
    await scrollTo(400);
    await scrollTo(340); // 60px up — not yet enough
    expect(api.hidden.value).toBe(true);
    await scrollTo(360); // interrupted by downward movement → the pull doesn't carry over
    await scrollTo(310); // another 50px up; 60+50 would have crossed 90 if it accumulated
    expect(api.hidden.value).toBe(true);
    wrapper.unmount();
  });

  it("always reveals at the top, without needing a pull", async () => {
    const { api, scrollTo, wrapper } = harness({ pullToReveal: 90, topReveal: 8 });
    await scrollTo(400);
    expect(api.hidden.value).toBe(true);
    await scrollTo(0); // e.g. a reload or scope switch jumping the list home
    expect(api.hidden.value).toBe(false);
    wrapper.unmount();
  });

  it("reveal() forces it back for programmatic jumps", async () => {
    const { api, scrollTo, wrapper } = harness();
    await scrollTo(400);
    expect(api.hidden.value).toBe(true);
    api.reveal();
    expect(api.hidden.value).toBe(false);
    wrapper.unmount();
  });

  it("detaches its listener on unmount", async () => {
    const { api, el, wrapper } = harness();
    const node = el.value!;
    wrapper.unmount();
    Object.defineProperty(node, "scrollTop", { value: 500, writable: true, configurable: true });
    node.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(api.hidden.value).toBe(false); // never saw the scroll
  });
});
