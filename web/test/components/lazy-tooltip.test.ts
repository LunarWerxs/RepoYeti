import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import LazyTooltip from "@/components/LazyTooltip.vue";
import { TooltipProvider } from "@/components/ui/tooltip";

// A row of these used to mount a full reka tooltip per row before anyone hovered. Until the first
// pointer enter the trigger must render bare: reka stamps data-state on its trigger once the tooltip
// root exists, so its absence is the proof that no tooltip tree was mounted.
describe("LazyTooltip", () => {
  it("renders the bare trigger until the first pointer enter, then the real tooltip", async () => {
    const wrapper = mount(
      {
        components: { LazyTooltip, TooltipProvider },
        template: `<TooltipProvider><LazyTooltip><button type="button">Go</button><template #content>Hint</template></LazyTooltip></TooltipProvider>`,
      },
      { attachTo: document.body },
    );

    expect(wrapper.get("button").attributes("data-state")).toBeUndefined();

    await wrapper.get("span.contents").trigger("pointerenter");
    await nextTick();

    expect(wrapper.get("button").attributes("data-state")).toBe("closed");
    wrapper.unmount();
  });
});
