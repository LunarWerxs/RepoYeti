import { describe, expect, it } from "vitest";
import { computed, ref } from "vue";

import { useRepoActions } from "@/store/repo";
import type { ActionName, ActionResult, Repo } from "@/types";

/**
 * A repo exactly as an SSE frame delivers one: a plain, NON-reactive object straight out of
 * JSON.parse. That rawness is the whole point of these tests — see upsertRepo in store/repo.ts.
 */
function repo(id: string, over: Partial<Repo> = {}): Repo {
  return JSON.parse(
    JSON.stringify({
      id,
      name: id,
      displayName: null,
      absPath: `D:/${id}`,
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
      sortOrder: null,
      status: null,
      updatedAt: 1,
      ...over,
    }),
  ) as Repo;
}

function status(over: Partial<NonNullable<Repo["status"]>> = {}): NonNullable<Repo["status"]> {
  return {
    branch: "main",
    detached: false,
    headOid: "a".repeat(40),
    dirty: 0,
    ahead: 0,
    behind: 0,
    remote: "origin",
    error: null,
    fetchedAt: null,
    updatedAt: 1,
    ...over,
  };
}

/** The composable under test, wired the way the store barrel wires it. */
function harness(initial: Repo[] = []) {
  const repos = ref<Repo[]>(initial);
  const busy: Record<string, ActionName | undefined> = {};
  const asResult = (e: unknown): ActionResult => ({
    ok: false,
    code: "ERROR",
    message: String(e),
  });
  const actions = useRepoActions(repos, busy, asResult);
  return { repos, ...actions, names: () => repos.value.map((r) => r.name) };
}

describe("upsertRepo: live-discovered repos stay reactive", () => {
  // The regression: upsertRepo used to cache the raw pushed object in its id→repo lookup. Vue
  // stores the raw value in the array proxy's target and only wraps it on READ, so patching that
  // cached raw reference mutated the target directly and never fired the proxy's set trap. A repo
  // a scan discovered therefore sat at status:null — no clean badge, push disabled — until a full
  // reload rebuilt the lookup. Anything that merely reads the list must see the patch.
  it("re-renders a scan-discovered repo when its status arrives later", () => {
    const h = harness();
    const branch = computed(() => h.repos.value[0]?.status?.branch ?? null);
    expect(branch.value).toBe(null);

    h.upsertRepo(repo("fresh"));
    expect(branch.value).toBe(null); // indexed, status not read yet

    h.patchRepo("fresh", { status: status({ branch: "trunk" }) });
    expect(branch.value).toBe("trunk");
  });

  it("re-renders through the visibleRepos computed the dashboard actually renders", () => {
    const h = harness();
    const dirty = computed(() => h.visibleRepos.value[0]?.status?.dirty ?? -1);

    h.upsertRepo(repo("fresh"));
    expect(dirty.value).toBe(-1);

    h.patchRepo("fresh", { status: status({ dirty: 7 }) });
    expect(dirty.value).toBe(7);
  });

  it("keeps a repo reactive through a later upsert of the same id", () => {
    const h = harness();
    const dirty = computed(() => h.repos.value[0]?.status?.dirty ?? -1);

    h.upsertRepo(repo("fresh"));
    h.upsertRepo(repo("fresh", { status: status({ dirty: 4 }) }));
    expect(dirty.value).toBe(4);
    expect(h.repos.value).toHaveLength(1); // upsert, not a duplicate insert
  });

  it("still patches repos that arrived in the initial list load", () => {
    const h = harness([repo("loaded")]);
    const branch = computed(() => h.repos.value[0]?.status?.branch ?? null);

    h.patchRepo("loaded", { status: status({ branch: "main" }) });
    expect(branch.value).toBe("main");
  });
});

describe("upsertRepo: placement matches the server's ORDER BY", () => {
  // Scans used to append every find to the end of the list, so a sweep dumped its results in raw
  // filesystem-walk order at the bottom instead of where a reload would have put them.
  it("slots an un-ordered repo alphabetically among the other un-ordered ones", () => {
    const h = harness([repo("alpha"), repo("charlie")]);

    h.upsertRepo(repo("bravo"));
    expect(h.names()).toEqual(["alpha", "bravo", "charlie"]);

    h.upsertRepo(repo("aardvark"));
    h.upsertRepo(repo("zulu"));
    expect(h.names()).toEqual(["aardvark", "alpha", "bravo", "charlie", "zulu"]);
  });

  it("is case-insensitive, matching COLLATE NOCASE", () => {
    const h = harness([repo("Apple"), repo("cherry")]);

    h.upsertRepo(repo("banana"));
    expect(h.names()).toEqual(["Apple", "banana", "cherry"]);
  });

  it("keeps every dragged repo ahead of un-ordered ones, as the server does", () => {
    // A drag assigns sort_order to everything present; a later find has none.
    const h = harness([repo("zebra", { sortOrder: 0 }), repo("apple", { sortOrder: 1 })]);

    h.upsertRepo(repo("mango"));
    expect(h.names()).toEqual(["zebra", "apple", "mango"]);

    // ...and the un-ordered tail is alphabetical among itself.
    h.upsertRepo(repo("banana"));
    expect(h.names()).toEqual(["zebra", "apple", "banana", "mango"]);
  });

  it("sorts submodules after ordinary repos at the same rank", () => {
    const h = harness([repo("aaa-sub", { isSubmodule: true })]);

    h.upsertRepo(repo("zzz-plain"));
    expect(h.names()).toEqual(["zzz-plain", "aaa-sub"]);
  });

  it("places the very first repo without inspecting an empty list", () => {
    const h = harness();
    h.upsertRepo(repo("only"));
    expect(h.names()).toEqual(["only"]);
  });

  it("leaves an inserted-before repo patchable (the lookup survives the shift)", () => {
    const h = harness();
    h.upsertRepo(repo("mike"));
    h.upsertRepo(repo("alpha")); // spliced in AHEAD of mike
    const mikeBranch = computed(
      () => h.repos.value.find((r) => r.id === "mike")?.status?.branch ?? null,
    );

    h.patchRepo("mike", { status: status({ branch: "release" }) });
    expect(h.names()).toEqual(["alpha", "mike"]);
    expect(mikeBranch.value).toBe("release");
  });
});

describe("hasManualOrder", () => {
  it("is false until some repo carries a drag-persisted position", () => {
    const h = harness([repo("a"), repo("b")]);
    expect(h.hasManualOrder.value).toBe(false);

    h.upsertRepo(repo("c", { sortOrder: 0 }));
    expect(h.hasManualOrder.value).toBe(true);
  });

  // A daemon older than the sortOrder field omits it entirely. `undefined !== null` would read as
  // "every repo is manually ordered", offering a Reset for an order that does not exist and
  // wedging every new find into the dragged bucket.
  it("treats a missing sortOrder from an older daemon as no order", () => {
    const legacy = () => {
      const r = repo("legacy") as Partial<Repo>;
      delete r.sortOrder;
      return r as Repo;
    };
    const h = harness([legacy()]);
    expect(h.hasManualOrder.value).toBe(false);

    h.upsertRepo(repo("apple"));
    expect(h.names()).toEqual(["apple", "legacy"]); // still plain alphabetical
  });
});

describe("queueRepoAdded: batched insertion for a repo_added burst", () => {
  // A "scan whole computer" run fires one `repo_added` SSE event per repo it finds — hundreds in
  // a burst. `upsertRepo` (used only by deliberate local actions: register/create/clone/restore)
  // stays immediate; `queueRepoAdded` is what the live event stream calls, and it buffers new
  // repos instead of splicing each one in, so a whole burst costs one recompute of the dependent
  // computeds (visibleRepos, filteredRepos, pinned/starred/other) instead of one per repo.
  it("buffers new repos until flushed, applying them as one merge", () => {
    const h = harness([repo("alpha"), repo("charlie")]);

    h.queueRepoAdded(repo("bravo"));
    h.queueRepoAdded(repo("aardvark"));
    expect(h.names()).toEqual(["alpha", "charlie"]); // still buffered, not yet in the list

    h.flushPendingRepoInserts();
    expect(h.names()).toEqual(["aardvark", "alpha", "bravo", "charlie"]);
  });

  it("matches per-event insertion for a shuffled arrival order", () => {
    // A realistic mixed batch: some repos carry a drag-persisted sort_order, some don't; one is a
    // submodule; one only differs from another by case. Arrival order is deliberately scrambled
    // relative to the final order the server's ORDER BY would produce.
    const arrivals = [
      repo("kiwi"),
      repo("zebra", { sortOrder: 2 }),
      repo("aardvark"),
      repo("sub-tool", { isSubmodule: true }),
      repo("banana", { sortOrder: 1 }),
      repo("Cherry"),
      repo("mango"),
      repo("apple", { sortOrder: 0 }),
    ];
    const expected = [
      "apple", "banana", "zebra", // ranked, by sort_order
      "aardvark", "Cherry", "kiwi", "mango", // un-ranked, alphabetical, case-insensitive
      "sub-tool", // un-ranked submodule, after ordinary repos at the same rank
    ];

    // Sequential: today's `upsertRepo` per-event behaviour (one splice + resort per repo), kept
    // as the ground truth the batched path must reproduce exactly.
    const sequential = harness();
    for (const r of arrivals) sequential.upsertRepo(r);
    expect(sequential.names()).toEqual(expected);

    // Batched: the exact same repos, all buffered via queueRepoAdded, then a single flush (a
    // scan burst).
    const batched = harness();
    for (const r of arrivals) batched.queueRepoAdded(r);
    expect(batched.names()).toEqual([]); // nothing lands until the flush
    batched.flushPendingRepoInserts();
    expect(batched.names()).toEqual(expected);
  });

  it("drops a buffered repo a wholesale reload already carries, instead of duplicating it", () => {
    const h = harness([repo("alpha")]);
    h.queueRepoAdded(repo("fresh", { status: status({ dirty: 3 }) })); // buffered, not flushed

    // A full reload (loadAll, resetRepoOrder, an identity switch) replaces the array wholesale —
    // and this one already carries "fresh" with newer data than the stale buffered copy.
    h.repos.value = [repo("alpha"), repo("fresh", { status: status({ dirty: 9 }) })];

    h.flushPendingRepoInserts();
    expect(h.names()).toEqual(["alpha", "fresh"]); // no duplicate "fresh"
    const fresh = h.repos.value.find((r) => r.name === "fresh");
    expect(fresh?.status?.dirty).toBe(9); // the reload's data won, not the stale buffered copy
  });

  it("does not resurrect a repo removed from the cache while still buffered", () => {
    const h = harness();
    h.queueRepoAdded(repo("ghost")); // buffered, not yet flushed
    h.clearRepoCache("ghost"); // e.g. its repo_removed SSE event arrives before the next flush

    h.flushPendingRepoInserts();
    expect(h.names()).toEqual([]);
  });

  it("keeps a patch applied to a still-buffered repo through the flush", () => {
    const h = harness();
    h.queueRepoAdded(repo("fresh")); // buffered, not yet flushed
    h.patchRepo("fresh", { status: status({ branch: "trunk" }) }); // arrives before the flush

    h.flushPendingRepoInserts();
    expect(h.repos.value[0]?.status?.branch).toBe("trunk");
  });

  it("refreshes an already-live repo immediately, without buffering", () => {
    const h = harness([repo("alpha", { status: status({ dirty: 0 }) })]);

    h.queueRepoAdded(repo("alpha", { status: status({ dirty: 5 }) }));
    expect(h.repos.value[0]?.status?.dirty).toBe(5); // no flush needed — it was already live
  });
});
