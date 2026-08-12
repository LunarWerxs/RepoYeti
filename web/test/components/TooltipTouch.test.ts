import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Touch gestures for tooltips (kit: components/ui/tooltip/touch.ts).
 *
 * reka-ui drops `pointermove` when `pointerType === "touch"`, so on a phone every tooltip is
 * unreachable — including the InfoHint text that has no other surface. The kit adds a long press
 * for action controls and a tap for informational ones. What these tests protect is the line
 * between them: a hold must reveal WITHOUT firing the button, and a plain tap must fire the button
 * WITHOUT revealing anything. Get that wrong and every tooltipped control on mobile becomes either
 * a two-tap control or an accidental one.
 */

/** reka mirrors open state onto the trigger as data-state — no need to dig through the portal. */
function state(el: Element | null): string | null {
  return el?.getAttribute("data-state") ?? null;
}

const Harness = defineComponent({
  components: { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger },
  props: {
    touch: { type: String, default: "long-press" },
    disabled: { type: Boolean, default: undefined },
  },
  emits: ["activate", "elsewhere"],
  template: `
    <TooltipProvider :disabled="disabled">
      <Tooltip>
        <TooltipTrigger as-child :touch="touch">
          <button type="button" data-testid="trigger" @click="$emit('activate')">Fetch</button>
        </TooltipTrigger>
        <TooltipContent>Fetches from the remote</TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger as-child :touch="touch">
          <button type="button" data-testid="second">Pull</button>
        </TooltipTrigger>
        <TooltipContent>Pulls from the remote</TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <button type="button" data-testid="elsewhere" @click="$emit('elsewhere')">Elsewhere</button>
  `,
});

const mounted: Array<{ unmount: () => void }> = [];

function mountHarness(props: Record<string, unknown> = {}) {
  const wrapper = mount(Harness, { props, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, trigger: wrapper.get('[data-testid="trigger"]') };
}

/** A finger, as the DOM reports one. `isPrimary` matters: a second touch must not start a gesture. */
const finger = (over: Record<string, unknown> = {}) => ({
  pointerType: "touch",
  pointerId: 1,
  isPrimary: true,
  clientX: 100,
  clientY: 100,
  ...over,
});

describe("tooltip touch gestures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Unmount rather than wiping innerHTML: a portalled TooltipContent left mounted over a nulled
    // container makes Vue's next patch throw out of band.
    while (mounted.length) mounted.pop()?.unmount();
    vi.useRealTimers();
  });

  describe("long press (the default, for action controls)", () => {
    it("reveals the tooltip after the hold", async () => {
      const { trigger } = mountHarness();
      expect(state(trigger.element)).toBe("closed");

      await trigger.trigger("pointerdown", finger());
      await vi.advanceTimersByTimeAsync(600);

      expect(state(trigger.element)).not.toBe("closed");
    });

    it("swallows the click the hold ends with, so the action does not also fire", async () => {
      const { wrapper, trigger } = mountHarness();

      await trigger.trigger("pointerdown", finger());
      await vi.advanceTimersByTimeAsync(600);
      await trigger.trigger("pointerup", finger());
      await trigger.trigger("click");

      expect(wrapper.emitted("activate")).toBeUndefined();
    });

    it("leaves a plain tap alone — button fires, nothing is revealed", async () => {
      const { wrapper, trigger } = mountHarness();

      await trigger.trigger("pointerdown", finger());
      await vi.advanceTimersByTimeAsync(150);
      await trigger.trigger("pointerup", finger());
      await trigger.trigger("click");

      expect(wrapper.emitted("activate")).toHaveLength(1);
      expect(state(trigger.element)).toBe("closed");
    });

    it("abandons the hold once the finger moves — that is a scroll, not a press", async () => {
      const { trigger } = mountHarness();

      await trigger.trigger("pointerdown", finger());
      await trigger.trigger("pointermove", finger({ clientY: 160 }));
      await vi.advanceTimersByTimeAsync(600);

      expect(state(trigger.element)).toBe("closed");
    });

    it("abandons the hold when the browser cancels the pointer", async () => {
      const { trigger } = mountHarness();

      await trigger.trigger("pointerdown", finger());
      await trigger.trigger("pointercancel", finger());
      await vi.advanceTimersByTimeAsync(600);

      expect(state(trigger.element)).toBe("closed");
    });

    it("stays out of the way of a mouse, so hover behaviour is untouched", async () => {
      const { trigger } = mountHarness();

      await trigger.trigger("pointerdown", finger({ pointerType: "mouse" }));
      await vi.advanceTimersByTimeAsync(600);

      expect(state(trigger.element)).toBe("closed");
    });

    it("ignores a non-primary touch, so a second finger cannot start a gesture", async () => {
      const { trigger } = mountHarness();

      await trigger.trigger("pointerdown", finger({ isPrimary: false, pointerId: 2 }));
      await vi.advanceTimersByTimeAsync(600);

      expect(state(trigger.element)).toBe("closed");
    });

    it("still eats the click after a long hold spent reading the tooltip", async () => {
      const { wrapper, trigger } = mountHarness();

      // The swallow is armed on RELEASE, not on reveal. Armed at reveal it would have expired under
      // any hold long enough to actually read the text, and the release would fire the action.
      await trigger.trigger("pointerdown", finger());
      await vi.advanceTimersByTimeAsync(3000);
      await trigger.trigger("pointerup", finger());
      await trigger.trigger("click");

      expect(wrapper.emitted("activate")).toBeUndefined();
      expect(state(trigger.element)).not.toBe("closed");
    });

    it("keeps the reveal even if the finger shifts after the tooltip appears", async () => {
      const { wrapper, trigger } = mountHarness();

      await trigger.trigger("pointerdown", finger());
      await vi.advanceTimersByTimeAsync(600);
      // Abandoning here would also drop the click swallow, and the release would fire the action.
      await trigger.trigger("pointermove", finger({ clientY: 160 }));
      await trigger.trigger("pointerup", finger({ clientY: 160 }));
      await trigger.trigger("click");

      expect(state(trigger.element)).not.toBe("closed");
      expect(wrapper.emitted("activate")).toBeUndefined();
    });

    it("does not reveal if tooltips get switched off mid-hold", async () => {
      const { wrapper, trigger } = mountHarness();

      await trigger.trigger("pointerdown", finger());
      await vi.advanceTimersByTimeAsync(200);
      await wrapper.setProps({ disabled: true });
      await vi.advanceTimersByTimeAsync(600);

      expect(state(trigger.element)).toBe("closed");
    });

    it("only eats a click on the control it was held on", async () => {
      const { wrapper, trigger } = mountHarness();

      // A hold can end with no click at all: the OS interrupts it, or the finger slides off before
      // release. The swallow must not sit armed and eat whatever the user taps next.
      await trigger.trigger("pointerdown", finger());
      await vi.advanceTimersByTimeAsync(600);
      await wrapper.get('[data-testid="elsewhere"]').trigger("click");

      expect(wrapper.emitted("elsewhere")).toHaveLength(1);
    });

    it("obeys the app-wide 'show tooltips' kill switch", async () => {
      const { trigger } = mountHarness({ disabled: true });

      await trigger.trigger("pointerdown", finger());
      await vi.advanceTimersByTimeAsync(600);

      expect(state(trigger.element)).toBe("closed");
    });
  });

  describe("tap (for informational triggers that do nothing when clicked)", () => {
    it("reveals on release", async () => {
      const { trigger } = mountHarness({ touch: "tap" });

      await trigger.trigger("pointerdown", finger());
      await trigger.trigger("pointerup", finger());

      expect(state(trigger.element)).not.toBe("closed");
    });

    it("does not reveal when the tap turns out to be a scroll", async () => {
      const { trigger } = mountHarness({ touch: "tap" });

      await trigger.trigger("pointerdown", finger());
      await trigger.trigger("pointermove", finger({ clientY: 200 }));
      await trigger.trigger("pointerup", finger());

      expect(state(trigger.element)).toBe("closed");
    });

    it("closes again on a second tap", async () => {
      const { trigger } = mountHarness({ touch: "tap" });

      await trigger.trigger("pointerdown", finger());
      await trigger.trigger("pointerup", finger());
      expect(state(trigger.element)).not.toBe("closed");

      await trigger.trigger("pointerdown", finger());
      await trigger.trigger("pointerup", finger());

      expect(state(trigger.element)).toBe("closed");
    });
  });

  // Adding the gestures meant taking reka's open state over (a pinned tooltip has to outlive the
  // close reka fires on release). These guard the two things that hand-off can quietly break for
  // everyone, touch or not.
  describe("desktop behaviour, unchanged", () => {
    it("still reveals on a mouse hover", async () => {
      const { trigger } = mountHarness();

      await trigger.trigger("pointermove", { pointerType: "mouse" });
      await vi.advanceTimersByTimeAsync(50);

      expect(state(trigger.element)).not.toBe("closed");
    });

    it("leaves the provider deciding whatever the tooltip did not ask about", async () => {
      const { trigger } = mountHarness({ disabled: true });

      // `disabled` belongs to TooltipProvider and Tooltip never sets it. Forwarding raw props would
      // hand reka a coerced `false` for it and silently override the app-wide kill switch.
      await trigger.trigger("pointermove", { pointerType: "mouse" });
      await vi.advanceTimersByTimeAsync(50);

      expect(state(trigger.element)).toBe("closed");
    });
  });

  describe("dismissal", () => {
    it("hands control back to reka once the gesture has settled", async () => {
      const { trigger } = mountHarness();

      await trigger.trigger("pointerdown", finger());
      await vi.advanceTimersByTimeAsync(600);
      await trigger.trigger("pointerup", finger());
      await trigger.trigger("click");
      expect(state(trigger.element)).not.toBe("closed");

      // The refusal is time-boxed on purpose. Held forever it would also block reka's own
      // dismissals — outside pointerdown, Escape, and the broadcast that closes one tooltip when
      // another opens — none of which this wrapper reimplements. Escape stands in for all three:
      // it reaches reka through the same DismissableLayer the other two use.
      await vi.advanceTimersByTimeAsync(1000);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await vi.advanceTimersByTimeAsync(50);

      expect(state(trigger.element)).toBe("closed");
    });

    it("shows one at a time — revealing a second tooltip puts the first away", async () => {
      const { wrapper, trigger } = mountHarness({ touch: "tap" });
      const second = wrapper.get('[data-testid="second"]');

      await trigger.trigger("pointerdown", finger());
      await trigger.trigger("pointerup", finger());
      await vi.advanceTimersByTimeAsync(600);
      expect(state(trigger.element)).not.toBe("closed");

      // reka's own one-at-a-time broadcast never lands here (it dispatches a non-bubbling event on
      // document and listens on window), and its touch outside-dismiss waits for the very click a
      // gesture swallows — so without our own outside-press watch, both would stay open.
      await second.trigger("pointerdown", finger({ pointerId: 2 }));
      await second.trigger("pointerup", finger({ pointerId: 2 }));
      await vi.advanceTimersByTimeAsync(50);

      expect(state(second.element)).not.toBe("closed");
      expect(state(trigger.element)).toBe("closed");
    });

    it("closes on a scroll, the one dismissal reka does not do", async () => {
      const { wrapper, trigger } = mountHarness({ touch: "tap" });

      await trigger.trigger("pointerdown", finger());
      await trigger.trigger("pointerup", finger());
      expect(state(trigger.element)).not.toBe("closed");

      await vi.advanceTimersByTimeAsync(600);
      document.dispatchEvent(new Event("scroll", { bubbles: true }));
      await wrapper.vm.$nextTick();

      expect(state(trigger.element)).toBe("closed");
    });

    it("survives the pointerleave and click that a finger release fires", async () => {
      const { trigger } = mountHarness();

      await trigger.trigger("pointerdown", finger());
      await vi.advanceTimersByTimeAsync(600);
      // reka closes on both of these. The pin has to outlast them, or the tooltip a hold just
      // revealed would vanish the instant the finger came off the glass.
      await trigger.trigger("pointerup", finger());
      await trigger.trigger("pointerleave", finger());
      await trigger.trigger("click");

      expect(state(trigger.element)).not.toBe("closed");
    });
  });
});
