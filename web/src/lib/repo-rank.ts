// "Needs attention" ranking for the repo grid: an additive, per-signal score where every point
// comes with a named reason, so the card can say WHY it sits where it sits instead of the order
// being a black box. Idea adapted from Z4nzu/hackingtool's discovery ranking (MIT); written fresh
// for RepoYeti's local-repo signals.
//
// Three decisions carried over on purpose:
//   - Every term is additive and recorded. The score shown is exactly the sum of the reasons
//     shown, so the explanation can never drift from the ordering.
//   - Cheap-to-inflate volume is weighted below deliberate volume and capped as ONE group. A
//     missing .gitignore line turns one build into thousands of changed files, commits do not
//     appear by accident, so dirty files weigh less than behind/ahead commits, the counts are
//     log-scaled, and all three share one cap: no pile of generated files outranks a conflict.
//   - Staleness is a soft demotion, never a filter. A repo nobody touched in months sinks below
//     active ones but stays in the list, and anything genuinely wrong with it still lifts it.
import type { Repo } from "../types";

export type RankReasonKey =
  | "conflicted"
  | "midOperation"
  | "error"
  | "behind"
  | "ahead"
  | "dirty"
  | "detached"
  | "unfetched"
  | "active"
  | "stale";

export interface RankReason {
  key: RankReasonKey;
  /** Signed contribution to the score, rounded to what the card displays. */
  points: number;
  /** The count behind a volume signal (commits behind/ahead, changed files). */
  count?: number;
  /** Whole days behind a time signal (since last fetch, since HEAD last moved). */
  days?: number;
}

export interface RepoRank {
  score: number;
  reasons: RankReason[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Flat points for states that block normal work until someone acts. */
export const RANK_WEIGHTS = {
  conflicted: 6,
  midOperation: 4,
  error: 4,
  detached: 1,
  // Volume signals: weight * (1 + log10(count)), so 1 -> w, 10 -> 2w, 1000 -> 4w.
  behind: 1.5,
  ahead: 1.25,
  dirty: 0.75,
  /** One cap shared by behind + ahead + dirty together. */
  volumeCap: 4,
  /** ahead/behind are only as fresh as the last fetch. */
  unfetched: 0.5,
  active: 1,
  stale: -2,
} as const;

export const UNFETCHED_AFTER_DAYS = 7;
export const ACTIVE_WITHIN_MS = DAY_MS;
export const STALE_AFTER_DAYS = 90;

const round = (n: number): number => Math.round(n * 100) / 100;

function volumePoints(weight: number, count: number): number {
  return weight * (1 + Math.log10(count));
}

/** Score one repo. Pure: `now` is passed in so the ordering is reproducible. */
export function rankRepo(repo: Repo, now: number): RepoRank {
  const reasons: RankReason[] = [];
  const add = (reason: RankReason): void => {
    const points = round(reason.points);
    if (points !== 0) reasons.push({ ...reason, points });
  };
  const st = repo.status;

  if (st) {
    if (st.conflicted) add({ key: "conflicted", points: RANK_WEIGHTS.conflicted });
    if (st.gitOperation) add({ key: "midOperation", points: RANK_WEIGHTS.midOperation });
    if (st.error) add({ key: "error", points: RANK_WEIGHTS.error });

    // Behind first: it is the one that turns into a conflict if you start editing on top of it.
    let volumeLeft: number = RANK_WEIGHTS.volumeCap;
    const volumes: [RankReasonKey, number, number][] = [
      ["behind", RANK_WEIGHTS.behind, st.behind],
      ["ahead", RANK_WEIGHTS.ahead, st.ahead],
      ["dirty", RANK_WEIGHTS.dirty, st.dirty],
    ];
    for (const [key, weight, count] of volumes) {
      if (count <= 0 || volumeLeft <= 0) continue;
      const points = Math.min(volumePoints(weight, count), volumeLeft);
      volumeLeft -= points;
      add({ key, points, count });
    }

    if (st.detached) add({ key: "detached", points: RANK_WEIGHTS.detached });

    if (st.remote && !st.error) {
      const since = st.fetchedAt == null ? null : now - st.fetchedAt;
      if (since == null || since > UNFETCHED_AFTER_DAYS * DAY_MS) {
        add({
          key: "unfetched",
          points: RANK_WEIGHTS.unfetched,
          ...(since == null ? {} : { days: Math.floor(since / DAY_MS) }),
        });
      }
    }
  }

  // Activity is when HEAD last moved (its reflog), never `repo.updatedAt`: the daemon rewrites
  // that on every discovery pass, rescan and hide/pin toggle, so after a restart it would call
  // every repo "changed in the last day" and nothing would ever go stale. No reflog, no term.
  const moved = st?.headMovedAt;
  if (moved != null) {
    const idle = now - moved;
    if (idle <= ACTIVE_WITHIN_MS) add({ key: "active", points: RANK_WEIGHTS.active });
    else if (idle > STALE_AFTER_DAYS * DAY_MS) {
      add({ key: "stale", points: RANK_WEIGHTS.stale, days: Math.floor(idle / DAY_MS) });
    }
  }

  return { score: round(reasons.reduce((sum, r) => sum + r.points, 0)), reasons };
}

/** Highest score first; ties fall back to HEAD moved most recently, then to the shown name. */
export function sortByAttention(list: Repo[], now: number): Repo[] {
  const scores = new Map(list.map((r) => [r.id, rankRepo(r, now).score]));
  return [...list].sort(
    (a, b) =>
      (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
      (b.status?.headMovedAt ?? 0) - (a.status?.headMovedAt ?? 0) ||
      (a.displayName || a.name).localeCompare(b.displayName || b.name, undefined, { sensitivity: "base" }),
  );
}
