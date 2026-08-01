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
  // reload replaced the array. Anything that merely reads the list must see the patch.
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
