/**
 * The Accept control's touch behaviour (F087).
 *
 * F087 read a long press on the Accept chip as a broken button: the hold opens the accept-hint
 * tooltip and the shared touch layer then swallows the click that ends it, so the region does not
 * flip to accepted. That is the deliberate contract of the kit (components/ui/tooltip/touch.ts,
 * guarded by TooltipTouch.test.ts) — a hold reveals, a tap acts — and this card's control is just
 * one more action control under it. These tests pin the card to that contract so a later "fix"
 * (e.g. `touch="tap"`, which would eat the ordinary tap instead) cannot turn Accept into a
 * two-tap control without a failure here.
 */
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConflictHunkCard from "@/components/conflicts/ConflictHunkCard.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";
import type { ConflictHunk, HunkResolution } from "@/types";

const hunk: ConflictHunk = {
  index: 1,
  line: 10,
  oursLabel: "HEAD",
  theirsLabel: "feature",
  oursText: "shared();\nours();\n",
  theirsText: "shared();\ntheirs();\n",
  raw: "<<<<<<< HEAD\nshared();\nours();\n=======\nshared();\ntheirs();\n>>>>>>> feature\n",
};

const resolution: HunkResolution = {
  index: 1,
  content: "shared();\nours();\ntheirs();\n",
  confidence: "high",
  note: "kept both sides",
  flags: [],
  droppedLines: [],
  inventedLines: [],
};

const mounted: Array<{ unmount: () => void }> = [];

function mountCard() {
  const updates: boolean[] = [];
  const wrapper = mount(
    {
      components: { TooltipProvider, ConflictHunkCard },
      data: () => ({ accepted: false, content: resolution.content }),
      template: `
        <TooltipProvider>
          <ConflictHunkCard
            :hunk="hunk"
            :resolution="resolution"
            v-model:accepted="accepted"
            v-model:content="content"
          />
        </TooltipProvider>
      `,
      computed: {
        hunk: () => hunk,
        resolution: () => resolution,
      },
      watch: {
        accepted: (v: boolean) => updates.push(v),
      },
    },
    { global: { plugins: [i18n] }, attachTo: document.body },
  );
  mounted.push(wrapper);
  return { wrapper, updates, button: wrapper.get('[role="checkbox"]') };
}

/** A finger, as the DOM reports one. */
const finger = () => ({
  pointerType: "touch",
  pointerId: 1,
  isPrimary: true,
  clientX: 100,
  clientY: 100,
});

describe("ConflictHunkCard accept control on touch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    while (mounted.length) mounted.pop()?.unmount();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("toggles acceptance on a plain tap", async () => {
    const { button, updates } = mountCard();

    await button.trigger("pointerdown", finger());
    await vi.advanceTimersByTimeAsync(150);
    await button.trigger("pointerup", finger());
    await button.trigger("click");

    expect(updates).toEqual([true]);
    // The tap must not double as a tooltip reveal.
    expect(button.attributes("data-state")).toBe("closed");
  });

  it("reveals the accept hint on a long press without also toggling", async () => {
    const { button, updates } = mountCard();

    await button.trigger("pointerdown", finger());
    await vi.advanceTimersByTimeAsync(600);
    await button.trigger("pointerup", finger());
    await button.trigger("click");

    // The tooltip opened — that IS the feedback — and the click that closed the gesture is eaten
    // so the region does not flip to accepted under the tooltip the owner is still reading.
    expect(button.attributes("data-state")).not.toBe("closed");
    expect(updates).toEqual([]);
  });
});
