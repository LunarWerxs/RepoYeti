/**
 * POST /api/pulse — the anonymous product pulse in src/http/routes/updates.ts.
 *
 * The thing worth pinning down is that it stays SILENT by default: with no collector configured
 * it must not reach the network at all, and it must not mint or persist an install id. Everything
 * else here is the opt-in path — what actually goes over the wire once an endpoint is set, and
 * that a collector being down is reported rather than thrown.
 *
 * (The sibling update routes are deliberately not exercised: `GET /api/updates` and
 * `POST /api/updates/apply` drive the real updater against this very checkout — `git ls-remote`,
 * `bun install`, a web build — which a test run must never trigger.)
 */
import { test, expect } from "bun:test";
import { createApp } from "../src/http/app.ts";
import type { RepoYetiConfig } from "../src/config.ts";

const cfg = (): RepoYetiConfig => ({ roots: [], port: 7171, maxDepth: 6, maxRepos: 200 });

const PULSE_ENV = [
  "REPOYETI_PULSE_URL",
  "CONNECTIONS_PULSE_URL",
  "REPOYETI_PULSE_TOKEN",
  "CONNECTIONS_PULSE_TOKEN",
] as const;

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Run `fn` with a clean pulse environment and a captured `fetch`, restoring both afterwards. */
async function withCollector(
  env: Partial<Record<(typeof PULSE_ENV)[number], string>>,
  respond: (() => Response) | "throw",
  fn: (sent: Sent[], app: ReturnType<typeof createApp>, config: RepoYetiConfig) => Promise<void>,
): Promise<void> {
  const previous = new Map(PULSE_ENV.map((name) => [name, process.env[name]]));
  for (const name of PULSE_ENV) delete process.env[name];
  for (const [name, value] of Object.entries(env)) process.env[name] = value;

  const sent: Sent[] = [];
  const realFetch = globalThis.fetch;
  // Only the collector is intercepted. `fetch` is process-global and bun runs the suite in one
  // process, so anything else in flight while this test is running (an SSE reconnect, a tunnel
  // probe) has to keep reaching the real implementation, or this file would fail other files.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes(".invalid/")) return realFetch(input as RequestInfo, init);
    sent.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    if (respond === "throw") throw new Error("collector unreachable");
    return respond();
  }) as typeof fetch;

  const config = cfg();
  try {
    await fn(sent, createApp(config), config);
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const pulse = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("with no collector configured the pulse is inert — no request, no install id", async () => {
  await withCollector({}, () => new Response("{}"), async (sent, app, config) => {
    const res = await app.request("/api/pulse", pulse({ event: "boot" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: false });
    expect(sent).toEqual([]);
    // Nothing was minted, so an install that never opts in stays unidentified on disk.
    expect(config.pulse?.installId).toBeUndefined();
  });
});

test("an opted-in pulse posts the event with a stable install id", async () => {
  await withCollector(
    { REPOYETI_PULSE_URL: "https://collector.invalid/pulse" },
    () => new Response("{}", { status: 200 }),
    async (sent, app, config) => {
      const first = await app.request("/api/pulse", pulse({ event: "boot", properties: { via: "test" } }));
      expect(await first.json()).toEqual({ ok: true, enabled: true });

      expect(sent.length).toBe(1);
      expect(sent[0]!.url).toBe("https://collector.invalid/pulse");
      expect(sent[0]!.body.app).toBe("repoyeti");
      expect(sent[0]!.body.event).toBe("boot");
      expect(sent[0]!.body.properties).toEqual({ via: "test" });
      expect(typeof sent[0]!.body.installId).toBe("string");
      expect(typeof sent[0]!.body.ts).toBe("string");
      // No token configured → no authorization header invented.
      expect(sent[0]!.headers.authorization).toBeUndefined();

      // The id identifies the install across events, so it must not be re-minted per pulse.
      await app.request("/api/pulse", pulse({ event: "second" }));
      expect(sent[1]!.body.installId).toBe(sent[0]!.body.installId);
      expect(config.pulse?.installId).toBe(sent[0]!.body.installId as string);
    },
  );
});

test("the shared Connections collector + token are honoured as the fallback", async () => {
  await withCollector(
    { CONNECTIONS_PULSE_URL: "https://shared.invalid/pulse", CONNECTIONS_PULSE_TOKEN: "sekrit" },
    () => new Response("{}"),
    async (sent, app) => {
      await app.request("/api/pulse", pulse({ event: "boot" }));
      expect(sent[0]!.url).toBe("https://shared.invalid/pulse");
      expect(sent[0]!.headers.authorization).toBe("Bearer sekrit");
    },
  );
});

test("a collector that rejects or is unreachable is reported, never thrown", async () => {
  await withCollector(
    { REPOYETI_PULSE_URL: "https://collector.invalid/pulse" },
    () => new Response("nope", { status: 503 }),
    async (_sent, app) => {
      const res = await app.request("/api/pulse", pulse({ event: "boot" }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, enabled: true });
    },
  );

  await withCollector(
    { REPOYETI_PULSE_URL: "https://collector.invalid/pulse" },
    "throw",
    async (_sent, app) => {
      const res = await app.request("/api/pulse", pulse({ event: "boot" }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, enabled: true });
    },
  );
});

test("a pulse with no body at all is accepted rather than 500ing", async () => {
  await withCollector({}, () => new Response("{}"), async (_sent, app) => {
    const res = await app.request("/api/pulse", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: false });
  });
});
