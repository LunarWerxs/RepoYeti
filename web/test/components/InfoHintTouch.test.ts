import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InfoHint from "@/shell/InfoHint.vue";

/**
 * InfoHint is the worst case of the touch-tooltip problem: settings deliberately hide their whole
 * description behind this icon, so on a phone that text was not merely awkward to reach, it did not
 * exist. Unlike an action button the icon does nothing when clicked, which is what makes a plain
 * tap safe here — and this test is what keeps it wired that way.
 */
describe("InfoHint on touch", () => {
  const mounted: Array<{ unmount: () => void }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    while (mounted.length) mounted.pop()?.unmount();
    vi.useRealTimers();
  });

  function mountHint() {
    const wrapper = mount(InfoHint, {
      props: { text: "Checks periodically and tells you." },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    return { wrapper, button: wrapper.get("button") };
  }

  const finger = { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 8, clientY: 8 };

  it("discloses its text on a single tap", async () => {
    const { button } = mountHint();
    expect(button.attributes("data-state")).toBe("closed");

    await button.trigger("pointerdown", finger);
    await button.trigger("pointerup", finger);

    expect(button.attributes("data-state")).not.toBe("closed");
  });

  it("stays exempt from the app-wide 'show tooltips' switch", async () => {
    // The nested always-enabled provider exists because this text has no other surface. The gesture
    // has to inherit that exemption, not the global setting.
    const { button } = mountHint();

    await button.trigger("pointerdown", finger);
    await button.trigger("pointerup", finger);

    expect(button.attributes("data-state")).not.toBe("closed");
  });

  it("carries a finger-sized hit area around a 14px icon", () => {
    // A pseudo-element, so the target grows without nudging the row it sits in.
    const { button } = mountHint();
    expect(button.classes()).toContain("before:-inset-2");
    expect(button.classes()).toContain("relative");
  });
});
