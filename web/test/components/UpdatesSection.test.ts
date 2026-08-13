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

  // ── the badge as the manual entry point (issue #20) ─────────────────────────
  // Being TOLD an update exists, with nothing to do about it, means waiting for the scheduled
  // apply — which is hours away by design, and on an installed PWA there is no terminal to fall
  // back on. The badge opens the existing offer; the offer still owns the install.
  describe("the update badge", () => {
    it("opens the update offer, and installs nothing by itself", async () => {
      const store = useStore();
      store.serverVersion = "0.20.5";
      store.updateStatus = { updateAvailable: true, canApply: true, reason: null } as never;
      const wrapper = render();

      const badge = wrapper.get('[data-testid="update-available"]');
      expect(badge.element.tagName).toBe("BUTTON");
      await badge.trigger("click");

      expect(store.updatePromptOpen).toBe(true);
      expect(store.updateApplying).toBe(false);
    });

    it("carries the reason an update can't be installed into the dialog", async () => {
      const store = useStore();
      const reason = "local changes must be committed or stashed before updating";
      store.updateStatus = { updateAvailable: true, canApply: false, reason } as never;

      await render().get('[data-testid="update-available"]').trigger("click");

      expect(store.updateBlockedReason).toBe(reason);
    });

    it("clears a blocked reason the current status no longer agrees with", async () => {
      // The announcement that set this arrived hours ago and the tree has been committed since.
      // Opening from the badge must not refuse an install the daemon would now accept.
      const store = useStore();
      store.updateBlockedReason = "local changes must be committed or stashed before updating";
      store.updateStatus = { updateAvailable: true, canApply: true, reason: null } as never;

      await render().get('[data-testid="update-available"]').trigger("click");

      expect(store.updateBlockedReason).toBeNull();
    });

    it("is absent while an update is mid-flight — there is nothing left to ask for", () => {
      const store = useStore();
      store.updateStatus = { updateAvailable: true, canApply: true, reason: null } as never;
      store.autoUpdateApplying = true;

      expect(render().find('[data-testid="update-available"]').exists()).toBe(false);
    });
  });

  it("links to the changelog, so 'what changed?' is answerable without a terminal", () => {
    const link = render().get('[data-testid="changelog-link"]');

    // The changelog FILE on the default branch, not the Releases page: a source checkout updates
    // off the branch and routinely sits ahead of any published release.
    expect(link.attributes("href")).toBe(
      "https://github.com/LunarWerxs/RepoYeti/blob/main/CHANGELOG.md",
    );
    expect(link.attributes("target")).toBe("_blank");
    expect(link.attributes("rel")).toContain("noopener");
  });
});
