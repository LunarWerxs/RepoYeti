// Covers audit finding #18 (gitBusy re-entrancy guard) for the stash controls: stashSave / stashPop
// / stashDrop must all no-op while a git op is already in flight for the repo, and run once free.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, DOMWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import StashPanel from "@/components/StashPanel.vue";

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
  activeWrapper = mount(StashPanel, {
    props: { repoId, ...props },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
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

  it("#18 blocks stashDrop while busy, then allows it once free", async () => {
    const store = useStore();
    store.stashesByRepo[repoId] = {
      ok: true,
      code: "OK",
      stashes: [{ index: 0, message: "wip", date: 0 }],
    };
    const dropSpy = vi.spyOn(store, "stashDrop").mockResolvedValue({ ok: true, code: "OK" });

    const wrapper = mountPanel({ canStash: true, dirty: 0 });
    const menu = await openMenu(wrapper);
    // Re-find the button after each state change — see the stashSave test above for why a
    // stale wrapper reference can miss a reactive re-render.
    const findDropBtn = () => menu.findAll("button").find((b) => b.attributes("aria-label") === "Drop")!;
    expect(findDropBtn().exists()).toBe(true);

    store.gitOpBusy[repoId] = "stash";
    await wrapper.vm.$nextTick();
    await findDropBtn().trigger("click");
    await wrapper.vm.$nextTick();
    expect(dropSpy).not.toHaveBeenCalled();

    store.gitOpBusy[repoId] = undefined;
    await wrapper.vm.$nextTick();
    await findDropBtn().trigger("click");
    await wrapper.vm.$nextTick();
    expect(dropSpy).toHaveBeenCalledOnce();
    expect(dropSpy).toHaveBeenCalledWith(repoId, 0);
  });
});
