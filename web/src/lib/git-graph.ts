/**
 * Commit-DAG lane assignment — the geometry behind the "Git Graph"-style history view.
 *
 * Input is a commit list in display order (newest first), each carrying its parent hashes
 * (the backend's `git log --date-order --branches --tags [--remotes]` already emits `%P`).
 * Output is, per row, the lane (column) its node sits in plus the connectors to draw in that
 * row's gutter cell — enough for a component to render an SVG per row without knowing any
 * graph theory.
 *
 * The algorithm is the classic incremental sweep: we keep an array of "open lanes", each
 * remembering the hash it is currently descending toward. Walking rows top→bottom, a commit
 * takes the lane(s) pointing at it (its children merge in), then hands its first parent the
 * same lane and forks a new lane per extra (merge) parent. It is O(rows × lanes) — trivial for
 * a page of 50–200 commits — and pure/synchronous so it unit-tests without a DOM.
 *
 * Colors are by lane index (`lane % paletteSize`), the same "each column has a hue" model Git
 * Graph uses; the component maps the index to a CSS var. A parent that is off the current page
 * simply leaves its lane descending past the last row — the component draws it running off the
 * bottom, which is exactly right (it continues on the next page).
 */

/** The minimum a row needs for layout: its hash and its parents (full hashes). A synthetic
 *  "working tree" row is just a GraphCommit whose single parent is the HEAD commit. */
export interface GraphCommit {
  hash: string;
  parents: string[];
}

/** A vertical position within a row's cell: 0 = top edge, 0.5 = node center, 1 = bottom edge. */
export type CellY = 0 | 0.5 | 1;

/**
 * One connector to draw inside a row's gutter cell, in lane/normalised-y space. The component
 * scales `lane → x` (lane × pitch + pitch/2) and `y → row height`, bending at the node center
 * for a smooth curve. Three shapes occur:
 *   - pass-through:  y1=0  → y2=1   (a lane crossing the row untouched)
 *   - incoming:      y1=0  → y2=0.5 (a child lane merging down into this row's node)
 *   - outgoing:      y1=0.5 → y2=1  (this row's node descending to a parent lane)
 */
export interface GraphLink {
  x1: number;
  y1: CellY;
  x2: number;
  y2: CellY;
  /** Palette index (lane % paletteSize) — the component resolves it to a color. */
  color: number;
}

export interface GraphNode {
  hash: string;
  /** Lane (column) the node sits in. */
  lane: number;
  /** Palette index for the node dot = lane % paletteSize. */
  color: number;
  /** 2+ parents ⇒ a merge (the component can badge it). */
  isMerge: boolean;
}

export interface GraphRow {
  node: GraphNode;
  links: GraphLink[];
  /** Highest lane index touched by this row (node or any link endpoint), 0-based. */
  maxLane: number;
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Widest lane count across all rows (max `maxLane` + 1) — the gutter's column count. */
  laneCount: number;
}

/** Default palette size — matches the theme's `--chart-1..5`. Lanes beyond it cycle the hues. */
export const DEFAULT_PALETTE_SIZE = 5;

/** Drop trailing empty lanes so the active-lane array can't grow without bound; interior holes
 *  are kept so a freed lane gets reused (keeps the graph narrow). */
function trimTrailing(lanes: (string | null)[]): void {
  while (lanes.length > 0 && lanes.at(-1) == null) lanes.pop();
}

/** First reusable (null) lane index, or the array length to append a fresh lane. */
function firstFreeLane(lanes: (string | null)[]): number {
  const i = lanes.indexOf(null);
  return i === -1 ? lanes.length : i;
}

/**
 * Lay out a commit DAG into per-row lanes + connectors.
 * `commits` must be in display order (newest first); each `parents` entry is a full hash.
 */
export function computeGraph(commits: GraphCommit[], paletteSize = DEFAULT_PALETTE_SIZE): GraphLayout {
  const size = Math.max(1, paletteSize);
  const colorOf = (lane: number): number => lane % size;
  // Open lanes as we cross INTO the current row from above: lanes[k] = hash lane k descends toward.
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let laneCount = 0;

  for (const c of commits) {
    // Which existing lanes were waiting for this commit (its children descending in).
    const incoming: number[] = [];
    for (let k = 0; k < lanes.length; k++) if (lanes[k] === c.hash) incoming.push(k);

    // The node's lane: the leftmost incoming lane, or a fresh lane for a tip nothing points at.
    const nodeLane = incoming.length > 0 ? incoming[0]! : firstFreeLane(lanes);
    if (nodeLane >= lanes.length) lanes.length = nodeLane + 1; // grow with holes if appending

    const links: GraphLink[] = [];
    let maxLane = nodeLane;
    const touch = (lane: number): void => {
      if (lane > maxLane) maxLane = lane;
    };

    // Incoming edges (top half): every child lane bends into the node at center.
    for (const k of incoming) {
      links.push({ x1: k, y1: 0, x2: nodeLane, y2: 0.5, color: colorOf(k) });
      touch(k);
    }
    // The incoming lanes terminate at the node; free them (nodeLane is re-used just below).
    for (const k of incoming) lanes[k] = null;

    // Pass-through edges: any still-open lane not consumed by this node crosses straight down.
    for (let k = 0; k < lanes.length; k++) {
      if (k === nodeLane) continue;
      if (lanes[k] != null) {
        links.push({ x1: k, y1: 0, x2: k, y2: 1, color: colorOf(k) });
        touch(k);
      }
    }

    // Outgoing edges (bottom half): first parent keeps the node's lane; extra (merge) parents
    // reuse a lane already heading to that parent, else fork into a fresh lane.
    if (c.parents.length === 0) {
      lanes[nodeLane] = null; // a root: the lane ends here
    } else {
      lanes[nodeLane] = c.parents[0]!;
      links.push({ x1: nodeLane, y1: 0.5, x2: nodeLane, y2: 1, color: colorOf(nodeLane) });
      for (let p = 1; p < c.parents.length; p++) {
        const parent = c.parents[p]!;
        let lane = lanes.indexOf(parent); // already descending toward this parent? merge into it
        if (lane === -1) {
          lane = firstFreeLane(lanes);
          if (lane >= lanes.length) lanes.length = lane + 1;
          lanes[lane] = parent;
        }
        links.push({ x1: nodeLane, y1: 0.5, x2: lane, y2: 1, color: colorOf(lane) });
        touch(lane);
      }
    }

    trimTrailing(lanes);
    rows.push({
      node: { hash: c.hash, lane: nodeLane, color: colorOf(nodeLane), isMerge: c.parents.length > 1 },
      links,
      maxLane,
    });
    if (maxLane + 1 > laneCount) laneCount = maxLane + 1;
  }

  return { rows, laneCount };
}
