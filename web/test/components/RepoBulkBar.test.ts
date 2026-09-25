// RepoBulkBar owns two things for the selection while it is mounted: the on-screen order a
// Shift-tap ranges over, and the dashboard-wide Ctrl+A / Escape keys. Both are wiring between the
// request model (@/lib/multi-select) and the real dashboard, so they are pinned here by mounting the
// bar against a seeded store: a range must skip a collapsed section (its cards are off screen, and a
// following Remove would take repos the owner never saw), and Ctrl+A in a text field must stay the
// field's own "select this text".
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import { resetSectionCollapse, toggleSection } from "@/lib/repo-sections";
import { activateRepo, selectionIds, startSelecting, stopSelecting } from "@/lib/repo-selection";
import RepoBulkBar from "@/components/RepoBulkBar.vue";
import type { Repo } from "@/types";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

function repo(id: string, patch: Partial<Repo> = {}): Repo {
  return {
    id,
    name: id,
    displayName: null,
    absPath: `C:/${id}`,
    source: "auto",
    vcs: "git",
    isSubmodule: false,
    identityId: null,
    syncAccountHost: null,
    syncAccountLogin: null,
    hidden: false,
    pinned: false,
    starred: false,
    autoCommit: false,
    status: null,
    updatedAt: 0,
    ...patch,
  };
}

const passThrough = { template: "<div><slot /></div>" };
let activeWrapper: ReturnType<typeof mount> | undefined;

function mountBar() {
  activeWrapper = mount(RepoBulkBar, {
    attachTo: document.body,
    global: {
      plugins: [i18n],
      // The remove-confirm dialog is not under test; rendering nothing keeps reka's dialog parts
      // from needing their root context.
      stubs: { Tooltip: passThrough, TooltipTrigger: passThrough, TooltipContent: passThrough, Dialog: { template: "<div />" } },
    },
  });
  return activeWrapper;
}

function press(target: EventTarget, key: string, mods: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
}

const sorted = () => [...selectionIds.value].sort();

describe("RepoBulkBar selection scope", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    resetSectionCollapse();
    useStore().repos.push(
      repo("p1", { pinned: true }),
      repo("s1", { starred: true }),
      repo("o1"),
      repo("o2"),
      repo("o3"),
    );
    startSelecting();
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    stopSelecting();
    document.body.innerHTML = "";
  });

  it("a Shift-range runs in on-screen section order and skips a collapsed section", () => {
    toggleSection("starred");
    mountBar();

    activateRepo("p1", { shift: false, ctrl: false });
    activateRepo("o2", { shift: true, ctrl: false });

    expect(sorted()).toEqual(["o1", "o2", "p1"]);
  });

  it("Ctrl+A ticks every visible repo and Escape clears them", () => {
    mountBar();

    press(document.body, "a", { ctrlKey: true });
    expect(sorted()).toEqual(["o1", "o2", "o3", "p1", "s1"]);

    press(document.body, "Escape");
    expect(selectionIds.value).toEqual([]);
  });

  // Contract: bulk Pull runs the card's own per-repo pull for exactly the selected repos, and a repo
  // the daemon refuses is named rather than silently counted. Seam: RepoBulkBar -> store.doAction.
  it("Pull runs the per-repo pull for each selected repo and names the ones refused", async () => {
    const store = useStore();
    const doAction = vi
      .spyOn(store, "doAction")
      .mockImplementation(async (id) =>
        id === "o2" ? { ok: false, code: "NOT_FAST_FORWARD", message: "diverged" } : { ok: true, code: "OK", message: "" },
      );
    const wrapper = mountBar();
    activateRepo("o1", { shift: false, ctrl: false });
    activateRepo("o3", { shift: true, ctrl: false });
    // The bar mounted with nothing ticked, so Pull is still rendered disabled until the selection
    // re-renders it, and trigger() on a disabled button dispatches nothing.
    await flushPromises();

    await wrapper.get('[data-testid="bulk-pull"]').trigger("click");
    await flushPromises();

    expect(doAction.mock.calls.map(([id, name]) => `${id}:${name}`).sort()).toEqual(["o1:pull", "o2:pull", "o3:pull"]);
    expect(toast.warning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ description: expect.stringContaining("o2") }),
    );
  });

  it("leaves Ctrl+A to a focused text field", () => {
    mountBar();
    const input = document.createElement("input");
    document.body.appendChild(input);

    press(input, "a", { ctrlKey: true });

    expect(selectionIds.value).toEqual([]);
  });
});
