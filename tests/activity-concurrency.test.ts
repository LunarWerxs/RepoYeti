/**
 * Activity enrichment must not multiply the git process budget (audit item 16).
 *
 * readGitActivity holds ONE readGate slot for its whole transaction; the gate exists to cap
 * concurrent git children machine-wide. The diff-tree enrichment inside that slot used to fan its
 * chunks out with Promise.allSettled — four children for a cold Daily view, up to fourteen for
 * Hourly, all charged to a single slot, and multiplied again by concurrent requests. This test
 * drives the enrichment step with a spied `gitRawWithInput` and asserts the chunks run strictly
 * one at a time. No real repository is needed: the spy stands in for git.
 */
import { expect, spyOn, test } from "bun:test";
import * as gitModule from "../src/git.ts";
import { measureMissingStats, type ActivityWindow, type ParsedActivityCommit } from "../src/read/activity.ts";

test("diff-tree enrichment chunks run one at a time inside the read slot, and one failure does not stop the rest", async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const spy = spyOn(gitModule, "gitRawWithInput").mockImplementation(async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(5); // long enough that a parallel fan-out would overlap
    active--;
    if (calls === 2) throw new Error("simulated git failure for one chunk");
    return "";
  });
  try {
    // 1,000 commits at a 1,000 cap → three chunks of 375 / 375 / 250 (ACTIVITY_CHANGE_STAT_CHUNK).
    const commits: ParsedActivityCommit[] = Array.from({ length: 1_000 }, (_, i) => ({
      hash: i.toString(16).padStart(40, "0"),
      date: 1_700_000_000_000 + i * 60_000,
      authorName: "a",
      authorEmail: "a@example.com",
    }));
    const window: ActivityWindow = {
      scale: "daily",
      bucketUnit: "day",
      starts: [1_700_000_000_000],
      since: 1_700_000_000_000,
      until: 1_700_000_000_000 + 1_000 * 60_000,
    };
    const measured = await measureMissingStats("<spied>", commits, window, 1_000, "%H", new Map());
    expect(calls).toBe(3);
    expect(peak).toBe(1);
    expect(measured).toEqual([]); // the spy returns no stat lines; the shape is what matters here
  } finally {
    spy.mockRestore();
  }
});
