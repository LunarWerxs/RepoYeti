/**
 * The owner's share-link routes: mint, list, edit, re-key, revoke, audit.
 *
 * tests/share-edit.test.ts pins the DB-level rules these sit on (an edit never touches the
 * secret, a rotate kills the old one, neither revives a revoked share). What is checked here is
 * the HTTP surface the panel actually calls, and specifically the two guards that decide whether
 * a link is worth minting at all: a scoped link naming no repos, and one naming a repo that does
 * not exist. Both would produce a link that grants nothing — the owner would hand it out believing
 * they had shared something, so both must be refused rather than silently accepted.
 */
import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { getShare } from "../src/db.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

const cfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const app = () => createApp(cfg());

const send = (method: string, body?: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

function repoId(name: string): string {
  return mustUpsertRepo(mkScratchDir(`gm-shr-${name}-`), name, "auto", false);
}

interface ShareDto {
  id: string;
  label: string;
  perm: "view" | "control";
  collaborative: boolean;
  scopeAll: boolean;
  repoIds?: string[];
  revokedAt?: number | null;
}

async function mint(body: Record<string, unknown>): Promise<{ share: ShareDto; token: string; url: string }> {
  const res = await app().request("/api/shares", send("POST", body));
  expect(res.status).toBe(200);
  return (await res.json()) as { share: ShareDto; token: string; url: string };
}

test("minting a share returns the row, the secret and a ready-to-paste link", async () => {
  const id = repoId("shr-mint");
  const created = await mint({ label: "for Ada", perm: "view", duration: "week", repoIds: [id] });

  expect(created.share.label).toBe("for Ada");
  expect(created.share.perm).toBe("view");
  expect(typeof created.token).toBe("string");
  expect(created.token.length).toBeGreaterThan(10);
  // The URL is assembled server-side (the relay form puts the secret in the fragment), so it must
  // come back carrying the token rather than leaving the browser to re-derive it.
  expect(created.url).toContain(created.token);

  const listed = (await (await app().request("/api/shares")).json()) as { shares: ShareDto[] };
  expect(listed.shares.some((s) => s.id === created.share.id)).toBe(true);
});

test("a scoped share must name at least one repo, and every repo must exist", async () => {
  const empty = await app().request(
    "/api/shares",
    send("POST", { label: "nothing", perm: "view", duration: "day", repoIds: [] }),
  );
  expect(empty.status).toBe(400);
  expect((await empty.json()).code).toBe("BAD_REQUEST");

  const ghost = await app().request(
    "/api/shares",
    send("POST", { label: "ghost", perm: "view", duration: "day", repoIds: ["no-such-repo"] }),
  );
  expect(ghost.status).toBe(404);
  expect((await ghost.json()).code).toBe("NOT_FOUND");

  // scopeAll IS how you say "everything", so it needs no list.
  const all = await mint({ label: "everything", perm: "control", duration: "never", scopeAll: true });
  expect(all.share.scopeAll).toBe(true);
});

test("editing a live grant changes what it means without changing the secret", async () => {
  const first = repoId("shr-edit-a");
  const second = repoId("shr-edit-b");
  const created = await mint({ label: "before", perm: "view", duration: "day", repoIds: [first] });

  const res = await app().request(
    `/api/shares/${created.share.id}`,
    send("PATCH", { label: "after", perm: "control", repoIds: [second], duration: "week" }),
  );
  expect(res.status).toBe(200);
  const patched = (await res.json()) as { ok: boolean; share: ShareDto };
  expect(patched.ok).toBe(true);
  expect(patched.share.label).toBe("after");
  expect(patched.share.perm).toBe("control");
  // The link already in someone's inbox keeps working — same row, same secret.
  expect(patched.share.id).toBe(created.share.id);
  expect(getShare(created.share.id)?.token).toBe(created.token);
});

test("an edit is held to the same guards as a mint, against the state it would produce", async () => {
  const id = repoId("shr-edit-guard");
  const created = await mint({ label: "scoped", perm: "view", duration: "day", repoIds: [id] });

  // Flipping scopeAll off with no list left would leave a link granting nothing.
  const empty = await app().request(
    `/api/shares/${created.share.id}`,
    send("PATCH", { scopeAll: false, repoIds: [] }),
  );
  expect(empty.status).toBe(400);

  const ghost = await app().request(
    `/api/shares/${created.share.id}`,
    send("PATCH", { repoIds: ["no-such-repo"] }),
  );
  expect(ghost.status).toBe(404);

  // Widening to scopeAll needs no list at all.
  const widened = await app().request(`/api/shares/${created.share.id}`, send("PATCH", { scopeAll: true }));
  expect(widened.status).toBe(200);
  expect(((await widened.json()) as { share: ShareDto }).share.scopeAll).toBe(true);
});

test("re-keying a share hands back a new secret and a new URL", async () => {
  const id = repoId("shr-rotate");
  const created = await mint({ label: "rotate me", perm: "view", duration: "day", repoIds: [id] });

  const res = await app().request(`/api/shares/${created.share.id}/rotate`, send("POST"));
  expect(res.status).toBe(200);
  const rotated = (await res.json()) as { ok: boolean; token: string; url: string; share: ShareDto };
  expect(rotated.ok).toBe(true);
  expect(rotated.token).not.toBe(created.token);
  expect(rotated.url).toContain(rotated.token);
  expect(rotated.share.id).toBe(created.share.id);
});

test("revoking a share kills it, and the audit trail is readable up to that point", async () => {
  const id = repoId("shr-revoke");
  const created = await mint({ label: "temporary", perm: "view", duration: "day", repoIds: [id] });

  const events = await app().request(`/api/shares/${created.share.id}/events`);
  expect(events.status).toBe(200);
  expect(Array.isArray((await events.json()).events)).toBe(true);

  const gone = await app().request(`/api/shares/${created.share.id}`, send("DELETE"));
  expect(gone.status).toBe(200);
  expect((await gone.json()).ok).toBe(true);
  expect(getShare(created.share.id)?.revokedAt).toBeGreaterThan(0);

  // Revoking twice is a NOT_FOUND, not a second success — the grant is already dead.
  expect((await app().request(`/api/shares/${created.share.id}`, send("DELETE"))).status).toBe(404);
  // And a revoked grant can't be edited back to life.
  expect(
    (await app().request(`/api/shares/${created.share.id}`, send("PATCH", { label: "back?" }))).status,
  ).toBe(404);
});

test("every share route reports an unknown id as NOT_FOUND rather than a 500", async () => {
  const a = app();
  expect((await a.request("/api/shares/nope", send("PATCH", { label: "x" }))).status).toBe(404);
  expect((await a.request("/api/shares/nope/rotate", send("POST"))).status).toBe(404);
  expect((await a.request("/api/shares/nope", send("DELETE"))).status).toBe(404);
  expect((await a.request("/api/shares/nope/events")).status).toBe(404);
});

test("a malformed share body is a validation error, not a crash", async () => {
  const res = await app().request(
    "/api/shares",
    send("POST", { label: "", perm: "sudo", duration: "fortnight" }),
  );
  expect(res.status).toBe(400);
  expect(await res.text()).not.toContain("stack");
});
