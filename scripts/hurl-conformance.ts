#!/usr/bin/env bun
/**
 * Black-box conformance suite for the daemon's HTTP API, written as plain-text Hurl files.
 *
 * WHY THIS EXISTS. The route tests in tests/ drive `createApp().request()` in-process, so they can
 * never tell a client author (or a post-deploy smoke) whether a REAL daemon, reached over a real
 * socket, still answers the documented API. tests/hurl/*.hurl is that contract in a form a human
 * or an agent reads without the codebase: one file per resource, each request followed by the
 * status and JSON shape it must return. Every run gets its own `uid`, and anything the suite
 * creates is named `hurl-<uid>` and deleted again, so it is safe to point at a daemon you use.
 *
 * Two modes:
 *
 *   bun run conformance [--host <url>] [hurl args...]
 *     Runs the suite with the `hurl` binary (https://hurl.dev, installed separately; it is a test
 *     tool, never a runtime dependency) against --host, else REPOYETI_BASE_URL, else the running
 *     local daemon. REPOYETI_TOKEN, when set, is sent as a Bearer token so the same suite works
 *     through a tunnel. Any other arguments pass straight through to hurl.
 *
 *   bun run check:hurl
 *     Static drift check, no daemon and no hurl needed: every request in the suite must be
 *     host-relative (`{{base}}/...`) and must resolve to a route documented in src/http/openapi.ts.
 *     A renamed or removed route therefore fails here, in CI, instead of on somebody's host later.
 *     It also prints how many documented operations the suite exercises.
 *
 * DELIBERATELY NOT FLAGGED: documented routes the suite does not exercise. Most mutating routes
 * need a real repository and would change it; the suite covers what is safe against a live host,
 * and the coverage line reports the rest rather than failing on it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { META } from "../src/http/openapi.ts";
import { resolveBaseUrl } from "../src/cli/client.ts";

const ROOT = join(import.meta.dir, "..");
export const SUITE_DIR = join(ROOT, "tests", "hurl");

/** One request line found in a .hurl file. */
export interface HurlRequest {
  file: string;
  line: number;
  method: string;
  url: string;
}

/** A request the drift check rejects, with the reason in words. */
export interface HurlDrift {
  request: HurlRequest;
  problem: string;
}

export interface HurlAudit {
  requests: HurlRequest[];
  drift: HurlDrift[];
  /** Documented `"<METHOD> <hono-path>"` keys at least one request resolves to. */
  covered: Set<string>;
}

const REQUEST_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/;

/** Every request line in one Hurl file. Hurl requires the method at column 0. */
export function parseHurlRequests(text: string, file: string): HurlRequest[] {
  const out: HurlRequest[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = REQUEST_LINE.exec(lines[i]!);
    if (m) out.push({ file, line: i + 1, method: m[1]!, url: m[2]! });
  }
  return out;
}

/**
 * Does a Hurl path match a documented Hono path? A `:param` segment accepts any value; a templated
 * Hurl segment (`{{identity_id}}`) only matches a `:param`, never a literal, since its runtime value
 * is unknown here.
 */
function pathMatches(hurlPath: string, honoPath: string): boolean {
  const got = hurlPath.split("/");
  const want = honoPath.split("/");
  if (got.length !== want.length) return false;
  return want.every((seg, i) => {
    const actual = got[i]!;
    if (seg.startsWith(":")) return actual.length > 0;
    return !actual.includes("{{") && actual === seg;
  });
}

/** Check a set of Hurl files against the documented routes (`"<METHOD> <hono-path>"` keys). */
export function auditHurlSuite(files: Array<{ file: string; text: string }>, documented: Iterable<string>): HurlAudit {
  const routes = [...documented].map((key) => {
    const [method, path] = key.split(" ") as [string, string];
    return { key, method, path, params: path.split("/").filter((s) => s.startsWith(":")).length };
  });
  const requests = files.flatMap(({ file, text }) => parseHurlRequests(text, file));
  const drift: HurlDrift[] = [];
  const covered = new Set<string>();

  for (const request of requests) {
    if (!request.url.startsWith("{{base}}/")) {
      drift.push({ request, problem: "URL must start with {{base}}/ so the suite runs against any host" });
      continue;
    }
    const path = request.url.slice("{{base}}".length).split("?")[0]!;
    // Most specific wins: a literal segment beats a `:param` one when both would match.
    const match = routes
      .filter((r) => r.method === request.method && pathMatches(path, r.path))
      .sort((a, b) => a.params - b.params)[0];
    if (match) covered.add(match.key);
    else drift.push({ request, problem: `${request.method} ${path} is not a documented route` });
  }
  return { requests, drift, covered };
}

/** The committed suite, one entry per .hurl file, in a stable order. */
export function loadHurlSuite(dir: string = SUITE_DIR): Array<{ file: string; text: string }> {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".hurl"))
    .sort()
    .map((name) => ({ file: `tests/hurl/${name}`, text: readFileSync(join(dir, name), "utf8") }));
}

function report(audit: HurlAudit, documentedCount: number): void {
  console.log(
    `hurl suite: ${audit.requests.length} requests exercise ${audit.covered.size} of ${documentedCount} documented operations`,
  );
  for (const d of audit.drift) console.error(`  ${d.request.file}:${d.request.line}  ${d.problem}`);
}

/** A fresh per-run namespace, so fixtures from two runs (or a half-finished one) never collide. */
function runUid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const documented = Object.keys(META);
  const suite = loadHurlSuite();
  const audit = auditHurlSuite(suite, documented);
  report(audit, documented.length);
  if (audit.drift.length > 0) {
    console.error(`✗ ${audit.drift.length} request(s) in tests/hurl drifted from the documented API`);
    process.exit(1);
  }
  if (args.includes("--check")) process.exit(0);

  const hurl = Bun.which("hurl");
  if (!hurl) {
    console.error("✗ hurl is not installed. Install it from https://hurl.dev, then re-run.");
    process.exit(2);
  }

  const hostAt = args.indexOf("--host");
  const host = hostAt >= 0 ? args[hostAt + 1] : undefined;
  const passThrough = hostAt >= 0 ? args.filter((_, i) => i !== hostAt && i !== hostAt + 1) : args;
  let base: string;
  try {
    base = host ? host.replace(/\/+$/, "") : await resolveBaseUrl();
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const uid = runUid();
  const hurlArgs = ["--test", "--variable", `base=${base}`, "--variable", `uid=${uid}`];
  const token = process.env.REPOYETI_TOKEN?.trim();
  if (token) hurlArgs.push("--header", `Authorization: Bearer ${token}`);

  console.log(`running against ${base} (uid ${uid}${token ? ", bearer token from REPOYETI_TOKEN" : ""})`);
  const child = Bun.spawn([hurl, ...hurlArgs, ...passThrough, ...suite.map((s) => join(ROOT, s.file))], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await child.exited);
}
