import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import UpdatesSection from "@/components/settings/UpdatesSection.vue";
import { i18n } from "@/i18n";
import { useStore } from "@/store";

/**
 * The running version, in the UI (issue #15). With auto-update on, the phone is often the only
 * screen the owner has, and until now the only ways to read the version were the terminal and
 * /api/health — neither reachable from an installed PWA. /api/status already carried it; the
 * dashboard was throwing it away.
 */
describe("UpdatesSection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function render() {
    return mount(UpdatesSection, { global: { plugins: [i18n] } });
  }

  it("shows the version the daemon reported", () => {
    useStore().serverVersion = "0.20.5";

    const wrapper = render();

    expect(wrapper.get('[data-testid="running-version"]').text()).toBe("0.20.5");
  });

  it("says so plainly before the first status lands, rather than showing a blank", () => {
    const wrapper = render();

    expect(wrapper.get('[data-testid="running-version"]').text()).toBe("Unknown");
  });

  it("flags a pending update next to it", () => {
    const store = useStore();
    store.serverVersion = "0.20.5";
    store.updateStatus = { updateAvailable: true } as never;

    expect(render().text()).toContain("Update available");
  });

  it("says nothing about updates when there is none to install", () => {
    const store = useStore();
    store.serverVersion = "0.20.5";
    store.updateStatus = { updateAvailable: false, currentVersion: "0.20.5" } as never;

    expect(render().text()).not.toContain("Update available");
    expect(render().text()).not.toContain("Restart to finish");
  });

  it("says a restart is pending when the installed build is ahead of the running one", () => {
    // A manual Update installs without relaunching the daemon, and reports the NEW version with
    // updateAvailable false. Trusting that alone would read as "up to date" on the old build.
    const store = useStore();
    store.serverVersion = "0.20.5";
    store.updateStatus = { updateAvailable: false, currentVersion: "0.20.6" } as never;

    const wrapper = render();

    expect(wrapper.get('[data-testid="running-version"]').text()).toBe("0.20.5");
    expect(wrapper.text()).toContain("Restart to finish");
  });
});
