import { describe, expect, it } from "bun:test";
import { preflightBuzz, type BuzzCommandResult } from "../src/buzz.ts";

const ok = (stdout = ""): BuzzCommandResult => ({ code: 0, stdout, stderr: "", timedOut: false, spawnError: false });

// `git config --type=bool --get credential.useHttpPath` normalises every enabled spelling
// (1/yes/on/true, and a bare key) to the literal "true"; the probe must ask Git to do that
// normalisation rather than string-comparing the raw stored token.
const preflightWithHttpPath = (httpPathStdout: string) =>
  preflightBuzz(
    { id: "one", name: "Buzz", url: "https://relay.example", gitUrl: "https://relay.example/git/owner/repo.git" },
    {
      run: async (argv) => {
        if (argv.join(" ") === "git --version") return ok("git version 2.46.0");
        if (argv.includes("--show-origin")) return ok("file:C:/gitconfig\tnostr\n");
        if (argv.includes("credential-nostr")) return ok();
        if (argv.includes("credential.useHttpPath")) return ok(httpPathStdout);
        if (argv.includes("ls-remote")) return ok("deadbeef\trefs/heads/main\n");
        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      },
      fetch: async () => new Response("ok", { status: 200 }),
    },
  );

describe("Buzz credential.useHttpPath boolean handling", () => {
  it("normalises the stored boolean via git instead of requiring the literal token", async () => {
    const result = await preflightWithHttpPath("true\n");
    expect(result.useHttpPath.code).toBe("HTTP_PATH_OK");
    expect(result.authentication.code).toBe("AUTH_OK");
    expect(result.ok).toBe(true);
  });

  it("still rejects an explicitly disabled useHttpPath and skips the auth probe", async () => {
    const result = await preflightWithHttpPath("false\n");
    expect(result.useHttpPath.code).toBe("HTTP_PATH_DISABLED");
    expect(result.authentication.code).toBe("AUTH_PREREQUISITE_FAILED");
  });

  it("asks git to coerce the value with --type=bool so 1/yes/on read back as enabled", async () => {
    const calls: string[][] = [];
    await preflightBuzz(
      { id: "one", name: "Buzz", url: "https://relay.example", gitUrl: "https://relay.example/git/owner/repo.git" },
      {
        run: async (argv) => {
          calls.push([...argv]);
          if (argv.join(" ") === "git --version") return ok("git version 2.46.0");
          if (argv.includes("--show-origin")) return ok("nostr\n");
          if (argv.includes("credential-nostr")) return ok();
          // Emulate a stored `credential.useHttpPath=1` that git's --type=bool normalises to true.
          if (argv.includes("credential.useHttpPath")) {
            expect(argv).toContain("--type=bool");
            return ok("true\n");
          }
          if (argv.includes("ls-remote")) return ok("deadbeef\trefs/heads/main\n");
          throw new Error(`unexpected argv: ${argv.join(" ")}`);
        },
        fetch: async () => new Response("ok"),
      },
    );
    const httpPathCall = calls.find((argv) => argv.includes("credential.useHttpPath"));
    expect(httpPathCall).toEqual(["git", "config", "--type=bool", "--get", "credential.useHttpPath"]);
  });
});
