// Covers audit finding #18 (gitBusy re-entrancy guard) for the stash controls: stashSave / stashPop
// / stashDrop must all no-op while a git op is already in flight for the repo, and run once free.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, DOMWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import StashPanel from "@/components/StashPanel.vue";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const repoId = "repo-1";

// Track the mounted wrapper so afterEach can unmount it — attachTo:document.body leaves the
// component (and any teleported dropdown content) in the live document otherwise, and a stale
// trigger/content from a previous test would shadow the current test's document.body queries.
let activeWrapper: ReturnType<typeof mount> | undefined;

function mountPanel(props: { canStash: boolean; dirty: number }) {
  // DropdownMenuContent teleports into document.body (reka-ui's DropdownMenuPortal), so the
  // component must be attached to a live document for the portal target to exist and for the
  // pop/drop dropdown to actually open in happy-dom (mirrors BranchPanel.test.ts's approach).
  // The drop confirm Dialog is stubbed to plain passthrough elements (mirrors
  // RemoteAccess.test.ts) so its content is queryable without reka-ui's portal/open-transition
  // machinery in happy-dom.
  activeWrapper = mount(
    {
      components: { StashPanel, TooltipProvider },
      props: ["repoId", "canStash", "dirty"],
      template:
        '<TooltipProvider><StashPanel :repo-id="repoId" :can-stash="canStash" :dirty="dirty" /></TooltipProvider>',
    },
    {
      props: { repoId, ...props },
      global: {
        plugins: [i18n],
        stubs: {
          // NOT stubbing 'teleport' globally: reka-ui's DropdownMenuPortal also uses <Teleport>,
          // and this test relies on it teleporting for real into document.body (see openMenu
          // below). Only the Dialog primitives are stubbed, so DialogContent never reaches its
          // own <Teleport> in the first place.
          Dialog: { template: "<div><slot /></div>" },
          DialogContent: { template: "<section><slot /></section>" },
          DialogHeader: { template: "<header><slot /></header>" },
          DialogTitle: { template: "<h2><slot /></h2>" },
          DialogDescription: { template: "<p><slot /></p>" },
        },
      },
      attachTo: document.body,
    },
  );
  return activeWrapper;
}

/** Open the stash dropdown and return a DOMWrapper over the teleported menu content. */
async function openMenu(wrapper: ReturnType<typeof mount>): Promise<DOMWrapper<HTMLElement>> {
  const trigger = wrapper.find('[data-slot="dropdown-menu-trigger"]');
  await trigger.trigger("click");
  await wrapper.vm.$nextTick();
  await new Promise((r) => setTimeout(r, 0));
  const content = document.body.querySelector('[data-slot="dropdown-menu-content"]') as HTMLElement;
  return new DOMWrapper(content);
}

describe("StashPanel.vue", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("#18 blocks stashSave while busy, then allows it once free", async () => {
    const store = useStore();
    const saveSpy = vi.spyOn(store, "stashSave").mockResolvedValue({ ok: true, code: "OK" });

    const wrapper = mountPanel({ canStash: true, dirty: 2 });
    // Re-find the button after each state change rather than reusing one reference — the
    // gitOpBusy flip re-renders the (possibly-disabled) button and a stale wrapper reference
    // can miss the patched element.
    const findStashBtn = () => wrapper.findAll("button").find((b) => b.text().includes("Stash"))!;
    expect(findStashBtn().exists()).toBe(true);

    store.gitOpBusy[repoId] = "stash";
    await wrapper.vm.$nextTick();
    await findStashBtn().trigger("click");
    await wrapper.vm.$nextTick();
    expect(saveSpy).not.toHaveBeenCalled();

    store.gitOpBusy[repoId] = undefined;
    await wrapper.vm.$nextTick();
    await findStashBtn().trigger("click");
    await wrapper.vm.$nextTick();
    expect(saveSpy).toHaveBeenCalledOnce();
    expect(saveSpy).toHaveBeenCalledWith(repoId);
  });

  it("renders the stash count once stashes are loaded", () => {
    const store = useStore();
    store.stashesByRepo[repoId] = {
      ok: true,
      code: "OK",
      stashes: [{ index: 0, message: "wip", date: 0 }],
    };
    const wrapper = mountPanel({ canStash: true, dirty: 0 });
    // dirty=0 hides the Stash save button but the pop/drop dropdown trigger should show "1".
    expect(wrapper.text()).toContain("1");
  });

  it("#18 blocks stashPop while busy, then allows it once free", async () => {
    const store = useStore();
    store.stashesByRepo[repoId] = {
      ok: true,
      code: "OK",
      stashes: [{ index: 0, message: "wip", date: 0 }],
    };
    const popSpy = vi.spyOn(store, "stashPop").mockResolvedValue({ ok: true, code: "OK" });

    const wrapper = mountPanel({ canStash: true, dirty: 0 });
    const menu = await openMenu(wrapper);
    // Re-find the button after each state change rather than reusing one reference — see the
    // stashSave test above for why a stale wrapper reference can miss a reactive re-render.
    const findPopBtn = () => menu.findAll("button").find((b) => b.attributes("aria-label") === "Pop")!;
    expect(findPopBtn().exists()).toBe(true);

    store.gitOpBusy[repoId] = "stash";
    await wrapper.vm.$nextTick();
    await findPopBtn().trigger("click");
    await wrapper.vm.$nextTick();
    expect(popSpy).not.toHaveBeenCalled();

    store.gitOpBusy[repoId] = undefined;
    await wrapper.vm.$nextTick();
    await findPopBtn().trigger("click");
    await wrapper.vm.$nextTick();
    expect(popSpy).toHaveBeenCalledOnce();
    expect(popSpy).toHaveBeenCalledWith(repoId, 0);
  });

  it("drop is confirm-gated: the Trash2 button opens a dialog naming the stash, not an immediate drop", async () => {
    const store = useStore();
    store.stashesByRepo[repoId] = {
      ok: true,
      code: "OK",
      stashes: [{ index: 0, message: "wip", date: 0 }],
    };
    const dropSpy = vi.spyOn(store, "stashDrop").mockResolvedValue({ ok: true, code: "OK" });

    const wrapper = mountPanel({ canStash: true, dirty: 0 });
    const menu = await openMenu(wrapper);
    const dropIcon = menu.findAll("button").find((b) => b.attributes("aria-label") === "Drop")!;
    expect(dropIcon.exists()).toBe(true);

    await dropIcon.trigger("click");
    await wrapper.vm.$nextTick();
    // A single tap must not have dropped the stash yet — the confirm dialog is in the way.
    expect(dropSpy).not.toHaveBeenCalled();
    // The dialog body (stubbed DialogDescription → <p>) names the specific stash, so the owner
    // knows what they're about to lose before confirming.
    expect(wrapper.find("p").text()).toContain("wip");

    const confirmBtn = wrapper.findAll("button").find((b) => b.text() === "Drop")!;
    expect(confirmBtn.exists()).toBe(true);
    await confirmBtn.trigger("click");
    await wrapper.vm.$nextTick();
    expect(dropSpy).toHaveBeenCalledOnce();
    expect(dropSpy).toHaveBeenCalledWith(repoId, 0);
  });

  it("#18 blocks the confirmed stashDrop while busy, then allows it once free", async () => {
    const store = useStore();
    store.stashesByRepo[repoId] = {
      ok: true,
      code: "OK",
      stashes: [{ index: 0, message: "wip", date: 0 }],
    };
    const dropSpy = vi.spyOn(store, "stashDrop").mockResolvedValue({ ok: true, code: "OK" });

    const wrapper = mountPanel({ canStash: true, dirty: 0 });
    const menu = await openMenu(wrapper);
    const dropIcon = () => menu.findAll("button").find((b) => b.attributes("aria-label") === "Drop")!;
    const confirmBtn = () => wrapper.findAll("button").find((b) => b.text() === "Drop")!;

    // Open the confirm dialog, then confirm while a git op is already in flight for the repo:
    // the drop must no-op (matches stashSave/stashPop above).
    await dropIcon().trigger("click");
    await wrapper.vm.$nextTick();
    store.gitOpBusy[repoId] = "stash";
    await wrapper.vm.$nextTick();
    await confirmBtn().trigger("click");
    await wrapper.vm.$nextTick();
    expect(dropSpy).not.toHaveBeenCalled();

    // Free again: re-open and confirm should now go through.
    store.gitOpBusy[repoId] = undefined;
    await wrapper.vm.$nextTick();
    await dropIcon().trigger("click");
    await wrapper.vm.$nextTick();
    await confirmBtn().trigger("click");
    await wrapper.vm.$nextTick();
    expect(dropSpy).toHaveBeenCalledOnce();
    expect(dropSpy).toHaveBeenCalledWith(repoId, 0);
  });
});
