import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import RepoCollaboration from "@/components/repo-card/RepoCollaboration.vue";
import type { Repo } from "@/types";

const repo = { id: "owner-repo" } as Repo;

describe("RepoCollaboration", () => {
  beforeEach(() => setActivePinia(createPinia()));

  function mountPanel() {
    const store = useStore();
    store.changesByRepo[repo.id] = [
      { path: "src/mine.ts", status: "M", staged: false },
      { path: "src/shared.ts", status: "M", staged: false },
    ];
    store.collaborationSnapshots = [
      {
        version: 1,
        participantId: "a".repeat(32),
        label: "peer@example.com",
        repoId: repo.id,
        localRepoName: "Peer checkout",
        status: null,
        changes: [
          {
            path: "src/theirs.ts",
            status: "A",
            staged: false,
            stat: { addedLines: 3, removedLines: 0, addedChars: 30, removedChars: 0 },
          },
          { path: "src/shared.ts", status: "M", staged: false },
        ],
        diff: "diff --git a/src/theirs.ts b/src/theirs.ts\n+peer edit",
        updatedAt: Date.now(),
      },
    ];
    return mount(RepoCollaboration, {
      props: { repo, mode: "mine" },
      global: { plugins: [i18n] },
    });
  }

  it("offers Mine, Theirs, and Combined whenever a live peer maps the same repo", () => {
    const wrapper = mountPanel();
    expect(wrapper.text()).toContain("peer@example.com");
    expect(wrapper.text()).toContain(i18n.global.t("collaboration.mine"));
    expect(wrapper.text()).toContain(i18n.global.t("collaboration.theirs"));
    expect(wrapper.text()).toContain(i18n.global.t("collaboration.combined"));
  });

  it("Theirs shows peer paths and encrypted diff totals without exposing local paths", async () => {
    const wrapper = mountPanel();
    await wrapper.setProps({ mode: "theirs" });
    expect(wrapper.text()).toContain("src/theirs.ts");
    expect(wrapper.text()).toContain("+3");
    expect(wrapper.text()).toContain(i18n.global.t("collaboration.peerDiff"));
    expect(wrapper.text()).toContain("peer edit");
    expect(wrapper.text()).not.toContain("src/mine.ts");
  });

  it("Combined merges matching paths and labels who changed each one", async () => {
    const wrapper = mountPanel();
    await wrapper.setProps({ mode: "combined" });
    expect(wrapper.text()).toContain("src/mine.ts");
    expect(wrapper.text()).toContain("src/theirs.ts");
    expect(wrapper.text()).toContain("src/shared.ts");
    expect(wrapper.text()).toContain("peer@example.com");
  });
});
