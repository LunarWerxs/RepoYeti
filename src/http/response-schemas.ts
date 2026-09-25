/**
 * Declared RESPONSE shapes for the HTTP API: the other half of the OpenAPI document.
 *
 * WHY this exists: the request side of every mutating route was already honest (openapi.ts documents
 * the same Zod schema the handler parses), but the response side said only "200: Success". Nothing
 * proved a handler still returned what the dashboard, the CLI verbs and agents read out of it, so a
 * renamed or dropped field shipped silently and surfaced as an `undefined` three layers away.
 *
 * Each schema here is used twice, from one source:
 *   - openapi.ts renders it into the route's 2xx response (`z.toJSONSchema`), so agents see it;
 *   - response-check.ts validates every real JSON response against it when REPOYETI_RESPONSE_CHECK=1
 *     (tests/setup.ts always sets it), so every route test is also a contract test for the doc.
 *
 * Objects are LOOSE on purpose: a schema pins the fields a caller relies on, and a handler may add
 * more (a guest-redacted `status`, a job counter) without that being drift. What IS drift is a
 * declared field going missing or changing type, which is exactly what the check reports.
 *
 * Zod only, like openapi.ts: the boundary guard keeps this layer free of git/service imports.
 */
import { z } from "zod";

/** The error envelope every jsonError() writes; the `default` response of every operation. */
export const ErrorResponse = z.looseObject({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
});

/** A git action that succeeded (fetch, pull, push, commit, checkout, stash, tag, remote...). */
export const ActionResponse = z.looseObject({
  ok: z.literal(true),
  code: z.literal("OK"),
  message: z.string(),
});

export const HealthResponse = z.looseObject({
  ok: z.literal(true),
  service: z.literal("repoyeti"),
  version: z.string(),
  ts: z.number(),
});

export const OpenApiDocResponse = z.looseObject({
  openapi: z.literal("3.1.0"),
  info: z.looseObject({ title: z.string(), version: z.string() }),
  paths: z.record(z.string(), z.unknown()),
});

export const RepoListResponse = z.looseObject({
  repos: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      displayName: z.string().nullable(),
      absPath: z.string(),
      vcs: z.string(),
    }),
  ),
});

export const RootsResponse = z.looseObject({ roots: z.array(z.string()) });

export const RootsChangedResponse = z.looseObject({
  ok: z.literal(true),
  roots: z.array(z.string()),
});

export const ScanStateResponse = z.looseObject({ ok: z.literal(true), running: z.boolean() });

export const ScanStartResponse = z.looseObject({
  ok: z.literal(true),
  running: z.literal(true),
  scope: z.enum(["folder", "machine"]),
});

export const CancelResponse = z.looseObject({ ok: z.literal(true), cancelled: z.boolean() });

export const FetchAllStateResponse = z.looseObject({
  ok: z.literal(true),
  running: z.boolean(),
  job: z.looseObject({}).nullable(),
});

export const TokenStateResponse = z.looseObject({ ok: z.literal(true), configured: z.boolean() });

/** The read-list envelope inspect.ts returns (BranchList / StashList / TagList). */
const readList = <K extends string, T extends z.ZodType>(key: K, item: T) =>
  z.looseObject({
    ok: z.boolean(),
    code: z.enum(["OK", "ERROR"]),
    message: z.string().optional(),
    ...({ [key]: z.array(item) } as Record<K, z.ZodArray<T>>),
  });

export const BranchListResponse = readList(
  "branches",
  z.looseObject({
    name: z.string(),
    current: z.boolean(),
    upstream: z.string().nullable(),
    ahead: z.number(),
    behind: z.number(),
    gone: z.boolean(),
  }),
).extend({ current: z.string().nullable(), detached: z.boolean() });

export const StashListResponse = readList(
  "stashes",
  z.looseObject({ index: z.number(), message: z.string(), date: z.number() }),
);

export const TagListResponse = readList(
  "tags",
  z.looseObject({ name: z.string(), date: z.number(), subject: z.string() }),
);
