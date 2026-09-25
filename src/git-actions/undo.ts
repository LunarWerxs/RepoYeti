/**
 * Undo / redo the last git action, driven entirely by the HEAD reflog.
 *
 * WHY THE REFLOG: a wrong tap on a phone (commit, pull, branch switch) and an unattended Scheduled
 * auto-commit both leave the same trace git already keeps for every HEAD move. Reading that trace,
 * instead of keeping a RepoYeti-side history, means undo also covers things done outside the app
 * (a commit from the terminal is just as undoable) and there is no second record to drift.
 *
 * The walk follows lazygit's reflog grammar (pkg/gui/controllers/undo_controller.go, MIT, idea
 * only, written fresh): entries newest-first become CHECKOUT / COMMIT / MOVE steps, and every undo
 * or redo tags its own reflog entry through GIT_REFLOG_ACTION so the next press counts past its
 * own steps instead of undoing the undo.
 *
 * WHERE THIS DELIBERATELY DIFFERS FROM LAZYGIT: lazygit undoes with `reset --hard` plus an
 * auto-stash. RepoYeti never runs `reset --hard` (docs/ARCHITECTURE.md, the "never" row), so:
 *  - a commit is undone with `reset --soft`: HEAD steps back and the commit's changes stay staged,
 *    so nothing ever leaves the working tree;
 *  - a pull / merge / external reset is undone with `reset --keep`, which git itself aborts (and
 *    we report WOULD_OVERWRITE) rather than touch a file that has uncommitted edits;
 *  - a branch switch is undone with a plain `git switch` back, which carries or refuses edits
 *    exactly like the dashboard's own checkout;
 *  - a commit that already exists on a remote is refused, because taking it back locally would
 *    leave a history only a force-push could publish;
 *  - anything the grammar does not recognise (rebase, cherry-pick, revert, am, the first commit)
 *    is a barrier: the step is refused with "undo it at your desk" instead of being skipped. Lazygit
 *    skips unknown entries, which lets the NEXT undo reset straight past them and drop their work.
 */
import { gitFor } from "../git.ts";
import { readStatus } from "../read/status.ts";
import { ok, fail, type ActionResult } from "../contract.ts";
import { classify } from "./sync.ts";
import { isValidBranchName } from "./refs.ts";

/** Reflog tags our own steps carry, so a later walk can tell them from the user's actions. */
export const UNDO_REFLOG_TAG = "[repoyeti undo]";
export const REDO_REFLOG_TAG = "[repoyeti redo]";

/** How far back one press will look. Past this the answer is "nothing to undo", not a slow walk. */
const REFLOG_WINDOW = 200;

/** One HEAD reflog entry, newest-first: the commit HEAD moved TO, and git's reflog subject. */
export interface ReflogEntry {
  hash: string;
  subject: string;
}

/**
 * One undoable step. `checkout` moves between branch names; `commit` and `move` move the current
 * branch between commit hashes (`commit` keeps its changes staged on undo, `move` uses --keep).
 * `barrier` is an entry this module will not reverse; `subject` says which.
 */
export interface UndoStep {
  kind: "checkout" | "commit" | "move" | "barrier";
  /** Where HEAD was before the step: a branch name for checkout, a commit hash otherwise. */
  from: string;
  /** Where the step left HEAD. */
  to: string;
  /** The reflog subject that produced this step, verbatim (e.g. "commit: fix typo"). */
  subject: string;
}

/** A resolved undo or redo: the step it would take, or the reason it would not. */
export interface UndoPlan extends ActionResult {
  step?: UndoStep;
}

export type UndoDirection = "undo" | "redo";

/** Turn one reflog entry into a step (null = not a step: our own tag, or a no-op move). */
function stepFor(entry: ReflogEntry, prevHash: string): UndoStep | null {
  const s = entry.subject;
  const checkout = /^checkout: moving from (\S+) to (\S+)/.exec(s);
  if (checkout) return { kind: "checkout", from: checkout[1]!, to: checkout[2]!, subject: s };
  // `commit (initial)` has no earlier HEAD to return to, so it falls through to the barrier below.
  if (/^commit( \((amend|merge)\))?:/.test(s) && prevHash) {
    return { kind: "commit", from: prevHash, to: entry.hash, subject: s };
  }
  if (/^(pull|merge |reset: moving to )/.test(s) && prevHash) {
    return { kind: "move", from: prevHash, to: entry.hash, subject: s };
  }
  return { kind: "barrier", from: prevHash, to: entry.hash, subject: s };
}

/**
 * Pick the step an undo (or redo) press acts on, from the reflog newest-first. Pure: the whole
 * grammar lives here so it can be pinned without a repository.
 *
 * `counter` tracks how many user steps are currently undone: each undo tag adds one, each redo
 * tag removes one, and walking past a user step consumes one. Undo acts on the first step reached
 * with nothing left undone above it (counter 0); redo acts on the most recently undone step
 * (counter 1) and has nothing to do when the counter is already 0.
 */
export function pickStep(entries: ReflogEntry[], direction: UndoDirection): UndoStep | null {
  let counter = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.subject.startsWith(UNDO_REFLOG_TAG)) {
      counter++;
      continue;
    }
    if (entry.subject.startsWith(REDO_REFLOG_TAG)) {
      counter--;
      continue;
    }
    const step = stepFor(entry, entries[i + 1]?.hash ?? "");
    // A move from somewhere to the same place changed nothing a user could want back.
    if (!step || (step.kind !== "barrier" && step.from === step.to)) continue;
    if (direction === "undo" && counter === 0) return step;
    if (direction === "redo") {
      if (counter <= 0) return null;
      if (counter === 1) return step;
    }
    counter--;
  }
  return null;
}

/** HEAD's reflog, newest-first, bounded. An absent reflog is an empty list, not an error. */
export async function readHeadReflog(absPath: string, limit = REFLOG_WINDOW): Promise<ReflogEntry[]> {
  let out: string;
  try {
    out = await gitFor(absPath).raw(["log", "-g", `-n${limit}`, "--format=%H%x09%gs", "HEAD", "--"]);
  } catch {
    return [];
  }
  const entries: ReflogEntry[] = [];
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    entries.push({ hash: line.slice(0, tab).trim(), subject: line.slice(tab + 1).trim() });
  }
  return entries;
}

const isHash = (s: string): boolean => /^[0-9a-f]{7,64}$/i.test(s);
const short = (h: string): string => (isHash(h) ? h.slice(0, 7) : h);

/**
 * Resolve what an undo or redo press would do right now, with every guard applied, without
 * touching anything. The same function gates the real run, so the dashboard's confirm dialog
 * never promises a step the run would then refuse.
 */
export async function planUndoRedo(absPath: string, direction: UndoDirection): Promise<UndoPlan> {
  const pre = await readStatus(absPath);
  if (pre.error) return fail("ERROR", pre.error);
  if (pre.gitOperation || pre.conflicted) {
    return fail("OPERATION_IN_PROGRESS", "a merge, rebase or similar is in progress - finish or abort it at your desk first");
  }
  const step = pickStep(await readHeadReflog(absPath), direction);
  if (!step) return fail("NOTHING_TO_UNDO", direction === "undo" ? "nothing to undo" : "nothing to redo");
  const refuse = (message: string): UndoPlan => ({ ...fail("UNDO_REFUSED", message), step });
  if (step.kind === "barrier") return refuse(`the last change was "${step.subject}" - undo it at your desk`);

  const target = direction === "undo" ? step.from : step.to;
  const expected = direction === "undo" ? step.to : step.from;
  if (step.kind === "checkout") {
    if (pre.detached || pre.branch !== expected) return refuse(`HEAD is no longer on ${expected} - nothing was changed`);
    // A hash here means that side of the switch was a detached HEAD; returning there would detach.
    if (isHash(target) || !isValidBranchName(target)) {
      return { ...fail("DETACHED_HEAD", `returning to ${short(target)} would detach HEAD - resolve at your desk`), step };
    }
    return { ...ok(`${direction === "undo" ? "switch back" : "switch again"} to ${target}`), step };
  }

  if (pre.detached || !pre.branch) return { ...fail("DETACHED_HEAD", "detached HEAD - resolve at your desk"), step };
  const git = gitFor(absPath);
  const head = (await git.raw(["rev-parse", "HEAD"])).trim();
  if (head !== expected) return refuse("the branch has moved since that step - nothing was changed");
  if (direction === "undo" && step.kind === "commit") {
    // A commit a remote already has cannot be taken back without a force-push to match it.
    const published = (await git.raw(["branch", "-r", "--contains", step.to])).trim();
    if (published) return refuse(`that commit is already pushed (${published.split("\n")[0]!.trim()}) - revert it at your desk instead`);
  }
  const verb = direction === "undo" ? "move" : "move forward";
  return { ...ok(`${verb} ${pre.branch} to ${short(target)} (${step.subject})`), step };
}

/**
 * Run the undo or redo that planUndoRedo resolves. Callers serialise this through the per-repo
 * op-queue (service/actions.ts), so the plan cannot go stale between the check and the write.
 */
export async function gitUndoRedo(absPath: string, direction: UndoDirection): Promise<ActionResult> {
  const plan = await planUndoRedo(absPath, direction);
  if (!plan.ok || !plan.step) return { ok: plan.ok, code: plan.code, message: plan.message };
  const step = plan.step;
  const target = direction === "undo" ? step.from : step.to;
  // The tag is what lets the next press see this step as ours and count past it.
  const git = gitFor(absPath, undefined, {
    GIT_REFLOG_ACTION: direction === "undo" ? UNDO_REFLOG_TAG : REDO_REFLOG_TAG,
  });
  try {
    if (step.kind === "checkout") {
      await git.raw(["switch", target]);
    } else {
      // `target` is a hash read back from the reflog, never caller input, so it cannot be a flag.
      await git.raw(["reset", step.kind === "commit" ? "--soft" : "--keep", target]);
    }
  } catch (err) {
    const low = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    // `reset --keep` refusing to touch an edited file: nothing moved, same advice as a pull.
    if (low.includes("not uptodate") || low.includes("could not reset")) {
      return fail("WOULD_OVERWRITE", "your uncommitted changes would be overwritten; commit or stash them first");
    }
    return classify(err);
  }
  return ok(`${direction === "undo" ? "undid" : "redid"}: ${step.subject}`);
}
