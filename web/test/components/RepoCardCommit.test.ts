import { GitCommitHorizontal, RefreshCw } from "@lucide/vue";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, reactive } from "vue";
import { api } from "@/api";
import RepoCardCommit from "@/components/repo-card/RepoCardCommit.vue";
import { i18n } from "@/i18n";
import type { TreeSelectionApi } from "@/lib/changes-selection";
import { defaultCommitAction } from "@/lib/commit-default";
import { useStore } from "@/store";
import type { Repo } from "@/types";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function repo(remote: string | null): Repo {
  return {
    id: "repo-1",
    name: "demo",
    displayName: null,
    absPath: "/demo",
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
      remote,
      error: null,
      fetchedAt: null,
      updatedAt: 1,
    },
    updatedAt: 1,
  };
}

function selection(paths: string[] = []): TreeSelectionApi {
  const selected = reactive(new Set(paths));
  return {
    selected,
    isSelected: (path) => selected.has(path),
    toggle: (path) => void (selected.has(path) ? selected.delete(path) : selected.add(path)),
    setMany: (nextPaths, select) => {
      for (const path of nextPaths) {
        if (select) selected.add(path);
        else selected.delete(path);
      }
    },
    clear: () => selected.clear(),
    prune: (validPaths) => {
      const valid = new Set(validPaths);
      for (const path of [...selected]) if (!valid.has(path)) selected.delete(path);
    },
    count: computed(() => selected.size),
  };
}

function mountCommit(remote: string | null, paths: string[] = []) {
  return mount(RepoCardCommit, {
    props: {
      repo: repo(remote),
      treeSelection: selection(paths),
      commitMsg: "feat: ship it",
    },
    global: { plugins: [i18n] },
  });
}

describe("RepoCardCommit default primary action", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    defaultCommitAction.value = "commit";
    // Keep the fixture focused on the regular split button.
    useStore().aiSettings.commitEnabled = false;
    // Successful commits refresh the non-critical recent-message chips in the background.
    // Keep that fire-and-forget refresh local to the test instead of leaving a real fetch for
    // happy-dom to abort noisily while its window is being torn down.
    vi.spyOn(api, "log").mockResolvedValue({
      ok: true,
      code: "OK",
      commits: [],
      hasMore: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to a plain Commit button", () => {
    const wrapper = mountCommit("origin");
    const primary = wrapper.get('[data-testid="primary-commit-action"]');

    expect(primary.attributes("data-commit-mode")).toBe("commit");
    expect(primary.text()).toBe("Commit");
    expect(primary.findComponent(GitCommitHorizontal).exists()).toBe(true);
    expect(primary.findComponent(RefreshCw).exists()).toBe(false);
  });

  it("runs pull then push from a Commit & Sync primary button when an upstream exists", async () => {
    defaultCommitAction.value = "sync";
    const store = useStore();
    const commit = vi.spyOn(store, "commit").mockResolvedValue({ ok: true, code: "OK" });
    const action = vi.spyOn(store, "doAction").mockResolvedValue({ ok: true, code: "OK" });
    const wrapper = mountCommit("origin");
    const primary = wrapper.get('[data-testid="primary-commit-action"]');

    expect(primary.attributes("data-commit-mode")).toBe("sync");
    expect(primary.text()).toBe("Commit & Sync");
    expect(primary.findComponent(RefreshCw).exists()).toBe(true);
    expect(primary.findComponent(GitCommitHorizontal).exists()).toBe(false);

    await primary.trigger("click");
    await flushPromises();

    expect(commit).toHaveBeenCalledOnce();
    expect(action.mock.calls).toEqual([
      ["repo-1", "pull"],
      ["repo-1", "push"],
    ]);
  });

  it("falls back to plain Commit when Commit & Sync is preferred but no upstream exists", async () => {
    defaultCommitAction.value = "sync";
    const store = useStore();
    const commit = vi.spyOn(store, "commit").mockResolvedValue({ ok: true, code: "OK" });
    const action = vi.spyOn(store, "doAction").mockResolvedValue({ ok: true, code: "OK" });
    const wrapper = mountCommit(null);
    const primary = wrapper.get('[data-testid="primary-commit-action"]');

    expect(primary.attributes("data-commit-mode")).toBe("commit");
    expect(primary.text()).toBe("Commit");
    expect(primary.findComponent(GitCommitHorizontal).exists()).toBe(true);
    expect(primary.findComponent(RefreshCw).exists()).toBe(false);

    await primary.trigger("click");
    await flushPromises();

    expect(commit).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
  });

  it("retargets the primary button at the SELECTION instead of announcing 'all'", () => {
    // The old design left the primary button saying "Commit all" while a separate strip below the
    // tree offered "Commit selected" — so the button you were looking at did the opposite of what
    // you had just checked. The selection now owns the primary action; the whole-tree commands move
    // into the dropdown and relabel themselves "all" there (see the menu items).
    defaultCommitAction.value = "sync";
    const wrapper = mountCommit("origin", ["src/a.ts"]);

    const primary = wrapper.get('[data-testid="primary-commit-action"]');
    expect(primary.text()).toBe("Commit selected (1)");
    expect(primary.attributes("data-commit-scope")).toBe("selected");
    // …and the sync mode is still honoured, rather than silently dropped by ticking a box.
    expect(primary.attributes("data-commit-mode")).toBe("sync");
  });

  it("keeps Ctrl+Enter on the SAME scope + mode as the primary button", async () => {
    // The shortcut used to hard-code doCommit("commit"): with files checked it committed the whole
    // tree while the button beside it read "Commit selected (1)".
    defaultCommitAction.value = "sync";
    const store = useStore();
    const commit = vi.spyOn(store, "commit").mockResolvedValue({ ok: true, code: "OK" });
    const commitSelected = vi.spyOn(store, "commitSelected").mockResolvedValue({ ok: true, code: "OK" });
    vi.spyOn(store, "doAction").mockResolvedValue({ ok: true, code: "OK" });
    const wrapper = mountCommit("origin", ["src/a.ts"]);

    await wrapper.get("textarea").trigger("keydown", { key: "Enter", ctrlKey: true });
    await flushPromises();

    expect(commit).not.toHaveBeenCalled();
    expect(commitSelected).toHaveBeenCalledWith("repo-1", "feat: ship it", ["src/a.ts"]);
  });

  it("offers a selection-scoped Sync in the dropdown instead of only a whole-tree one", async () => {
    // The reported bug: with files checked, the menu's only sync entry committed EVERYTHING, so
    // "commit and sync these files" was unreachable whenever the default action was a plain commit.
    const store = useStore();
    const commit = vi.spyOn(store, "commit").mockResolvedValue({ ok: true, code: "OK" });
    const commitSelected = vi.spyOn(store, "commitSelected").mockResolvedValue({ ok: true, code: "OK" });
    const action = vi.spyOn(store, "doAction").mockResolvedValue({ ok: true, code: "OK" });
    const wrapper = mountCommit("origin", ["src/a.ts"]);

    // The menu content is teleported to <body>, so it's queried there rather than through `wrapper`.
    await wrapper.get('[aria-label="Commit options"]').trigger("pointerdown", { button: 0, ctrlKey: false });
    await wrapper.get('[aria-label="Commit options"]').trigger("click");
    await flushPromises();
    const items = [...document.body.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
    const labels = items.map((el) => el.textContent?.trim());
    expect(labels).toContain("Commit selected & Sync");
    expect(labels).toContain("Commit all & Sync");

    items.find((el) => el.textContent?.trim() === "Commit selected & Sync")?.click();
    await flushPromises();

    expect(commit).not.toHaveBeenCalled();
    expect(commitSelected).toHaveBeenCalledWith("repo-1", "feat: ship it", ["src/a.ts"]);
    expect(action.mock.calls).toEqual([
      ["repo-1", "pull"],
      ["repo-1", "push"],
    ]);
  });

  it("leaves the primary button on the whole tree when nothing is selected", () => {
    defaultCommitAction.value = "sync";
    const wrapper = mountCommit("origin", []);

    const primary = wrapper.get('[data-testid="primary-commit-action"]');
    expect(primary.text()).toBe("Commit & Sync");
    expect(primary.attributes("data-commit-scope")).toBe("all");
  });
});
