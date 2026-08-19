import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "vue-sonner";
import UpdatesSection from "@/components/settings/UpdatesSection.vue";
import { i18n } from "@/i18n";
import { api } from "@/api";
import { useStore } from "@/store";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

/**
 * The running version, in the UI (issue #15). With auto-update on, the phone is often the only
 * screen the owner has, and until now the only ways to read the version were the terminal and
 * /api/health — neither reachable from an installed PWA. /api/status already carried it; the
 * dashboard was throwing it away.
 */
describe("UpdatesSection", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
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

  // ── the restart badge as the manual entry point (issue #23) ─────────────────
  // The badge stated the one thing left to do on the one screen that could not do it: an installed
  // PWA has no tray and no terminal, so an installed update simply waited for something else to
  // restart the daemon. It now asks the daemon to relaunch itself.
  describe("the restart badge", () => {
    /** A store whose installed build is ahead of the running one — the "Restart to finish" state. */
    function restartPending() {
      const store = useStore();
      store.serverVersion = "0.20.5";
      store.updateStatus = { updateAvailable: false, currentVersion: "0.20.6" } as never;
      return store;
    }

    it("restarts the daemon, and says so while it goes down", async () => {
      const store = restartPending();
      const restart = vi.spyOn(api, "restartDaemon").mockResolvedValue({ ok: true });
      const wrapper = render();

      const badge = wrapper.get('[data-testid="restart-pending"]');
      expect(badge.element.tagName).toBe("BUTTON");
      await badge.trigger("click");
      await flushPromises();

      expect(restart).toHaveBeenCalledTimes(1);
      // Set from the answer, not from the daemon's SSE announcement: that event and the disconnect
      // race each other, and this is the one client that must not be left staring at the old badge.
      expect(store.autoUpdateRestarting).toBe(true);
      expect(wrapper.text()).toContain("Restarting…");
      expect(wrapper.find('[data-testid="restart-pending"]').exists()).toBe(false);
    });

    it("carries the daemon's refusal through, and does NOT claim a restart", async () => {
      // The daemon refuses while work is in flight (a running git op, an agent awaiting approval)
      // and its message names which. That is the only explanation this screen can offer.
      const store = restartPending();
      const reason = "a git operation is running right now — try again in a moment";
      vi.spyOn(api, "restartDaemon").mockRejectedValue(new Error(reason));
      const wrapper = render();

      await wrapper.get('[data-testid="restart-pending"]').trigger("click");
      await flushPromises();

      expect(store.autoUpdateRestarting).toBe(false);
      expect(wrapper.get('[data-testid="restart-pending"]').text()).toContain("Restart to finish");
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't restart RepoYeti",
        expect.objectContaining({ description: reason }),
      );
    });

    it("is clickable again if the pending state comes back after a restart", async () => {
      // The component is not unmounted by the restart, so an in-flight flag left latched true would
      // bring the badge back permanently disabled the next time the versions disagree — visible,
      // stating what to do, and dead to the touch. Found in a real browser, not here.
      const store = restartPending();
      const restart = vi.spyOn(api, "restartDaemon").mockResolvedValue({ ok: true });
      const wrapper = render();

      await wrapper.get('[data-testid="restart-pending"]').trigger("click");
      await flushPromises();
      // The daemon came back (reconnect clears the flag) and is STILL behind the installed build.
      store.autoUpdateRestarting = false;
      await flushPromises();

      const badge = wrapper.get('[data-testid="restart-pending"]');
      expect((badge.element as HTMLButtonElement).disabled).toBe(false);
      await badge.trigger("click");
      await flushPromises();
      expect(restart).toHaveBeenCalledTimes(2);
    });

    it("ignores a second tap while the first is still in flight", async () => {
      restartPending();
      let release: (() => void) | null = null;
      const restart = vi
        .spyOn(api, "restartDaemon")
        .mockReturnValue(new Promise((r) => (release = () => r({ ok: true }))));
      const wrapper = render();

      const badge = wrapper.get('[data-testid="restart-pending"]');
      await badge.trigger("click");
      await badge.trigger("click");

      expect(restart).toHaveBeenCalledTimes(1);
      release!();
      await flushPromises();
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
