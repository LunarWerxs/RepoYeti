import { test, expect } from "bun:test";
import { parseCommitPlan } from "../src/ai.ts";

// Regression for F016: a group whose `files` repeats a path used to keep the duplicate, because
// `seen` is only filled *after* the per-group filter — so within-group dupes never got dropped.
test("parseCommitPlan dedupes a path repeated inside one group", () => {
  const text = JSON.stringify({
    groups: [{ type: "fix", subject: "x", files: ["src/a.ts", "src/a.ts"] }],
  });
  const plan = parseCommitPlan(text, ["src/a.ts"]);
  expect(plan).not.toBeNull();
  expect(plan!.groups[0]!.files).toEqual(["src/a.ts"]);
});

test("parseCommitPlan keeps within-group dedupe disjoint with cross-group dedupe", () => {
  const text = JSON.stringify({
    groups: [
      { type: "feat", subject: "one", files: ["a.ts", "a.ts", "b.ts"] },
      { type: "fix", subject: "two", files: ["b.ts", "c.ts", "c.ts"] },
    ],
  });
  const plan = parseCommitPlan(text, ["a.ts", "b.ts", "c.ts"]);
  expect(plan!.groups[0]!.files).toEqual(["a.ts", "b.ts"]);
  expect(plan!.groups[1]!.files).toEqual(["c.ts"]);
  expect(plan!.leftovers).toEqual([]);
});
