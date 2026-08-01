/**
 * The conflict-resolution review UI.
 *
 * These assert the SAFETY surface, not the styling: that the model-tier advisory is present and
 * escalates, that no region is accepted by default, that the mechanical audit is rendered even
 * when the model called itself confident, and that Apply sends exactly what was ticked. Each of
 * those is a decision someone could "simplify" away later without noticing what it was for.
 */
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import ConflictResolver from "@/components/conflicts/ConflictResolver.vue";
import { i18n } from "@/i18n";
import { useStore } from "@/store";
import type { AiSettings, ConflictHunk, ConflictResolveResponse, Repo } from "@/types";

vi.mock("vue-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

const REPO_ID = "conflicted-repo";
const FILE = "src/app.ts";

const repo = (): Repo =>
  ({
    id: REPO_ID,
    name: "conflicted-repo",
    displayName: null,
    absPath: "C:/conflicted-repo",
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
      conflicted: true,
    },
    updatedAt: 0,
  }) as unknown as Repo;

/** A connected provider, so `aiConflictEnabled` is true and the Resolve button is offered. */
const aiSettings = (model: string, conflictEnabled = true): AiSettings =>
  ({
    providers: { openai: { configured: true, model } },
    defaultProvider: "openai",
    style: "conventional",
    diffDetail: "lean",
    yolo: false,
    commitEnabled: true,
    conflictEnabled,
    modelTier: model.includes("mini") ? "small" : "unknown",
  }) as unknown as AiSettings;

const hunk = (index: number): ConflictHunk => ({
  index,
  line: 10 * index,
  oursLabel: "HEAD",
  theirsLabel: "feature",
  oursText: "shared();\nours();\n",
  theirsText: "shared();\ntheirs();\n",
  raw: "<<<<<<< HEAD\nshared();\nours();\n=======\nshared();\ntheirs();\n>>>>>>> feature\n",
});

const resolveResponse = (over: Partial<ConflictResolveResponse> = {}): ConflictResolveResponse =>
  ({
    ok: true,
    path: FILE,
    hash: "abc123hash",
    hasBase: true,
    windowed: false,
    hunks: [hunk(1), hunk(2)],
    provider: "openai",
    model: "gpt-4o-mini",
    modelTier: "small",
    rejected: [],
    resolutions: [
      {
        index: 1,
        content: "shared();\nours();\ntheirs();",
        confidence: "high",
        note: "kept both changes",
        flags: [],
        droppedLines: [],
        inventedLines: [],
      },
      {
        index: 2,
        // The dangerous shape: the model says "high", and it dropped a line both sides kept.
        content: "ours();\ntheirs();",
        confidence: "high",
        note: "merged them",
        flags: ["dropped-shared-lines"],
        droppedLines: ["shared();"],
        inventedLines: [],
      },
    ],
    ...over,
  }) as ConflictResolveResponse;

let wrapper: VueWrapper | undefined;

function mountResolver() {
  wrapper = mount(ConflictResolver, {
    props: { repo: repo() },
    global: {
      plugins: [i18n],
      stubs: {
        Tooltip: { template: "<div><slot /></div>" },
        TooltipTrigger: { template: "<span><slot /></span>" },
        TooltipContent: { template: "<span><slot /></span>" },
      },
    },
  });
  return wrapper;
}

describe("ConflictResolver", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.restoreAllMocks();
  });

  it("lists conflicted files and names the reason an unsupported one cannot be resolved", async () => {
    const store = useStore();
    store.aiSettings = aiSettings("gpt-4o-mini");
    vi.spyOn(store, "listConflicts").mockResolvedValue([
      { path: FILE, kind: "both-modified", hunks: 2 },
      { path: "logo.png", kind: "both-added", hunks: 0, unsupported: "binary" },
    ]);

    const w = mountResolver();
    await flushPromises();

    expect(w.text()).toContain(FILE);
    expect(w.text()).toContain("logo.png");
    // Listed WITH its reason rather than filtered out — a vanished file reads as a broken feature.
    expect(w.text()).toContain("Binary file");
    // …and it gets no Resolve button.
    expect(w.findAll("button").filter((b) => b.text().includes("Resolve with AI"))).toHaveLength(1);
  });

  it("warns about the model on every run, and escalates for a small tier", async () => {
    const store = useStore();
    store.aiSettings = aiSettings("gpt-4o-mini");
    vi.spyOn(store, "listConflicts").mockResolvedValue([{ path: FILE, hunks: 1 }]);

    const small = mountResolver();
    await flushPromises();
    expect(small.text()).toContain("gpt-4o-mini");
    expect(small.text()).toContain("small, fast model");
    small.unmount();

    store.aiSettings = aiSettings("llama-3.3-70b-versatile");
    const big = mountResolver();
    await flushPromises();
    // Still warned — just not the escalated wording.
    expect(big.text()).toContain("a wrong merge is code that compiles");
    expect(big.text()).not.toContain("small, fast model");
  });

  it("hides the Resolve button when the owner turned the feature off", async () => {
    const store = useStore();
    store.aiSettings = aiSettings("gpt-4o-mini", false);
    vi.spyOn(store, "listConflicts").mockResolvedValue([{ path: FILE, hunks: 1 }]);

    const w = mountResolver();
    await flushPromises();
    // The file still LISTS (the owner should see the merge), but AI is not offered.
    expect(w.text()).toContain(FILE);
    expect(w.findAll("button").filter((b) => b.text().includes("Resolve with AI"))).toHaveLength(0);
  });

  it("accepts nothing by default and keeps Apply disabled until the owner ticks a region", async () => {
    const store = useStore();
    store.aiSettings = aiSettings("gpt-4o-mini");
    vi.spyOn(store, "listConflicts").mockResolvedValue([{ path: FILE, hunks: 2 }]);
    vi.spyOn(store, "resolveConflict").mockResolvedValue(resolveResponse());

    const w = mountResolver();
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("Resolve with AI"))!.trigger("click");
    await flushPromises();

    // Both regions rendered, neither accepted — on this feature, nobody is opted in by default.
    expect(w.text()).toContain("0 of 2 accepted");
    const applyBtn = w.findAll("button").find((b) => b.text().includes("Apply accepted"))!;
    expect(applyBtn.attributes("disabled")).toBeDefined();
  });

  it("renders the mechanical audit even when the model called itself high-confidence", async () => {
    // The whole point of the audit: a confidently-worded bad merge still shows its evidence.
    const store = useStore();
    store.aiSettings = aiSettings("gpt-4o-mini");
    vi.spyOn(store, "listConflicts").mockResolvedValue([{ path: FILE, hunks: 2 }]);
    vi.spyOn(store, "resolveConflict").mockResolvedValue(resolveResponse());

    const w = mountResolver();
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("Resolve with AI"))!.trigger("click");
    await flushPromises();

    expect(w.text()).toContain("drops a line that BOTH sides kept");
    // And the actual dropped line is shown, so the claim is checkable in place.
    expect(w.text()).toContain("shared();");
  });

  it("'Accept the clean ones' skips any region the audit flagged", async () => {
    const store = useStore();
    store.aiSettings = aiSettings("gpt-4o-mini");
    vi.spyOn(store, "listConflicts").mockResolvedValue([{ path: FILE, hunks: 2 }]);
    vi.spyOn(store, "resolveConflict").mockResolvedValue(resolveResponse());

    const w = mountResolver();
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("Resolve with AI"))!.trigger("click");
    await flushPromises();

    // Region 2 carries `dropped-shared-lines`, so only region 1 counts as clean.
    const clean = w.findAll("button").find((b) => b.text().includes("Accept the 1 clean"))!;
    expect(clean).toBeTruthy();
    await clean.trigger("click");
    await nextTick();
    expect(w.text()).toContain("1 of 2 accepted");
  });

  it("applies exactly the accepted regions, with the hash the proposal was made against", async () => {
    const store = useStore();
    store.aiSettings = aiSettings("gpt-4o-mini");
    vi.spyOn(store, "listConflicts").mockResolvedValue([{ path: FILE, hunks: 2 }]);
    vi.spyOn(store, "resolveConflict").mockResolvedValue(resolveResponse());
    const applySpy = vi
      .spyOn(store, "applyConflict")
      .mockResolvedValue({ ok: true, path: FILE, applied: 1, remaining: 1 });

    const w = mountResolver();
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("Resolve with AI"))!.trigger("click");
    await flushPromises();

    await w.findAll("button").find((b) => b.text().includes("Accept the 1 clean"))!.trigger("click");
    await nextTick();
    await w.findAll("button").find((b) => b.text().includes("Apply accepted"))!.trigger("click");
    await flushPromises();

    expect(applySpy).toHaveBeenCalledWith(REPO_ID, FILE, "abc123hash", [
      { index: 1, content: "shared();\nours();\ntheirs();" },
    ]);
  });

  it("says so when the model saw only part of the file, or had no common ancestor", async () => {
    const store = useStore();
    store.aiSettings = aiSettings("gpt-4o-mini");
    vi.spyOn(store, "listConflicts").mockResolvedValue([{ path: FILE, hunks: 1 }]);
    vi.spyOn(store, "resolveConflict").mockResolvedValue(
      resolveResponse({ windowed: true, hasBase: false }),
    );

    const w = mountResolver();
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("Resolve with AI"))!.trigger("click");
    await flushPromises();

    expect(w.text()).toContain("too large to show the model in full");
    expect(w.text()).toContain("could not tell an addition from a deletion");
  });

  it("names a region the model failed to answer for instead of silently showing fewer cards", async () => {
    const store = useStore();
    store.aiSettings = aiSettings("gpt-4o-mini");
    vi.spyOn(store, "listConflicts").mockResolvedValue([{ path: FILE, hunks: 2 }]);
    vi.spyOn(store, "resolveConflict").mockResolvedValue(
      resolveResponse({
        resolutions: [resolveResponse().resolutions[0]!],
        rejected: [{ index: 2, reason: "conflict-markers" }],
      }),
    );

    const w = mountResolver();
    await flushPromises();
    await w.findAll("button").find((b) => b.text().includes("Resolve with AI"))!.trigger("click");
    await flushPromises();

    expect(w.text()).toContain("still contained conflict markers");
    // Region 2 has no proposal, so it gets no Accept control and cannot be applied by mistake —
    // and "Accept the clean ones" still only reaches the one region that came back usable.
    expect(w.text()).toContain("0 of 2 accepted");
    expect(w.findAll("button").filter((b) => b.text().trim() === "Accept")).toHaveLength(1);
  });
});
