/**
 * Editing and re-keying a share link.
 *
 * Both of these change a grant that someone else may already be holding, so the rules that matter
 * are the ones about what MUST NOT happen: an edit must never touch the secret (or every link the
 * owner already sent dies for no reason), a rotate must invalidate the old secret (or "give me a
 * working link again" would silently leave two live keys), and neither may resurrect a revoked
 * share — reviving a secret the owner deliberately killed is the one outcome a PATCH should never
 * be able to produce.
 */
import { test, expect, beforeAll } from "bun:test";
import {
  initDb,
  createShare,
  updateShare,
  rotateShareToken,
  revokeShare,
  getShare,
  getShareByTokenHash,
  shareRepoIds,
  type Share,
} from "../src/db.ts";
import { hashToken, mintToken, isStaleOrigin } from "../src/share/index.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { $ } from "bun";

let repoA = "";
let repoB = "";

async function gitRepo(name: string): Promise<string> {
  const dir = mkScratchDir(name);
  await $`git init -q ${dir}`.quiet();
  return mustUpsertRepo(dir, name, "pinned", false);
}

beforeAll(async () => {
  initDb();
  repoA = await gitRepo("share-edit-a");
  repoB = await gitRepo("share-edit-b");
});

function mint(overrides: Partial<Parameters<typeof createShare>[1]> = {}): { share: Share; token: string } {
  const token = mintToken();
  const share = createShare(hashToken(token), {
    label: "for my brother",
    perm: "view",
    scopeAll: false,
    repoIds: [repoA],
    expiresAt: null,
    ...overrides,
  });
  return { share, token };
}

/**
 * Like mint(), but the plaintext travels all the way into Share.token instead of being thrown
 * away after hashing. mint() itself never passes one (every test above it predates the `token`
 * column), so this exists specifically for the Copy-link tests, where the caller needs the exact
 * token that produced `tokenHash` in hand to prove the two never drift apart.
 */
function mintWithToken(token: string): Share {
  return createShare(hashToken(token), {
    label: "for my brother",
    perm: "view",
    scopeAll: false,
    repoIds: [repoA],
    expiresAt: null,
    token,
  });
}

test("an edit changes the grant and leaves the secret alone", () => {
  const { share, token } = mint();

  const updated = updateShare(share.id, { label: "renamed", perm: "control" });
  expect(updated?.label).toBe("renamed");
  expect(updated?.perm).toBe("control");

  // The whole point: a link already sent still resolves to this share.
  expect(getShareByTokenHash(hashToken(token))?.id).toBe(share.id);
});

test("live collaboration is an independent, editable share capability", () => {
  const { share } = mint({ collaborative: true });
  expect(share.collaborative).toBe(true);
  expect(updateShare(share.id, { collaborative: false })?.collaborative).toBe(false);
});

test("editing the repo scope replaces the list rather than appending to it", () => {
  const { share } = mint();
  expect(shareRepoIds(share.id)).toEqual([repoA]);

  updateShare(share.id, { scopeAll: false, repoIds: [repoB] });
  // Not [repoA, repoB] — the grant is exactly what was last set, so narrowing a link actually
  // narrows it instead of quietly widening it.
  expect(shareRepoIds(share.id)).toEqual([repoB]);
});

test("switching a share to scopeAll clears its per-repo rows", () => {
  const { share } = mint();
  updateShare(share.id, { scopeAll: true });
  expect(getShare(share.id)?.scopeAll).toBe(true);
  // Stale rows behind a scopeAll grant would come back if it were ever narrowed again.
  expect(shareRepoIds(share.id)).toEqual([]);
});

test("an omitted field is left as it was", () => {
  const { share } = mint({ label: "keep me", perm: "control" });
  updateShare(share.id, { label: "new label" });
  const after = getShare(share.id);
  expect(after?.label).toBe("new label");
  expect(after?.perm).toBe("control"); // untouched
  expect(after?.expiresAt).toBeNull();
});

test("expiry can be set and cleared explicitly", () => {
  const { share } = mint();
  const when = Date.now() + 86_400_000;
  expect(updateShare(share.id, { expiresAt: when })?.expiresAt).toBe(when);
  expect(updateShare(share.id, { expiresAt: null })?.expiresAt).toBeNull();
});

test("rotating mints a new secret and kills the old one", () => {
  const { share, token } = mint();
  const next = mintToken();
  expect(next).not.toBe(token);

  const rotated = rotateShareToken(share.id, { tokenHash: hashToken(next) });
  expect(rotated?.id).toBe(share.id);

  // The new link works…
  expect(getShareByTokenHash(hashToken(next))?.id).toBe(share.id);
  // …and the one the owner lost is now worthless, which is the trade being made.
  expect(getShareByTokenHash(hashToken(token))).toBeNull();
});

test("rotating resets the usage counters, since they described the old key", () => {
  const { share } = mint();
  const rotated = rotateShareToken(share.id, { tokenHash: hashToken(mintToken()) });
  expect(rotated?.useCount).toBe(0);
  expect(rotated?.lastUsedAt).toBeNull();
});

test("a revoked share can be neither edited nor rotated", () => {
  const { share, token } = mint();
  expect(revokeShare(share.id)).toBe(true);

  expect(updateShare(share.id, { label: "back from the dead" })).toBeNull();
  expect(rotateShareToken(share.id, { tokenHash: hashToken(mintToken()) })).toBeNull();

  // And the original secret stays dead rather than being quietly re-armed.
  const found = getShareByTokenHash(hashToken(token));
  expect(found?.revokedAt).not.toBeNull();
});

test("editing an unknown id reports failure instead of creating one", () => {
  expect(updateShare("00000000-0000-0000-0000-000000000000", { label: "nope" })).toBeNull();
  expect(rotateShareToken("00000000-0000-0000-0000-000000000000", { tokenHash: hashToken(mintToken()) })).toBeNull();
});

// ── the plaintext token (Copy link on a share the owner already sent) ──────────
// Retaining the secret alongside its hash is what lets the panel hand an existing link back
// instead of only ever offering "regenerate". The two columns are written together everywhere
// they're written at all, and the tests below exist to make sure they never say something
// different: a stored token whose hash doesn't match token_hash would look like a perfectly good
// link right up until someone tried to use it.

test("createShare round-trips a token whose hash matches token_hash, so Copy link redeems", () => {
  const token = mintToken();
  const share = mintWithToken(token);
  expect(share.token).toBe(token);
  // The whole point: hashing the stored plaintext back must reproduce the stored hash, proven by
  // redeeming through the real lookup path rather than comparing strings by hand.
  expect(getShareByTokenHash(hashToken(share.token!))?.id).toBe(share.id);
});

test("createShare without a token leaves it null — the pre-existing-link shape", () => {
  // mint() never passes `token`, which is exactly the shape of a link minted before this column
  // existed: no secret to show, so Copy link has nothing to offer and that must not crash.
  const { share } = mint();
  expect(share.token).toBeNull();
  expect(getShare(share.id)?.token).toBeNull();
});

test("rotating replaces both the hash and the plaintext together", () => {
  const token = mintToken();
  const share = mintWithToken(token);
  const next = mintToken();

  const rotated = rotateShareToken(share.id, { tokenHash: hashToken(next), token: next });
  expect(rotated?.token).toBe(next);

  // The new plaintext redeems…
  expect(getShareByTokenHash(hashToken(next))?.id).toBe(share.id);
  // …and the old one is gone on both fronts, not just the hash — a lingering plaintext would be
  // a live secret with no way left to look it up, which is worse than storing none at all.
  expect(getShareByTokenHash(hashToken(token))).toBeNull();
});

test("revoking clears the stored token but keeps the row as an audit trail", () => {
  const token = mintToken();
  const share = mintWithToken(token);
  expect(revokeShare(share.id)).toBe(true);

  const after = getShare(share.id);
  // Still here — revoke stamps revoked_at, it does not delete.
  expect(after).not.toBeNull();
  expect(after?.revokedAt).not.toBeNull();
  // But nothing left for a stale Copy button to hand back.
  expect(after?.token).toBeNull();
});

// ── the origin a link was handed out on ────────────────────────────────────────
// A quick tunnel re-hosts itself on every restart, so a link that embeds the old hostname stops
// resolving — silently, on the RECIPIENT's end. Recording where each link was minted is what lets
// the owner be told instead of finding out second-hand.

test("a link records the origin it was minted against", () => {
  const { share } = mint({ origin: "https://old-host.trycloudflare.com" });
  expect(getShare(share.id)?.origin).toBe("https://old-host.trycloudflare.com");
});

test("a link minted with no tunnel up records no origin", () => {
  // Not knowing where we live is different from having moved — this must not read as stale later.
  const { share } = mint({ origin: null });
  expect(getShare(share.id)?.origin).toBeNull();
});

test("editing a link leaves its origin alone", () => {
  const { share } = mint({ origin: "https://old-host.trycloudflare.com" });
  updateShare(share.id, { label: "renamed" });
  // An edit doesn't re-issue the URL, so the address it was sent on hasn't changed.
  expect(getShare(share.id)?.origin).toBe("https://old-host.trycloudflare.com");
});

test("regenerating re-stamps the origin to wherever we live now", () => {
  const { share } = mint({ origin: "https://old-host.trycloudflare.com" });
  rotateShareToken(share.id, { tokenHash: hashToken(mintToken()), origin: "https://new-host.trycloudflare.com" });
  // Otherwise regenerating a stale link would hand back another link still flagged stale.
  expect(getShare(share.id)?.origin).toBe("https://new-host.trycloudflare.com");
});

test("regenerating without a known origin keeps the previous one", () => {
  const { share } = mint({ origin: "https://old-host.trycloudflare.com" });
  rotateShareToken(share.id, { tokenHash: hashToken(mintToken()), origin: null });
  // Better to keep the last address we knew than to blank it and lose the staleness signal.
  expect(getShare(share.id)?.origin).toBe("https://old-host.trycloudflare.com");
});

// ── the staleness rule ─────────────────────────────────────────────────────────
// Extracted from the DTO so the decision "is this link's address dead?" is testable on its own.

test("a link minted on a different address is stale", () => {
  expect(isStaleOrigin("https://old.trycloudflare.com", "https://new.trycloudflare.com")).toBe(true);
});

test("a link minted on the current address is not stale", () => {
  expect(isStaleOrigin("https://same.trycloudflare.com", "https://same.trycloudflare.com")).toBe(false);
});

test("trailing slashes and case are not a change of address", () => {
  // These differences come from how a URL was stored, not from the daemon moving. Treating them
  // as stale would tell owners to regenerate links that work perfectly.
  expect(isStaleOrigin("https://Host.TryCloudflare.com/", "https://host.trycloudflare.com")).toBe(false);
});

test("not knowing where we live is never reported as stale", () => {
  // No tunnel up, or a link predating the record. "Unknown" must not read as "moved", or every
  // link would be flagged the moment remote access is switched off.
  expect(isStaleOrigin(null, "https://new.trycloudflare.com")).toBe(false);
  expect(isStaleOrigin("https://old.trycloudflare.com", null)).toBe(false);
  expect(isStaleOrigin(null, null)).toBe(false);
});
