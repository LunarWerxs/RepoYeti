import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import PullPreview from "@/components/repo-card/PullPreview.vue";
import RepoCardActions from "@/components/repo-card/RepoCardActions.vue";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import type { IncomingResult, Repo } from "@/types";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/file-icons", () => ({ fileVisual: () => "span" }));

const passThrough = { template: "<div><slot /></div>" };
const inlinePassThrough = { template: "<span><slot /></span>" };
const menuItemStub = {
  props: ["disabled"],
  template: '<button type="button" :disabled="disabled"><slot /></button>',
};

function incoming(overrides: Partial<IncomingResult> = {}): IncomingResult {
  return {
    ok: true,
    code: "OK",
    upstream: "origin/main",
    noUpstream: false,
    ahead: 0,
    behind: 2,
    relation: "behind_fast_forward",
    pullDisposition: "ready_fast_forward",
    checkedAt: 100,
    snapshot: {
      headOid: "1".repeat(40),
      upstreamOid: "2".repeat(40),
      worktreeStateHash: "5".repeat(64),
      indexWorktreeHash: "3".repeat(64),
      token: "4".repeat(64),
    },
    commits: [
      {
        hash: "a".repeat(40),
        shortHash: "aaaaaaa",
        subject: "remote work",
        authorName: "A",
        authorEmail: "a@example.com",
        date: Date.now(),
        refs: "",
        parents: [],
        isMerge: false,
        stat: { filesChanged: 1, addedLines: 3, removedLines: 1 },
      },
    ],
    commitsTruncated: false,
    files: [],
    filesTruncated: false,
    stat: { filesChanged: 1, addedLines: 3, removedLines: 1 },
    conflicts: [],
    conflictCheck: true,
    fastForward: true,
    ...overrides,
  };
}

function repo(status: Partial<NonNullable<Repo["status"]>> = {}): Repo {
  return {
    id: "pull-repo",
    name: "pull-repo",
    displayName: null,
    absPath: "C:/pull-repo",
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
      headOid: "1".repeat(40),
      upstreamOid: "2".repeat(40),
      worktreeStateHash: "5".repeat(64),
      dirty: 0,
      ahead: 0,
      behind: 2,
      remote: "origin",
      error: null,
      fetchedAt: 1,
      updatedAt: 1,
      ...status,
    },
    updatedAt: 1,
  };
}

function mountPreview(result: IncomingResult, props: Record<string, unknown> = {}) {
  useStore().incomingByRepo["pull-repo"] = result;
  return mount(PullPreview, {
    props: { repoId: "pull-repo", ...props },
    global: {
      plugins: [i18n],
      stubs: {
        ChangesTree: true,
        DropdownMenu: passThrough,
        DropdownMenuTrigger: passThrough,
        DropdownMenuContent: passThrough,
        DropdownMenuItem: menuItemStub,
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

describe("PullPreview fast-forward trust verdict", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it("blocks a diverged pull even when a hypothetical manual merge is clean", () => {
    const wrapper = mountPreview(
      incoming({
        ahead: 3,
        relation: "diverged",
        pullDisposition: "blocked_non_fast_forward",
        fastForward: false,
      }),
      { pullDisabled: true, statusDiverged: true },
    );

    const verdict = wrapper.get('[data-testid="preview-pull-disposition"]');
    expect(verdict.text()).toContain("histories have diverged");
    expect(verdict.classes()).toContain("text-destructive");

    const manual = wrapper.get('[data-testid="preview-manual-merge"]');
    expect(manual.text()).toContain("A manual merge appears clean");
    expect(manual.text()).toContain("Pull stays blocked");
    expect(manual.classes()).toContain("text-info");
    expect(wrapper.text()).not.toContain("Merges cleanly with your local commits");
    expect(wrapper.text()).not.toContain("Pull anyway");
    expect(wrapper.get<HTMLButtonElement>('[data-testid="preview-pull-action"]').element.disabled).toBe(true);
    expect(wrapper.get<HTMLButtonElement>('[data-testid="preview-menu-pull"]').element.disabled).toBe(true);
  });

  it("only presents a proven fast-forward as green and actionable", async () => {
    const wrapper = mountPreview(incoming());
    const verdict = wrapper.get('[data-testid="preview-pull-disposition"]');
    const action = wrapper.get<HTMLButtonElement>('[data-testid="preview-pull-action"]');

    expect(verdict.text()).toContain("Ready to pull");
    expect(verdict.classes()).toContain("text-success");
    expect(action.element.disabled).toBe(false);

    await action.trigger("click");
    expect(wrapper.emitted("pull")).toHaveLength(1);
  });

  it("shows overwrite and unknown outcomes as non-actionable, never green", () => {
    const overwrite = mountPreview(
      incoming({
        pullDisposition: "blocked_would_overwrite",
        fastForward: true,
      }),
    );
    expect(overwrite.get('[data-testid="preview-pull-disposition"]').text()).toContain(
      "would overwrite local work",
    );
    expect(overwrite.get('[data-testid="preview-pull-disposition"]').classes()).toContain(
      "text-destructive",
    );
    expect(overwrite.get<HTMLButtonElement>('[data-testid="preview-pull-action"]').element.disabled).toBe(true);
    overwrite.unmount();

    const unknown = mountPreview(
      incoming({
        relation: "unknown",
        pullDisposition: "unknown",
        conflictCheck: false,
        fastForward: false,
      }),
    );
    const unknownVerdict = unknown.get('[data-testid="preview-pull-disposition"]');
    expect(unknownVerdict.text()).toContain("couldn't prove");
    expect(unknownVerdict.classes()).not.toContain("text-success");
    expect(unknown.get<HTMLButtonElement>('[data-testid="preview-pull-action"]').element.disabled).toBe(true);
    expect(unknown.get<HTMLButtonElement>('[data-testid="preview-menu-pull"]').element.disabled).toBe(true);
  });

  it("shows a fetch error before the fallback's no-upstream state", () => {
    const wrapper = mountPreview(
      incoming({
        ok: false,
        code: "ERROR",
        message: "Remote check failed",
        noUpstream: true,
        ahead: 0,
        behind: 0,
        relation: "unknown",
        pullDisposition: "unknown",
        commits: [],
      }),
    );

    expect(wrapper.text()).toContain("Remote check failed");
    expect(wrapper.text()).not.toContain("isn't tracking a remote branch");
    expect(wrapper.get<HTMLButtonElement>('[data-testid="preview-menu-pull"]').element.disabled).toBe(true);
  });
});

describe("RepoCardActions proactive pull warning", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  function mountActions(value: Repo, active = true) {
    return mount(RepoCardActions, {
      props: { repo: value, active },
      global: {
        plugins: [i18n],
        stubs: {
          StashPanel: true,
          PullPreview: {
            name: "PullPreview",
            props: ["repoId", "variant", "disabled", "pullDisabled", "statusDiverged"],
            template: '<div data-testid="pull-preview-stub" />',
          },
          Tooltip: passThrough,
          TooltipTrigger: inlinePassThrough,
          TooltipContent: inlinePassThrough,
        },
      },
    });
  }

  it("immediately turns both split-button halves red, blocks Pull, and previews divergence", async () => {
    const store = useStore();
    const load = vi.spyOn(store, "loadIncoming").mockResolvedValue();
    const value = repo({ ahead: 2, behind: 4, fetchedAt: 10 });
    const wrapper = mountActions(value);
    await flushPromises();

    const primary = wrapper.get<HTMLButtonElement>('[data-testid="repo-pull-primary"]');
    const preview = wrapper.getComponent({ name: "PullPreview" });
    expect(primary.attributes("data-variant")).toBe("destructive");
    expect(primary.element.disabled).toBe(true);
    expect(preview.props("variant")).toBe("destructive");
    expect(preview.props("disabled")).toBe(false);
    expect(preview.props("pullDisabled")).toBe(true);
    expect(preview.props("statusDiverged")).toBe(true);
    expect(wrapper.text()).toContain("histories have diverged");
    expect(load).toHaveBeenCalledWith("pull-repo", false);

    await wrapper.setProps({
      repo: repo({ ahead: 2, behind: 4, fetchedAt: 11 }),
    });
    await nextTick();
    expect(load).toHaveBeenCalledTimes(2);

    await wrapper.setProps({
      active: false,
      repo: repo({ ahead: 2, behind: 4, fetchedAt: 12 }),
    });
    await nextTick();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("preflights any behind Git card and fails closed during the initial check", async () => {
    const store = useStore();
    const load = vi.spyOn(store, "loadIncoming").mockResolvedValue();
    const wrapper = mountActions(repo({ ahead: 0, behind: 2 }));
    await flushPromises();
    expect(load).toHaveBeenCalledWith("pull-repo", false);
    wrapper.unmount();

    load.mockClear();
    store.incomingLoading["pull-repo"] = true;
    const loading = mountActions(repo({ ahead: 0, behind: 2 }));
    const primary = loading.get<HTMLButtonElement>('[data-testid="repo-pull-primary"]');
    const preview = loading.getComponent({ name: "PullPreview" });
    expect(primary.attributes("data-variant")).toBe("outline");
    expect(primary.element.disabled).toBe(true);
    expect(preview.props("disabled")).toBe(false);
    expect(preview.props("pullDisabled")).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it("uses a cached overwrite verdict to disable Pull while preserving Preview access", () => {
    const store = useStore();
    store.incomingByRepo["pull-repo"] = incoming({
      pullDisposition: "blocked_would_overwrite",
    });
    const wrapper = mountActions(repo({ ahead: 0, behind: 2 }));

    const primary = wrapper.get<HTMLButtonElement>('[data-testid="repo-pull-primary"]');
    const preview = wrapper.getComponent({ name: "PullPreview" });
    expect(primary.attributes("data-variant")).toBe("destructive");
    expect(primary.element.disabled).toBe(true);
    expect(preview.props("disabled")).toBe(false);
    expect(preview.props("pullDisabled")).toBe(true);
    expect(wrapper.text()).toContain("would overwrite local work");
  });

  it("fails closed and revalidates when ahead/behind changed since the cached preview", async () => {
    const store = useStore();
    const load = vi.spyOn(store, "loadIncoming").mockResolvedValue();
    store.incomingByRepo["pull-repo"] = incoming({
      ahead: 2,
      behind: 4,
      relation: "diverged",
      pullDisposition: "blocked_non_fast_forward",
      fastForward: false,
    });
    const wrapper = mountActions(repo({ ahead: 0, behind: 2 }));

    const primary = wrapper.get<HTMLButtonElement>('[data-testid="repo-pull-primary"]');
    const preview = wrapper.getComponent({ name: "PullPreview" });
    expect(primary.attributes("data-variant")).toBe("outline");
    expect(primary.element.disabled).toBe(true);
    expect(preview.props("pullDisabled")).toBe(true);
    expect(load).toHaveBeenCalledWith("pull-repo", false);
  });

  it("drops stale green and stale red verdicts when worktree status changes at the same counts", async () => {
    const store = useStore();
    const load = vi.spyOn(store, "loadIncoming").mockResolvedValue();

    store.incomingByRepo["pull-repo"] = incoming({
      checkedAt: 100,
      pullDisposition: "ready_fast_forward",
    });
    const green = mountActions(
      repo({ ahead: 0, behind: 2, updatedAt: 100, worktreeStateHash: "6".repeat(64) }),
    );
    expect(green.get('[data-testid="repo-pull-primary"]').attributes("data-variant")).toBe("outline");
    expect(green.get<HTMLButtonElement>('[data-testid="repo-pull-primary"]').element.disabled).toBe(true);
    expect(load).toHaveBeenCalledWith("pull-repo", false);
    green.unmount();

    load.mockClear();
    store.incomingByRepo["pull-repo"] = incoming({
      checkedAt: 100,
      pullDisposition: "blocked_would_overwrite",
    });
    const red = mountActions(
      repo({ ahead: 0, behind: 2, updatedAt: 100, worktreeStateHash: "6".repeat(64) }),
    );
    expect(red.get('[data-testid="repo-pull-primary"]').attributes("data-variant")).toBe("outline");
    expect(red.get<HTMLButtonElement>('[data-testid="repo-pull-primary"]').element.disabled).toBe(true);
    expect(load).toHaveBeenCalledWith("pull-repo", false);
  });

  it.each([
    {
      label: "unknown",
      result: incoming({ relation: "unknown", pullDisposition: "unknown", snapshot: null }),
    },
    {
      label: "error",
      result: incoming({
        ok: false,
        code: "ERROR",
        relation: "unknown",
        pullDisposition: "unknown",
        snapshot: null,
      }),
    },
    {
      label: "no upstream",
      result: incoming({
        noUpstream: true,
        upstream: "",
        ahead: 0,
        behind: 2,
        relation: "no_upstream",
        pullDisposition: "noop",
        snapshot: null,
      }),
    },
  ])("disables both Pull entry points for a current $label preview", ({ result }) => {
    const store = useStore();
    store.incomingByRepo["pull-repo"] = result;
    const wrapper = mountActions(repo({ ahead: result.ahead, behind: result.behind }));
    const primary = wrapper.get<HTMLButtonElement>('[data-testid="repo-pull-primary"]');
    const preview = wrapper.getComponent({ name: "PullPreview" });
    expect(primary.element.disabled).toBe(true);
    expect(preview.props("pullDisabled")).toBe(true);
  });
});
