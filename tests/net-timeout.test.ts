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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { classify, classifyRemote, isSshUrl, gitClone } from "../src/git-actions/sync.ts";
import { gitTagCreate } from "../src/git-actions/refs.ts";
import { PROGRESS_ARG, safeGitEnv } from "../src/git.ts";
import { mkScratchDir, fileUrl } from "./helpers/scratch.ts";
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

test("a branch with nothing to push to is NO_UPSTREAM, not a remote or network verdict", () => {
  const r = classify(new Error("fatal: The current branch main has no upstream branch."));
  expect(r.code).toBe("NO_UPSTREAM");
  const configured = classify(new Error("There is no tracking information for the current branch.\nfatal: no upstream configured for branch 'main'"));
  expect(configured.code).toBe("NO_UPSTREAM");
});

test("a credential failure names the account git asked for — and invents none when it can't", () => {
  // The account is in the URL git echoes back: name it, because "signed in but not ACTIVE" is
  // the usual cause and the stock message reads as if the account were signed out entirely.
  const named = classify(
    new Error("fatal: could not read Password for 'https://octocat@github.com': terminal prompts disabled"),
  );
  expect(named.code).toBe("GH_ACCOUNT_NOT_AUTHORIZED");
  expect(named.message).toContain('"octocat"');

  // Nothing to name (git asked for the Username, so there is no `user@host` to quote) → say so
  // plainly rather than putting an empty pair of quotes in front of the owner.
  const anonymous = classify(
    new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
  );
  expect(anonymous.code).toBe("GH_ACCOUNT_NOT_AUTHORIZED");
  expect(anonymous.message).toBe("git needs GitHub credentials and none were available");
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

// ── the ops themselves, over a real (local) transport ───────────────────────────────
// The classifier above is only half the fix. The other half is that every remote op now runs
// `--progress` on the network idle budget, so these drive the real commands over `file://` —
// which, unlike a bare path, makes git use the actual transport instead of hardlinking.

const ID: Identity = {
  id: "t",
  displayName: "T",
  gitUsername: "Tester",
  gitEmail: "t@test.io",
  sshKeyPath: null,
};

/** A repo with one commit. */
async function seedRepo(prefix: string): Promise<string> {
  const dir = mkScratchDir(prefix);
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "f.txt"), "x\n");
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io add -A`.quiet();
  await $`git -C ${dir} -c user.name=S -c user.email=s@s.io commit -q -m init`.quiet();
  return dir;
}

test("--progress is what makes git speak on a pipe — the silence that tripped the idle timer", async () => {
  const src = await seedRepo("gm-net-prog-");
  const parent = mkScratchDir("gm-net-prog-dest-");
  const url = fileUrl(src);

  // Same shape as a daemon's git child: stderr is a pipe, never a TTY.
  const cloneStderr = async (name: string, args: string[]): Promise<string> => {
    const proc = Bun.spawn(["git", "clone", ...args, "--", url, name], {
      cwd: parent,
      env: safeGitEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [err] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return err;
  };

  const silent = await cloneStderr("silent", []);
  const talking = await cloneStderr("talking", [PROGRESS_ARG]);

  // Without the flag git announces the clone and then works in complete silence — which is
  // exactly what let simple-git's IDLE timer fire on a transfer that was doing fine.
  expect(silent).not.toMatch(/\d+% \(\d+\/\d+\)/);
  // With it the transfer narrates itself, so the timer measures real idleness instead of git's
  // non-TTY quiet. (A one-commit repo is enough to prove the stream exists at all.)
  expect(talking).toMatch(/\d+% \(\d+\/\d+\)/);
  expect(talking.length).toBeGreaterThan(silent.length);
});

test("a tag push takes the same pairing and lands the tag on the remote", async () => {
  const bare = mkScratchDir("gm-net-tag-bare-");
  await $`git -c init.defaultBranch=main init -q --bare ${bare}`.quiet();
  const work = await seedRepo("gm-net-tag-");
  await $`git -C ${work} remote add origin ${fileUrl(bare)}`.quiet();
  await $`git -C ${work} push -q origin main`.quiet();

  const r = await gitTagCreate(work, ID, "v9.0.0", "nine", true);
  expect(r.ok).toBe(true);
  expect(r.message).toBe("tag created and pushed");
  expect((await $`git -C ${bare} tag -l`.text()).trim()).toBe("v9.0.0");
});

test("a tag push that fails keeps the local tag and reports git's verdict, not the progress bar", async () => {
  const work = await seedRepo("gm-net-tag-fail-");
  // An origin that exists as a path but is not a repository: the push reaches git and fails
  // there, so the LOCAL tag has already been written when the failure arrives.
  const notARepo = mkScratchDir("gm-net-tag-notrepo-");
  await $`git -C ${work} remote add origin ${fileUrl(notARepo)}`.quiet();

  const r = await gitTagCreate(work, ID, "v9.1.0", undefined, true);
  expect(r.ok).toBe(false);
  expect(r.message.startsWith("tag created locally, but push failed: ")).toBe(true);
  expect(r.message).not.toContain("Enumerating"); // git's diagnosis, never the progress bar
  // Honest partial result: the tag the owner asked for still exists, nothing was rolled back.
  expect((await $`git -C ${work} tag -l`.text()).trim()).toBe("v9.1.0");
});

test("a clone that cannot reach its source is classified, never thrown", async () => {
  const parent = mkScratchDir("gm-net-clone-");
  const r = await gitClone(parent, fileUrl(join(parent, "no-such-repo")), "dest", null);
  expect(r.ok).toBe(false);
  // The clone URL IS the transport here, and it is not SSH — so whatever went wrong, the one
  // thing it cannot be is a passphrase prompt. That claim is the whole point of the fix.
  expect(r.code).not.toBe("SSH_PASSPHRASE_REQUIRED");
  expect(r.message.toLowerCase()).not.toContain("passphrase");
});

test("a clone that fails after git starts talking reports the diagnosis, not 'Cloning into…'", async () => {
  const src = await seedRepo("gm-net-clone-src-");
  const parent = mkScratchDir("gm-net-clone-taken-");
  mkdirSync(join(parent, "taken"));
  writeFileSync(join(parent, "taken", "keep.txt"), "mine\n");

  const r = await gitClone(parent, fileUrl(src), "taken", null);
  expect(r.ok).toBe(false);
  expect(r.message.toLowerCase()).toContain("already exists");
  expect(r.message).not.toContain("Cloning into");
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
