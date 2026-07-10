/**
 * Lore output parsers, locked against REAL `lore 0.8.4` (x86_64-pc-windows-msvc) output
 * captured from a live local repo. These fixtures are the regression guard: if Lore changes
 * its CLI format in a future 0.x release, these tests fail loudly instead of the daemon
 * silently mis-reading status/branches/history. No `lore` binary is needed to run them.
 */
import { describe, it, expect } from "bun:test";
import {
  parseChangedLines,
  parseBranchFromStatus,
  parseBranchList,
  parseHistory,
} from "../src/vcs/lore.ts";

// `lore status --scan` with two new files staged-as-added.
const STATUS_DIRTY = `Repository 019f1234c94274d0b1aa77436ca096a2
On branch main revision 0 -> 0000000000000000000000000000000000000000000000000000000000000000
Untracked files:
A main.py
A readme.txt
Tracked changes: 2 added`;

// `lore status` on a clean tree, post-commit.
const STATUS_CLEAN = `Repository 019f1234c94274d0b1aa77436ca096a2
On branch main revision 1 -> 6694f0b5b5fe9cc7df641c5f2af751a058985abfdde744fb3162b1eb909dd903`;

const BRANCH_LIST = `Local branches:
* main
Warning: Could not query remote branch list`;

const HISTORY = `Revision  : 1
Signature : 6694f0b5b5fe9cc7df641c5f2af751a058985abfdde744fb3162b1eb909dd903
Branch    : e726318bbc3fd75ac8733a7e030cc35b
Date      : Mon, 29 Jun 2026 07:08:15 +0000
    initial commit
Creator   : tester
Committer : tester`;

describe("lore output parsers (fixtures: lore 0.8.4)", () => {
  it("parses changed files, ignoring headers/footers", () => {
    const files = parseChangedLines(STATUS_DIRTY);
    expect(files).toEqual([
      { path: "main.py", status: "A", staged: false },
      { path: "readme.txt", status: "A", staged: false },
    ]);
    // "Repository …", "Untracked files:", "Tracked changes: 2 added" must NOT be files.
    expect(files.some((f) => f.path.includes("019f"))).toBe(false);
  });

  it("reports no changes on a clean tree", () => {
    expect(parseChangedLines(STATUS_CLEAN)).toEqual([]);
  });

  it("extracts the current branch from the status line", () => {
    expect(parseBranchFromStatus(STATUS_DIRTY)).toBe("main");
    expect(parseBranchFromStatus(STATUS_CLEAN)).toBe("main");
    expect(parseBranchFromStatus("Repository abc\n(no branch line)")).toBe(null);
  });

  it("parses the branch list, skipping the header and the remote warning", () => {
    const { current, branches } = parseBranchList(BRANCH_LIST);
    expect(current).toBe("main");
    expect(branches).toEqual([
      { name: "main", current: true, upstream: null, ahead: 0, behind: 0, gone: false },
    ]);
  });

  it("parses a history record into a normalized commit", () => {
    const commits = parseHistory(HISTORY, 10);
    expect(commits).toHaveLength(1);
    const c = commits[0]!;
    expect(c.hash).toBe("6694f0b5b5fe9cc7df641c5f2af751a058985abfdde744fb3162b1eb909dd903");
    expect(c.shortHash).toBe("6694f0b5b5fe");
    expect(c.subject).toBe("initial commit");
    expect(c.authorName).toBe("tester");
    expect(c.authorEmail).toBe("");
    expect(c.date).toBe(Date.parse("Mon, 29 Jun 2026 07:08:15 +0000"));
  });

  it("parses multiple history records and honors the cap", () => {
    const two = `${HISTORY}
Revision  : 0
Signature : 0000000000000000000000000000000000000000000000000000000000000000
Branch    : e726318bbc3fd75ac8733a7e030cc35b
Date      : Mon, 29 Jun 2026 07:00:00 +0000
    root
Creator   : tester`;
    expect(parseHistory(two, 10)).toHaveLength(2);
    expect(parseHistory(two, 1)).toHaveLength(1);
  });
});
