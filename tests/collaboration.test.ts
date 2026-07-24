/**
 * The collaboration wire format deliberately puts only authenticated ciphertext on the relay.
 * These tests pin that contract independently of HTTP and Git so a future refactor cannot turn a
 * share token into an observable channel name or accidentally accept tampered peer state.
 */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  collaborationChannel,
  collaborationPresenceSignature,
  collaborationFingerprint,
  commitAndSyncAcceptedCollaboration,
  decryptSnapshot,
  encryptSnapshot,
  inspectCollaborationInvitation,
  parseCollaborationInvitation,
  readAcceptedCollaborationDiff,
  readAcceptedCollaborationStatus,
  readCollaborationSnapshots,
  REMOTE_COMMIT_IDLE_MS,
  receiveCollaborationSnapshot,
  type CollaborationSnapshot,
} from "../src/collaboration.ts";
import {
  createCollaborationLink,
  createShare,
  initDb,
  revokeShare,
} from "../src/db.ts";
import { hashToken } from "../src/share/index.ts";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import { commitRepoWithFingerprint } from "../src/service/index.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir } from "./helpers/scratch.ts";

const snapshot: CollaborationSnapshot = {
  version: 1,
  participantId: "0123456789abcdef0123456789abcdef",
  label: "teammate@example.com",
  repoId: "remote-repo-id",
  localRepoName: "RepoYeti",
  status: null,
  changes: [{ path: "src/collaboration.ts", status: "M", staged: false }],
  diff: "diff --git a/src/collaboration.ts b/src/collaboration.ts",
  updatedAt: 1_750_000_000_000,
};

test("snapshot encryption round-trips and does not expose the plaintext", () => {
  const token = "one-private-share-token";
  const encoded = encryptSnapshot(token, snapshot);
  expect(encoded).not.toContain("collaboration.ts");
  expect(encoded).not.toContain("teammate@example.com");
  expect(decryptSnapshot(token, encoded)).toEqual(snapshot);
});

test("the wrong token and ciphertext tampering both fail closed", () => {
  const encoded = encryptSnapshot("right-token", snapshot);
  expect(decryptSnapshot("wrong-token", encoded)).toBeNull();
  const last = encoded.at(-1)!;
  const tampered = `${encoded.slice(0, -1)}${last === "A" ? "B" : "A"}`;
  expect(decryptSnapshot("right-token", tampered)).toBeNull();
});

test("channel ids are deterministic, fixed-width, and domain-separated from the token", () => {
  const a = collaborationChannel("token-a");
  expect(a).toHaveLength(43);
  expect(a).not.toContain("token-a");
  expect(collaborationChannel("token-a")).toBe(a);
  expect(collaborationChannel("token-b")).not.toBe(a);
});

test("presence signatures change when content changes but path/stat totals do not", () => {
  const changes = [{ path: "src/a.ts", status: "M", staged: false, linesAdded: 1, linesDeleted: 1 }];
  expect(collaborationPresenceSignature(changes, "-old\n+new-a")).not.toBe(
    collaborationPresenceSignature(changes, "-old\n+new-b"),
  );
});

test("the owner atomically rejects a collaboration commit when the observed tree changed", async () => {
  const dir = mkScratchDir("gm-collaboration-atomic-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q --allow-empty -m init`.quiet();
  writeFileSync(join(dir, "shared.txt"), "version one\n");
  const id = mustUpsertRepo(dir, `collaboration-atomic-${crypto.randomUUID()}`, "auto", false);
  const observed = await collaborationFingerprint(id);
  expect(observed.complete).toBe(true);

  // Same path and byte length, different content: a path/stat-only guard would miss this.
  writeFileSync(join(dir, "shared.txt"), "version two\n");
  const stale = await commitRepoWithFingerprint(id, "fix: stale remote attempt", observed.fingerprint);
  expect(stale.ok).toBe(false);
  expect(stale.code).toBe("PLAN_STALE");
  expect((await $`git -C ${dir} rev-list --count HEAD`.text()).trim()).toBe("1");

  const current = await collaborationFingerprint(id);
  const committed = await commitRepoWithFingerprint(id, "fix: accepted remote work", current.fingerprint);
  expect(committed.ok).toBe(true);
  expect((await $`git -C ${dir} rev-list --count HEAD`.text()).trim()).toBe("2");
});

test("direct and relay invitations retain the secret only in the daemon-side parser", () => {
  expect(parseCollaborationInvitation("https://host.example/s/my-secret")).toEqual({
    token: "my-secret",
    directOrigin: "https://host.example",
    relayOrigin: null,
    daemonId: null,
  });
  expect(
    parseCollaborationInvitation(
      "https://app.repoyeti.com/r/0123456789abcdef#/s/my-secret",
    ),
  ).toEqual({
    token: "my-secret",
    directOrigin: null,
    relayOrigin: "https://app.repoyeti.com",
    daemonId: "0123456789abcdef",
  });
});

test("malformed and plaintext remote invitations are rejected", () => {
  expect(() => parseCollaborationInvitation("https://host.example/not-a-share")).toThrow();
  expect(() => parseCollaborationInvitation("http://host.example/s/token")).toThrow("HTTPS");
});

test("invitation inspection redeems the share server-side and uses only its guest projection", async () => {
  const originalFetch = globalThis.fetch;
  const seenCookies: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://owner.example/s/invite-token") {
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": "repoyeti_share=guest-session; Path=/; HttpOnly; Secure",
        },
      });
    }
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    seenCookies.push(cookie);
    if (url === "https://owner.example/api/status") {
      return Response.json({
        share: { label: "Design shift", perm: "view", collaborative: true },
      });
    }
    if (url === "https://owner.example/api/repos") {
      return Response.json({
        repos: [{ id: "repo-1", name: "repoyeti", displayName: "RepoYeti" }],
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    const invite = await inspectCollaborationInvitation(
      "https://owner.example/s/invite-token",
    );
    expect(invite.share).toEqual({
      label: "Design shift",
      perm: "view",
      collaborative: true,
    });
    expect(invite.repos).toEqual([
      { id: "repo-1", name: "repoyeti", displayName: "RepoYeti" },
    ]);
    expect(seenCookies).toEqual([
      "repoyeti_share=guest-session",
      "repoyeti_share=guest-session",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the owner accepts only fresh, correctly addressed snapshots from a live collaborative share", () => {
  initDb();
  const token = `presence-${crypto.randomUUID()}`;
  const share = createShare(hashToken(token), {
    label: "peer presence",
    perm: "view",
    collaborative: true,
    scopeAll: true,
    repoIds: [],
    expiresAt: null,
    token,
  });
  const live = { ...snapshot, updatedAt: Date.now(), repoId: `repo-${crypto.randomUUID()}` };
  const encoded = encryptSnapshot(token, live);

  const channel = collaborationChannel(token);
  expect(receiveCollaborationSnapshot(token, channel, live.participantId, encoded)).toBe(true);
  expect(readCollaborationSnapshots()).toContainEqual(live);
  expect(receiveCollaborationSnapshot(token, channel, "f".repeat(32), encoded)).toBe(false);
  expect(receiveCollaborationSnapshot(token, collaborationChannel("wrong"), live.participantId, encoded)).toBe(
    false,
  );

  revokeShare(share.id);
  expect(readCollaborationSnapshots()).not.toContainEqual(live);
  expect(receiveCollaborationSnapshot(token, channel, live.participantId, encoded)).toBe(false);
});

test("the public presence route requires the bearer secret and keeps owner reads owner-side", async () => {
  initDb();
  const token = `route-${crypto.randomUUID()}`;
  createShare(hashToken(token), {
    label: "route presence",
    perm: "view",
    collaborative: true,
    scopeAll: true,
    repoIds: [],
    expiresAt: null,
    token,
  });
  const live = {
    ...snapshot,
    participantId: "1".repeat(32),
    repoId: `route-repo-${crypto.randomUUID()}`,
    updatedAt: Date.now(),
  };
  const channel = collaborationChannel(token);
  const path = `/c/${channel}/${live.participantId}`;
  const cfg: RepoYetiConfig = {
    roots: [],
    port: 7171,
    maxDepth: 6,
    maxRepos: 200,
    mode: "local",
  };
  const app = createApp(cfg);

  const denied = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: encryptSnapshot(token, live) }),
  });
  expect(denied.status).toBe(403);

  const oversized = await app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ data: "x".repeat(360_001) }),
  });
  expect(oversized.status).toBe(413);

  const accepted = await app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ data: encryptSnapshot(token, live) }),
  });
  expect(accepted.status).toBe(200);

  const owner = await app.request("/api/collaborations");
  expect(owner.status).toBe(200);
  const body = (await owner.json()) as { snapshots: CollaborationSnapshot[] };
  expect(body.snapshots).toContainEqual(live);
});

test("accepted collaborations expose remote dirty state and enforce ten quiet minutes before MCP commit+sync", async () => {
  initDb();
  const suffix = crypto.randomUUID();
  const remoteRepoId = `remote-${suffix}`;
  const token = `accepted-${suffix}`;
  const link = createCollaborationLink({
    token,
    relayUrl: "",
    channelId: collaborationChannel(token),
    remoteOrigin: "https://owner.example",
    daemonId: null,
    participantId: "2".repeat(32),
    localRepoId: `local-${suffix}`,
    remoteRepoId,
    label: "recipient@example.com",
  });
  const persisted = initDb()
    .query("SELECT invite_url AS inviteUrl FROM collaboration_links WHERE id = ?")
    .get(link.id) as { inviteUrl: string };
  expect(persisted.inviteUrl).toBe(""); // do not duplicate the bearer token inside a retained URL
  const originalFetch = globalThis.fetch;
  const mutations: string[] = [];
  const commitBodies: unknown[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `https://owner.example/s/${encodeURIComponent(token)}`) {
      return new Response(null, {
        status: 302,
        headers: { location: "/", "set-cookie": "ry_share=session; Path=/; HttpOnly; Secure" },
      });
    }
    if (url === "https://owner.example/api/status") {
      return Response.json({
        share: { label: "Owner workspace", perm: "control", collaborative: true },
      });
    }
    if (url === "https://owner.example/api/repos") {
      return Response.json({
        repos: [
          {
            id: remoteRepoId,
            name: "remote-repo",
            displayName: "Remote Repo",
            vcs: "git",
            status: {
              branch: "main",
              detached: false,
              dirty: 1,
              ahead: 0,
              behind: 0,
              remote: "https://github.com/example/repo.git",
              error: null,
              fetchedAt: null,
              diff: null,
              conflicted: false,
              gitOperation: null,
              updatedAt: Date.now(),
            },
          },
        ],
      });
    }
    if (url === `https://owner.example/api/repos/${remoteRepoId}/changes`) {
      return Response.json({
        files: [{ path: "src/shared.ts", status: "M", staged: false }],
        total: 1,
        truncated: false,
      });
    }
    if (url === `https://owner.example/api/repos/${remoteRepoId}/collaboration-fingerprint`) {
      return Response.json({ fingerprint: "stable-remote-content", complete: true });
    }
    if (url === `https://owner.example/api/repos/${remoteRepoId}/diff?path=src%2Fshared.ts`) {
      return Response.json({ ok: true, patch: "+shared edit" });
    }
    if (
      url === `https://owner.example/api/repos/${remoteRepoId}/commit` ||
      url === `https://owner.example/api/repos/${remoteRepoId}/pull` ||
      url === `https://owner.example/api/repos/${remoteRepoId}/push`
    ) {
      mutations.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/commit")) commitBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ ok: true, code: "OK" });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  try {
    const first = await readAcceptedCollaborationStatus(link.id, 1_000);
    expect(first.changes.map((file) => file.path)).toEqual(["src/shared.ts"]);
    expect(first.stableForMs).toBe(0);
    expect(first.commitEligibleAt).toBe(1_000 + REMOTE_COMMIT_IDLE_MS);

    await expect(
      commitAndSyncAcceptedCollaboration(link.id, "fix: shared work", 1_001),
    ).rejects.toThrow("wait");
    expect(mutations).toHaveLength(0);

    const later = await readAcceptedCollaborationStatus(
      link.id,
      1_000 + REMOTE_COMMIT_IDLE_MS + 1,
    );
    expect(later.stableForMs).toBeGreaterThanOrEqual(REMOTE_COMMIT_IDLE_MS);
    expect(await readAcceptedCollaborationDiff(link.id, "src/shared.ts")).toEqual({
      ok: true,
      patch: "+shared edit",
    });

    const result = (await commitAndSyncAcceptedCollaboration(
      link.id,
      "fix: shared work",
      1_000 + REMOTE_COMMIT_IDLE_MS + 2,
    )) as { ok: boolean; localRepoId: string; remoteRepoId: string };
    expect(result).toMatchObject({
      ok: true,
      localRepoId: `local-${suffix}`,
      remoteRepoId,
    });
    expect(mutations.map((entry) => entry.replace("https://owner.example", ""))).toEqual([
      `POST /api/repos/${remoteRepoId}/commit`,
      `POST /api/repos/${remoteRepoId}/pull`,
      `POST /api/repos/${remoteRepoId}/push`,
    ]);
    expect(commitBodies).toEqual([
      {
        message: "fix: shared work",
        amend: false,
        expectedFingerprint: "stable-remote-content",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
