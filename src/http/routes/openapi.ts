import type { Hono } from "hono";
import type { Deps } from "../deps.ts";
import { buildOpenApiDoc } from "../openapi.ts";

export function register(app: Hono, _deps: Deps): void {
  // Public, unauthenticated machine-readable API description. The handler reads `app.routes` at
  // request time, so it reflects every route regardless of registration order. See src/auth.ts
  // (this path is in the authMiddleware allowlist) and src/http/openapi.ts.
  app.get("/api/openapi.json", (c) => c.json(buildOpenApiDoc(app)));
}
