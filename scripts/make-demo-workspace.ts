#!/usr/bin/env bun
/**
 * make-demo-workspace.ts
 *
 * Fabricates a fake multi-repo workspace used ONLY for marketing screenshots
 * of the RepoYeti app. Deterministic and re-runnable: wipes and recreates the
 * target directory every time it runs.
 *
 * Usage:
 *   bun run scripts/make-demo-workspace.ts [targetDir]
 *   node --experimental-strip-types scripts/make-demo-workspace.ts [targetDir]
 *
 * Defaults to D:\repoyeti-shots-demo when no argv is given.
 *
 * Node/Bun stdlib only. No new dependencies.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Target directory validation
// ---------------------------------------------------------------------------

const DEFAULT_TARGET = "D:\\repoyeti-shots-demo";
const rawTarget = process.argv[2] && process.argv[2].trim().length > 0 ? process.argv[2] : DEFAULT_TARGET;
const target = resolve(rawTarget);

const FORBIDDEN_ROOTS = [resolve(tmpdir()), resolve("D:\\PublicProjects")];
for (const forbidden of FORBIDDEN_ROOTS) {
  const withSep = forbidden.endsWith(sep) ? forbidden : forbidden + sep;
  if (target === forbidden || target.startsWith(withSep)) {
    console.error(
      `Refusing to use "${target}": it is under a forbidden root ("${forbidden}"). ` +
        `RepoYeti hard-refuses to index temp paths, and this demo workspace must live ` +
        `outside D:\\PublicProjects as well. Pass a different target directory as argv[2].`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Author = { name: string; email: string };

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function gitQuiet(cwd: string, args: string[], env?: NodeJS.ProcessEnv): void {
  execFileSync("git", args, {
    cwd,
    env: env ?? process.env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
}

function commitAt(
  cwd: string,
  author: Author,
  isoDate: string,
  message: string,
): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  };
  gitQuiet(cwd, ["commit", "--quiet", "--no-gpg-sign", "-m", message], env);
}

/** Deterministic pseudo-random generator (mulberry32) so re-runs are stable. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: T[]): T {
  // The project runs with noUncheckedIndexedAccess, so an index read is `T | undefined`. Clamping
  // the index cannot prove non-emptiness to the compiler, so an empty array is rejected outright —
  // it is a caller bug here, and returning undefined would only push the failure somewhere worse.
  if (arr.length === 0) throw new Error("pick() called with an empty array");
  const value = arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
  if (value === undefined) throw new Error("pick() produced an out-of-range index");
  return value;
}

/** Indexed read that fails loudly rather than yielding `undefined` under noUncheckedIndexedAccess. */
function at<T>(arr: T[], i: number): T {
  const value = arr[i];
  if (value === undefined) throw new Error(`index ${i} out of range (length ${arr.length})`);
  return value;
}

/** Comment syntax varies by extension so appended filler stays syntactically valid. */
function commentLine(path: string, text: string): string {
  if (path.endsWith(".md")) return `<!-- ${text} -->`;
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return `# ${text}`;
  return `// ${text}`;
}

/** Files with no comment syntax (JSON has none) must never be filler targets. */
function isMutable(path: string): boolean {
  return !path.endsWith(".json");
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * Spread commit N of `total` over the last `spanDays`, oldest first, with jitter.
 *
 * The result is CLAMPED to the span. Unclamped jitter let the oldest commit drift past the
 * window (a "60 day" history rendering a `73d ago` row), which is exactly the sort of detail
 * that makes a screenshot read as fabricated.
 */
function makeCommitDates(rng: () => number, total: number, now: number, spanDays = 60): string[] {
  const spanMs = spanDays * 24 * 60 * 60 * 1000;
  const oldest = now - spanMs;
  const dates: number[] = [];
  for (let i = 0; i < total; i++) {
    // Base position spread evenly across the span, oldest -> newest.
    const frac = total === 1 ? 1 : i / (total - 1);
    const base = now - spanMs * (1 - frac);
    // Jitter within +/- half a day, and bias toward working hours.
    const jitter = (rng() - 0.5) * (spanMs / total) * 1.4;
    dates.push(Math.min(now - 1000, Math.max(oldest, base + jitter)));
  }
  dates.sort((a, b) => a - b);
  return dates.map((ms) => new Date(ms).toISOString());
}

// ---------------------------------------------------------------------------
// Fictional authors (never real people, never real domains)
// ---------------------------------------------------------------------------

// Named rather than indexed out of an array: under noUncheckedIndexedAccess every `ALL_AUTHORS[0]`
// is `Author | undefined`, which fails the project typecheck at each of the ~30 use sites.
const ADA: Author = { name: "Ada Lovelace", email: "ada@example.com" };
const GRACE: Author = { name: "Grace Hopper", email: "grace@example.com" };
const ALAN: Author = { name: "Alan Turing", email: "alan@example.com" };
const MARGARET: Author = { name: "Margaret Hamilton", email: "margaret@example.com" };
const KATHERINE: Author = { name: "Katherine Johnson", email: "katherine@example.com" };
const RADIA: Author = { name: "Radia Perlman", email: "radia@example.com" };


// ---------------------------------------------------------------------------
// Per-repo subject-matter commit message pools + starter files
// ---------------------------------------------------------------------------

interface RepoSpec {
  name: string;
  authors: Author[];
  messages: string[];
  files: Array<{ path: string; content: string }>;
  /** Extra commits added on a feature branch that gets merged with --no-ff. */
  featureBranch?: { branchName: string; messages: string[]; file: { path: string; content: string } };
}

const REPOS: RepoSpec[] = [
  {
    name: "api-gateway",
    authors: [ADA, GRACE, ALAN],
    messages: [
      "feat(routes): add /v1/orders passthrough route",
      "feat(auth): validate bearer tokens against JWKS cache",
      "fix(ratelimit): correct token bucket refill under burst load",
      "chore(deps): bump go.mod to go 1.22",
      "feat(gateway): add circuit breaker for upstream billing service",
      "fix(cors): allow credentials on preflight for dashboard origin",
      "refactor(middleware): extract logging middleware into own package",
      "feat(routes): add /v1/inventory read-through cache",
      "fix(healthcheck): report degraded when upstream latency > 500ms",
      "test(routes): add table-driven tests for order routing",
      "docs(readme): document required environment variables",
      "feat(observability): emit request duration histogram",
      "fix(gateway): close idle upstream connections on shutdown",
      "chore(ci): cache go modules between runs",
      "feat(routes): add /v1/notifications route",
      "fix(auth): reject expired tokens instead of silently passing",
      "refactor(config): load gateway config from single yaml file",
      "feat(gateway): add per-route request size limits",
    ],
    files: [
      {
        path: "go.mod",
        content: "module api-gateway\n\ngo 1.22\n\nrequire example.com/example/httprouter v1.4.0\n",
      },
      {
        path: "routes/orders.go",
        content:
          "package routes\n\nimport \"net/http\"\n\n// OrdersHandler proxies order requests to the orders service.\nfunc OrdersHandler(w http.ResponseWriter, r *http.Request) {\n\tw.Header().Set(\"Content-Type\", \"application/json\")\n\tw.WriteHeader(http.StatusOK)\n\tw.Write([]byte(`{\"status\":\"ok\"}`))\n}\n",
      },
      {
        path: "middleware/auth.go",
        content:
          "package middleware\n\nimport \"net/http\"\n\n// RequireAuth rejects requests without a valid bearer token.\nfunc RequireAuth(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\ttoken := r.Header.Get(\"Authorization\")\n\t\tif token == \"\" {\n\t\t\thttp.Error(w, \"missing token\", http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n",
      },
      {
        path: "config/gateway.yaml",
        content: "listenPort: 8080\nupstreams:\n  orders: http://orders.internal:9001\n  billing: http://billing.internal:9002\n",
      },
    ],
    featureBranch: {
      branchName: "feature/circuit-breaker",
      messages: [
        "feat(gateway): scaffold circuit breaker state machine",
        "feat(gateway): trip breaker after 5 consecutive failures",
        "test(gateway): add breaker half-open recovery test",
      ],
      file: {
        path: "middleware/breaker.go",
        content:
          "package middleware\n\n// Breaker is a minimal circuit breaker for upstream calls.\ntype Breaker struct {\n\tfailures  int\n\tthreshold int\n\topen      bool\n}\n\nfunc NewBreaker(threshold int) *Breaker {\n\treturn &Breaker{threshold: threshold}\n}\n\nfunc (b *Breaker) RecordFailure() {\n\tb.failures++\n\tif b.failures >= b.threshold {\n\t\tb.open = true\n\t}\n}\n\nfunc (b *Breaker) Allow() bool {\n\treturn !b.open\n}\n",
      },
    },
  },
  {
    name: "docs-site",
    authors: [MARGARET, KATHERINE, ADA],
    messages: [
      "docs(getting-started): rewrite install instructions",
      "docs(api): document pagination query params",
      "content(blog): add post about the new dashboard release",
      "fix(nav): correct broken link in sidebar",
      "docs(faq): add section on rate limits",
      "content(changelog): backfill v2 changelog entries",
      "docs(auth): clarify token expiry behavior",
      "fix(search): reindex pages after build",
      "docs(webhooks): add signature verification example",
      "content(guides): add guide for migrating from v1 to v2",
      "docs(readme): update badges and quickstart snippet",
      "fix(images): compress hero images for faster loads",
      "docs(api): document error response shape",
      "content(blog): announce payments-api public beta",
      "docs(contributing): add style guide for docs authors",
    ],
    files: [
      {
        path: "docs/getting-started.md",
        content: "# Getting Started\n\nInstall the CLI and authenticate:\n\n```\nnpm install -g examplectl\nexamplectl login\n```\n",
      },
      {
        path: "docs/api/pagination.md",
        content: "# Pagination\n\nAll list endpoints accept `cursor` and `limit` query params. `limit` defaults to 20 and maxes out at 100.\n",
      },
      {
        path: "content/blog/2026-dashboard-release.md",
        content: "---\ntitle: The new dashboard is live\ndate: 2026-06-01\n---\n\nWe rebuilt the dashboard from scratch. Here is what changed.\n",
      },
      {
        path: "package.json",
        content: "{\n  \"name\": \"docs-site\",\n  \"private\": true,\n  \"scripts\": {\n    \"build\": \"docs-builder build\"\n  }\n}\n",
      },
    ],
  },
  {
    name: "infra-cdk",
    authors: [GRACE, ALAN, RADIA],
    messages: [
      "feat(vpc): add three-az vpc stack",
      "feat(rds): provision postgres instance with automated backups",
      "chore(cdk): bump aws-cdk-lib to 2.140.0",
      "feat(ecs): add fargate service for api-gateway",
      "fix(iam): scope down task execution role permissions",
      "feat(cdn): add cloudfront distribution for static assets",
      "feat(monitoring): add cloudwatch alarms for 5xx rate",
      "fix(rds): enable storage autoscaling",
      "feat(secrets): move db credentials to secrets manager",
      "refactor(stacks): split network stack from compute stack",
      "feat(dns): add hosted zone and health-checked records",
      "fix(ecs): correct container health check path",
      "chore(ci): add cdk diff check on pull requests",
    ],
    files: [
      {
        path: "lib/network-stack.ts",
        content:
          "import { Stack, StackProps } from \"aws-cdk-lib\";\nimport { Construct } from \"constructs\";\n\nexport class NetworkStack extends Stack {\n  constructor(scope: Construct, id: string, props?: StackProps) {\n    super(scope, id, props);\n    // VPC with 3 availability zones, public + private subnets.\n  }\n}\n",
      },
      {
        path: "lib/compute-stack.ts",
        content:
          "import { Stack, StackProps } from \"aws-cdk-lib\";\nimport { Construct } from \"constructs\";\n\nexport class ComputeStack extends Stack {\n  constructor(scope: Construct, id: string, props?: StackProps) {\n    super(scope, id, props);\n    // Fargate service running api-gateway behind an ALB.\n  }\n}\n",
      },
      {
        path: "cdk.json",
        content: "{\n  \"app\": \"npx ts-node bin/infra.ts\",\n  \"context\": {\n    \"env\": \"production\"\n  }\n}\n",
      },
      {
        path: "config/alarms.yaml",
        content: "alarms:\n  - name: gateway-5xx-rate\n    threshold: 0.05\n    period: 60\n  - name: rds-cpu\n    threshold: 80\n    period: 300\n",
      },
    ],
  },
  {
    name: "mobile-app",
    authors: [KATHERINE, ADA, MARGARET],
    messages: [
      "feat(onboarding): add three-step onboarding carousel",
      "fix(push): register device token after login instead of at launch",
      "feat(profile): add avatar upload with crop step",
      "fix(nav): prevent double-push on rapid tab taps",
      "feat(offline): cache last known feed for offline viewing",
      "chore(deps): upgrade react-native to 0.74",
      "fix(ios): correct safe-area inset on notch devices",
      "feat(notifications): add in-app notification center",
      "fix(android): fix keyboard overlap on login form",
      "feat(settings): add dark mode toggle",
      "fix(profile): avatar upload retries on network failure",
      "refactor(navigation): migrate to typed navigation params",
      "feat(search): add recent searches list",
      "fix(onboarding): skip carousel for returning users",
      "test(profile): add snapshot tests for avatar cropper",
      "feat(feed): add pull-to-refresh haptic feedback",
    ],
    files: [
      {
        path: "src/screens/OnboardingScreen.tsx",
        content:
          "import React from \"react\";\nimport { View, Text } from \"react-native\";\n\nexport function OnboardingScreen() {\n  return (\n    <View>\n      <Text>Welcome</Text>\n    </View>\n  );\n}\n",
      },
      {
        path: "src/screens/ProfileScreen.tsx",
        content:
          "import React from \"react\";\nimport { View, Text } from \"react-native\";\n\nexport function ProfileScreen() {\n  return (\n    <View>\n      <Text>Your profile</Text>\n    </View>\n  );\n}\n",
      },
      {
        path: "src/navigation/types.ts",
        content: "export type RootStackParamList = {\n  Onboarding: undefined;\n  Profile: { userId: string };\n  Settings: undefined;\n};\n",
      },
      {
        path: "package.json",
        content: "{\n  \"name\": \"mobile-app\",\n  \"private\": true,\n  \"dependencies\": {\n    \"react-native\": \"0.74.0\"\n  }\n}\n",
      },
    ],
  },
  {
    name: "payments-api",
    authors: [ALAN, RADIA, GRACE],
    messages: [
      "feat(refunds): add partial refund support",
      "feat(webhooks): sign outgoing webhook payloads",
      "fix(charges): round currency amounts to two decimals",
      "feat(payouts): add scheduled payout batching",
      "fix(refunds): prevent double refund on retried request",
      "feat(webhooks): retry failed deliveries with backoff",
      "refactor(charges): extract fee calculation into own module",
      "fix(payouts): correct timezone used for batch cutoff",
      "feat(disputes): add dispute evidence upload endpoint",
      "test(refunds): add tests for partial refund edge cases",
      "fix(webhooks): include idempotency key in signed payload",
      "feat(charges): support multi-currency charges",
      "chore(deps): bump stripe-like sdk to 4.2.0",
      "fix(disputes): return 404 for unknown dispute id",
      "docs(readme): document webhook signature verification",
      "feat(refunds): add refund reason enum",
      "fix(charges): reject negative charge amounts",
      "perf(payouts): batch payout writes in a single transaction",
    ],
    files: [
      {
        path: "src/refunds.ts",
        content:
          "export interface RefundRequest {\n  chargeId: string;\n  amountCents: number;\n  reason: \"requested_by_customer\" | \"duplicate\" | \"fraudulent\";\n}\n\n// Calculates the refundable amount for a charge, capped at the\n// original charge amount minus any refunds already issued.\nexport function calculateRefundAmount(\n  chargeAmountCents: number,\n  alreadyRefundedCents: number,\n  requestedCents: number,\n): number {\n  const remaining = chargeAmountCents - alreadyRefundedCents;\n  return Math.min(requestedCents, remaining);\n}\n",
      },
      {
        path: "src/webhooks.ts",
        content:
          "import { createHmac } from \"node:crypto\";\n\nexport function signPayload(payload: string, secret: string): string {\n  return createHmac(\"sha256\", secret).update(payload).digest(\"hex\");\n}\n",
      },
      {
        path: "src/charges.ts",
        content:
          "export function roundToCents(amount: number): number {\n  return Math.round(amount * 100) / 100;\n}\n",
      },
      {
        path: "package.json",
        content: "{\n  \"name\": \"payments-api\",\n  \"private\": true,\n  \"version\": \"1.4.0\"\n}\n",
      },
    ],
    featureBranch: {
      branchName: "feature/dispute-evidence",
      messages: [
        "feat(disputes): scaffold evidence upload endpoint",
        "feat(disputes): validate evidence file type and size",
        "test(disputes): add evidence upload integration test",
      ],
      file: {
        path: "src/disputes.ts",
        content:
          "export interface DisputeEvidence {\n  disputeId: string;\n  fileName: string;\n  mimeType: string;\n}\n\nconst ALLOWED_MIME_TYPES = new Set([\"application/pdf\", \"image/png\", \"image/jpeg\"]);\n\nexport function validateEvidence(evidence: DisputeEvidence): boolean {\n  return ALLOWED_MIME_TYPES.has(evidence.mimeType);\n}\n",
      },
    },
  },
  {
    name: "web-dashboard",
    authors: [ADA, MARGARET, KATHERINE],
    messages: [
      "feat(charts): add revenue over time chart",
      "fix(table): correct sort order for currency columns",
      "feat(filters): add date-range filter to activity view",
      "chore(deps): upgrade vite to 5.x",
      "feat(auth): add sso login option",
      "fix(charts): fix tooltip positioning near edges",
      "feat(export): add csv export for transactions table",
      "refactor(state): migrate transactions store to signals",
      "fix(nav): keep sidebar scroll position on route change",
      "feat(dashboard): add empty state for new workspaces",
      "test(table): add unit tests for currency sort comparator",
      "fix(export): escape commas in exported csv fields",
      "feat(charts): add weekly/monthly toggle",
      "fix(auth): handle expired sso session gracefully",
      "docs(readme): add local dev setup steps",
      "feat(filters): persist filters in url query string",
      "fix(dashboard): correct loading skeleton height",
      "perf(table): virtualize long transaction lists",
      "feat(notifications): add toast for failed exports",
      "fix(charts): avoid divide-by-zero on empty dataset",
    ],
    files: [
      {
        path: "src/components/RevenueChart.tsx",
        content:
          "import React from \"react\";\n\nexport function RevenueChart({ points }: { points: number[] }) {\n  return <div data-testid=\"revenue-chart\">{points.length} points</div>;\n}\n",
      },
      {
        path: "src/components/TransactionsTable.tsx",
        content:
          "import React from \"react\";\n\nexport function TransactionsTable() {\n  return <table><tbody /></table>;\n}\n",
      },
      {
        path: "src/lib/exportCsv.ts",
        content:
          "export function toCsv(rows: Record<string, string | number>[]): string {\n  if (rows.length === 0) return \"\";\n  const headers = Object.keys(rows[0]);\n  const lines = rows.map((row) => headers.map((h) => String(row[h])).join(\",\"));\n  return [headers.join(\",\"), ...lines].join(\"\\n\");\n}\n",
      },
      {
        path: "package.json",
        content: "{\n  \"name\": \"web-dashboard\",\n  \"private\": true,\n  \"dependencies\": {\n    \"vite\": \"5.2.0\"\n  }\n}\n",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Per-repo dirty/ahead state after the shared history + origin setup
// ---------------------------------------------------------------------------

type DirtyPlan = {
  extraCommits?: number; // commits made after pushing to origin (ahead state)
  modifiedFile?: string; // path (relative) to touch and leave modified, unstaged
  /** Replace the whole file's contents (clean function-level diff) instead of appending filler. */
  modifiedFileContent?: string;
  stagedFile?: { path: string; content: string }; // new file staged but not committed
};

const DIRTY_PLANS: Record<string, DirtyPlan> = {
  "api-gateway": { extraCommits: 2, modifiedFile: "config/gateway.yaml" },
  "docs-site": { modifiedFile: "docs/getting-started.md" },
  "infra-cdk": {},
  "mobile-app": { extraCommits: 1 },
  "payments-api": {
    modifiedFile: "src/refunds.ts",
    modifiedFileContent:
      "export interface RefundRequest {\n  chargeId: string;\n  amountCents: number;\n  reason: \"requested_by_customer\" | \"duplicate\" | \"fraudulent\";\n}\n\n// Calculates the refundable amount for a charge, capped at the\n// original charge amount minus any refunds already issued. Never\n// returns a negative amount, even if prior refunds exceed the charge.\nexport function calculateRefundAmount(\n  chargeAmountCents: number,\n  alreadyRefundedCents: number,\n  requestedCents: number,\n): number {\n  const remaining = Math.max(0, chargeAmountCents - alreadyRefundedCents);\n  return Math.min(requestedCents, remaining);\n}\n",
    stagedFile: { path: "src/idempotency.ts", content: "export const IDEMPOTENCY_HEADER = \"Idempotency-Key\";\n" },
  },
  "web-dashboard": { extraCommits: 5 },
};

// ---------------------------------------------------------------------------
// Repo builder
// ---------------------------------------------------------------------------

interface RepoSummary {
  name: string;
  commits: number;
  branch: string;
  state: string;
}

function buildRepo(repoDir: string, spec: RepoSpec, now: number): RepoSummary {
  mkdirSync(repoDir, { recursive: true });

  const primary = spec.authors[0];
  if (!primary) throw new Error(`repo ${spec.name} declares no authors`);
  gitQuiet(repoDir, ["init", "--quiet", "--initial-branch=main"]);
  gitQuiet(repoDir, ["config", "user.name", primary.name]);
  gitQuiet(repoDir, ["config", "user.email", primary.email]);
  gitQuiet(repoDir, ["config", "init.defaultBranch", "main"]);
  gitQuiet(repoDir, ["config", "commit.gpgsign", "false"]);

  const rng = makeRng(hashSeed(spec.name));
  const commitCount = randInt(rng, 12, 25);
  const dates = makeCommitDates(rng, commitCount, now);

  // Write starter files once, then commit them progressively so each commit
  // has something plausible to show even though the working tree is small.
  for (const file of spec.files) {
    const full = join(repoDir, file.path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, file.content, "utf8");
  }
  // Ignore the local bare "origin" dir up front so it never shows up as
  // untracked clutter in `git status` (would otherwise wreck the "fully
  // clean" / "N modified" states this script is deliberately setting up).
  writeFileSync(join(repoDir, ".gitignore"), ".origins/\n", "utf8");

  let commitsMade = 0;

  // First commit: initial scaffold with all starter files.
  gitQuiet(repoDir, ["add", "-A"]);
  commitAt(repoDir, pick(rng, spec.authors), at(dates, 0), "chore(init): scaffold project");
  commitsMade++;

  // Remaining commits: cycle through message pool, touching a file each time
  // with a small realistic-looking change (append a comment / bump a value)
  // so the diffs are non-empty.
  const pool = spec.messages.slice();
  // The file reserved for this repo's final uncommitted diff is kept pristine
  // throughout history so that diff reads as one clean, readable change.
  const protectedPath = DIRTY_PLANS[spec.name]?.modifiedFile;
  const mutableFiles = spec.files.filter((f) => isMutable(f.path) && f.path !== protectedPath);
  for (let i = 1; i < commitCount; i++) {
    const message = at(pool, (i - 1) % pool.length);
    const author = pick(rng, spec.authors);
    const targetFile = pick(rng, mutableFiles);
    const full = join(repoDir, targetFile.path);
    appendFileSync(full, `\n${commentLine(targetFile.path, message)}\n`, "utf8");
    gitQuiet(repoDir, ["add", "-A"]);
    // `git commit --allow-empty` isn't needed: appendFileSync always changes something.
    commitAt(repoDir, author, at(dates, i), message);
    commitsMade++;
  }

  // Feature branch + true merge commit for repos that specify one.
  if (spec.featureBranch) {
    const fb = spec.featureBranch;
    gitQuiet(repoDir, ["checkout", "-b", fb.branchName]);
    // A SHORT-LIVED branch: its commits sit in the ~10 days before the merge. Spreading them over
    // the full 60-day span made the branch older than the trunk commits it merges into, so the
    // graph showed a branch dated `73d ago` merging alongside `1d ago` mainline work.
    const branchDates = makeCommitDates(
      rng,
      fb.messages.length,
      now - 2 * 24 * 60 * 60 * 1000,
      10,
    );
    const full = join(repoDir, fb.file.path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, fb.file.content, "utf8");
    gitQuiet(repoDir, ["add", "-A"]);
    commitAt(repoDir, pick(rng, spec.authors), at(branchDates, 0), at(fb.messages, 0));
    commitsMade++;
    for (let i = 1; i < fb.messages.length; i++) {
      appendFileSync(full, `\n// ${fb.messages[i]}\n`, "utf8");
      gitQuiet(repoDir, ["add", "-A"]);
      commitAt(repoDir, pick(rng, spec.authors), at(branchDates, i), at(fb.messages, i));
      commitsMade++;
    }
    gitQuiet(repoDir, ["checkout", "main"]);
    const mergeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: primary.name,
      GIT_AUTHOR_EMAIL: primary.email,
      GIT_COMMITTER_NAME: primary.name,
      GIT_COMMITTER_EMAIL: primary.email,
      GIT_AUTHOR_DATE: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
      GIT_COMMITTER_DATE: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
    };
    gitQuiet(repoDir, [
      "merge",
      "--no-ff",
      "--no-gpg-sign",
      "-m",
      `merge: bring in ${fb.branchName}`,
      fb.branchName,
    ], mergeEnv);
    commitsMade++;
  }

  // Set up a local bare "origin" so ahead/behind is real, not cosmetic.
  const originsDir = join(repoDir, ".origins");
  mkdirSync(originsDir, { recursive: true });
  const bareDir = join(originsDir, `${spec.name}.git`);
  gitQuiet(repoDir, ["init", "--quiet", "--bare", "--initial-branch=main", bareDir]);
  gitQuiet(repoDir, ["remote", "add", "origin", bareDir]);
  // `-u` is what makes ahead/behind real: without an upstream, `git status` reports no tracking
  // branch and the dashboard's ↑/↓ badges have nothing to count, so every repo reads as clean.
  gitQuiet(repoDir, ["push", "--quiet", "-u", "origin", "main"]);

  // Apply the dirty/ahead plan for this repo.
  const plan = DIRTY_PLANS[spec.name] ?? {};
  if (plan.extraCommits && plan.extraCommits > 0) {
    for (let i = 0; i < plan.extraCommits; i++) {
      const targetFile = pick(rng, mutableFiles);
      const full = join(repoDir, targetFile.path);
      appendFileSync(full, `\n${commentLine(targetFile.path, `local work-in-progress commit ${i + 1}`)}\n`, "utf8");
      gitQuiet(repoDir, ["add", "-A"]);
      const when = new Date(now - (plan.extraCommits - i) * 60 * 60 * 1000).toISOString();
      commitAt(
        repoDir,
        pick(rng, spec.authors),
        when,
        `wip: local change ${i + 1} not yet pushed`,
      );
      commitsMade++;
    }
  }
  if (plan.stagedFile) {
    const full = join(repoDir, plan.stagedFile.path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, plan.stagedFile.content, "utf8");
    gitQuiet(repoDir, ["add", plan.stagedFile.path]);
  }
  if (plan.modifiedFile) {
    const full = join(repoDir, plan.modifiedFile);
    if (plan.modifiedFileContent !== undefined) {
      writeFileSync(full, plan.modifiedFileContent, "utf8");
    } else {
      appendFileSync(full, `\n${commentLine(plan.modifiedFile, "TODO: revisit this before shipping")}\n`, "utf8");
    }
  }

  const branch = git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const stateParts: string[] = [];
  if (plan.extraCommits) stateParts.push(`${plan.extraCommits} ahead`);
  if (plan.stagedFile) stateParts.push("1 staged");
  if (plan.modifiedFile) stateParts.push("1 modified");
  const state = stateParts.length > 0 ? stateParts.join(", ") : "clean";

  return { name: spec.name, commits: commitsMade, branch, state };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    console.error("git is not available on PATH. Install git and try again.");
    process.exit(1);
  }

  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(target, { recursive: true });

  const now = Date.now();
  const summaries: RepoSummary[] = [];

  for (const spec of REPOS) {
    const repoDir = join(target, spec.name);
    try {
      const summary = buildRepo(repoDir, spec, now);
      summaries.push(summary);
    } catch (err) {
      console.error(`Failed to build repo "${spec.name}":`, err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }

  console.log(`\nDemo workspace created at: ${target}\n`);
  for (const s of summaries) {
    console.log(`${s.name}: ${s.commits} commits, branch ${s.branch}, ${s.state}`);
  }
}

main();
