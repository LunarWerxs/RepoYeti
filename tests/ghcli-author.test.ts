import { expect, spyOn, test } from "bun:test";

import { accountsSnapshot, invalidateAccountsSnapshot, switchGhAccount } from "../src/gh-cli.ts";

/**
 * Regression: switching to the ALREADY-active account with a linked author wrote the new global
 * git author but returned the account snapshot memoized a moment earlier, so the response's
 * `commitIdentity` reported the previous author (and kept doing so for the rest of the 10s
 * SNAPSHOT_TTL_MS window).
 *
 * The `gh`/`git` children are faked so the test is deterministic and never needs a real gh install
 * or a real global git config: Bun.spawn is spied for the duration of the test, and the fake `git`
 * keeps the global author in a local variable, so a read after a write sees the new value the way
 * a real `git config --global` round-trip would.
 */

/** A Bun.spawn-shaped process whose streams carry fixed text and which exits with `code`. */
function fakeProc(stdout: string, stderr: string, code: number): ReturnType<typeof Bun.spawn> {
  const encoder = new TextEncoder();
  const stream = (text: string): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  return {
    stdout: stream(stdout),
    stderr: stream(stderr),
    exited: Promise.resolve(code),
    kill() {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

test("switching to the already-active account returns the freshly applied global author", async () => {
  let authorName = "Old Name";
  let authorEmail = "old@example.com";
  const accountsJson = JSON.stringify({
    hosts: {
      "github.com": [
        { active: true, host: "github.com", login: "octocat", gitProtocol: "https", scopes: "repo" },
      ],
    },
  });

  const originalSpawn = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
    if (cmd[0] === "gh") return fakeProc(accountsJson, "", 0);
    if (cmd[0] === "git") {
      const get = cmd.indexOf("--get");
      if (get >= 0) {
        return fakeProc(get + 1 < cmd.length && cmd[get + 1] === "user.name" ? authorName : authorEmail, "", 0);
      }
      const value = cmd[cmd.length - 1] ?? "";
      if (cmd.includes("user.name")) authorName = value;
      else if (cmd.includes("user.email")) authorEmail = value;
      return fakeProc("", "", 0);
    }
    return fakeProc("", "", 0);
  }) as unknown as typeof Bun.spawn);

  invalidateAccountsSnapshot();
  try {
    const result = await switchGhAccount("github.com", "octocat", {
      name: "New Name",
      email: "new@example.com",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.commitIdentity).toEqual({ name: "New Name", email: "new@example.com" });
    // The memo must be dropped too, not just the returned object: a GET /api/accounts fired
    // immediately after the switch reads the same cache.
    expect((await accountsSnapshot()).commitIdentity).toEqual({
      name: "New Name",
      email: "new@example.com",
    });
  } finally {
    spy.mockRestore();
    Bun.spawn = originalSpawn;
    invalidateAccountsSnapshot();
  }
});
