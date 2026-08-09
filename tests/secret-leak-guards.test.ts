/**
 * The three places a credential used to escape, and the guards that now stop it.
 *
 * They are grouped because they are one defect wearing three costumes: something the daemon did
 * not compose (a remote URL, a git error line, a file's contents) travelled outward without
 * anyone asking whether it held a secret. Each guard is small; the point of testing them together
 * is that the NEXT one of these is easier to spot as a member of a family.
 */
import { test, expect } from "bun:test";
import { isSecretPath, redactSecretFileDiffs } from "../src/git-actions/diff.ts";
import { scrubUrlCredentials } from "../src/git-actions/sync.ts";
import { guestStatus } from "../src/share/redact.ts";
import type { RepoStatus } from "../src/db.ts";

// ── 1. secret-bearing files are not sent to an AI provider ───────────────────────

test("isSecretPath recognises the files people actually commit by mistake", () => {
  for (const p of [
    ".env",
    ".env.local",
    "config/.env.production",
    "deploy/id_rsa",
    "certs/server.pem",
    "certs/server.key",
    "secrets.json",
    "app/credentials.json",
    "keystore.jks",
    ".npmrc",
    ".netrc",
  ]) {
    expect(isSecretPath(p)).toBe(true);
  }
});

test("isSecretPath leaves ordinary source, and public keys, alone", () => {
  for (const p of [
    "src/index.ts",
    "README.md",
    ".env.example", // a template of NAMES, committed on purpose — folding it helps nobody
    "deploy/id_rsa.pub", // the public half; publishing it is the whole point
    "docs/environment.md",
    "src/keyboard.ts",
  ]) {
    expect(isSecretPath(p)).toBe(false);
  }
});

test("isSecretPath does not withhold CODE about secrets", () => {
  // The false positive that shipped in the first cut of this guard: a fuzzy "…secret…" match with
  // no extension check withheld `src/secrets.ts` — a file in THIS repository — so Smart Commit
  // would have silently written vaguer messages about its own source. Code and prose are about
  // credentials; they are not credentials.
  for (const p of [
    "src/secrets.ts",
    "src/ai/credentials.ts",
    "web/src/lib/secret-store.ts",
    "tests/secrets.test.ts",
    "docs/credentials.md",
    "app/Secrets.tsx",
    "lib/secret.py",
    "internal/credentials.go",
  ]) {
    expect(isSecretPath(p)).toBe(false);
  }
});

test("isSecretPath still withholds credential FORMATS that share those names", () => {
  // The other half of the same trade: .json/.yaml/.toml/.sh are where credentials actually live,
  // so a fuzzy name match on them must still withhold. A vaguer commit message is the cheaper
  // mistake than a sent credential.
  for (const p of [
    "aws-credentials.json",
    "config/secrets.yaml",
    "config/secret.toml",
    "scripts/deploy-secrets.sh",
    "app.credentials.ini",
  ]) {
    expect(isSecretPath(p)).toBe(true);
  }
});

test("isSecretPath withholds known secret files that wear a code/prose extension", () => {
  // The false NEGATIVE round 2 found: wp-config.php was short-circuited by CODE_EXT (.php) and
  // .p8 (Apple push key) was simply missing from the key-extension list. Both leaked to the AI
  // provider. The exact-name set is checked before CODE_EXT; the extension list now covers them.
  for (const p of [
    "wp-config.php",
    "deploy/AuthKey_XYZ.p8",
    "vault.kdbx",
    "login.keychain",
    ".git-credentials",
    ".pgpass",
    ".dockercfg",
    "client.ovpn",
  ]) {
    expect(isSecretPath(p)).toBe(true);
  }
});

test("redactSecretFileDiffs withholds a secret file under a quoted (non-ASCII) path header", () => {
  // Round 2 critical: git's default core.quotePath=true wraps a non-ASCII path in quotes and octal
  // escapes, so `diff --git "a/\346…/credentials.json" …` did not match the unquoted matcher and
  // the whole chunk (secret and all) passed through. boundedGit now forces core.quotePath=false so
  // this shape should not occur, but the parser tolerates it anyway as defense in depth.
  const quoted =
    'diff --git "a/\\346\\227\\245/credentials.json" "b/\\346\\227\\245/credentials.json"\n' +
    "@@ -1 +1 @@\n-SECRET=old\n+SECRET=xyz789\n";
  const out = redactSecretFileDiffs(quoted);
  expect(out).not.toContain("xyz789");
  expect(out).toContain("contents withheld");
});

test("redactSecretFileDiffs fails CLOSED on an unparseable file header", () => {
  // A security filter must never treat "I can't identify this file" as "so send it". A chunk that
  // opens with `diff --git` but whose paths cannot be parsed is withheld, not passed through.
  const weird = "diff --git something-we-cannot-parse\n@@ -1 +1 @@\n+TOKEN=leak123\n";
  const out = redactSecretFileDiffs(weird);
  expect(out).not.toContain("leak123");
  expect(out).toContain("contents withheld");
});

test("redactSecretFileDiffs leaves a normal ASCII diff untouched", () => {
  // The other direction: fail-closed must not mangle ordinary diffs.
  const normal = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n";
  expect(redactSecretFileDiffs(normal)).toBe(normal);
});

test("redactSecretFileDiffs catches a secret file RENAMED to a benign name (rename-header bypass)", () => {
  // Round-2 critical: the `diff --git a/OLD b/NEW` line carries TWO unquoted, space-capable paths on
  // a rename, so scraping it with a regex was defeated by an old path whose directory ended in ' b'
  // (`x b/credentials.json`) — the parse mis-split, both halves looked benign, and the secret's real
  // lines went to the AI provider. The fix reads git's unambiguous `rename from`/`--- a/` lines
  // instead. This is the exact header `git diff -M` emits for that case (the planner passes -M).
  const renamed =
    "diff --git a/x b/credentials.json b/y.txt\n" +
    "similarity index 60%\n" +
    "rename from x b/credentials.json\n" +
    "rename to y.txt\n" +
    "--- a/x b/credentials.json\n" +
    "+++ b/y.txt\n" +
    "@@ -1 +1 @@\n-API_KEY=old\n+API_KEY=abc123\n";
  const out = redactSecretFileDiffs(renamed);
  expect(out).not.toContain("abc123");
  expect(out).toContain("contents withheld");
});

test("redactSecretFileDiffs catches a secret RENAMED via rename-from even with no content diff", () => {
  // A pure rename (100% similarity) has no `---`/`+++` lines at all — only `rename from`/`rename to`.
  const pureRename =
    "diff --git a/config/secrets.json b/renamed.json\n" +
    "similarity index 100%\n" +
    "rename from config/secrets.json\n" +
    "rename to renamed.json\n";
  const out = redactSecretFileDiffs(pureRename);
  expect(out).toContain("contents withheld");
});

test("redactSecretFileDiffs drops a secret file's body but keeps it in the diff", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "@@ -1 +1 @@",
    "-const a = 1",
    "+const a = 2",
    "diff --git a/.env b/.env",
    "@@ -1 +1 @@",
    "-STRIPE_KEY=sk_live_OLD",
    "+STRIPE_KEY=sk_live_NEWSECRETVALUE",
    "",
  ].join("\n");

  const out = redactSecretFileDiffs(diff);
  // The secret never appears.
  expect(out).not.toContain("sk_live_NEWSECRETVALUE");
  expect(out).not.toContain("sk_live_OLD");
  // But the model still learns that .env changed, so it can describe the commit correctly.
  expect(out).toContain("diff --git a/.env b/.env");
  expect(out).toContain("contents withheld");
  // And an ordinary file is completely untouched.
  expect(out).toContain("+const a = 2");
});

test("redactSecretFileDiffs leaves a diff with no secret files byte-identical", () => {
  const diff = "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n";
  expect(redactSecretFileDiffs(diff)).toBe(diff);
});

test("redactSecretFileDiffs catches a RENAME into or out of a secret path", () => {
  // Both sides of the header are checked: renaming `notes.txt` to `.env` must not leak the body
  // just because the "a/" side looked innocent.
  const diff = "diff --git a/notes.txt b/.env\n@@ -1 +1 @@\n+TOKEN=ghp_realtoken\n";
  const out = redactSecretFileDiffs(diff);
  expect(out).not.toContain("ghp_realtoken");
  expect(out).toContain("contents withheld");
});

// ── 2. git's own error text does not carry a PAT back to the caller ──────────────

test("scrubUrlCredentials strips http(s) userinfo out of a git diagnosis line", () => {
  const line =
    "fatal: unable to access 'https://mike:ghp_SECRETTOKEN@github.com/o/r.git/': The requested URL returned error: 403";
  const out = scrubUrlCredentials(line);
  expect(out).not.toContain("ghp_SECRETTOKEN");
  expect(out).not.toContain("mike:");
  // The URL is still readable, which is the half the owner needs to diagnose anything.
  expect(out).toContain("https://github.com/o/r.git/");
});

test("scrubUrlCredentials strips a bare token@ userinfo too", () => {
  expect(scrubUrlCredentials("error: https://ghp_TOKEN@github.com/o/r")).toBe(
    "error: https://github.com/o/r",
  );
});

test("scrubUrlCredentials leaves an ssh remote's account name intact", () => {
  // `git@host` is an ACCOUNT NAME, not a secret. Stripping it would corrupt the message into one
  // naming a URL that does not exist.
  const line = "fatal: Could not read from remote repository ssh://git@github.com/o/r.git";
  expect(scrubUrlCredentials(line)).toBe(line);
});

// ── 3. a share guest does not receive raw exception text ─────────────────────────

const status = (over: Partial<RepoStatus>): RepoStatus =>
  ({
    branch: "main",
    dirty: 0,
    ahead: 0,
    behind: 0,
    remote: null,
    error: null,
    ...over,
  }) as RepoStatus;

test("guestStatus replaces an error message with a signal, not the detail", () => {
  const raw = "ENOENT: no such file or directory, open 'C:\\Users\\mike\\code\\secret-client\\.git\\HEAD'";
  const projected = guestStatus(status({ error: raw }));
  expect(projected?.error).toBeTruthy(); // the card still shows an error state
  expect(projected?.error).not.toContain("C:\\Users");
  expect(projected?.error).not.toContain("secret-client");
});

test("guestStatus keeps a clean repo's null error null", () => {
  expect(guestStatus(status({}))?.error).toBeNull();
});

test("guestStatus still strips a PAT out of the remote URL", () => {
  const projected = guestStatus(status({ remote: "https://mike:ghp_TOKEN@github.com/o/r.git" }));
  expect(projected?.remote).toBe("https://github.com/o/r.git");
});
