import { existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type DetectedIdentitySource =
  | "git-global"
  | "git-local"
  | "git-credential"
  | "github-cli"
  | "windows-credential"
  | "ssh-key"
  | "ssh-agent";
export type DetectedIdentityConfidence = "high" | "medium" | "low";

export interface DetectedIdentitySuggestion {
  displayName: string;
  gitUsername: string;
  gitEmail: string;
  sshKeyPath: string | null;
}

export interface DetectedIdentity {
  id: string;
  source: DetectedIdentitySource;
  title: string;
  detail: string;
  confidence: DetectedIdentityConfidence;
  suggestion: DetectedIdentitySuggestion;
  missing: Array<keyof DetectedIdentitySuggestion>;
}

export interface RepoIdentityHint {
  name: string;
  absPath: string;
}

interface RunResult {
  ok: boolean;
  stdout: string;
}

function idFor(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 16);
}

async function run(args: string[], timeoutMs = 1500): Promise<RunResult> {
  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* process already exited */
      }
    }, timeoutMs);
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timer);
    return { ok: code === 0, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function missingFor(suggestion: DetectedIdentitySuggestion): Array<keyof DetectedIdentitySuggestion> {
  const missing: Array<keyof DetectedIdentitySuggestion> = [];
  if (!suggestion.displayName.trim()) missing.push("displayName");
  if (!suggestion.gitUsername.trim()) missing.push("gitUsername");
  if (!suggestion.gitEmail.trim()) missing.push("gitEmail");
  return missing;
}

function candidate(input: Omit<DetectedIdentity, "id" | "missing">): DetectedIdentity {
  return {
    ...input,
    id: idFor(input.source, input.title, input.detail, JSON.stringify(input.suggestion)),
    missing: missingFor(input.suggestion),
  };
}

const ACCOUNT_SOURCES = new Set<DetectedIdentitySource>(["github-cli", "git-credential", "windows-credential"]);
const SOURCE_PRIORITY: Partial<Record<DetectedIdentitySource, number>> = {
  "github-cli": 0,
  "git-credential": 1,
  "windows-credential": 2,
};
const SOURCE_DETAIL: Partial<Record<DetectedIdentitySource, string>> = {
  "github-cli": "GitHub CLI",
  "git-credential": "Git credential config",
  "windows-credential": "Windows Credential Manager",
};

function isAccountOnlyHint(item: DetectedIdentity): boolean {
  return (
    ACCOUNT_SOURCES.has(item.source) &&
    !!item.suggestion.gitUsername.trim() &&
    !item.suggestion.gitEmail.trim() &&
    !item.suggestion.sshKeyPath
  );
}

export function mergeDetectedIdentityHints(items: DetectedIdentity[]): DetectedIdentity[] {
  const merged: DetectedIdentity[] = [];
  const accountIndexes = new Map<string, number>();
  const accountSources = new Map<string, Set<DetectedIdentitySource>>();

  for (const item of items) {
    if (!isAccountOnlyHint(item)) {
      merged.push(item);
      continue;
    }

    const key = item.suggestion.gitUsername.trim().toLowerCase();
    const existingIndex = accountIndexes.get(key);
    if (existingIndex === undefined) {
      const next = candidate({
        ...item,
        title: `GitHub account: ${item.suggestion.gitUsername}`,
        detail: SOURCE_DETAIL[item.source] ?? item.detail,
      });
      merged.push(next);
      accountIndexes.set(key, merged.length - 1);
      accountSources.set(key, new Set([item.source]));
      continue;
    }

    const sources = accountSources.get(key)!;
    sources.add(item.source);
    const existing = merged[existingIndex]!;
    const bestSource = [...sources].sort((a, b) => (SOURCE_PRIORITY[a] ?? 99) - (SOURCE_PRIORITY[b] ?? 99))[0]!;
    existing.source = bestSource;
    existing.detail = [...sources]
      .sort((a, b) => (SOURCE_PRIORITY[a] ?? 99) - (SOURCE_PRIORITY[b] ?? 99))
      .map((source) => SOURCE_DETAIL[source] ?? source)
      .join(" · ");
  }

  return merged;
}

export function detectedFromGitConfig(name: string, email: string): DetectedIdentity | null {
  const gitUsername = name.trim();
  const gitEmail = email.trim();
  if (!gitUsername && !gitEmail) return null;
  return candidate({
    source: "git-global",
    title: "Global Git config",
    detail: [gitUsername, gitEmail].filter(Boolean).join(" · "),
    confidence: gitUsername && gitEmail ? "high" : "medium",
    suggestion: {
      displayName: gitUsername || gitEmail || "Global Git",
      gitUsername,
      gitEmail,
      sshKeyPath: null,
    },
  });
}

export function detectedFromRepoGitConfig(repo: RepoIdentityHint, name: string, email: string): DetectedIdentity | null {
  const gitUsername = name.trim();
  const gitEmail = email.trim();
  if (!gitUsername && !gitEmail) return null;
  return candidate({
    source: "git-local",
    title: `Repo Git config: ${repo.name}`,
    detail: [gitUsername, gitEmail, repo.absPath].filter(Boolean).join(" · "),
    confidence: gitUsername && gitEmail ? "high" : "medium",
    suggestion: {
      displayName: `${repo.name} Git`,
      gitUsername,
      gitEmail,
      sshKeyPath: null,
    },
  });
}

function githubAccountSuggestion(source: Extract<DetectedIdentitySource, "git-credential" | "windows-credential">, login: string, detail: string): DetectedIdentity {
  return candidate({
    source,
    title: source === "git-credential" ? `Git credential: ${login}` : `Windows credential: ${login}`,
    detail,
    confidence: "medium",
    suggestion: {
      displayName: `GitHub ${login}`,
      gitUsername: login,
      gitEmail: "",
      sshKeyPath: null,
    },
  });
}

export function detectedFromGitCredentialConfig(output: string): DetectedIdentity[] {
  const accounts = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^credential\..*github[^ ]*\.username\s+(.+)$/i);
    if (match?.[1]) accounts.add(match[1].trim());
  }
  return [...accounts].map((login) => githubAccountSuggestion("git-credential", login, "Git credential config for github.com"));
}

export function detectedFromWindowsCredentialTargets(output: string): DetectedIdentity[] {
  const accounts = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const target = line.match(/Target:\s*(.+)$/i)?.[1]?.trim();
    if (!target || !/github/i.test(target)) continue;
    const ghCli = target.match(/gh:github\.com:([^:\s]+)/i)?.[1];
    if (ghCli) {
      accounts.add(ghCli);
      continue;
    }
    const api = target.match(/api\.github\.com\/([^/\s]+)/i)?.[1];
    if (api) {
      accounts.add(api);
      continue;
    }
    const gitHttps = target.match(/git:https:\/\/([^@\s]+)@github\.com/i)?.[1];
    if (gitHttps) accounts.add(gitHttps);
  }
  return [...accounts].map((login) => githubAccountSuggestion("windows-credential", login, "Windows Credential Manager GitHub target"));
}

export function detectedFromGhAuthStatus(output: string): DetectedIdentity[] {
  const accounts = new Map<string, { protocol?: string }>();
  let currentLogin: string | null = null;

  for (const line of output.split(/\r?\n/)) {
    const account = line.match(/\baccount\s+([^\s()]+)/i);
    if (account?.[1]) {
      currentLogin = account[1].trim();
      if (!accounts.has(currentLogin)) accounts.set(currentLogin, {});
      continue;
    }
    const protocol = line.match(/Git operations protocol:\s*([^\s]+)/i);
    if (protocol?.[1] && currentLogin) {
      accounts.get(currentLogin)!.protocol = protocol[1].trim();
    }
  }

  return [...accounts.entries()].map(([login, meta]) =>
    candidate({
      source: "github-cli",
      title: `GitHub CLI: ${login}`,
      detail: `Authenticated GitHub account${meta.protocol ? ` · ${meta.protocol}` : ""}`,
      confidence: "medium",
      suggestion: {
        displayName: `GitHub ${login}`,
        gitUsername: login,
        gitEmail: "",
        sshKeyPath: null,
      },
    }),
  );
}

export function detectedFromSshKeyPaths(paths: string[]): DetectedIdentity[] {
  return paths.map((path) => {
    const name = basename(path);
    return candidate({
      source: "ssh-key",
      title: `SSH key: ${name}`,
      detail: path,
      confidence: "low",
      suggestion: {
        displayName: name.replace(/^id_/, "").replace(/[_-]/g, " "),
        gitUsername: "",
        gitEmail: "",
        sshKeyPath: path,
      },
    });
  });
}

export function detectedFromSshAdd(output: string): DetectedIdentity[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const fingerprint = parts[1] ?? "";
      const comment = parts.slice(2).join(" ").replace(/\s*\([^)]*\)\s*$/, "").trim();
      const label = comment || fingerprint || "loaded key";
      return candidate({
        source: "ssh-agent",
        title: `SSH agent: ${label}`,
        detail: fingerprint ? `Loaded in ssh-agent · ${fingerprint}` : "Loaded in ssh-agent",
        confidence: "low",
        suggestion: {
          displayName: label,
          gitUsername: "",
          gitEmail: "",
          sshKeyPath: null,
        },
      });
    });
}

function discoverSshKeyPaths(): string[] {
  const dir = join(homedir(), ".ssh");
  if (!existsSync(dir)) return [];
  const ignored = new Set(["config", "known_hosts", "known_hosts.old", "authorized_keys", "environment", "rc"]);
  try {
    return readdirSync(dir)
      .filter((name) => !name.endsWith(".pub") && !ignored.has(name))
      .map((name) => join(dir, name))
      .filter((path) => {
        try {
          const st = statSync(path);
          return st.isFile() && st.size > 0;
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function detectRepoGitConfig(repos: RepoIdentityHint[]): Promise<DetectedIdentity[]> {
  const limited = repos.slice(0, 200);
  const results = await Promise.all(
    limited.map(async (repo) => {
      const [name, email] = await Promise.all([
        run(["git", "-C", repo.absPath, "config", "--local", "--get", "user.name"]),
        run(["git", "-C", repo.absPath, "config", "--local", "--get", "user.email"]),
      ]);
      return detectedFromRepoGitConfig(repo, name.stdout, email.stdout);
    }),
  );
  return results.filter((item): item is DetectedIdentity => !!item);
}

export async function detectIdentities(repos: RepoIdentityHint[] = []): Promise<DetectedIdentity[]> {
  const [gitName, gitEmail, gitCredentials, ghStatus, windowsCredentials, sshAgent, repoConfig] = await Promise.all([
    run(["git", "config", "--global", "--get", "user.name"]),
    run(["git", "config", "--global", "--get", "user.email"]),
    run(["git", "config", "--global", "--get-regexp", "^credential\\..*github.*\\.username$"]),
    run(["gh", "auth", "status"], 2000),
    process.platform === "win32" ? run(["cmdkey", "/list"], 1000) : Promise.resolve({ ok: false, stdout: "" }),
    run(["ssh-add", "-l"], 1000),
    detectRepoGitConfig(repos),
  ]);

  const detected: DetectedIdentity[] = [];
  const gitCandidate = detectedFromGitConfig(gitName.stdout, gitEmail.stdout);
  if (gitCandidate) detected.push(gitCandidate);
  if (gitCredentials.ok) detected.push(...detectedFromGitCredentialConfig(gitCredentials.stdout));
  detected.push(...repoConfig);
  if (ghStatus.ok) detected.push(...detectedFromGhAuthStatus(ghStatus.stdout));
  if (windowsCredentials.ok) detected.push(...detectedFromWindowsCredentialTargets(windowsCredentials.stdout));
  detected.push(...detectedFromSshKeyPaths(discoverSshKeyPaths()));
  if (sshAgent.ok) detected.push(...detectedFromSshAdd(sshAgent.stdout));

  const seen = new Set<string>();
  return mergeDetectedIdentityHints(detected).filter((item) => {
    const key = [
      item.source,
      item.suggestion.gitUsername,
      item.suggestion.gitEmail,
      item.suggestion.sshKeyPath ?? "",
      item.title,
    ].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
