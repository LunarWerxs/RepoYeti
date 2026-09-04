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
import { shareCoversRepo, getRepo } from "../db.ts";
import { guestRepoView, guestStatus } from "./redact.ts";

/**
 * One event as a guest should receive it.
 *
 * The event NAME is part of the projection, not a constant passed through: for an all-repos share
 * the owner hiding a repo is, from the guest's side, that repo leaving their scope — so it is
 * delivered as the scope change it actually is (`repo_removed`), never as the owner's private
 * `repo_hidden_changed`. See the hidden branch below.
 */
export interface GuestEvent {
  event: string;
  data: string;
}

/** A repo id carried by an event that concerns exactly one repo. */
interface RepoIdPayload {
  id?: string;
}

/** Events shaped `{ repos: [{ id, name, … }] }` — filtered element-wise, not all-or-nothing. */
interface RepoListPayload {
  repos?: Array<{ id?: string }>;
}

/**
 * Single-repo events, gated on the share covering that repo.
 *
 * `repo_pinned_changed` / `repo_starred_changed` are here because the guest dashboard now GROUPS by
 * those flags (see redact.ts): without the live patch a guest's sections would drift from the
 * owner's until they reloaded. Both payloads are `{ id, pinned|starred }` — an id the share already
 * covers plus a boolean, so there is nothing to redact out of them.
 */
const SCOPED_BY_ID = new Set([
  "repo_state_changed",
  "repo_removed",
  "repo_pinned_changed",
  "repo_starred_changed",
]);

/** Multi-repo events whose `repos` array is filtered down to the share's scope. */
const SCOPED_BY_LIST = new Set([
  "repo_synced",
  "repo_behind",
  "repo_auto_committed",
  "repo_auto_commit_blocked",
]);

/**
 * Project one broadcast event for one guest. Returns the event + JSON to send, or null to drop.
 *
 * Deliberately NOT forwarded (each was considered): `settings_changed`, `daemon_status`,
 * `identity_rules_changed`, `ai_key_invalid`, `approval_pending`, `approval_resolved`, `scan_*`,
 * `auto_update_*`, `operational_error_changed` — all owner-plane. `repo_identity_changed` /
 * `repo_account_changed` name the owner's credentials. `repo_auto_commit_changed` is a flag the
 * guest's repo view flattens, so forwarding it would put state on their dashboard that its
 * controls can't act on.
 */
export function guestEventData(share: Share, event: string, payload: unknown): GuestEvent | null {
  if (SCOPED_BY_ID.has(event)) {
    const p = payload as RepoIdPayload;
    if (!p?.id || !shareCoversRepo(share, p.id)) return null;
    // repo_state_changed carries a full status, whose remote URL may embed a credential.
    if (event === "repo_state_changed") {
      const s = payload as { id: string; status: Parameters<typeof guestStatus>[0] };
      return { event, data: JSON.stringify({ id: s.id, status: guestStatus(s.status) }) };
    }
    return { event, data: JSON.stringify(payload) };
  }

  if (SCOPED_BY_LIST.has(event)) {
    const p = payload as RepoListPayload;
    const repos = (p?.repos ?? []).filter((r) => r?.id && shareCoversRepo(share, r.id));
    if (repos.length === 0) return null; // nothing in scope ⇒ the guest never learns it happened
    return { event, data: JSON.stringify({ ...p, repos }) };
  }

  // A repo appearing is only in scope for an "all repos" share; a per-repo share was granted a
  // fixed list and must not silently widen when the owner clones something new.
  if (event === "repo_added") {
    if (!share.scopeAll) return null;
    const p = payload as { repo?: Parameters<typeof guestRepoView>[0] };
    // Read `hidden` off the RAW repo — guestRepoView flattens it, so checking after projecting
    // would always see false. A hidden repo is out of scope for a scopeAll share (db.ts
    // getSharedRepos / shareCoversRepo), and an event may not smuggle in what the list won't show.
    if (!p?.repo || p.repo.hidden) return null;
    return { event, data: JSON.stringify({ repo: guestRepoView(p.repo) }) };
  }

  // Hiding a repo is the owner's own dashboard bookkeeping — EXCEPT on an all-repos share, where
  // it is what puts the repo out of scope. Delivering the flag itself would be both a leak of that
  // bookkeeping and useless to the guest, whose repo view has `hidden` flattened; delivering the
  // SCOPE CHANGE is neither. So it is translated: hidden ⇒ the repo left their dashboard, un-hidden
  // ⇒ it arrived on it, which is exactly what the owner's own view does.
  //
  // A per-repo share is untouched: that grant names the repo outright, and decluttering your own
  // dashboard must not silently revoke a link you deliberately handed someone.
  if (event === "repo_hidden_changed") {
    if (!share.scopeAll) return null;
    const p = payload as { id?: string; hidden?: boolean };
    if (!p?.id) return null;
    if (p.hidden) return { event: "repo_removed", data: JSON.stringify({ id: p.id }) };
    const repo = getRepo(p.id);
    if (!repo) return null; // raced with a real removal; the repo_removed for it is already queued
    return { event: "repo_added", data: JSON.stringify({ repo: guestRepoView(repo) }) };
  }

  return null;
}
