/**
 * Test-mode response validation: every real JSON answer is checked against the schema the OpenAPI
 * document declares for it (idea adapted from Bitcoin Core's -rpcdoccheck, src/rpc/util.cpp: each
 * RPC's result is matched against its declared RPCResult whenever the functional tests run).
 *
 * WHY: the spec's request side is parsed by the handler itself, so it cannot drift, but nothing read
 * the response side back. A handler could rename `absPath`, drop `code`, or answer an error without a
 * `message`, and the doc, the dashboard's types and every agent reading /api/openapi.json would all
 * keep promising the old shape. With this on, every route test that goes through createApp() is
 * also a contract test for the document, at zero production cost: the middleware is not even
 * registered unless REPOYETI_RESPONSE_CHECK=1 (tests/setup.ts sets it for the whole daemon suite).
 *
 * On a mismatch the real body is REPLACED by a 500 that names the route, the status and the first
 * offending field, the same "internal bug" stance Bitcoin takes: a test asserting on the old body
 * then fails loudly at the route that drifted, instead of passing on a shape the doc no longer
 * describes. It is logged too, for the tests that only look at the status.
 *
 * DELIBERATELY NOT CHECKED: non-JSON bodies (SSE, file bytes, redirects, the static PWA) and 2xx
 * routes whose META entry declares no `response`: the doc makes no claim there, so there is nothing
 * to hold it to. Unknown extra fields are allowed (response-schemas.ts explains why).
 */
import type { MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { z } from "zod";
import { declaredResponseSchema } from "./openapi.ts";

/** The opt-in switch. An explicit flag rather than NODE_ENV so `bun run dev` can turn it on too. */
export function responseCheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.REPOYETI_RESPONSE_CHECK === "1";
}

/** "repos.0.absPath: expected string, received undefined" for the first issue, or null when valid. */
export function describeMismatch(schema: z.ZodType, body: unknown): string | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  if (!issue) return "invalid";
  const where = issue.path.length ? issue.path.join(".") : "(body)";
  return `${where}: ${issue.message}`;
}

/**
 * The route Hono actually dispatched to: the first matched non-middleware entry for this method.
 * HEAD is served by the GET handler, so it is looked up as GET.
 */
function dispatchedPath(c: Parameters<MiddlewareHandler>[0]): string | null {
  const method = c.req.method === "HEAD" ? "GET" : c.req.method;
  const route = matchedRoutes(c).find((r) => r.method === method);
  return route ? route.path : null;
}

export function responseCheck(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) return;
    const path = dispatchedPath(c);
    if (!path) return;
    const method = c.req.method === "HEAD" ? "GET" : c.req.method;
    const schema = declaredResponseSchema(method, path, res.status);
    if (!schema) return;

    let body: unknown;
    try {
      body = await res.clone().json();
    } catch {
      body = undefined; // a JSON content-type with an unparsable body is drift too
    }
    const problem = describeMismatch(schema, body);
    if (!problem) return;

    const message = `response schema drift: ${method} ${path} -> ${res.status}: ${problem}`;
    console.error(`[response-check] ${message}`);
    // Clear first: Hono's res setter copies the old response's headers onto the new one.
    c.res = undefined;
    c.res = new Response(JSON.stringify({ ok: false, code: "ERROR", message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  };
}
