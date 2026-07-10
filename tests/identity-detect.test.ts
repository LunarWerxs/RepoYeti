import { test, expect } from "bun:test";
import {
  detectedFromGhAuthStatus,
  detectedFromGitConfig,
  detectedFromGitCredentialConfig,
  detectedFromRepoGitConfig,
  detectedFromSshAdd,
  detectedFromSshKeyPaths,
  detectedFromWindowsCredentialTargets,
  mergeDetectedIdentityHints,
} from "../src/identity-detect.ts";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";

const localCfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

test("detectedFromGitConfig creates a complete candidate from global author config", () => {
  const [candidate] = [detectedFromGitConfig("Octo Cat", "octo@example.com")];

  expect(candidate?.source).toBe("git-global");
  expect(candidate?.suggestion.gitUsername).toBe("Octo Cat");
  expect(candidate?.suggestion.gitEmail).toBe("octo@example.com");
  expect(candidate?.missing).toEqual([]);
});

test("detectedFromRepoGitConfig creates a repo-scoped author candidate", () => {
  const candidate = detectedFromRepoGitConfig(
    { name: "client-site", absPath: "C:\\work\\client-site" },
    "Client Bot",
    "client@example.com",
  );

  expect(candidate?.source).toBe("git-local");
  expect(candidate?.title).toContain("client-site");
  expect(candidate?.suggestion.gitUsername).toBe("Client Bot");
  expect(candidate?.suggestion.gitEmail).toBe("client@example.com");
});

test("detectedFromGitCredentialConfig extracts GitHub usernames from git credential config", () => {
  const candidates = detectedFromGitCredentialConfig(`
credential.https://github.com.username lunawerx
credential.https://gist.github.com.username gist-user
credential.helper manager
`);

  expect(candidates.map((c) => c.suggestion.gitUsername)).toEqual(["lunawerx", "gist-user"]);
  expect(candidates.every((c) => c.source === "git-credential")).toBe(true);
  expect(candidates.every((c) => c.missing.includes("gitEmail"))).toBe(true);
});

test("detectedFromGhAuthStatus extracts logins without exposing token lines", () => {
  const candidates = detectedFromGhAuthStatus(`
github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token: ghp_secret_that_must_not_escape
`);

  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.source).toBe("github-cli");
  expect(candidates[0]!.suggestion.gitUsername).toBe("octocat");
  expect(candidates[0]!.suggestion.gitEmail).toBe("");
  expect(JSON.stringify(candidates)).not.toContain("ghp_secret");
});

test("detectedFromWindowsCredentialTargets extracts GitHub account names only", () => {
  const candidates = detectedFromWindowsCredentialTargets(`
    Target: LegacyGeneric:target=gh:github.com:L0garithmic
    Target: LegacyGeneric:target=gh:github.com:
    Target: LegacyGeneric:target=GitHub - https://api.github.com/LunarWerxs
    Target: LegacyGeneric:target=git:https://lunawerx@github.com
    Target: LegacyGeneric:target=not-github:token-secret
`);

  expect(candidates.map((c) => c.suggestion.gitUsername)).toEqual([
    "L0garithmic",
    "LunarWerxs",
    "lunawerx",
  ]);
  expect(candidates.every((c) => c.source === "windows-credential")).toBe(true);
  expect(JSON.stringify(candidates)).not.toContain("token-secret");
});

test("mergeDetectedIdentityHints combines duplicate GitHub account hints", () => {
  const hints = [
    ...detectedFromGitCredentialConfig("credential.https://github.com.username octocat"),
    ...detectedFromGhAuthStatus(`
github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Git operations protocol: https
`),
    ...detectedFromWindowsCredentialTargets("Target: LegacyGeneric:target=gh:github.com:octocat"),
  ];

  const merged = mergeDetectedIdentityHints(hints);

  expect(merged).toHaveLength(1);
  expect(merged[0]!.title).toBe("GitHub account: octocat");
  expect(merged[0]!.source).toBe("github-cli");
  expect(merged[0]!.detail).toContain("GitHub CLI");
  expect(merged[0]!.detail).toContain("Git credential config");
  expect(merged[0]!.detail).toContain("Windows Credential Manager");
});

test("SSH key path candidates prefill the key path but require author details", () => {
  const [candidate] = detectedFromSshKeyPaths(["C:\\Users\\me\\.ssh\\id_ed25519_work"]);

  expect(candidate!.source).toBe("ssh-key");
  expect(candidate!.suggestion.sshKeyPath).toBe("C:\\Users\\me\\.ssh\\id_ed25519_work");
  expect(candidate!.missing).toContain("gitUsername");
  expect(candidate!.missing).toContain("gitEmail");
});

test("ssh-add output becomes a non-secret loaded-key hint", () => {
  const [candidate] = detectedFromSshAdd("256 SHA256:abc123 me@laptop (ED25519)");

  expect(candidate!.source).toBe("ssh-agent");
  expect(candidate!.title).toContain("me@laptop");
  expect(candidate!.detail).toContain("SHA256:abc123");
  expect(candidate!.suggestion.sshKeyPath).toBeNull();
});

test("GET /api/identities/detected returns a stable envelope", async () => {
  const res = await createApp(localCfg()).request("/api/identities/detected");

  expect(res.status).toBe(200);
  const j = await res.json();
  expect(Array.isArray(j.detected)).toBe(true);
});
