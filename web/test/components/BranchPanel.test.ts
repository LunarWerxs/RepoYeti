// Covers audit findings #18 (gitBusy re-entrancy guard: switch/create must no-op while a git op
// is already in flight for the repo) and #22 (deleteBranch failures must toast the FRIENDLY
// translated string, e.g. repo.err.protectedBranch, never the raw ApiError code).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, DOMWrapper } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import BranchPanel from "@/components/BranchPanel.vue";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const repoId = "repo-1";

function seedBranches(): void {
  const store = useStore();
  store.branchesByRepo[repoId] = {
    ok: true,
    code: "OK",
    current: "main",
    detached: false,
    branches: [
      { name: "feature", current: false, upstream: null, ahead: 0, behind: 0, gone: false },
      { name: "main", current: true, upstream: null, ahead: 0, behind: 0, gone: false },
    ],
  };
}

// Track mounted wrappers so afterEach can unmount them — attachTo:document.body leaves the
// component (and any teleported dropdown content) in the live document otherwise, and a stale
// trigger/content from a previous test would shadow the current test's document.body queries.
let activeWrapper: ReturnType<typeof mount> | undefined;

function mountPanel() {
  // DropdownMenuContent teleports into document.body (reka-ui's DropdownMenuPortal), so the
  // component must be attached to a live document for the portal target to exist and for the
  // dropdown to actually open in happy-dom.
  activeWrapper = mount(
    {
      components: { BranchPanel, TooltipProvider },
      props: ["repoId", "branch", "detached"],
      template:
        '<TooltipProvider><BranchPanel :repo-id="repoId" :branch="branch" :detached="detached" /></TooltipProvider>',
    },
    {
      props: { repoId, branch: "main", detached: false },
      global: { plugins: [i18n] },
      attachTo: document.body,
    },
  );
  return activeWrapper;
}

/** Open the branch dropdown and return a DOMWrapper over the teleported menu content (it lives
 *  in document.body, outside the mounted component's own root, so `wrapper.find` can't see it). */
async function openMenu(wrapper: ReturnType<typeof mount>): Promise<DOMWrapper<HTMLElement>> {
  const trigger = wrapper.find('[data-slot="dropdown-menu-trigger"]');
  await trigger.trigger("click");
  await wrapper.vm.$nextTick();
  await new Promise((r) => setTimeout(r, 0));
  const content = document.body.querySelector('[data-slot="dropdown-menu-content"]') as HTMLElement;
  return new DOMWrapper(content);
}

describe("BranchPanel.vue", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("#18 blocks switchBranch while a git op is busy, then allows it once free", async () => {
    const store = useStore();
    seedBranches();
    const switchSpy = vi.spyOn(store, "switchBranch").mockResolvedValue({ ok: true, code: "OK" });

    const wrapper = mountPanel();
    const menu = await openMenu(wrapper);
    // The "feature" row's switch button is the non-delete button in that row. Re-find it after
    // each state change rather than reusing one reference, in case a re-render replaces the node.
    const findSwitchBtn = () =>
      menu.findAll('[class*="group/br"]').find((row) => row.text().includes("feature"))!.findAll("button")[0]!;

    store.gitOpBusy[repoId] = "checkout";
    await wrapper.vm.$nextTick();
    await findSwitchBtn().trigger("click");
    await wrapper.vm.$nextTick();
    expect(switchSpy).not.toHaveBeenCalled();

    store.gitOpBusy[repoId] = undefined;
    await wrapper.vm.$nextTick();
    await findSwitchBtn().trigger("click");
    await wrapper.vm.$nextTick();
    expect(switchSpy).toHaveBeenCalledOnce();
    expect(switchSpy).toHaveBeenCalledWith(repoId, "feature");
  });

  it("#18 blocks createBranch submit while busy, then allows it once free", async () => {
    const store = useStore();
    seedBranches();
    const createSpy = vi.spyOn(store, "createBranch").mockResolvedValue({ ok: true, code: "OK" });

    const wrapper = mountPanel();
    // Open the inline create-branch form via the "+" toggle button.
    const plusBtn = wrapper.findAll("button").find((b) => b.attributes("aria-label")?.includes("Create"))!;
    await plusBtn.trigger("click");
    await wrapper.vm.$nextTick();

    const input = wrapper.find("input[type=text]");
    expect(input.exists()).toBe(true);
    await input.setValue("new-feature");

    const form = wrapper.find("form");
    expect(form.exists()).toBe(true);

    store.gitOpBusy[repoId] = "checkout";
    await form.trigger("submit.prevent");
    await wrapper.vm.$nextTick();
    expect(createSpy).not.toHaveBeenCalled();

    store.gitOpBusy[repoId] = undefined;
    await form.trigger("submit.prevent");
    await wrapper.vm.$nextTick();
    expect(createSpy).toHaveBeenCalledOnce();
    expect(createSpy).toHaveBeenCalledWith(repoId, "new-feature", true);
  });

  it("#22 toasts the friendly protected-branch message, not the raw code, on delete failure", async () => {
    const store = useStore();
    seedBranches();
    vi.spyOn(store, "deleteBranch").mockResolvedValue({
      ok: false,
      code: "PROTECTED_BRANCH",
      message: "raw",
    });

    const wrapper = mountPanel();
    const menu = await openMenu(wrapper);
    const featureRow = menu.findAll('[class*="group/br"]').find((row) => row.text().includes("feature"))!;
    const deleteBtn = featureRow.findAll("button")[1]!;

    await deleteBtn.trigger("click");
    await wrapper.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 0));

    expect(toast.error).toHaveBeenCalledOnce();
    const [message] = vi.mocked(toast.error).mock.calls[0]!;
    expect(message).toBe("That branch is protected — delete it at your desk.");
    expect(message).not.toBe("PROTECTED_BRANCH");
    expect(message).not.toBe("raw");
  });
});
