// Bounds RepoCard's keep-the-body-mounted optimization (see RepoCard.vue).
//
// After a card's first expand its CollapsibleContent stays mounted through collapses, so
// toggling is a pure CSS height animation with no rebuild of the (up to 2000-row) changes
// tree. Unbounded, a long session that opens many of the ~50 cards would retain every one
// of those bodies — DOM memory plus a shallow re-render per SSE status tick, forever. This
// registry caps the residency: the MAX_KEPT most recently expanded cards keep their bodies
// while collapsed; older COLLAPSED cards quietly release theirs (they're hidden, so the
// unmount is invisible — the next expand just pays the one-time mount again). A currently
// expanded card is never evicted, even when that means temporarily exceeding the cap.
import { reactive } from "vue";

const MAX_KEPT = 8;

interface KeptCard {
  stamp: number; // monotonic "last expanded" order — lower = older
  expanded: boolean;
}

const kept = reactive(new Map<string, KeptCard>());
let tick = 0;

function evict(): void {
  while (kept.size > MAX_KEPT) {
    let oldest: string | null = null;
    let oldestStamp = Infinity;
    for (const [id, k] of kept) {
      if (!k.expanded && k.stamp < oldestStamp) {
        oldest = id;
        oldestStamp = k.stamp;
      }
    }
    if (!oldest) return; // every kept card is currently open — never evict an open one
    kept.delete(oldest);
  }
}

export function cardKeepAlive(repoId: string) {
  return {
    /** Reactive: true while this card's body should stay mounted when collapsed. */
    keep: (): boolean => kept.has(repoId),
    /** Call on every expand/collapse toggle with the new expanded state. */
    onToggle(expanded: boolean): void {
      if (expanded) {
        kept.set(repoId, { stamp: ++tick, expanded: true });
        evict();
      } else {
        const cur = kept.get(repoId);
        if (cur) cur.expanded = false;
      }
    },
    /** Call when the card unmounts (list filtering/removal): a fresh mount starts cold. */
    release(): void {
      kept.delete(repoId);
    },
  };
}
