/**
 * The repo list's ordering contract, from the daemon's side.
 *
 * The trap this pins down: setRepoOrder() assigns a position to EVERY id it is handed, so the
 * first drag stamps all 51 repos at once. From then on a newly discovered repo — which has no
 * position — can only sort after all of them, forever, no matter what it is called. That is why
 * a scan's finds pile up at the bottom of the dashboard and stay there across reloads, and it is
 * why "Reset to A–Z" (an empty reorder) exists as the way back out.
 *
 * `sortOrder` is exposed on the view for the same reason: the dashboard has to be able to slot a
 * repo that streams in over SSE into the position a reload would have given it, which means it
 * needs to know which repos are pinned to a saved arrangement and which are not.
 */
import { test, expect } from "bun:test";
import { getRepos, setRepoOrder } from "../src/db.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";

/** Seed three repos whose names are deliberately NOT in insertion order. */
function seed(prefix: string): { charlie: string; alpha: string; bravo: string } {
  const charlie = mustUpsertRepo(mkScratchDir(`${prefix}-c-`), "charlie", "auto", false);
  const alpha = mustUpsertRepo(mkScratchDir(`${prefix}-a-`), "alpha", "auto", false);
  const bravo = mustUpsertRepo(mkScratchDir(`${prefix}-b-`), "bravo", "auto", false);
  return { charlie, alpha, bravo };
}

const namesOf = (ids: string[]): string[] =>
  getRepos()
    .filter((r) => ids.includes(r.id))
    .map((r) => r.name);

test("an un-reordered repo carries no sortOrder and sorts by name", () => {
  const { charlie, alpha, bravo } = seed("order-fresh");
  const ids = [charlie, alpha, bravo];

  for (const r of getRepos().filter((x) => ids.includes(x.id))) {
    expect(r.sortOrder).toBeNull();
  }
  expect(namesOf(ids)).toEqual(["alpha", "bravo", "charlie"]);
});

test("setRepoOrder stamps a position on every id it is given, and getRepos honours it", () => {
  const { charlie, alpha, bravo } = seed("order-drag");
  const ids = [charlie, alpha, bravo];

  setRepoOrder([charlie, bravo, alpha]);

  const byId = new Map(getRepos().map((r) => [r.id, r]));
  expect(byId.get(charlie)!.sortOrder).toBe(0);
  expect(byId.get(bravo)!.sortOrder).toBe(1);
  expect(byId.get(alpha)!.sortOrder).toBe(2);
  expect(namesOf(ids)).toEqual(["charlie", "bravo", "alpha"]);
});

test("a repo discovered after a drag has no position, so it sorts BELOW every dragged one", () => {
  const { charlie, alpha, bravo } = seed("order-newcomer");
  setRepoOrder([charlie, bravo, alpha]);

  // "aaa" would be first alphabetically — it still lands last. This is the reported complaint.
  const newcomer = mustUpsertRepo(mkScratchDir("order-newcomer-n-"), "aaa-newcomer", "auto", false);
  const ids = [charlie, alpha, bravo, newcomer];

  expect(getRepos().find((r) => r.id === newcomer)!.sortOrder).toBeNull();
  expect(namesOf(ids)).toEqual(["charlie", "bravo", "alpha", "aaa-newcomer"]);
});

test("an empty reorder clears every saved position — the 'Reset to A–Z' way out", () => {
  const { charlie, alpha, bravo } = seed("order-reset");
  const newcomer = mustUpsertRepo(mkScratchDir("order-reset-n-"), "aaa-newcomer", "auto", false);
  const ids = [charlie, alpha, bravo, newcomer];
  setRepoOrder([charlie, bravo, alpha]);
  expect(namesOf(ids)).toEqual(["charlie", "bravo", "alpha", "aaa-newcomer"]);

  setRepoOrder([]);

  for (const r of getRepos().filter((x) => ids.includes(x.id))) {
    expect(r.sortOrder).toBeNull();
  }
  expect(namesOf(ids)).toEqual(["aaa-newcomer", "alpha", "bravo", "charlie"]);
});

test("setRepoOrder clears the position of any repo missing from the list", () => {
  const { charlie, alpha, bravo } = seed("order-partial");
  setRepoOrder([charlie, bravo, alpha]);

  // A later drag over a filtered view lists only two of them; the omitted one must not keep a
  // stale position and float somewhere arbitrary.
  setRepoOrder([alpha, charlie]);

  const byId = new Map(getRepos().map((r) => [r.id, r]));
  expect(byId.get(alpha)!.sortOrder).toBe(0);
  expect(byId.get(charlie)!.sortOrder).toBe(1);
  expect(byId.get(bravo)!.sortOrder).toBeNull();
  expect(namesOf([charlie, alpha, bravo])).toEqual(["alpha", "charlie", "bravo"]);
});
