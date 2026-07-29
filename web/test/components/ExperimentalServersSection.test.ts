import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ExperimentalServersSection from "@/components/settings/ExperimentalServersSection.vue";
import { i18n } from "@/i18n";

vi.mock("@/components/settings/LoreServersSection.vue", () => ({
  default: { template: '<div data-testid="lore-settings" />' },
}));
vi.mock("@/components/settings/BuzzIntegrationSection.vue", () => ({
  default: { template: '<div data-testid="buzz-settings" />' },
}));

describe("ExperimentalServersSection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders one section with two clean support toggles", () => {
    const wrapper = mount(ExperimentalServersSection, {
      props: { open: true },
      global: { plugins: [i18n] },
    });

    expect(wrapper.text()).toContain("Experimental servers");
    expect(wrapper.text()).toContain("Enable Lore support");
    expect(wrapper.text()).toContain("Enable Buzz support");
    expect(wrapper.text()).not.toContain("Advanced and experimental; off by default.");
    expect(wrapper.findAll('[role="switch"]')).toHaveLength(2);
  });
});
