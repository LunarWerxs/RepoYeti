/**
 * Regression tests for the bug that made pushing a large repo look permanently broken.
 *
 * `simple-git`'s `timeout.block` is an IDLE timer, and git suppresses transfer progress when
 * stderr is not a TTY. So a healthy push that went quiet during "Writing objects" was killed at
 * 30s, and classify() then reported EVERY timeout as SSH_PASSPHRASE_REQUIRED — on an https remote,
 * with a passphrase-free key, which named a cause that could not exist. Two failures, one message.
 *
 * Locked down here: (1) a timeout is reported as what it is, and only claims a passphrase when a
 * prompt was genuinely reachable; (2) the real error survives the progress output `--progress` now
 * produces; (3) every remote op keeps the `--progress` + NET_BLOCK_MS pairing that stops the
 * premature kill in the first place.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { classify, classifyRemote, isSshUrl } from "../src/git-actions/sync.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import type { Identity } from "../src/db.ts";

const BLOCK_TIMEOUT = new Error("block timeout reached");

test("a timeout is NETWORK_TIMEOUT, not a phantom SSH passphrase", () => {
  const r = classify(BLOCK_TIMEOUT);
  expect(r.ok).toBe(false);
  expect(r.code).toBe("NETWORK_TIMEOUT");
  // The old message sent the owner to ssh-agent for an https push. It must not do that any more.
  expect(r.message.toLowerCase()).not.toContain("passphrase");
  expect(r.message.toLowerCase()).not.toContain("ssh-agent");
});

test("a timeout DOES name the passphrase when a prompt was actually reachable", () => {
  const r = classify(BLOCK_TIMEOUT, { couldPromptForPassphrase: true });
  expect(r.code).toBe("SSH_PASSPHRASE_REQUIRED");
  expect(r.message).toContain("ssh-agent");
});

test("git's real verdict survives the --progress output that now precedes it", () => {
  // Shape of a failing push once `--progress` is on: progress first, diagnosis last.
  const stderr = [
    "Enumerating objects: 1284, done.",
    "Counting objects:  100% (1284/1284), done.",
    "Compressing objects:  73% (900/1233)\rCompressing objects: 100% (1233/1233), done.",
    "Writing objects:  46% (591/1284), 12.41 MiB | 2.10 MiB/s",
    "remote: error: hook declined to update refs/heads/main",
    "! [remote rejected] main -> main (hook declined)",
  ].join("\n");
  const r = classify(new Error(stderr));
  expect(r.code).toBe("ERROR");
  expect(r.message).toBe("remote: error: hook declined to update refs/heads/main");
  // Specifically NOT the progress bar that happens to be line 1.
  expect(r.message).not.toContain("Enumerating");
});

test("progress is skipped even when git's verdict carries no fatal/error prefix", () => {
  const stderr = [
    "Enumerating objects: 12, done.",
    "Writing objects:  50% (6/12), 1.02 MiB | 900.00 KiB/s",
    "Total 12 (delta 3), reused 0 (delta 0)",
    " ! [rejected]        main -> main (stale info)",
  ].join("\n");
  expect(classify(new Error(stderr)).message).toBe("! [rejected]        main -> main (stale info)");
});

test("a plain fatal with no progress noise is still reported verbatim", () => {
  const r = classify(new Error("fatal: repository 'https://example.invalid/x.git' not found\n"));
  expect(r.message).toBe("fatal: repository 'https://example.invalid/x.git' not found");
});

// ── which transport was actually in play ────────────────────────────────────────────

test("isSshUrl tells an SSH remote from every other transport", () => {
  expect(isSshUrl("git@github.com:Lunarwerx/connections.git")).toBe(true);
  expect(isSshUrl("ssh://git@github.com/Lunarwerx/connections.git")).toBe(true);
  expect(isSshUrl("https://github.com/Lunarwerx/connections.git")).toBe(false);
  expect(isSshUrl("http://example.invalid/x.git")).toBe(false);
  expect(isSshUrl("file:///srv/repos/x.git")).toBe(false);
  // A Windows path is not a scp-like URL, even though it also has a colon.
  expect(isSshUrl("D:/PublicProjects/RepoYeti")).toBe(false);
});

/** A scratch repo whose `origin` points at `url` (never contacted — only its shape is read). */
async function repoWithRemote(url: string): Promise<string> {
  const dir = mkScratchDir("gm-net-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  await $`git -C ${dir} remote add origin ${url}`.quiet();
  return dir;
}

const WITH_KEY: Identity = {
  id: "k",
  displayName: "K",
  gitUsername: "K",
  gitEmail: "k@k.io",
  sshKeyPath: "C:/does/not/need/to/exist",
};

test("a timeout on an https remote never blames the passphrase", async () => {
  const dir = await repoWithRemote("https://github.com/Lunarwerx/connections.git");
  expect((await classifyRemote(dir, null, BLOCK_TIMEOUT)).code).toBe("NETWORK_TIMEOUT");
});

test("a timeout on an SSH remote with no identity key CAN be a passphrase prompt", async () => {
  const dir = await repoWithRemote("git@github.com:Lunarwerx/connections.git");
  expect((await classifyRemote(dir, null, BLOCK_TIMEOUT)).code).toBe("SSH_PASSPHRASE_REQUIRED");
});

test("the same SSH remote with an identity key cannot: BatchMode makes ssh fail fast", async () => {
  const dir = await repoWithRemote("git@github.com:Lunarwerx/connections.git");
  expect((await classifyRemote(dir, WITH_KEY, BLOCK_TIMEOUT)).code).toBe("NETWORK_TIMEOUT");
});

test("a repo with no remote at all still classifies a timeout, it does not throw", async () => {
  const dir = mkScratchDir("gm-net-bare-");
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  expect((await classifyRemote(dir, null, BLOCK_TIMEOUT)).code).toBe("NETWORK_TIMEOUT");
});

test("a path that isn't a repo at all can't reveal a transport, so it stays a plain timeout", async () => {
  expect((await classifyRemote(mkScratchDir("gm-net-norepo-"), null, BLOCK_TIMEOUT)).code).toBe(
    "NETWORK_TIMEOUT",
  );
  // And a folder deleted out from under the daemon must not turn a timeout into a thrown error.
  const gone = join(mkScratchDir("gm-net-gone-"), "vanished");
  expect((await classifyRemote(gone, null, BLOCK_TIMEOUT)).code).toBe("NETWORK_TIMEOUT");
});

test("a non-timeout failure skips the transport lookup entirely", async () => {
  const dir = await repoWithRemote("git@github.com:Lunarwerx/connections.git");
  const r = await classifyRemote(dir, null, new Error("fatal: Authentication failed for 'x'"));
  expect(r.code).toBe("SSH_AUTH_FAILED");
});

// ── the pairing that prevents the kill ──────────────────────────────────────────────
// `--progress` and NET_BLOCK_MS only work together: the budget is an idle timer, so without the
// flag git's own silence trips it. A future remote op added without both re-opens this bug, so
// assert the shape at the source rather than waiting to be bitten by it again.
test("every remote git op passes --progress with the network idle budget", () => {
  const root = join(import.meta.dir, "..");
  const sync = readFileSync(join(root, "src/git-actions/sync.ts"), "utf8");
  const refs = readFileSync(join(root, "src/git-actions/refs.ts"), "utf8");

  for (const verb of ['"fetch"', '"pull"', '"push"', '"clone"']) {
    // The arg array containing the verb must also carry the progress flag.
    const arrays = sync.match(/\.raw\(\[[\s\S]*?\]\)/g) ?? [];
    const withVerb = arrays.filter((a) => a.includes(verb));
    expect(withVerb.length).toBeGreaterThan(0);
    for (const a of withVerb) expect(a).toContain("PROGRESS_ARG");
  }
  // Nothing on a network path may fall back to gitFor()'s 30s local default.
  expect(sync).not.toMatch(/gitFor\(absPath, undefined/);
  expect(sync.match(/gitFor\(absPath, NET_BLOCK_MS/g)?.length).toBe(3); // fetch, pull, push
  expect(refs).toContain("gitFor(absPath, NET_BLOCK_MS)"); // the one network op in refs.ts (tag push)
});
