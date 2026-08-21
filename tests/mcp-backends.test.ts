/**
 * The two McpBackend adapters, plus the briefing they both hand to the tools.
 *
 * src/mcp/tools.ts and core.ts are transport-agnostic on purpose: the SAME tool catalog runs over
 * the in-process adapter (the daemon's own /mcp endpoint) and over the HTTP one (what Claude
 * Desktop/Code spawn as `repoyeti mcp`, proxying to the running daemon). That only holds if both
 * adapters actually implement the contract, and the HTTP one is pure wire-format: a wrong path or
 * a dropped query parameter fails silently inside someone's editor, with nothing in this repo to
 * catch it. So the HTTP adapter is checked against a recording server — every call it makes,
 * verbatim — and the service adapter against a real seeded repo.
 */
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { buildTriageBriefing, type TriageRepoInput } from "../src/mcp/backend.ts";
import { serviceBackend } from "../src/mcp/adapter-service.ts";
import { httpBackend } from "../src/mcp/adapter-http.ts";
import { setRepoStatus, type RepoStatus } from "../src/db.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// Real git subprocesses: 20s, not bun's 5s default, so `bun test` and `bun run test` agree.
useSuiteTimeout();

// ── the shared triage briefing (pure) ────────────────────────────────────────────────

type TriageOverride = Omit<Partial<TriageRepoInput>, "status"> & {
  status?: Partial<NonNullable<TriageRepoInput["status"]>> | null;
};

const triageRepo = (over: TriageOverride = {}): TriageRepoInput => ({
  id: over.id ?? "r1",
  name: over.name ?? "demo",
  autoCommit: over.autoCommit,
  status:
    over.status === null
      ? null
      : {
          branch: "main",
          detached: false,
          dirty: 0,
          ahead: 0,
          behind: 0,
          error: null,
          ...over.status,
        },
});

test("the triage briefing files one repo under every concern it actually has", () => {
  const b = buildTriageBriefing([
    triageRepo({ id: "a", name: "conflicted", status: { conflicted: true, dirty: 2 } }),
  ]);
  // A conflicted repo with uncommitted work is BOTH — the briefing is grouped by concern, not a
  // partition, so the reader sees it in each place they'd look.
  expect(b.conflicted.map((e) => e.id)).toEqual(["a"]);
  expect(b.dirty.map((e) => e.id)).toEqual(["a"]);
  expect(b.dirty[0]!.reason).toBe("2 uncommitted");
  expect(b.drifted).toEqual([]);
});

test("the triage briefing names which way a repo drifted", () => {
  const b = buildTriageBriefing([
    triageRepo({ id: "a", status: { ahead: 2 } }),
    triageRepo({ id: "b", status: { behind: 3 } }),
    triageRepo({ id: "c", status: { ahead: 1, behind: 1 } }),
  ]);
  expect(b.drifted.map((e) => `${e.id}:${e.reason}`)).toEqual(["a:ahead", "b:behind", "c:diverged"]);
});

test("the briefing reports mid-operation by its marker when there's no conflict", () => {
  const b = buildTriageBriefing([triageRepo({ status: { gitOperation: "rebase-merge" } })]);
  expect(b.conflicted[0]!.reason).toBe("rebase-merge");
});

test("auto-commit-blocked lists only repos that opted in AND can't be committed", () => {
  const b = buildTriageBriefing([
    triageRepo({ id: "off", status: { detached: true } }), // not opted in → not our problem
    triageRepo({ id: "healthy", autoCommit: true, status: { dirty: 1 } }), // opted in, fine
    triageRepo({ id: "detached", autoCommit: true, status: { detached: true } }),
    triageRepo({ id: "errored", autoCommit: true, status: { error: "boom" } }),
    triageRepo({ id: "unborn", autoCommit: true, status: { branch: null } }),
    triageRepo({ id: "midop", autoCommit: true, status: { conflicted: true } }),
  ]);
  expect(b.autoCommitBlocked.map((e) => `${e.id}:${e.reason}`)).toEqual([
    "detached:detached",
    "errored:error",
    "unborn:no-branch",
    "midop:conflict",
  ]);
});

test("a repo with no status yet is skipped rather than guessed at", () => {
  const b = buildTriageBriefing([{ id: "x", name: "unscanned", status: null }]);
  expect(b).toEqual({ conflicted: [], drifted: [], autoCommitBlocked: [], dirty: [] });
});

// ── the in-process adapter, over a real repo ─────────────────────────────────────────

const service = serviceBackend();

/** A registered repo with one commit, one modified tracked file and one untracked file. */
async function seeded(name: string): Promise<{ id: string; path: string }> {
  const path = mkScratchDir(`gm-mcpb-${name}-`);
  await $`git -c init.defaultBranch=main init -q ${path}`.quiet();
  writeFileSync(join(path, "a.txt"), "one\n");
  await $`git -C ${path} -c user.name=S -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${path} -c user.name=S -c user.email=s@s.io commit -q -m init`.quiet();
  writeFileSync(join(path, "a.txt"), "one\nneedle\n");
  writeFileSync(join(path, "b.txt"), "untracked\n");
  const id = mustUpsertRepo(path, name, "auto", false);
  return { id, path };
}

test("the service adapter answers every read a tool can ask for", async () => {
  const { id } = await seeded("mcpb-reads");

  const status = (await service.repoStatus("mcpb-reads")) as { id: string; vcs: string };
  expect(status.id).toBe(id);
  expect(status.vcs).toBe("git");

  const changes = (await service.changes(id)) as { files: Array<{ path: string }> };
  expect(changes.files.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);

  const log = (await service.log(id, { limit: 5 })) as { commits: Array<{ subject: string }> };
  expect(log.commits[0]!.subject).toBe("init");

  const branches = (await service.branches(id)) as { branches: Array<{ name: string }> };
  expect(branches.branches.map((b) => b.name)).toContain("main");

  const diff = (await service.diff(id, "a.txt")) as { ok: boolean };
  expect(diff.ok).toBe(true);

  const stashes = (await service.listStashes(id)) as { stashes: unknown[] };
  expect(stashes.stashes).toEqual([]);

  const hits = (await service.search(id, "needle")) as { files?: unknown[]; matches?: unknown[] };
  expect(JSON.stringify(hits)).toContain("a.txt");

  const repos = (await service.listRepos()) as { repos: Array<{ id: string }> };
  expect(repos.repos.some((r) => r.id === id)).toBe(true);
});

test("the service adapter's mutations resolve the repo the same way its reads do", async () => {
  const { id, path } = await seeded("mcpb-writes");

  expect(await service.commit("mcpb-writes", "from mcp")).toBeDefined();
  expect((await $`git -C ${path} log -1 --pretty=%s`.text()).trim()).toBe("from mcp");

  await service.createBranch(id, "mcp-branch", true);
  expect((await $`git -C ${path} rev-parse --abbrev-ref HEAD`.text()).trim()).toBe("mcp-branch");

  await service.checkout(id, "main");
  expect((await $`git -C ${path} rev-parse --abbrev-ref HEAD`.text()).trim()).toBe("main");
});

test("a remote op with nowhere to go surfaces as a thrown tool error, not a false success", async () => {
  const { id } = await seeded("mcpb-noremote");
  // ensureOk turns every not-ok envelope into a throw, which core.ts renders as an MCP
  // isError result — so an agent is told the push failed instead of reading `ok:false` off a
  // payload it never inspects.
  await expect(service.push(id)).rejects.toThrow();
  await expect(service.pull(id)).rejects.toThrow();
  // fetch is the exception, and deliberately: `git fetch` with nothing configured is a no-op that
  // exits clean, so there is no failure to report.
  expect(await service.fetch(id)).toBeDefined();
});

test("the service adapter resolves a repo by id, name and basename — and refuses a guess", async () => {
  const { id, path } = await seeded("mcpb-resolve");
  const base = path.replace(/[/\\]+$/, "").split(/[/\\]/).pop()!;

  expect(((await service.repoStatus(id)) as { id: string }).id).toBe(id);
  expect(((await service.repoStatus("mcpb-resolve")) as { id: string }).id).toBe(id);
  expect(((await service.repoStatus(base)) as { id: string }).id).toBe(id);

  await expect(service.repoStatus("  ")).rejects.toThrow(/required/);
  await expect(service.repoStatus("no-such-repo-anywhere")).rejects.toThrow(/no repo matches/);

  // Two repos sharing a name must never be silently picked between.
  const dupA = mkScratchDir("gm-mcpb-dup-a-");
  const dupB = mkScratchDir("gm-mcpb-dup-b-");
  await $`git -c init.defaultBranch=main init -q ${dupA}`.quiet();
  await $`git -c init.defaultBranch=main init -q ${dupB}`.quiet();
  mustUpsertRepo(dupA, "mcpb-twin", "auto", false);
  mustUpsertRepo(dupB, "mcpb-twin", "auto", false);
  await expect(service.repoStatus("mcpb-twin")).rejects.toThrow(/ambiguous/);
});

test("drift and the briefing read the same repo list the dashboard does", async () => {
  const { id } = await seeded("mcpb-drift");
  const drifted: RepoStatus = {
    branch: "main",
    detached: false,
    dirty: 0,
    ahead: 2,
    behind: 1,
    remote: "origin",
    error: null,
    fetchedAt: null,
    updatedAt: Date.now(),
  };
  setRepoStatus(id, drifted);

  const { repos } = (await service.drift()) as { repos: Array<{ id: string }> };
  expect(repos.some((r) => r.id === id)).toBe(true);

  const briefing = (await service.triageBriefing()) as ReturnType<typeof buildTriageBriefing>;
  expect(briefing.drifted.find((e) => e.id === id)?.reason).toBe("diverged");
});

test("collaboration reads report a missing link instead of answering for the wrong one", async () => {
  const links = (await service.listCollaborations()) as {
    sharedWithMe: unknown[];
    collaboratingWithMe: unknown[];
  };
  expect(Array.isArray(links.sharedWithMe)).toBe(true);
  expect(Array.isArray(links.collaboratingWithMe)).toBe(true);

  await expect(service.collaborationStatus("no-such-link")).rejects.toThrow();
  await expect(service.collaborationDiff("no-such-link", "a.txt")).rejects.toThrow();
  await expect(service.collaborationCommitSync("no-such-link", "msg")).rejects.toThrow();
});

// ── the HTTP adapter: exactly what goes on the wire ──────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

const FIXTURE_REPOS = [
  {
    id: "r1",
    name: "demo",
    absPath: "/srv/demo",
    vcs: "git",
    autoCommit: true,
    status: { branch: "main", detached: false, dirty: 1, ahead: 2, behind: 0, remote: "origin", error: null },
  },
  {
    id: "r2",
    name: "quiet",
    absPath: "/srv/quiet",
    vcs: "git",
    status: { branch: "main", detached: false, dirty: 0, ahead: 0, behind: 0, remote: "origin", error: null },
  },
];

/**
 * Stand in for the running daemon: answer /api/repos with the fixture so `resolveRepo` works,
 * echo everything else, and record each request. Every httpBackend method resolves the repo
 * first, so the call under test is always the LAST one recorded.
 */
async function withRecorder(fn: (calls: Recorded[]) => Promise<void>): Promise<void> {
  const calls: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      calls.push({
        method: req.method,
        path: url.pathname + url.search,
        body: text ? JSON.parse(text) : undefined,
      });
      if (url.pathname === "/api/repos") return Response.json({ repos: FIXTURE_REPOS });
      if (url.pathname === "/api/collaboration-links") return Response.json({ links: [{ id: "c1" }] });
      if (url.pathname === "/api/collaborations") return Response.json({ snapshots: [{ id: "s1" }] });
      return Response.json({ ok: true, path: url.pathname });
    },
  });
  const prev = process.env.REPOYETI_BASE_URL;
  process.env.REPOYETI_BASE_URL = `http://127.0.0.1:${server.port}`;
  try {
    await fn(calls);
  } finally {
    server.stop(true);
    if (prev === undefined) delete process.env.REPOYETI_BASE_URL;
    else process.env.REPOYETI_BASE_URL = prev;
  }
}

const last = (calls: Recorded[]): Recorded => calls[calls.length - 1]!;

test("every HTTP-adapter read hits the daemon path the API actually serves", async () => {
  await withRecorder(async (calls) => {
    const http = httpBackend();

    const repos = (await http.listRepos()) as { repos: unknown[] };
    expect(repos.repos.length).toBe(2);
    expect(last(calls)).toEqual({ method: "GET", path: "/api/repos", body: undefined });

    // repoStatus is answered entirely from the repo list — no second round trip.
    const status = (await http.repoStatus("demo")) as { id: string; absPath: string };
    expect(status.id).toBe("r1");
    expect(status.absPath).toBe("/srv/demo");
    expect(last(calls).path).toBe("/api/repos");

    await http.changes("demo");
    expect(last(calls)).toEqual({ method: "GET", path: "/api/repos/r1/changes", body: undefined });

    await http.branches("r1");
    expect(last(calls).path).toBe("/api/repos/r1/branches");

    await http.listStashes("demo");
    expect(last(calls).path).toBe("/api/repos/r1/stashes");
  });
});

test("the HTTP adapter's log options survive the trip as query parameters", async () => {
  await withRecorder(async (calls) => {
    const http = httpBackend();

    await http.log("demo");
    expect(last(calls).path).toBe("/api/repos/r1/log"); // no options → no stray "?"

    await http.log("demo", { limit: 25, merges: "only" });
    expect(last(calls).path).toBe("/api/repos/r1/log?limit=25&merges=only");

    await http.log("demo", { merges: "exclude" });
    expect(last(calls).path).toBe("/api/repos/r1/log?merges=exclude");

    // A junk limit is dropped rather than forwarded as "limit=NaN"; a fractional one is floored.
    await http.log("demo", { limit: Number.NaN });
    expect(last(calls).path).toBe("/api/repos/r1/log");
    await http.log("demo", { limit: 0 });
    expect(last(calls).path).toBe("/api/repos/r1/log");
    await http.log("demo", { limit: 7.9 });
    expect(last(calls).path).toBe("/api/repos/r1/log?limit=7");
  });
});

test("paths and queries the agent supplies are encoded, not pasted into the URL", async () => {
  await withRecorder(async (calls) => {
    const http = httpBackend();

    await http.diff("demo", "src/a b&c.ts");
    expect(last(calls).path).toBe("/api/repos/r1/diff?path=src%2Fa%20b%26c.ts");

    await http.search("demo", "needle&limit=1");
    expect(last(calls).path).toBe("/api/repos/r1/search?q=needle%26limit%3D1");

    await http.collaborationStatus("link one");
    expect(last(calls).path).toBe("/api/collaboration-links/link%20one/status");

    await http.collaborationDiff("link one", "a b.txt");
    expect(last(calls).path).toBe("/api/collaboration-links/link%20one/diff?path=a%20b.txt");
  });
});

test("every HTTP-adapter mutation POSTs the body the route expects", async () => {
  await withRecorder(async (calls) => {
    const http = httpBackend();

    await http.commit("demo", "a message");
    expect(last(calls)).toEqual({
      method: "POST",
      path: "/api/repos/r1/commit",
      body: { message: "a message", amend: false },
    });

    await http.commit("demo", "fixup", true);
    expect(last(calls).body).toEqual({ message: "fixup", amend: true });

    await http.createBranch("demo", "feature");
    expect(last(calls)).toEqual({
      method: "POST",
      path: "/api/repos/r1/branch",
      body: { name: "feature", switch: true },
    });
    await http.createBranch("demo", "feature", false);
    expect(last(calls).body).toEqual({ name: "feature", switch: false });

    await http.checkout("demo", "main");
    expect(last(calls)).toEqual({ method: "POST", path: "/api/repos/r1/checkout", body: { branch: "main" } });

    for (const [verb, path] of [
      [http.push, "/api/repos/r1/push"],
      [http.pull, "/api/repos/r1/pull"],
      [http.fetch, "/api/repos/r1/fetch"],
    ] as const) {
      await verb("demo");
      expect(last(calls)).toEqual({ method: "POST", path, body: {} });
    }

    await http.collaborationCommitSync("c1", "shipped");
    expect(last(calls)).toEqual({
      method: "POST",
      path: "/api/collaboration-links/c1/commit-sync",
      body: { message: "shipped" },
    });
  });
});

test("the HTTP adapter derives drift, the briefing and collaborations from the daemon's own lists", async () => {
  await withRecorder(async (calls) => {
    const http = httpBackend();

    // Filtered here rather than server-side: only r1 is ahead.
    const drift = (await http.drift()) as { repos: Array<{ id: string }> };
    expect(drift.repos.map((r) => r.id)).toEqual(["r1"]);

    const briefing = (await http.triageBriefing()) as ReturnType<typeof buildTriageBriefing>;
    expect(briefing.drifted.map((e) => e.id)).toEqual(["r1"]);
    expect(briefing.dirty.map((e) => e.id)).toEqual(["r1"]);

    const collabs = (await http.listCollaborations()) as {
      sharedWithMe: unknown[];
      collaboratingWithMe: unknown[];
    };
    // Two different endpoints, one answer: accepted links + peers publishing into this daemon.
    expect(collabs.sharedWithMe).toEqual([{ id: "c1" }]);
    expect(collabs.collaboratingWithMe).toEqual([{ id: "s1" }]);
    const paths = calls.map((c) => c.path);
    expect(paths).toContain("/api/collaboration-links");
    expect(paths).toContain("/api/collaborations");
  });
});

test("an error envelope from the daemon reaches the agent as a thrown tool error", async () => {
  const prev = process.env.REPOYETI_BASE_URL;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/api/repos") return Response.json({ repos: FIXTURE_REPOS });
      return Response.json({ ok: false, code: "NON_FAST_FORWARD", message: "remote has diverged" }, { status: 409 });
    },
  });
  process.env.REPOYETI_BASE_URL = `http://127.0.0.1:${server.port}`;
  try {
    await expect(httpBackend().push("demo")).rejects.toThrow("remote has diverged");
  } finally {
    server.stop(true);
    if (prev === undefined) delete process.env.REPOYETI_BASE_URL;
    else process.env.REPOYETI_BASE_URL = prev;
  }
});
