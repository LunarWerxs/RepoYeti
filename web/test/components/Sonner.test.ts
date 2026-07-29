import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { toast } from "vue-sonner";
import { Toaster } from "@/components/ui/sonner";

/**
 * vue-sonner puts its close button at the toast's TOP-LEFT by default, which renders as a stray
 * control floating beside the card instead of that card's dismiss. The kit wrapper defaults it to
 * top-right to match every other dismiss (DialogScrollContent, SheetContent). This is a kit-owned
 * file — fix it in ../lunarwerx-ui and re-sync, never here.
 */
describe("Toaster", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("puts the close button on the right", async () => {
    const wrapper = mount(Toaster, { attachTo: document.body, props: { closeButton: true } });
    toast.success("pushed");
    await flush();
    await wrapper.vm.$nextTick();

    const el = document.querySelector("[data-close-button-position]");
    expect(el?.getAttribute("data-close-button-position")).toBe("top-right");
    wrapper.unmount();
  });

  it("still lets a caller move it back", async () => {
    const wrapper = mount(Toaster, {
      attachTo: document.body,
      props: { closeButton: true, closeButtonPosition: "top-left" },
    });
    toast.success("pushed");
    await flush();
    await wrapper.vm.$nextTick();

    const el = document.querySelector("[data-close-button-position]");
    expect(el?.getAttribute("data-close-button-position")).toBe("top-left");
    wrapper.unmount();
  });
});
