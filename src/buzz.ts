/**
 * Buzz Git compatibility adapter.
 *
 * Buzz repositories are ordinary Git Smart HTTP repositories. This module therefore owns only
 * discovery/preflight concerns; clone/fetch/pull/push continue through the existing Git backend
 * and its safety policy. In particular, every child is argv-based (never shell text), bounded by
 * a timeout, and inherits safeGitEnv() so an authentication check can never open a prompt.
 */
import { safeGitEnv } from "./git.ts";
import type { BuzzCommunity, BuzzConfig, RepoYetiConfig } from "./config.ts";
import {
  buzzGitUrlMatchesCommunity,
  normalizeBuzzCommunities,
  normalizeBuzzPublicUrl,
} from "./buzz-url.ts";
import { readTextStreamLimited } from "./process-output.ts";

export {
  buzzGitUrlMatchesCommunity,
  normalizeBuzzGitUrl,
  normalizeBuzzPublicUrl,
} from "./buzz-url.ts";

const MIN_GIT_VERSION = [2, 46, 0] as const;
const COMMAND_TIMEOUT_MS = Number(process.env.REPOYETI_BUZZ_TIMEOUT_MS) || 10_000;
const RELAY_TIMEOUT_MS = Number(process.env.REPOYETI_BUZZ_RELAY_TIMEOUT_MS) || 8_000;

export type BuzzCheckStatus = "pass" | "fail" | "skip";

export interface BuzzCheck {
  status: BuzzCheckStatus;
  /** Stable machine-readable diagnosis for component tests and API consumers. */
  code: string;
  /** Short, actionable, secret-free owner-facing explanation. */
  message: string;
}

export interface BuzzPreflight {
  ok: boolean;
  checkedAt: string;
  git: BuzzCheck & { version?: string };
  credentialHelper: BuzzCheck;
  useHttpPath: BuzzCheck;
  relay: BuzzCheck;
  authentication: BuzzCheck;
}

export interface BuzzCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: boolean;
}

/** Injectable in tests; production uses the argv-only Bun.spawn runner below. */
export type BuzzCommandRunner = (
  argv: readonly string[],
  options?: { stdin?: string; timeoutMs?: number },
) => Promise<BuzzCommandResult>;

export type BuzzFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface BuzzPreflightDeps {
  run?: BuzzCommandRunner;
  fetch?: BuzzFetcher;
}

const pass = (code: string, message: string): BuzzCheck => ({ status: "pass", code, message });
const fail = (code: string, message: string): BuzzCheck => ({ status: "fail", code, message });
const skip = (code: string, message: string): BuzzCheck => ({ status: "skip", code, message });

/**
 * Keep daemon/API diagnostics useful without ever reflecting credential material. Git normally
 * suppresses headers and helper output already; this is a second boundary for unexpected stderr.
 */
export function sanitizeBuzzDiagnostic(value: string): string {
  return value
    .replace(/\b(nsec1)[023456789acdefghjklmnpqrstuvwxyz]{20,}\b/gi, "$1[redacted]")
    .replace(/\bNOSTR_PRIVATE_KEY\s*=\s*[^\s]+/gi, "NOSTR_PRIVATE_KEY=[redacted]")
    .replace(/\bAuthorization\s*:\s*[^\r\n]+/gi, "Authorization: [redacted]")
    .replace(/\bcredential\s*=\s*[^\r\n]+/gi, "credential=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** Parse `git version 2.46.1.windows.1` and similar vendor suffixes. */
export function parseGitVersion(output: string): [number, number, number] | null {
  const match = output.match(/\bgit version\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function versionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let i = 0; i < minimum.length; i += 1) {
    if (actual[i]! > minimum[i]!) return true;
    if (actual[i]! < minimum[i]!) return false;
  }
  return true;
}

/** Public, secret-free projection used by the owner API. */
export function buzzConfigView(cfg: RepoYetiConfig): Required<BuzzConfig> {
  return {
    enabled: cfg.buzz?.enabled === true,
    communities: normalizeBuzzCommunities(cfg.buzz?.communities),
  };
}

function relayHealthUrl(raw: string): string | null {
  const normalized = normalizeBuzzPublicUrl(raw);
  if (!normalized) return null;
  const url = new URL(normalized);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/health`;
  url.search = "";
  return url.toString();
}

async function defaultRunBuzzCommand(
  argv: readonly string[],
  options: { stdin?: string; timeoutMs?: number } = {},
): Promise<BuzzCommandResult> {
  try {
    const proc = Bun.spawn([...argv], {
      env: safeGitEnv(),
      stdin: options.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (options.stdin !== undefined && proc.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }
    let timedOut = false;
    let outputLimited = false;
    const kill = (): void => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    try {
      const onLimit = (): void => {
        outputLimited = true;
        kill();
      };
      const [stdout, stderr, code] = await Promise.all([
        readTextStreamLimited(proc.stdout, 2 * 1024 * 1024, onLimit),
        readTextStreamLimited(proc.stderr, 512 * 1024, onLimit),
        proc.exited,
      ]);
      return {
        code,
        stdout: stdout.text,
        stderr: outputLimited
          ? `${stderr.text}\ncommand output exceeded the daemon limit`.trim()
          : stderr.text,
        timedOut,
        spawnError: false,
      };
    } finally {
      clearTimeout(timer);
      kill();
      await proc.exited.catch(() => undefined);
    }
  } catch (error) {
    return {
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : "unable to start command",
      timedOut: false,
      spawnError: true,
    };
  }
}

function configuredNostrHelper(stdout: string): boolean {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).at(-1)?.replace(/^["']|["']$/g, "") ?? "")
    .some((helper) => helper === "nostr" || helper === "git-credential-nostr");
}

async function checkRelay(
  community: BuzzCommunity | undefined,
  fetcher: BuzzFetcher,
): Promise<BuzzCheck> {
  if (!community) return skip("RELAY_NOT_CONFIGURED", "Save a Buzz community to test relay reachability.");
  const healthUrl = relayHealthUrl(community.url);
  if (!healthUrl) return fail("RELAY_URL_INVALID", "The saved community URL is not a valid public relay URL.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  try {
    const response = await fetcher(healthUrl, {
      method: "GET",
      // Never let a saved community redirect this owner-only diagnostic to a different target.
      // Local/private targets remain intentional: Buzz's documented self-host default is
      // ws://localhost:3000, and rejecting them would break the primary advanced use case.
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "text/plain, application/json" },
    });
    if (response.ok) return pass("RELAY_REACHABLE", `Buzz relay reachable (${response.status}).`);
    if (response.status >= 300 && response.status < 400) {
      return fail(
        "RELAY_REDIRECTED",
        "Buzz relay redirected its health check; save the final community URL instead.",
      );
    }
    return fail("RELAY_UNREACHABLE", `Buzz relay returned HTTP ${response.status} from /health.`);
  } catch (error) {
    const detail = error instanceof Error && error.name === "AbortError"
      ? "connection timed out"
      : sanitizeBuzzDiagnostic(error instanceof Error ? error.message : "connection failed");
    return fail("RELAY_UNREACHABLE", `Buzz relay is unreachable: ${detail || "connection failed"}.`);
  } finally {
    clearTimeout(timer);
  }
}

function authFailure(result: BuzzCommandResult): BuzzCheck {
  if (result.timedOut) return fail("AUTH_TIMEOUT", "Authentication timed out; no interactive prompt was opened.");
  const detail = sanitizeBuzzDiagnostic(`${result.stderr}\n${result.stdout}`);
  if (/no nostr key configured|could not read username|terminal prompts disabled/i.test(detail)) {
    return fail(
      "AUTH_MISSING",
      "Buzz authentication is not configured in the system Git credential-helper chain.",
    );
  }
  if (/authentication failed|access denied|forbidden|http.*(?:401|403)|requested url returned error: (?:401|403)/i.test(detail)) {
    return fail("AUTH_REJECTED", "The Buzz relay rejected the system Git credential.");
  }
  return fail("AUTH_FAILED", detail ? `Git authentication failed: ${detail}` : "Git authentication failed.");
}

/**
 * Run all Phase 1 checks. The optional `gitUrl` is the only reliable way to prove the helper can
 * complete Buzz's 401/NIP-98 challenge, so authentication is explicitly skipped without it rather
 * than reporting a false success from a local key-file inspection.
 */
export async function preflightBuzz(
  community?: BuzzCommunity,
  deps: BuzzPreflightDeps = {},
): Promise<BuzzPreflight> {
  const run = deps.run ?? defaultRunBuzzCommand;
  const versionRun = await run(["git", "--version"]);
  const parsedVersion = parseGitVersion(versionRun.stdout || versionRun.stderr);
  const versionText = parsedVersion?.join(".");
  const git = versionRun.spawnError
    ? { ...fail("GIT_MISSING", "System Git was not found on PATH."), version: undefined }
    : !parsedVersion
      ? { ...fail("GIT_VERSION_UNKNOWN", "System Git's version could not be determined."), version: undefined }
      : versionAtLeast(parsedVersion, MIN_GIT_VERSION)
        ? { ...pass("GIT_OK", `System Git ${versionText} meets the 2.46 minimum.`), version: versionText }
        : { ...fail("GIT_TOO_OLD", `System Git ${versionText} is too old; install Git 2.46 or newer.`), version: versionText };

  const helperConfigRun = await run(["git", "config", "--show-origin", "--get-all", "credential.helper"]);
  const helperConfigured = configuredNostrHelper(helperConfigRun.stdout);
  // Probe dispatch only. Credential-helper actions such as `store` are allowed to mutate state
  // and therefore never belong in a diagnostic.
  const helperRun = await run(["git", "credential-nostr"]);
  const helperDetail = sanitizeBuzzDiagnostic(`${helperRun.stderr}\n${helperRun.stdout}`);
  const helperMissing =
    helperRun.spawnError ||
    helperRun.timedOut ||
    /(?:is not a git command|not recognized|not found|cannot find)/i.test(helperDetail);
  const credentialHelper = helperMissing
    ? fail("HELPER_MISSING", "git-credential-nostr is not installed or is not available to system Git.")
    : !helperConfigured
      ? fail(
          "HELPER_NOT_CONFIGURED",
          "git-credential-nostr is installed but not configured; run `git config --global credential.helper nostr`.",
        )
      : pass("HELPER_OK", "git-credential-nostr is installed and configured in the Git helper chain.");

  const httpPathRun = await run(["git", "config", "--get", "credential.useHttpPath"]);
  const httpPathEnabled = httpPathRun.code === 0 && httpPathRun.stdout.trim().toLowerCase() === "true";
  const useHttpPath = httpPathEnabled
    ? pass("HTTP_PATH_OK", "credential.useHttpPath=true is configured.")
    : fail(
        "HTTP_PATH_DISABLED",
        "credential.useHttpPath must be true; run `git config --global credential.useHttpPath true`.",
      );

  const relay = await checkRelay(community, deps.fetch ?? fetch);
  let authentication: BuzzCheck;
  if (!community?.gitUrl) {
    authentication = skip(
      "AUTH_URL_NOT_CONFIGURED",
      "Add a Buzz Git repository URL to this community to test non-interactive authentication.",
    );
  } else if (!buzzGitUrlMatchesCommunity(community.url, community.gitUrl)) {
    authentication = fail(
      "AUTH_URL_INVALID",
      "The authentication-check repository must use the saved Buzz community origin.",
    );
  } else if (
    git.status !== "pass" ||
    credentialHelper.status !== "pass" ||
    useHttpPath.status !== "pass" ||
    relay.status !== "pass"
  ) {
    authentication = skip("AUTH_PREREQUISITE_FAILED", "Fix the failed preflight checks before testing authentication.");
  } else {
    const authRun = await run(
      ["git", "-c", "credential.interactive=never", "ls-remote", community.gitUrl, "HEAD"],
      { timeoutMs: COMMAND_TIMEOUT_MS },
    );
    authentication = authRun.code === 0
      ? pass("AUTH_OK", "System Git authenticated to Buzz without an interactive prompt.")
      : authFailure(authRun);
  }

  const checks = [git, credentialHelper, useHttpPath, relay, authentication];
  return {
    ok: checks.every((check) => check.status === "pass"),
    checkedAt: new Date().toISOString(),
    git,
    credentialHelper,
    useHttpPath,
    relay,
    authentication,
  };
}
