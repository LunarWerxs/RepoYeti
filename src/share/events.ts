/**
 * Which live events a guest's SSE connection may receive.
 *
 * `bus.broadcast()` fans one payload out to every listener with no notion of who's listening, and
 * the daemon broadcasts a lot more than repo state: `settings_changed` carries the owner's tunnel
 * config and MCP rails, `daemon_status` carries the tunnel URL, `repo_added` carries the absolute
 * path of a repo the guest may have no business knowing exists, `scan_*` narrates a sweep of the
 * owner's disks, `approval_pending` narrates their agent traffic. A guest subscribed to the raw
 * bus would receive all of it.
 *
 * So this is an ALLOWLIST, for the same reason policy.ts is: the next event someone adds must be
 * invisible to guests until a human decides otherwise. Unknown event ⇒ dropped.
 */
import type { Share } from "../db.ts";
import { shareCoversRepo } from "../db.ts";
import { guestRepoView, guestStatus } from "./redact.ts";

/** A repo id carried by an event that concerns exactly one repo. */
interface RepoIdPayload {
  id?: string;
}

/** Events shaped `{ repos: [{ id, name, … }] }` — filtered element-wise, not all-or-nothing. */
interface RepoListPayload {
  repos?: Array<{ id?: string }>;
}

/** Single-repo events, gated on the share covering that repo. */
const SCOPED_BY_ID = new Set(["repo_state_changed", "repo_removed"]);

/** Multi-repo events whose `repos` array is filtered down to the share's scope. */
const SCOPED_BY_LIST = new Set([
  "repo_synced",
  "repo_behind",
  "repo_auto_committed",
  "repo_auto_commit_blocked",
]);

/**
 * Project one broadcast event for one guest. Returns the JSON string to send, or null to drop.
 *
 * Deliberately NOT forwarded (each was considered): `settings_changed`, `daemon_status`,
 * `identity_rules_changed`, `ai_key_invalid`, `approval_pending`, `approval_resolved`, `scan_*`,
 * `auto_update_*` — all owner-plane. `repo_identity_changed` / `repo_account_changed` name the
 * owner's credentials. `repo_hidden_changed` / `_pinned_` / `_starred_` / `_auto_commit_` are the
 * owner's private dashboard bookkeeping, already flattened out of the guest's repo view.
 */
export function guestEventData(share: Share, event: string, payload: unknown): string | null {
  if (SCOPED_BY_ID.has(event)) {
    const p = payload as RepoIdPayload;
    if (!p?.id || !shareCoversRepo(share, p.id)) return null;
    // repo_state_changed carries a full status, whose remote URL may embed a credential.
    if (event === "repo_state_changed") {
      const s = payload as { id: string; status: Parameters<typeof guestStatus>[0] };
      return JSON.stringify({ id: s.id, status: guestStatus(s.status) });
    }
    return JSON.stringify(payload);
  }

  if (SCOPED_BY_LIST.has(event)) {
    const p = payload as RepoListPayload;
    const repos = (p?.repos ?? []).filter((r) => r?.id && shareCoversRepo(share, r.id));
    if (repos.length === 0) return null; // nothing in scope ⇒ the guest never learns it happened
    return JSON.stringify({ ...p, repos });
  }

  // A repo appearing is only in scope for an "all repos" share; a per-repo share was granted a
  // fixed list and must not silently widen when the owner clones something new.
  if (event === "repo_added") {
    if (!share.scopeAll) return null;
    const p = payload as { repo?: Parameters<typeof guestRepoView>[0] };
    if (!p?.repo) return null;
    return JSON.stringify({ repo: guestRepoView(p.repo) });
  }

  return null;
}
