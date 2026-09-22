// The changed-files "search inside files" toggle. treeQuery/contentMode are hoisted to
// RepoCard (v-model) because RepoCardChanges unmounts when the card is collapsed or when the
// collaboration mode/pane changes. So on remount the refs arrive already populated while the
// component's own contentMatches starts empty — the watcher that issues the content grep must
// therefore re-run on mount, or the lit toggle silently falls back to filename-only filtering.
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import type { Repo } from "@/types";

const searchContent = vi.hoisted(() => vi.fn());
vi.mock("@/api", () => ({ api: { searchContent } }));
vi.mock("@/lib/file-icons", () => ({ fileVisual: () => "span" }));

import RepoCardChanges from "@/components/repo-card/RepoCardChanges.vue";

const repoId = "search-repo";
const repo: Repo = {
  id: repoId,
  name: "search-repo",
  displayName: null,
  absPath: "C:/search-repo",
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
    dirty: 1,
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
const inlinePassThrough = { template: "<span><slot /></span>" };
const expandTransition = {
  props: ["open"],
  template: '<div v-if="open"><slot /></div>',
};

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// Mount exactly as RepoCard does — initial props carry the restored query + toggle, which is
// the state a remount sees.
function mountWith(treeQuery: string, contentMode: boolean) {
  return mount(RepoCardChanges, {
    props: {
      repo,
      treeQuery,
      contentMode,
      "onUpdate:treeQuery": () => {},
      "onUpdate:contentMode": () => {},
    },
    global: {
      plugins: [i18n],
      stubs: {
        BranchPanel: true,
        ChangesTree: true,
        RepoCardMenu: true,
        ExpandTransition: expandTransition,
        Tooltip: passThrough,
        TooltipTrigger: inlinePassThrough,
        TooltipContent: inlinePassThrough,
        Dialog: passThrough,
        DialogContent: passThrough,
        DialogHeader: passThrough,
        DialogTitle: passThrough,
        DialogDescription: passThrough,
        DialogFooter: passThrough,
      },
    },
  });
}

describe("RepoCardChanges changed-files content search", () => {
  let wrapper: ReturnType<typeof mount> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    searchContent.mockReset();
    searchContent.mockResolvedValue(["src/only-file.ts"]);
    setActivePinia(createPinia());
    localStorage.clear();
    const store = useStore();
    store.changesByRepo[repoId] = [{ path: "src/only-file.ts", status: "M", staged: false }];
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("re-issues the content grep on mount when the restored toggle + query are already set", async () => {
    wrapper = mountWith("needle", true);

    // Nothing to fetch while the debounce is pending.
    expect(searchContent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    await nextTick();

    expect(searchContent).toHaveBeenCalledWith(repoId, "needle", expect.anything());
  });

  it("stays quiet on mount when the toggle is off", async () => {
    wrapper = mountWith("needle", false);
    vi.advanceTimersByTime(180);
    await nextTick();

    expect(searchContent).not.toHaveBeenCalled();
  });
});
