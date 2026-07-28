/**
 * Every `repoyeti <verb>` git command, driven the way a user runs it: against a live daemon over
 * loopback HTTP (src/cli/git.ts may not import the service layer, so there is no shortcut).
 *
 * tests/cli.test.ts already covers the client and the repos/drift/status happy paths. This covers
 * the rest of the surface — the verbs that read, the verbs that mutate, the argument walker, and
 * the top-level handler, whose whole job is that a failure prints one line and sets exit 1 rather
 * than dumping a stack at someone's terminal.
 */
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { runGitVerb } from "../src/cli/git.ts";
import { relativeTime } from "../src/cli/format.ts";
import { setRepoStatus, type RepoStatus } from "../src/db.ts";
import { mustUpsertRepo } from "./helpers/upsert.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { withDaemon } from "./helpers/daemon.ts";

interface Run {
  out: string;
  err: string;
  exitCode: number;
}

/** Run one verb with stdout/stderr captured and the process exit code isolated. */
async function verb(cmd: string, args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const previousExit = process.exitCode;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
  process.exitCode = 0;
  try {
    await runGitVerb(cmd, args);
    return { out: out.join("\n"), err: err.join("\n"), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    // Never let a verb's `process.exitCode = 1` escape into the test runner's own exit status.
    process.exitCode = previousExit;
  }
}

/** A registered repo with two commits (one a merge) and an uncommitted edit. */
async function seeded(name: string): Promise<{ id: string; path: string }> {
  const path = mkScratchDir(`gm-cliv-${name}-`);
  const git = async (...args: string[]) =>
    void (await $`git -C ${path} -c user.name=S -c user.email=s@s.io ${args}`.quiet());
  await $`git -c init.defaultBranch=main init -q ${path}`.quiet();
  writeFileSync(join(path, "a.txt"), "one\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "first commit");
  await git("checkout", "-q", "-b", "side");
  writeFileSync(join(path, "b.txt"), "side\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "side commit");
  await git("checkout", "-q", "main");
  await git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  writeFileSync(join(path, "a.txt"), "one\nedited\n");
  const id = mustUpsertRepo(path, `cliv-${name}`, "auto", false);
  return { id, path };
}

// ── reads ─────────────────────────────────────────────────────────────────────────────

test("log renders the history, and its filters reach the daemon", async () => {
  await seeded("log");
  await withDaemon(async () => {
    const all = await verb("log", ["cliv-log"]);
    expect(all.exitCode).toBe(0);
    expect(all.out).toContain("merge side");
    expect(all.out).toContain("first commit");

    // --limit trims the page; --merges filters it.
    const one = await verb("log", ["cliv-log", "--limit", "1"]);
    expect(one.out).toContain("merge side");
    expect(one.out).not.toContain("first commit");

    const merges = await verb("log", ["cliv-log", "--merges", "only"]);
    expect(merges.out).toContain("merge side");
    expect(merges.out).not.toContain("first commit");

    const noMerges = await verb("log", ["cliv-log", "--merges", "exclude"]);
    expect(noMerges.out).not.toContain("merge side");
    expect(noMerges.out).toContain("first commit");

    // A junk --limit is ignored rather than sent as "limit=NaN".
    expect((await verb("log", ["cliv-log", "--limit", "nope"])).exitCode).toBe(0);
  });
});

test("branches marks the current branch and reports its upstream state", async () => {
  await seeded("branches");
  await withDaemon(async () => {
    const r = await verb("branches", ["cliv-branches"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("main");
    expect(r.out).toContain("side");
    expect(r.out).toContain("(no upstream)"); // a local-only branch says so rather than blank
  });
});

test("diff prints the patch for a changed file", async () => {
  await seeded("diff");
  await withDaemon(async () => {
    const r = await verb("diff", ["cliv-diff", "a.txt"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("edited");
  });
});

test("stash saves, lists, pops and drops through the daemon", async () => {
  await seeded("stash");
  await withDaemon(async () => {
    const empty = await verb("stash", ["cliv-stash", "list"]);
    expect(empty.out).toContain("No stashes.");

    const saved = await verb("stash", ["cliv-stash"]); // no subcommand → save
    expect(saved.exitCode).toBe(0);
    expect(saved.out).toContain("stashed");

    const listed = await verb("stash", ["cliv-stash", "list"]);
    expect(listed.out).toContain("stash@{0}");

    const popped = await verb("stash", ["cliv-stash", "pop"]);
    expect(popped.exitCode).toBe(0);
    expect(popped.out).toContain("popped");

    // drop with nothing left is an API failure, printed as "✗ CODE: message".
    const dropped = await verb("stash", ["cliv-stash", "drop"]);
    expect(dropped.exitCode).toBe(1);
    expect(dropped.err).toContain("STASH_EMPTY");
  });
});

test("a repo whose status is an error, or has none yet, still prints a status block", async () => {
  const broken = mkScratchDir("gm-cliv-broken-");
  const brokenId = mustUpsertRepo(broken, "cliv-broken", "auto", false);
  const unscanned = mkScratchDir("gm-cliv-unscanned-");
  mustUpsertRepo(unscanned, "cliv-unscanned", "auto", false);
  const status: RepoStatus = {
    branch: null,
    detached: false,
    dirty: 0,
    ahead: 0,
    behind: 0,
    remote: null,
    error: "not a git repository",
    fetchedAt: null,
    updatedAt: Date.now(),
  };
  setRepoStatus(brokenId, status);

  await withDaemon(async () => {
    const errored = await verb("status", ["cliv-broken"]);
    expect(errored.exitCode).toBe(0); // an unhealthy repo is reported, not an CLI failure
    expect(errored.out).toContain("not a git repository");

    const none = await verb("status", ["cliv-unscanned"]);
    expect(none.exitCode).toBe(0);
    expect(none.out).toContain("(no status yet)");
  });
});

// ── mutations ─────────────────────────────────────────────────────────────────────────

test("branch, checkout and commit act on the repo and confirm what they did", async () => {
  const { path } = await seeded("write");
  await withDaemon(async () => {
    const made = await verb("branch", ["cliv-write", "from-cli", "--switch"]);
    expect(made.exitCode).toBe(0);
    expect((await $`git -C ${path} rev-parse --abbrev-ref HEAD`.text()).trim()).toBe("from-cli");

    const back = await verb("checkout", ["cliv-write", "main"]);
    expect(back.exitCode).toBe(0);
    expect((await $`git -C ${path} rev-parse --abbrev-ref HEAD`.text()).trim()).toBe("main");

    const committed = await verb("commit", ["cliv-write", "-m", "from the cli"]);
    expect(committed.exitCode).toBe(0);
    expect((await $`git -C ${path} log -1 --pretty=%s`.text()).trim()).toBe("from the cli");

    // --amend rewrites that same commit rather than adding one.
    writeFileSync(join(path, "a.txt"), "amended\n");
    const amended = await verb("commit", ["cliv-write", "-m", "amended subject", "--amend"]);
    expect(amended.exitCode).toBe(0);
    expect((await $`git -C ${path} log -1 --pretty=%s`.text()).trim()).toBe("amended subject");
  });
});

test("push, pull and fetch report the daemon's verdict for a repo with no remote", async () => {
  await seeded("sync");
  await withDaemon(async () => {
    for (const action of ["push", "pull"] as const) {
      const r = await verb(action, ["cliv-sync"]);
      expect(r.exitCode).toBe(1);
      expect(r.err).toMatch(/NO_REMOTE|NO_UPSTREAM/);
    }
    // fetch with nothing configured is a clean no-op, so it reports success.
    const fetched = await verb("fetch", ["cliv-sync"]);
    expect(fetched.exitCode).toBe(0);
  });
});

// ── the argument walker and the top-level handler ─────────────────────────────────────

test("every repo-scoped verb prints its own usage line when an argument is missing", async () => {
  await seeded("usage");
  await withDaemon(async () => {
    for (const [cmd, args, needle] of [
      ["log", [], "repoyeti log"],
      ["branches", [], "repoyeti branches"],
      ["branch", ["cliv-usage"], "repoyeti branch"], // repo given, name missing
      ["checkout", ["cliv-usage"], "repoyeti checkout"],
      ["commit", ["cliv-usage"], "repoyeti commit"], // no -m
      ["commit", ["cliv-usage", "-m", "   "], "repoyeti commit"], // blank -m is not a message
      ["diff", ["cliv-usage"], "repoyeti diff"],
      ["stash", ["cliv-usage", "nonsense"], "repoyeti stash"],
      ["push", [], "repoyeti push"],
    ] as const) {
      const r = await verb(cmd, [...args]);
      expect(r.exitCode).toBe(1);
      expect(r.err).toContain(needle);
    }
  });
});

test("an unknown verb is a usage error, not a crash", async () => {
  await withDaemon(async () => {
    const r = await verb("teleport", []);
    expect(r.exitCode).toBe(1);
    expect(r.err).toContain("unknown git verb: teleport");
  });
});

test("a verb that can't reach a daemon at all fails with one readable line", async () => {
  const prev = process.env.REPOYETI_BASE_URL;
  // A port nothing is listening on: the fetch itself fails, which is neither an ApiError nor a
  // usage error — the branch that must still print something a human can read.
  process.env.REPOYETI_BASE_URL = "http://127.0.0.1:1";
  try {
    const r = await verb("repos", []);
    expect(r.exitCode).toBe(1);
    expect(r.err.length).toBeGreaterThan(0);
    expect(r.err).not.toContain("at <anonymous>"); // a message, not a stack
  } finally {
    if (prev === undefined) delete process.env.REPOYETI_BASE_URL;
    else process.env.REPOYETI_BASE_URL = prev;
  }
});

test("the flag walker takes values, booleans and short flags the way the verbs expect", async () => {
  await seeded("flags");
  await withDaemon(async () => {
    // `--switch` as a bare trailing flag is true (it isn't followed by a value)…
    expect((await verb("branch", ["cliv-flags", "bare-flag", "--switch"])).exitCode).toBe(0);
    // …and `--switch true` is the same thing spelled out.
    expect((await verb("branch", ["cliv-flags", "explicit-flag", "--switch", "true"])).exitCode).toBe(0);
    // `--message` is the long form of `-m`.
    expect((await verb("commit", ["cliv-flags", "--message", "long form"])).exitCode).toBe(0);
    // A short flag with nothing after it is a boolean, so it is NOT a message → usage error.
    const dangling = await verb("commit", ["cliv-flags", "-m"]);
    expect(dangling.exitCode).toBe(1);
    expect(dangling.err).toContain("repoyeti commit");
  });
});

// ── the timestamps those tables print ─────────────────────────────────────────────────

test("relativeTime walks the unit ladder and says nothing about a missing timestamp", () => {
  const ago = (ms: number): string => relativeTime(Date.now() - ms);
  expect(relativeTime(0)).toBe("");
  expect(ago(5_000)).toBe("5s ago");
  expect(ago(90_000)).toBe("1m ago");
  expect(ago(3 * 3600_000)).toBe("3h ago");
  expect(ago(2 * 86_400_000)).toBe("2d ago");
  expect(ago(3 * 7 * 86_400_000)).toBe("3w ago");
  expect(ago(60 * 86_400_000)).toBe("1mo ago");
  expect(ago(800 * 86_400_000)).toBe("2y ago");
  // A future timestamp clamps at zero rather than printing a negative age.
  expect(relativeTime(Date.now() + 60_000)).toBe("0s ago");
});
