import { describe, it, expect } from "vitest";
import { computeGraph, type GraphCommit, type GraphLink } from "@/lib/git-graph";

// Helper: does a row contain a link matching the given endpoints (ignoring color)?
const hasLink = (links: GraphLink[], x1: number, y1: number, x2: number, y2: number): boolean =>
  links.some((l) => l.x1 === x1 && l.y1 === y1 && l.x2 === x2 && l.y2 === y2);

describe("computeGraph", () => {
  it("lays a linear history in a single lane", () => {
    const commits: GraphCommit[] = [
      { hash: "A", parents: ["B"] },
      { hash: "B", parents: ["C"] },
      { hash: "C", parents: [] }, // root
    ];
    const { rows, laneCount } = computeGraph(commits);
    expect(laneCount).toBe(1);
    expect(rows.map((r) => r.node.lane)).toEqual([0, 0, 0]);
    expect(rows.every((r) => !r.node.isMerge)).toBe(true);

    // Tip A: only descends (no incoming edge from above).
    expect(hasLink(rows[0]!.links, 0, 0.5, 0, 1)).toBe(true);
    expect(rows[0]!.links.some((l) => l.y1 === 0 && l.y2 === 0.5)).toBe(false);
    // Middle B: in from above AND out below.
    expect(hasLink(rows[1]!.links, 0, 0, 0, 0.5)).toBe(true);
    expect(hasLink(rows[1]!.links, 0, 0.5, 0, 1)).toBe(true);
    // Root C: only the incoming edge; the lane ends here (no descent).
    expect(hasLink(rows[2]!.links, 0, 0, 0, 0.5)).toBe(true);
    expect(rows[2]!.links.some((l) => l.y1 === 0.5 && l.y2 === 1)).toBe(false);
  });

  it("forks a merge into a second lane and converges at the shared ancestor", () => {
    const commits: GraphCommit[] = [
      { hash: "M", parents: ["A", "B"] }, // merge of A and B
      { hash: "A", parents: ["C"] },
      { hash: "B", parents: ["C"] },
      { hash: "C", parents: [] },
    ];
    const { rows, laneCount } = computeGraph(commits);
    expect(laneCount).toBe(2);

    const [M, A, B, C] = rows;
    // The merge node is flagged and forks a second lane below.
    expect(M!.node.isMerge).toBe(true);
    expect(M!.node.lane).toBe(0);
    expect(hasLink(M!.links, 0, 0.5, 0, 1)).toBe(true); // first parent keeps lane 0
    expect(hasLink(M!.links, 0, 0.5, 1, 1)).toBe(true); // merge parent forks to lane 1

    // A stays in lane 0, B lands in lane 1.
    expect(A!.node.lane).toBe(0);
    expect(B!.node.lane).toBe(1);
    // While B's row is drawn, lane 0 (heading to C) passes straight through.
    expect(hasLink(B!.links, 0, 0, 0, 1)).toBe(true);

    // C is the common ancestor: two lanes descend into it and converge at its node (lane 0).
    expect(C!.node.lane).toBe(0);
    expect(hasLink(C!.links, 0, 0, 0, 0.5)).toBe(true);
    expect(hasLink(C!.links, 1, 0, 0, 0.5)).toBe(true);
  });

  it("gives two independent tips their own lanes", () => {
    const commits: GraphCommit[] = [
      { hash: "A", parents: ["A0"] },
      { hash: "B", parents: ["B0"] }, // unrelated branch tip — nothing points at it
      { hash: "A0", parents: [] },
      { hash: "B0", parents: [] },
    ];
    const { rows, laneCount } = computeGraph(commits);
    expect(laneCount).toBe(2);
    expect(rows[0]!.node.lane).toBe(0); // A
    expect(rows[1]!.node.lane).toBe(1); // B — a fresh lane, not lane 0
    expect(rows[2]!.node.lane).toBe(0); // A0 converges lane 0
    expect(rows[3]!.node.lane).toBe(1); // B0 converges lane 1
  });

  it("leaves an off-page parent descending past the last row", () => {
    // Z is never listed (it's on the next page): A's lane must keep descending.
    const { rows, laneCount } = computeGraph([{ hash: "A", parents: ["Z"] }]);
    expect(laneCount).toBe(1);
    expect(hasLink(rows[0]!.links, 0, 0.5, 0, 1)).toBe(true);
  });

  it("reuses a freed lane so the graph stays narrow", () => {
    // A short side branch (B) merges back at D; the lane it used should be free afterward.
    const commits: GraphCommit[] = [
      { hash: "A", parents: ["B", "C"] }, // fork
      { hash: "B", parents: ["D"] },
      { hash: "C", parents: ["D"] },
      { hash: "D", parents: [] }, // merge point (common ancestor)
    ];
    const { laneCount } = computeGraph(commits);
    expect(laneCount).toBe(2); // never needs a third column
  });

  it("cycles colors by lane index modulo the palette size", () => {
    const commits: GraphCommit[] = [
      { hash: "A", parents: ["A0"] },
      { hash: "B", parents: ["B0"] },
      { hash: "A0", parents: [] },
      { hash: "B0", parents: [] },
    ];
    const { rows } = computeGraph(commits, 1); // palette of 1 → everything color 0
    expect(rows.every((r) => r.node.color === 0)).toBe(true);
    const three = computeGraph(commits, 3);
    expect(three.rows[0]!.node.color).toBe(0); // lane 0
    expect(three.rows[1]!.node.color).toBe(1); // lane 1
  });
});
