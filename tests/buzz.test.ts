import { describe, expect, it, test } from "bun:test";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";
import {
  buzzGitUrlMatchesCommunity,
  buzzConfigView,
  normalizeBuzzGitUrl,
  normalizeBuzzPublicUrl,
  parseGitVersion,
  preflightBuzz,
  sanitizeBuzzDiagnostic,
  type BuzzCommandResult,
} from "../src/buzz.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });
const ok = (stdout = ""): BuzzCommandResult => ({ code: 0, stdout, stderr: "", timedOut: false, spawnError: false });

describe("Buzz input and diagnostic boundaries", () => {
  it("parses supported Git versions, including vendor suffixes", () => {
    expect(parseGitVersion("git version 2.46.1.windows.1")).toEqual([2, 46, 1]);
    expect(parseGitVersion("git version 2.46")).toEqual([2, 46, 0]);
    expect(parseGitVersion("not git")).toBeNull();
  });

  it("accepts only public community and Smart HTTP repository URLs", () => {
    expect(normalizeBuzzPublicUrl(" https://relay.example/ ")).toBe("https://relay.example");
    expect(normalizeBuzzPublicUrl("wss://relay.example/events")).toBe("wss://relay.example/events");
    expect(normalizeBuzzPublicUrl("https://relay.example/?token=not-public")).toBe("https://relay.example");
    expect(normalizeBuzzPublicUrl("https://nsec1secret@relay.example")).toBeNull();
    expect(normalizeBuzzPublicUrl("file:///relay")).toBeNull();

    expect(normalizeBuzzGitUrl("https://relay.example/git/owner/repo.git/")).toBe(
      "https://relay.example/git/owner/repo.git",
    );
    expect(normalizeBuzzGitUrl("https://relay.example/git/owner/repo.git?token=not-public")).toBe(
      "https://relay.example/git/owner/repo.git",
    );
    expect(normalizeBuzzGitUrl("https://relay.example/owner/repo.git")).toBeNull();
    expect(normalizeBuzzGitUrl("https://token@relay.example/git/owner/repo.git")).toBeNull();
    expect(
      buzzGitUrlMatchesCommunity(
        "wss://relay.example",
        "https://relay.example/git/owner/repo.git",
      ),
    ).toBe(true);
    expect(
      buzzGitUrlMatchesCommunity(
        "https://relay.example",
        "https://other.example/git/owner/repo.git",
      ),
    ).toBe(false);
  });

  it("redacts credential material from diagnostics and config views", () => {
    const secret = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
    const diagnostic = sanitizeBuzzDiagnostic(
      `Authorization: Bearer nope\nNOSTR_PRIVATE_KEY=${secret}\ncredential=${secret}`,
    );
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).toContain("[redacted]");

    const cfg = localCfg();
    cfg.buzz = {
      enabled: true,
      communities: [{ id: "a", name: "Public", url: "https://relay.example", gitUrl: "https://relay.example/git/a/b.git" }],
    };
    (cfg.buzz as typeof cfg.buzz & { nsec?: string }).nsec = secret;
    expect(JSON.stringify(buzzConfigView(cfg))).not.toContain(secret);
    expect(buzzConfigView(localCfg())).toEqual({ enabled: false, communities: [] });

    cfg.buzz.communities = [
      {
        id: "unsafe",
        name: "Unsafe",
        url: `https://${secret}@relay.example`,
        gitUrl: "https://other.example/git/a/b.git",
      },
    ];
    expect(JSON.stringify(buzzConfigView(cfg))).not.toContain(secret);
    expect(buzzConfigView(cfg).communities).toEqual([]);
  });
});

describe("Buzz preflight", () => {
  it("uses argv-only, non-interactive Git authentication and reports a complete pass", async () => {
    const calls: Array<{ argv: readonly string[]; stdin?: string; timeoutMs?: number }> = [];
    const result = await preflightBuzz(
      { id: "one", name: "Buzz", url: "https://relay.example", gitUrl: "https://relay.example/git/owner/repo.git" },
      {
        run: async (argv, options) => {
          calls.push({ argv, ...options });
          if (argv.join(" ") === "git --version") return ok("git version 2.46.0");
          if (argv.includes("--show-origin")) return ok("file:C:/gitconfig\tnostr\n");
          if (argv.includes("credential-nostr")) return ok();
          if (argv.includes("credential.useHttpPath")) return ok("true\n");
          if (argv.includes("ls-remote")) return ok("deadbeef\trefs/heads/main\n");
          throw new Error(`unexpected argv: ${argv.join(" ")}`);
        },
        fetch: async (_input, init) => {
          expect(init?.redirect).toBe("manual");
          return new Response("ok", { status: 200 });
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.authentication.code).toBe("AUTH_OK");
    const auth = calls.find(({ argv }) => argv.includes("ls-remote"));
    expect(auth?.argv).toEqual([
      "git",
      "-c",
      "credential.interactive=never",
      "ls-remote",
      "https://relay.example/git/owner/repo.git",
      "HEAD",
    ]);
    expect(auth?.timeoutMs).toBeNumber();
    expect(calls.some(({ argv }) => argv.includes("store"))).toBe(false);
    expect(calls.every(({ argv }) => !argv.some((arg) => /[;&|]/.test(arg)))).toBe(true);
  });

  it("classifies old Git, missing helper, and an unreachable relay without attempting auth", async () => {
    const calls: string[][] = [];
    const result = await preflightBuzz(
      { id: "one", name: "Buzz", url: "https://relay.example", gitUrl: "https://relay.example/git/owner/repo.git" },
      {
        run: async (argv) => {
          calls.push([...argv]);
          if (argv.join(" ") === "git --version") return ok("git version 2.45.9");
          if (argv.includes("credential-nostr")) return { ...ok(), code: null, spawnError: true };
          if (argv.includes("credential.useHttpPath")) return ok("false\n");
          return ok();
        },
        fetch: async () => {
          throw new Error("relay offline");
        },
      },
    );

    expect(result.git.code).toBe("GIT_TOO_OLD");
    expect(result.credentialHelper.code).toBe("HELPER_MISSING");
    expect(result.relay.code).toBe("RELAY_UNREACHABLE");
    expect(result.authentication.code).toBe("AUTH_PREREQUISITE_FAILED");
    expect(calls.some((argv) => argv.includes("ls-remote"))).toBe(false);
  });

  it("redacts a rejected authentication response", async () => {
    const secret = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
    const result = await preflightBuzz(
      { id: "one", name: "Buzz", url: "https://relay.example", gitUrl: "https://relay.example/git/owner/repo.git" },
      {
        run: async (argv) => {
          if (argv.join(" ") === "git --version") return ok("git version 2.46.0");
          if (argv.includes("--show-origin")) return ok("nostr\n");
          if (argv.includes("credential-nostr")) return ok();
          if (argv.includes("credential.useHttpPath")) return ok("true\n");
          return { ...ok(), code: 128, stderr: `Authentication failed; Authorization: Bearer x ${secret}` };
        },
        fetch: async () => new Response("ok"),
      },
    );
    expect(result.authentication.code).toBe("AUTH_REJECTED");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("never sends an authentication probe to a cross-origin legacy config URL", async () => {
    const calls: string[][] = [];
    const result = await preflightBuzz(
      {
        id: "one",
        name: "Buzz",
        url: "https://relay.example",
        gitUrl: "https://other.example/git/owner/repo.git",
      },
      {
        run: async (argv) => {
          calls.push([...argv]);
          if (argv.join(" ") === "git --version") return ok("git version 2.46.0");
          if (argv.includes("--show-origin")) return ok("nostr\n");
          if (argv.includes("credential-nostr")) return ok();
          if (argv.includes("credential.useHttpPath")) return ok("true\n");
          throw new Error(`unexpected argv: ${argv.join(" ")}`);
        },
        fetch: async () => new Response("ok"),
      },
    );
    expect(result.authentication.code).toBe("AUTH_URL_INVALID");
    expect(calls.some((argv) => argv.includes("ls-remote"))).toBe(false);
  });
});

test("Buzz routes default off and reject credential-bearing public URLs", async () => {
  const app = createApp(localCfg());
  const initial = await app.request("/api/buzz");
  expect(initial.status).toBe(200);
  expect(await initial.json()).toEqual({ config: { enabled: false, communities: [] } });

  const rejected = await app.request("/api/buzz/communities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Unsafe", url: "https://nsec1secret@relay.example" }),
  });
  expect(rejected.status).toBe(400);
  expect((await rejected.json()).code).toBe("BAD_REQUEST");

  const preflight = await app.request("/api/buzz/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(preflight.status).toBe(400);
  expect((await preflight.json()).message).toContain("enable Buzz support");
});

test("Buzz routes persist only normalized public community metadata", async () => {
  const cfg = localCfg();
  const app = createApp(cfg);
  const enabled = await app.request("/api/buzz", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(enabled.status).toBe(200);

  const secret = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
  const added = await app.request("/api/buzz/communities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Team",
      url: "https://relay.example/?token=discarded",
      gitUrl: "https://relay.example/git/team/repo.git?token=discarded",
      nsec: secret,
    }),
  });
  expect(added.status).toBe(201);
  const body = await added.json();
  expect(JSON.stringify(body)).not.toContain(secret);
  expect(body.config).toEqual({
    enabled: true,
    communities: [
      {
        id: body.community.id,
        name: "Team",
        url: "https://relay.example",
        gitUrl: "https://relay.example/git/team/repo.git",
      },
    ],
  });
  expect(cfg.buzz).toEqual(body.config);
});

test("Buzz routes bind diagnostic Git URLs to the saved community origin and cap inputs", async () => {
  const app = createApp(localCfg());
  const crossOrigin = await app.request("/api/buzz/communities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://relay.example",
      gitUrl: "https://other.example/git/team/repo.git",
    }),
  });
  expect(crossOrigin.status).toBe(400);
  expect((await crossOrigin.json()).message).toContain("community origin");

  const oversized = await app.request("/api/buzz/communities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "x".repeat(101), url: "https://relay.example" }),
  });
  expect(oversized.status).toBe(400);
});
