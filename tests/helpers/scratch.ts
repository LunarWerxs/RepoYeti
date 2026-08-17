// Shared scratch-directory root for the WHOLE test suite. Deliberately NOT under the OS temp
// directory (os.tmpdir() / TEMP / TMP / TMPDIR): src/paths.ts's isUnderTempDir (the owner-directive
// hard guard upsertRepo enforces, see src/db.ts) refuses to import any repo whose path lives
// there, and the suite fabricates hundreds of scratch git repos via `mkdtempSync`. If those repos
// were rooted under the real OS temp dir (the historic pattern that produced the owner's ~115
// junk `%TEMP%\gm-*` rows in the first place), every one of those tests would now be refused by
// the very guard this project adds.
//
// So test scratch state (REPOYETI_HOME from tests/setup.ts, AND every ad-hoc scratch git repo the
// suite creates) lives under a repo-local directory instead. This also means the guard itself is
// exercised against the REAL os.tmpdir()/TEMP/TMP/TMPDIR (untouched here), not a substitute, in
// tests/db-temp-guard.test.ts.
//
// ── WHY THIS FILE OWNS CLEANUP ────────────────────────────────────────────────────
// Moving off the OS temp dir silently dropped the thing the OS was doing for free: reaping.
// Nothing else reaps `.testtmp/` — it is gitignored, so no git-based check sees it; CI never
// notices because GitHub runners are destroyed after every job; and tests/rmrf.ts still carries
// the old assumption in its doc comment ("the OS temp reaper collects any leaked dir later"),
// which stopped being true the moment scratch moved in here. On a developer machine the result
// is unbounded growth: this directory reached 1,673,606 files across 46,854 leaked scratch dirs
// between 2026-07-27 and 2026-08-15 before anyone looked. It is only ~4.6 GB — the damage is the
// FILE COUNT, which slows every tool that walks the working tree (git status, editors, ripgrep,
// the repo's own checks) and is brutal to delete once it has grown.
//
// The fix is a per-RUN subdirectory that is removed when the run ends, plus a sweep of run
// directories orphaned by a crashed or killed run.
//
// CONCURRENCY IS A HARD REQUIREMENT, not a nicety: this repo is worked on by many agent sessions
// at once, so a blunt "delete .testtmp on startup" would delete a sibling run's fixtures mid-test.
// Run directories are therefore keyed by PID, and the sweep only removes a directory whose owning
// process is gone.
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { rmrf } from "../rmrf.ts";

/** Repo-local scratch root (gitignored; see .gitignore's `.testtmp/`). Created on first use. */
const ROOT = join(import.meta.dir, "..", "..", ".testtmp");
mkdirSync(ROOT, { recursive: true });

const RUN_PREFIX = "run-";

/**
 * This run's own subdirectory. Every scratch path the suite creates lives under here, so teardown
 * is a single recursive remove rather than bookkeeping per call site (there are 53 test files
 * calling mkScratchDir; asking each to clean up is exactly the discipline that already failed).
 *
 * The PID is in the name so a concurrent run can tell whose directory is whose, and so the sweep
 * below can ask the OS whether the owner is still alive.
 */
const RUN_ROOT = join(ROOT, `${RUN_PREFIX}${process.pid}-${Date.now().toString(36)}`);
mkdirSync(RUN_ROOT, { recursive: true });

/** True if a process with this pid currently exists. Signal 0 performs the permission/existence
 *  check without delivering anything. EPERM means it exists but is owned by someone else — alive
 *  for our purposes, and the safe answer either way. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove run directories whose owning process is gone — the residue of a run that crashed, was
 * killed, or was Ctrl-C'd before its teardown could fire. Without this, cleanup only ever works
 * for runs that exit cleanly, and the leak returns by a slower route.
 *
 * Deliberately conservative: a directory is removed ONLY when its pid is parseable AND that pid is
 * dead. Anything else — a live sibling run, an unrecognised name, a stat failure — is left alone.
 * Over-deleting here would break a concurrent run's fixtures mid-test, which is far worse than
 * leaving a directory behind for the next sweep.
 *
 * PID reuse is the one way this can be wrong, and it is handled from both sides. A recycled pid
 * cannot make a LIVE run look dead, because a directory younger than SWEEP_GRACE_MS is never
 * touched regardless of pid state. It can make a DEAD run look alive indefinitely — pid 1234 exits,
 * the OS hands 1234 to something else, and that orphan then looks owned forever — so a hard age
 * ceiling removes any run directory past MAX_RUN_AGE_MS whatever its pid says. No test run lasts a
 * day; without this the leak would simply return by a slower route.
 */
const SWEEP_GRACE_MS = 5 * 60_000;
const MAX_RUN_AGE_MS = 24 * 60 * 60_000;

function sweepOrphanedRuns(): void {
  let entries: string[];
  try {
    entries = readdirSync(ROOT);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    const dir = join(ROOT, name);
    if (dir === RUN_ROOT) continue;

    let mtime: number;
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      mtime = st.mtimeMs;
    } catch {
      continue;
    }
    // Young directories are never touched: this is the guard that makes pid reuse a non-issue.
    if (now - mtime < SWEEP_GRACE_MS) continue;

    const ancient = now - mtime > MAX_RUN_AGE_MS;
    if (name.startsWith(RUN_PREFIX) && !ancient) {
      const pid = Number.parseInt(name.slice(RUN_PREFIX.length).split("-")[0] ?? "", 10);
      if (!Number.isInteger(pid) || pid <= 0 || pidAlive(pid)) continue;
    }
    // Non-`run-` entries are pre-existing scratch from before this layout (or a stray fixture).
    // Past the grace period with no owner to attribute them to, they are residue by definition.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort. A locked handle just means the next run sweeps it.
    }
  }
}

sweepOrphanedRuns();

/** The shared scratch root itself, for callers that want to nest their own subdirectory under it
 *  (e.g. tests/setup.ts's REPOYETI_HOME). This is THIS RUN's directory, so anything nested under
 *  it is removed by cleanupScratchRun(). */
export function scratchRoot(): string {
  return RUN_ROOT;
}

/**
 * The `.testtmp` root shared by ALL runs — deliberately not this run's subdirectory.
 *
 * Exists for exactly one caller: tests/setup.ts's GIT_CEILING_DIRECTORIES blast door. Anchoring
 * the ceiling here rather than at RUN_ROOT keeps the documented semantics (git cannot climb out of
 * `.testtmp` and find RepoYeti's own `.git`) covering ANY path under the scratch tree, including a
 * stray fixture that some future test creates outside the per-run directory. Do not use it to
 * create scratch state: anything written here instead of under scratchRoot() is not cleaned up by
 * this run and has to wait for a later sweep.
 */
export function scratchSuiteRoot(): string {
  return ROOT;
}

/** `mkdtempSync(join(scratchRoot(), prefix))`: the drop-in replacement for the suite's old
 *  `mkdtempSync(join(tmpdir(), prefix))` pattern, minus the OS-temp-dir problem above. */
export function mkScratchDir(prefix: string): string {
  return mkdtempSync(join(RUN_ROOT, prefix));
}

/**
 * Remove this run's entire scratch tree. Wired to a suite-wide `afterAll` and to process exit in
 * tests/setup.ts, so no individual test has to remember.
 *
 * Child-by-child, NOT a single rmSync of RUN_ROOT, and that detail is the whole difference between
 * working and not. Windows holds a directory handle open for a short while after a watcher or SSE
 * stream closes (see tests/rmrf.ts), and a recursive remove of the parent is atomic in its failure:
 * ONE still-locked fixture aborts the walk and every other directory under it survives too. The
 * first version of this cleanup did exactly that and left 40 directories behind. Removing each
 * child separately means a lock costs you that one directory instead of all of them.
 *
 * Synchronous and swallowing: it runs from an exit handler, where async work would never complete,
 * and a teardown failure must never turn a run whose assertions already passed red. Whatever is
 * still locked is left for sweepOrphanedRuns() on a later run — precisely the case it exists for.
 */
export function cleanupScratchRun(): void {
  let children: string[] = [];
  try {
    children = readdirSync(RUN_ROOT);
  } catch {
    return;
  }
  for (const name of children) {
    try {
      rmSync(join(RUN_ROOT, name), { recursive: true, force: true });
    } catch {
      // This one is locked; the others are not its hostage.
    }
  }
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    // Non-empty because something above was locked. Next run's sweep gets it.
  }
}

/**
 * Async teardown for the clean-exit path, used by tests/setup.ts's `afterAll`.
 *
 * Same child-by-child structure as cleanupScratchRun(), but each removal goes through rmrf()'s
 * backoff, which is what actually beats the Windows handle-release delay: the handles this suite
 * leaves open are released within milliseconds, so a retry succeeds where the immediate sync
 * attempt fails. Cleanup is therefore near-total here, and the sync exit handler is the backstop
 * for the interrupted case rather than the main mechanism.
 */
export async function cleanupScratchRunAsync(): Promise<void> {
  let children: string[] = [];
  try {
    children = readdirSync(RUN_ROOT);
  } catch {
    return;
  }
  await Promise.all(children.map((name) => rmrf(join(RUN_ROOT, name))));
  await rmrf(RUN_ROOT);
}

/**
 * A cross-platform `file://` URL that git can actually clone/fetch/push: `file:///tmp/x` on POSIX
 * (the path already starts with `/`) and `file://C:/x` on Windows (git rejects the `file:///C:/x`
 * form — it reads the path as `/C:/x`). So just prefix the forward-slashed path with `file://`.
 *
 * Worth the URL rather than a plain path: git only takes the LOCAL-clone shortcut (hardlinks, no
 * transfer) for a bare path. `file://` puts the real transport in play, which is what makes a
 * scratch remote exercise the same code — and the same `--progress` output — as a network one.
 */
export function fileUrl(p: string): string {
  return `file://${p.replace(/\\/g, "/")}`;
}
