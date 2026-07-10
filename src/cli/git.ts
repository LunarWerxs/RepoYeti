/**
 * Command-line git verbs that drive the ALREADY-RUNNING local daemon over its HTTP API.
 *
 * Every verb here is a thin client call (src/cli/client.ts) + a pretty-print — it NEVER imports
 * the in-process service/read/git-actions/vcs layers (check-boundaries.ts enforces this). The
 * daemon owns all the git work; the CLI just asks it over loopback HTTP and renders the answer.
 *
 * Response shapes are mirrored locally (the read-layer types they correspond to live in
 * src/read/* and src/service/*, which the CLI is forbidden to import) — kept minimal, only the
 * fields these verbs render.
 */
import { get, post, resolveRepo, ApiError } from "./client.ts";
import { printTable, relativeTime, bold, dim, red, green, yellow, cyan } from "./format.ts";
import type { RepoView } from "../db.ts";

// ── response shapes (subset; mirror src/read/* + src/service/*) ────────────────────────────

interface ActionResult {
  ok: boolean;
  code: string;
  message: string;
}
interface LogEntry {
  shortHash: string;
  subject: string;
  authorName: string;
  date: number;
  isMerge: boolean;
}
interface LogResult {
  commits: LogEntry[];
  hasMore: boolean;
}
interface BranchInfo {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
}
interface BranchList {
  current: string | null;
  detached: boolean;
  branches: BranchInfo[];
}
interface StashEntry {
  index: number;
  message: string;
  date: number;
}
interface StashList {
  stashes: StashEntry[];
}
interface FileDiffResult {
  mode: "patch" | "models";
  patch?: string;
  original?: string;
  modified?: string;
  binary?: boolean;
  truncated?: boolean;
}

// ── tiny arg walker ────────────────────────────────────────────────────────────────────────

interface ParsedArgs {
  /** Positional args, in order. */
  pos: string[];
  /** Flags: --foo bar → flags.foo = "bar"; --foo (no value) → flags.foo = true. */
  flags: Record<string, string | true>;
}

/** Parse `args` into positionals + flags. A flag that's followed by a non-flag token takes it as
 *  its value (`--limit 20`); a bare flag at the end or before another flag is boolean (`--switch`). */
function parseArgs(args: string[]): ParsedArgs {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a.startsWith("-") && a.length === 2) {
      // short flag (e.g. -m <msg>) — always takes the next token as its value.
      const key = a.slice(1);
      const next = args[i + 1];
      if (next !== undefined) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

/** Require the first positional as the repo arg; print usage + throw a UsageError if missing. */
function requireRepoArg(pos: string[], usage: string): string {
  const repo = pos[0];
  if (!repo) throw new UsageError(usage);
  return repo;
}

/** A usage error — printed without the "✗ CODE:" prefix (it's a CLI-usage problem, not an API one). */
class UsageError extends Error {}

// ── formatting helpers ───────────────────────────────────────────────────────────────────────

/** A compact "↑2 ↓1" ahead/behind badge (empty when both are 0). */
function aheadBehind(ahead: number, behind: number): string {
  const parts: string[] = [];
  if (ahead > 0) parts.push(green(`↑${ahead}`));
  if (behind > 0) parts.push(yellow(`↓${behind}`));
  return parts.join(" ");
}

// ── verbs ────────────────────────────────────────────────────────────────────────────────────

async function reposVerb(): Promise<void> {
  const { repos } = await get<{ repos: RepoView[] }>("/api/repos");
  if (repos.length === 0) {
    console.log(dim("No repos indexed yet."));
    return;
  }
  const rows = repos.map((r) => {
    const s = r.status;
    return [
      bold(r.name),
      s?.branch ?? (s?.detached ? "(detached)" : "?"),
      s?.dirty ? yellow(`~${s.dirty}`) : dim("clean"),
      aheadBehind(s?.ahead ?? 0, s?.behind ?? 0),
      dim(r.vcs),
    ];
  });
  printTable(["NAME", "BRANCH", "DIRTY", "AHEAD/BEHIND", "VCS"], rows);
}

async function statusVerb(pos: string[]): Promise<void> {
  const repoArg = requireRepoArg(pos, "usage: repoyeti status <repo>");
  const repo = await resolveRepo(repoArg);
  const s = repo.status;
  console.log(bold(repo.name) + dim(`  (${repo.absPath})`));
  if (!s) {
    console.log(dim("  (no status yet)"));
    return;
  }
  if (s.error) {
    console.log(`  ${red("error")}: ${s.error}`);
    return;
  }
  const branch = s.detached ? `${s.branch ?? "HEAD"} ${dim("(detached)")}` : (s.branch ?? "?");
  console.log(`  branch:  ${branch}`);
  console.log(`  dirty:   ${s.dirty ? yellow(`${s.dirty} file(s)`) : green("clean")}`);
  const ab = aheadBehind(s.ahead, s.behind);
  console.log(`  sync:    ${ab || green("in sync")}`);
  console.log(`  remote:  ${s.remote ?? dim("(none)")}`);
}

async function logVerb(pos: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const repoArg = requireRepoArg(pos, "usage: repoyeti log <repo> [--limit N] [--merges only|exclude]");
  const repo = await resolveRepo(repoArg);
  const params = new URLSearchParams();
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : NaN;
  if (Number.isFinite(limit) && limit > 0) params.set("limit", String(Math.floor(limit)));
  const merges = flags.merges;
  if (merges === "only" || merges === "exclude") params.set("merges", merges);
  const qs = params.toString();
  const { commits } = await get<LogResult>(`/api/repos/${repo.id}/log${qs ? `?${qs}` : ""}`);
  if (commits.length === 0) {
    console.log(dim("No commits."));
    return;
  }
  const rows = commits.map((c) => [
    cyan(c.shortHash),
    c.isMerge ? yellow("(M)") : "",
    c.subject,
    dim(c.authorName),
    dim(relativeTime(c.date)),
  ]);
  printTable(["HASH", "", "SUBJECT", "AUTHOR", "WHEN"], rows);
}

async function branchesVerb(pos: string[]): Promise<void> {
  const repoArg = requireRepoArg(pos, "usage: repoyeti branches <repo>");
  const repo = await resolveRepo(repoArg);
  const list = await get<BranchList>(`/api/repos/${repo.id}/branches`);
  if (list.branches.length === 0) {
    console.log(dim("No branches."));
    return;
  }
  const rows = list.branches.map((b) => [
    b.current ? green("*") : " ",
    b.current ? bold(b.name) : b.name,
    aheadBehind(b.ahead, b.behind),
    b.gone ? red("(gone)") : b.upstream ? dim(b.upstream) : dim("(no upstream)"),
  ]);
  printTable(["", "BRANCH", "AHEAD/BEHIND", "UPSTREAM"], rows);
}

async function branchVerb(pos: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const repoArg = requireRepoArg(pos, "usage: repoyeti branch <repo> <name> [--switch]");
  const name = pos[1];
  if (!name) throw new UsageError("usage: repoyeti branch <repo> <name> [--switch]");
  const repo = await resolveRepo(repoArg);
  const r = await post<ActionResult>(`/api/repos/${repo.id}/branch`, {
    name,
    switch: flags.switch === true || flags.switch === "true",
  });
  console.log(`${green("✓")} ${r.message}`);
}

async function checkoutVerb(pos: string[]): Promise<void> {
  const repoArg = requireRepoArg(pos, "usage: repoyeti checkout <repo> <branch>");
  const branch = pos[1];
  if (!branch) throw new UsageError("usage: repoyeti checkout <repo> <branch>");
  const repo = await resolveRepo(repoArg);
  const r = await post<ActionResult>(`/api/repos/${repo.id}/checkout`, { branch });
  console.log(`${green("✓")} ${r.message}`);
}

async function commitVerb(pos: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const repoArg = requireRepoArg(pos, "usage: repoyeti commit <repo> -m <msg> [--amend]");
  const message = typeof flags.m === "string" ? flags.m : typeof flags.message === "string" ? flags.message : "";
  if (!message.trim()) throw new UsageError("usage: repoyeti commit <repo> -m <msg> [--amend]");
  const repo = await resolveRepo(repoArg);
  const r = await post<ActionResult>(`/api/repos/${repo.id}/commit`, {
    message,
    amend: flags.amend === true || flags.amend === "true",
  });
  console.log(`${green("✓")} ${r.message}`);
}

async function diffVerb(pos: string[]): Promise<void> {
  const repoArg = requireRepoArg(pos, "usage: repoyeti diff <repo> <path>");
  const path = pos[1];
  if (!path) throw new UsageError("usage: repoyeti diff <repo> <path>");
  const repo = await resolveRepo(repoArg);
  const r = await get<FileDiffResult>(`/api/repos/${repo.id}/diff?path=${encodeURIComponent(path)}`);
  if (r.binary) {
    console.log(dim("(binary file — no text diff)"));
    return;
  }
  if (r.mode === "patch") {
    console.log(r.patch?.trim() ? r.patch : dim("(no changes)"));
  } else {
    // models: print both sides labelled, so the change is visible without a diff engine.
    console.log(dim("── HEAD ──"));
    console.log(r.original ?? "");
    console.log(dim("── working tree ──"));
    console.log(r.modified ?? "");
  }
  if (r.truncated) console.log(dim("…[truncated]"));
}

async function driftVerb(): Promise<void> {
  const { repos } = await get<{ repos: RepoView[] }>("/api/repos");
  const drifted = repos.filter((r) => (r.status?.ahead ?? 0) > 0 || (r.status?.behind ?? 0) > 0);
  if (drifted.length === 0) {
    console.log(green("✓ all in sync"));
    return;
  }
  const rows = drifted.map((r) => [
    bold(r.name),
    r.status?.branch ?? "?",
    aheadBehind(r.status?.ahead ?? 0, r.status?.behind ?? 0),
  ]);
  printTable(["NAME", "BRANCH", "DRIFT"], rows);
}

async function stashVerb(pos: string[]): Promise<void> {
  const repoArg = requireRepoArg(pos, "usage: repoyeti stash <repo> [list|pop|drop]");
  const sub = pos[1];
  const repo = await resolveRepo(repoArg);
  if (!sub || sub === "save") {
    const r = await post<ActionResult>(`/api/repos/${repo.id}/stash`, {});
    console.log(`${green("✓")} ${r.message}`);
    return;
  }
  if (sub === "list") {
    const { stashes } = await get<StashList>(`/api/repos/${repo.id}/stashes`);
    if (stashes.length === 0) {
      console.log(dim("No stashes."));
      return;
    }
    printTable(
      ["INDEX", "MESSAGE", "WHEN"],
      stashes.map((s) => [`stash@{${s.index}}`, s.message, dim(relativeTime(s.date))]),
    );
    return;
  }
  if (sub === "pop" || sub === "drop") {
    const r = await post<ActionResult>(`/api/repos/${repo.id}/stash/${sub}`, {});
    console.log(`${green("✓")} ${r.message}`);
    return;
  }
  throw new UsageError("usage: repoyeti stash <repo> [list|pop|drop]");
}

async function syncVerb(action: "push" | "pull" | "fetch", pos: string[]): Promise<void> {
  const repoArg = requireRepoArg(pos, `usage: repoyeti ${action} <repo>`);
  const repo = await resolveRepo(repoArg);
  const r = await post<ActionResult>(`/api/repos/${repo.id}/${action}`, {});
  console.log(`${green("✓")} ${r.code}: ${r.message}`);
}

// ── dispatcher ─────────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch one git verb. On a thrown ApiError, print "✗ <code>: <message>" to stderr and set
 * process.exitCode = 1; on a usage error, print the usage line and exit 1; on any other error,
 * print its message and exit 1. Never throws to the caller — it's the CLI's top-level handler.
 */
export async function runGitVerb(cmd: string, args: string[]): Promise<void> {
  const { pos, flags } = parseArgs(args);
  try {
    switch (cmd) {
      case "repos":
        await reposVerb();
        break;
      case "status":
        await statusVerb(pos);
        break;
      case "log":
        await logVerb(pos, flags);
        break;
      case "branches":
        await branchesVerb(pos);
        break;
      case "branch":
        await branchVerb(pos, flags);
        break;
      case "checkout":
        await checkoutVerb(pos);
        break;
      case "commit":
        await commitVerb(pos, flags);
        break;
      case "diff":
        await diffVerb(pos);
        break;
      case "drift":
        await driftVerb();
        break;
      case "stash":
        await stashVerb(pos);
        break;
      case "push":
      case "pull":
      case "fetch":
        await syncVerb(cmd, pos);
        break;
      default:
        throw new UsageError(`unknown git verb: ${cmd}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
    } else if (e instanceof ApiError) {
      console.error(red(`✗ ${e.code}: ${e.message}`));
    } else {
      console.error(red(`✗ ${e instanceof Error ? e.message : String(e)}`));
    }
    process.exitCode = 1;
  }
}
