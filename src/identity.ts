/**
 * Resolve the effective identity for a repo.
 *
 * Phase 3: a repo's explicit override only. Phase 5 extends this to fall back to
 * the repo's workspace default identity. Returns null when none is assigned (git
 * then uses whatever the repo/host already has — we never force one on).
 */
import { getIdentity, type Identity, type RepoView } from "./db.ts";

export function resolveRepoIdentity(repo: RepoView): Identity | null {
  if (repo.identityId) return getIdentity(repo.identityId);
  return null;
}
