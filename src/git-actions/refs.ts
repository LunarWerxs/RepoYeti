/**
 * Repository ref/config management: remotes, tags, branches, and stash. These are mostly
 * local config/ref writes (remotes, branch create/delete, stash) with one network exception —
 * a tag push — which reuses the same identity + `netGate` seam as ./sync.ts.
 */
import { gitFor, identityConfigArgs } from "../git.ts";
import { readStatus } from "../read/status.ts";
import { netGate } from "../gitgate.ts";
import type { Identity } from "../db.ts";
import { ok, fail, type ActionResult } from "../contract.ts";
import { classify } from "./sync.ts";

// ── remotes (add / set-url / remove — local config only, no network) ────────────────

/**
 * Point a remote (default `origin`) at `url`: add it if absent, else update its URL. This is a
 * pure `.git/config` edit — no network — so it's the missing piece that lets a `git init`-from-
 * the-phone repo gain a remote and become pushable. The caller validates the URL scheme; `--`
 * isn't used (remote subcommands take fixed positional args), but the URL is passed as one arg
 * (parameterized, never a shell string) so it can't inject.
 */
export async function gitRemoteSet(absPath: string, name: string, url: string): Promise<ActionResult> {
  try {
    const git = gitFor(absPath);
    const remotes = await git.getRemotes();
    if (remotes.some((r) => r.name === name)) await git.raw(["remote", "set-url", name, url]);
    else await git.raw(["remote", "add", name, url]);
    return ok("remote saved");
  } catch (err) {
    return classify(err);
  }
}

/** Remove a remote (default `origin`). Local config only. */
export async function gitRemoteRemove(absPath: string, name: string): Promise<ActionResult> {
  try {
    await gitFor(absPath).raw(["remote", "remove", name]);
    return ok("remote removed");
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (low.includes("no such remote")) return fail("NO_REMOTE", `no remote named ${name}`);
    return classify(err);
  }
}

// ── tags ────────────────────────────────────────────────────────────────────────────

/**
 * Create a tag — "tag a release from your phone". Annotated (`-a -m`, identity-attributed) when a
 * message is given, else lightweight. Creating a tag is a local, safe ref write. When `push` is
 * set the tag is then pushed to origin (network → identity SSH key + `netGate`); a push failure is
 * reported but the LOCAL tag is kept (honest partial result, nothing lost). The caller validates
 * that this is a git repo; the name is validated here with the shared ref-name check.
 */
export async function gitTagCreate(
  absPath: string,
  identity: Identity | null,
  name: string,
  message?: string,
  push = false,
): Promise<ActionResult> {
  if (!isValidBranchName(name)) return fail("INVALID_REF_NAME", "invalid tag name");
  try {
    const git = gitFor(absPath);
    const msg = (message ?? "").trim();
    // `--` separates the tag name so one starting with a dash can't be read as a flag.
    const args = [...identityConfigArgs(identity), "tag", ...(msg ? ["-a", "-m", msg] : []), "--", name];
    await git.raw(args);
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (low.includes("already exists")) return fail("EXISTS", `tag already exists: ${name}`);
    return classify(err);
  }
  if (push) {
    try {
      await netGate.run(() => gitFor(absPath).raw([...identityConfigArgs(identity), "push", "origin", name]));
    } catch (err) {
      const c = classify(err);
      return fail(c.code, `tag created locally, but push failed: ${c.message}`);
    }
  }
  return ok(push ? "tag created and pushed" : "tag created");
}

// ── branches ──────────────────────────────────────────────────────────────────────

/** Branch names we refuse to delete from the phone (a slip is too costly). */
const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

/**
 * A conservative branch-name check (a subset of `git check-ref-format`) so a crafted name
 * can never inject a flag or a path. Rejects whitespace, the git-special characters
 * (`~^:?*[\`), control bytes, `..`, `@{`, leading/trailing dot or slash, `//`, and `.lock`.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 255) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: git ref rules forbid control chars (\x00-\x1f, \x7f) in branch names — rejecting them here is intentional validation.
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return false;
  if (name.startsWith(".") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.startsWith("-")) return false; // git refuses a leading dash (also avoids flag injection)
  if (name === "@") return false;
  return true;
}

/**
 * Switch to an existing branch. Guarded exactly like pull: refused on a dirty working
 * tree ("resolve at your desk") so a checkout can never carry changes into a conflict.
 * Uses `git switch`, which refuses to silently detach onto a remote-tracking ref (it will
 * dwim-create a local tracking branch for an unambiguous `origin/<name>`, which is safe).
 */
export async function gitCheckout(absPath: string, branch: string): Promise<ActionResult> {
  if (!isValidBranchName(branch)) return fail("INVALID_REF_NAME", "invalid branch name");
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.dirty > 0) {
    return fail("DIRTY_WORKING_TREE", "working tree has uncommitted changes — stash or resolve at your desk");
  }
  if (pre.branch === branch) return ok("already on branch");
  try {
    await gitFor(absPath).raw(["switch", branch]);
    return ok(`switched to ${branch}`);
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (low.includes("did not match") || low.includes("invalid reference") || low.includes("not a commit") || low.includes("could not find") || low.includes("unknown")) {
      return fail("NOT_FOUND", `branch not found: ${branch}`);
    }
    return classify(err);
  }
}

/**
 * Create a new branch from the current HEAD. Creating a branch never touches the working
 * tree, so it is safe even on a dirty tree — and creating-and-switching to a brand-new
 * branch at the same commit can't conflict either, so `switchTo` is allowed regardless of
 * dirtiness (the uncommitted changes simply carry over).
 */
export async function gitCreateBranch(
  absPath: string,
  name: string,
  switchTo = true,
): Promise<ActionResult> {
  if (!isValidBranchName(name)) return fail("INVALID_REF_NAME", "invalid branch name");
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.detached || !pre.branch) return fail("DETACHED_HEAD", "detached HEAD — resolve at your desk");
  try {
    // `switch -c` creates + checks out; `branch` creates without switching. Both fail if the
    // name already exists (git: "already exists").
    await gitFor(absPath).raw(switchTo ? ["switch", "-c", name] : ["branch", name]);
    return ok(switchTo ? `created and switched to ${name}` : `created ${name}`);
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (low.includes("already exists")) return fail("BRANCH_EXISTS", `branch already exists: ${name}`);
    return classify(err);
  }
}

/**
 * Delete a LOCAL branch — safe-delete only (`-d`, which git refuses for an unmerged branch),
 * never the force `-D`. Refuses the currently checked-out branch and the protected set
 * (main/master/develop/trunk). An unmerged branch surfaces UNMERGED_BRANCH so the UI can
 * say "not fully merged — delete at your desk" rather than silently force-deleting.
 */
export async function gitDeleteBranch(absPath: string, name: string): Promise<ActionResult> {
  if (!isValidBranchName(name)) return fail("INVALID_REF_NAME", "invalid branch name");
  if (PROTECTED_BRANCHES.has(name)) return fail("PROTECTED_BRANCH", `refusing to delete protected branch: ${name}`);
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.branch === name) return fail("CANNOT_DELETE_CURRENT", "cannot delete the current branch");
  try {
    await gitFor(absPath).raw(["branch", "-d", name]);
    return ok(`deleted ${name}`);
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (low.includes("not fully merged")) {
      return fail("UNMERGED_BRANCH", `'${name}' is not fully merged — delete at your desk`);
    }
    if (low.includes("not found")) return fail("NOT_FOUND", `branch not found: ${name}`);
    return classify(err);
  }
}

// ── stash ───────────────────────────────────────────────────────────────────────────

const stashRef = (index: number): string => `stash@{${Math.max(0, Math.floor(index))}}`;

/**
 * Stash the working tree (including untracked files) — the phone-side escape from the
 * "dirty tree blocks pull" dead-end: stash → pull → pop. Always safe (a save can never
 * conflict). Refuses a clean tree (nothing to stash). Attributed to the repo's identity so
 * the stash commit objects carry the right author.
 */
export async function gitStashSave(
  absPath: string,
  identity: Identity | null,
  message?: string,
): Promise<ActionResult> {
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.dirty === 0) return fail("NOTHING_TO_STASH", "nothing to stash — working tree is clean");
  try {
    const args = [...identityConfigArgs(identity), "stash", "push", "--include-untracked"];
    const msg = (message ?? "").trim();
    if (msg) args.push("-m", msg);
    await gitFor(absPath).raw(args);
    return ok("stashed");
  } catch (err) {
    return classify(err);
  }
}

/**
 * Pop a stash entry (default the newest) back onto a CLEAN working tree. Refused on a dirty
 * tree so the apply starts from a known-good state. If the apply conflicts, git leaves the
 * stash entry intact (it only drops on a clean apply) — so nothing is ever lost; we report
 * STASH_CONFLICT ("applied with conflicts — resolve at your desk") and the post-action
 * refresh shows the now-dirty tree. HEAD is never touched, so there is no half-merged commit.
 */
export async function gitStashPop(absPath: string, index = 0): Promise<ActionResult> {
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.dirty > 0) {
    return fail("DIRTY_WORKING_TREE", "working tree has uncommitted changes — commit or stash them first");
  }
  try {
    await gitFor(absPath).raw(["stash", "pop", stashRef(index)]);
    return ok("stash popped");
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (low.includes("no stash entries") || low.includes("is not a valid reference") || low.includes("does not exist")) {
      return fail("STASH_EMPTY", "no such stash entry");
    }
    if (low.includes("conflict")) {
      return fail("STASH_CONFLICT", "stash applied with conflicts — resolve at your desk (the stash was kept)");
    }
    return classify(err);
  }
}

/** Drop a stash entry (default the newest). Irreversible — the UI confirms first. */
export async function gitStashDrop(absPath: string, index = 0): Promise<ActionResult> {
  try {
    await gitFor(absPath).raw(["stash", "drop", stashRef(index)]);
    return ok("stash dropped");
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (low.includes("no stash entries") || low.includes("is not a valid reference") || low.includes("does not exist")) {
      return fail("STASH_EMPTY", "no such stash entry");
    }
    return classify(err);
  }
}
