// RepoCardHeader is a single role="button" row wrapping several real controls (drag handle,
// identity/sync-account menu trigger, expand chevron). Two reviewed defects lived in that
// nesting: Enter/Space bubbling up from a nested control toggled the card behind it (or, via the
// row's preventDefault, cancelled the control's own activation), and a rejected identity /
// account assignment was `void`-ed — the optimistic patch rolled back with no toast. Both are
// DOM-level integrations (keydown bubbling, promise rejection surfacing), so they are pinned here
// by driving the real component rather than by asserting internals.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";
import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import RepoCardHeader from "@/components/repo-card/RepoCardHeader.vue";
import {
  activateRepo,
  provideRangeOrder,
  selectionIds,
  startSelecting,
  stopSelecting,
} from "@/lib/repo-selection";
import type { Repo } from "@/types";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

const repo: Repo = {
  id: "header-repo",
  name: "header-repo",
  displayName: null,
  absPath: "C:/header-repo",
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
  status: {
    branch: "main",
    detached: false,
    dirty: 0,
    ahead: 0,
    behind: 0,
    remote: null,
    error: null,
    fetchedAt: null,
    updatedAt: 0,
  },
  updatedAt: 0,
};

const passThrough = { template: "<div><slot /></div>" };
// The real menu trigger is a native <button>; the stub keeps that shape (and its fallthrough
// class / aria-label / click handler) so the row's nested-control guard sees a real target.
const triggerStub = { template: "<button><slot /></button>" };
// reka's DropdownMenuItem drives selection through a `select` event, not a click; the stub
// replays that contract so clicking an item exercises the component's @select handlers.
const itemStub = {
  emits: ["select"],
  template: '<button type="button" @click="$emit(\'select\')"><slot /></button>',
};

let activeWrapper: ReturnType<typeof mount> | undefined;

function mountHeader(expanded = false) {
  activeWrapper = mount(RepoCardHeader, {
    props: { repo, expanded, draggable: true },
    attachTo: document.body,
    global: {
      plugins: [i18n],
      stubs: {
        DropdownMenu: passThrough,
        DropdownMenuContent: passThrough,
        DropdownMenuLabel: passThrough,
        DropdownMenuSeparator: passThrough,
        DropdownMenuTrigger: triggerStub,
        DropdownMenuItem: itemStub,
        Tooltip: passThrough,
        TooltipTrigger: passThrough,
        TooltipContent: passThrough,
      },
    },
  });
  return activeWrapper;
}

/** Keydown that actually bubbles — @vue/test-utils' trigger defaults are not relied on here. */
function keydownOn(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("RepoCardHeader keyboard activation", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  it("still expands the card on Enter/Space pressed on the row itself", () => {
    const wrapper = mountHeader();
    const row = wrapper.get('[role="button"]');

    keydownOn(row.element, "Enter");
    expect(wrapper.emitted("toggle")).toHaveLength(1);

    keydownOn(row.element, " ");
    expect(wrapper.emitted("toggle")).toHaveLength(2);
  });

  it("does not toggle the card when Enter is pressed on the drag handle", () => {
    const wrapper = mountHeader();
    const handle = wrapper.get("button.drag-handle");

    keydownOn(handle.element, "Enter");

    // The regression: this keydown bubbled to the row, which expanded the card.
    expect(wrapper.emitted("toggle")).toBeUndefined();
  });

  it("does not toggle the card when Enter is pressed on the identity menu trigger", () => {
    const store = useStore();
    // Two identities make the identity block render (see identitiesRelevant), so the trigger
    // carries the "Set git identity" label.
    store.identities.push(
      { id: "i1", displayName: "Work", gitUsername: "work", gitEmail: "work@example.com", sshKeyPath: null },
      { id: "i2", displayName: "Home", gitUsername: "home", gitEmail: "home@example.com", sshKeyPath: null },
    );
    const wrapper = mountHeader();
    const trigger = wrapper.get('button[aria-label="Set git identity"]');

    keydownOn(trigger.element, "Enter");

    // The menu handles the key itself; the row must not also treat it as a card activation
    // (and must not preventDefault away the trigger's own activation).
    expect(wrapper.emitted("toggle")).toBeUndefined();
  });

  it("leaves the expand chevron's single toggle to its click, not the row's keydown", async () => {
    const wrapper = mountHeader(false);
    const chevron = wrapper.get('button[aria-label="Expand"]');

    keydownOn(chevron.element, "Enter");
    expect(wrapper.emitted("toggle")).toBeUndefined();

    await chevron.trigger("click");
    expect(wrapper.emitted("toggle")).toHaveLength(1);
  });
});

// The row reads the click/keydown modifiers and hands them to the selection's request model; with
// the modifiers dropped every Shift-tap would degrade to a single toggle.
describe("RepoCardHeader in select mode", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    startSelecting();
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    stopSelecting();
  });

  it("Shift-click on the row ranges from the last picked repo", async () => {
    const release = provideRangeOrder(() => ["first", "middle", "header-repo"]);
    const wrapper = mountHeader();
    activateRepo("first", { shift: false, ctrl: false });

    await wrapper.get('[role="button"]').trigger("click", { shiftKey: true });

    expect([...selectionIds.value].sort()).toEqual(["first", "header-repo", "middle"]);
    expect(wrapper.emitted("toggle")).toBeUndefined();
    release();
  });

  it("Shift+Space on the focused row ranges the same way", () => {
    const release = provideRangeOrder(() => ["first", "middle", "header-repo"]);
    const wrapper = mountHeader();
    activateRepo("first", { shift: false, ctrl: false });

    wrapper.get('[role="button"]').element.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", shiftKey: true, bubbles: true, cancelable: true }),
    );

    expect([...selectionIds.value].sort()).toEqual(["first", "header-repo", "middle"]);
    release();
  });
});

describe("RepoCardHeader assignment failure feedback", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = undefined;
    vi.restoreAllMocks();
  });

  function itemWithText(wrapper: ReturnType<typeof mount>, text: string) {
    return wrapper.findAll("button").find((b) => b.text().includes(text));
  }

  it("reports a rejected identity assignment instead of silently reverting the avatar", async () => {
    const store = useStore();
    store.identities.push(
      { id: "i1", displayName: "Work", gitUsername: "work", gitEmail: "work@example.com", sshKeyPath: null },
      { id: "i2", displayName: "Home", gitUsername: "home", gitEmail: "home@example.com", sshKeyPath: null },
    );
    const assign = vi.spyOn(store, "assignIdentity").mockRejectedValue(new Error("not found"));
    const wrapper = mountHeader();

    // The store rethrows after rolling the optimistic patch back; the header must not void it.
    await itemWithText(wrapper, "No identity")!.trigger("click");
    await flush();

    expect(assign).toHaveBeenCalledWith(repo.id, null);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected sync-account assignment", async () => {
    const store = useStore();
    store.ghAccounts.push({
      host: "github.com",
      login: "octocat",
      active: true,
      gitProtocol: "https",
      scopes: [],
      identityId: null,
    });
    const assign = vi.spyOn(store, "assignRepoAccount").mockRejectedValue(new Error("gone"));
    const wrapper = mountHeader();

    await itemWithText(wrapper, "Automatic")!.trigger("click");
    await flush();

    expect(assign).toHaveBeenCalledWith(repo.id, null, null);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
