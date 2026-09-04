/**
 * Pure unit tests for the AI provider key-rotation pool (src/ai/credential-pool.ts). No network,
 * no daemon - every case would fail today if withKeyRotation/acquireKeys/reportKeyOutcome were
 * removed and callers went back to a single bare API key.
 */
import { test, expect, beforeEach } from "bun:test";
import {
  withKeyRotation,
  acquireKeys,
  reportKeyOutcome,
  snapshotPool,
  resetCredentialPools,
} from "../src/ai/credential-pool.ts";
import { AiError } from "../src/ai/commit-message.ts";

beforeEach(() => {
  resetCredentialPools();
});

test("withKeyRotation rotates to the next key after a rate-limited first key", async () => {
  const tried: string[] = [];
  const result = await withKeyRotation("groq", ["key-a", "key-b"], async (key) => {
    tried.push(key);
    if (key === "key-a") throw new AiError("AI_RATE_LIMITED", "rate limited", 429);
    return `ok:${key}`;
  });
  expect(result).toBe("ok:key-b");
  expect(tried).toEqual(["key-a", "key-b"]);
});

test("withKeyRotation rotates to the next key after an auth-rejected key", async () => {
  const tried: string[] = [];
  const result = await withKeyRotation("openai", ["dead-key", "live-key"], async (key) => {
    tried.push(key);
    if (key === "dead-key") throw new AiError("AI_AUTH_FAILED", "invalid key", 401);
    return `ok:${key}`;
  });
  expect(result).toBe("ok:live-key");
  expect(tried).toEqual(["dead-key", "live-key"]);
});

test("withKeyRotation does NOT rotate on a bad request - fails fast without trying the next key", async () => {
  const tried: string[] = [];
  const attempt = async (key: string) => {
    tried.push(key);
    throw new AiError("AI_BAD_REQUEST", "malformed request", 400);
  };
  await expect(withKeyRotation("openai", ["key-a", "key-b"], attempt)).rejects.toThrow("malformed request");
  // A bad request would fail identically on every key - rotating would just multiply one
  // unrelated failure by the pool size for nothing.
  expect(tried).toEqual(["key-a"]);
});

test("withKeyRotation rethrows the last error once every key in the pool has been tried", async () => {
  const attempt = async () => {
    throw new AiError("AI_AUTH_FAILED", "invalid key", 401);
  };
  await expect(withKeyRotation("groq", ["key-a", "key-b"], attempt)).rejects.toThrow("invalid key");
});

test("withKeyRotation makes exactly one attempt with an empty string for an empty pool", async () => {
  const tried: string[] = [];
  const result = await withKeyRotation("compatible", [], async (key) => {
    tried.push(key);
    return "ok";
  });
  expect(result).toBe("ok");
  expect(tried).toEqual([""]);
});

test("a rate-limited key is skipped on the NEXT acquireKeys() call until its cooldown clears", () => {
  const keys = ["key-a", "key-b"];
  const first = acquireKeys("gemini", keys);
  expect(first.map((k) => k.key)).toEqual(["key-a", "key-b"]);
  reportKeyOutcome("gemini", first[0]!.id, { code: "AI_RATE_LIMITED", message: "429" });
  const second = acquireKeys("gemini", keys);
  // key-a is cooling down - only key-b comes back as available.
  expect(second.map((k) => k.key)).toEqual(["key-b"]);
});

test("an auth-dead key is reflected in the snapshot as dead, and success clears a cooldown", () => {
  const keys = ["key-a", "key-b"];
  const acquired = acquireKeys("anthropic", keys);
  reportKeyOutcome("anthropic", acquired[0]!.id, { code: "AI_AUTH_FAILED", message: "invalid" });
  const deadSnapshot = snapshotPool("anthropic", keys);
  expect(deadSnapshot.total).toBe(2);
  expect(deadSnapshot.available).toBe(1);
  expect(deadSnapshot.entries.find((e) => e.id === acquired[0]!.id)?.status).toBe("dead");

  // A later success (e.g. the owner replaced the dead key with a working one under the same
  // pool slot) clears the cooldown and status.
  reportKeyOutcome("anthropic", acquired[0]!.id, "ok");
  const recovered = snapshotPool("anthropic", keys);
  expect(recovered.available).toBe(2);
  expect(recovered.entries.find((e) => e.id === acquired[0]!.id)?.status).toBe("ok");
});

test("a bad request never cools down or marks a key dead", () => {
  const keys = ["key-a"];
  const acquired = acquireKeys("deepseek", keys);
  reportKeyOutcome("deepseek", acquired[0]!.id, { code: "AI_BAD_REQUEST", message: "bad" });
  const snap = snapshotPool("deepseek", keys);
  expect(snap.available).toBe(1);
  expect(snap.entries[0]!.status).toBe("untested"); // never touched by a request-shaped failure
});

test("snapshotPool never exposes the raw key material", () => {
  const secretKey = "sk-super-secret-value-do-not-leak";
  const snap = snapshotPool("openrouter", [secretKey]);
  expect(JSON.stringify(snap)).not.toContain(secretKey);
  expect(snap.entries[0]!.id).not.toBe(secretKey);
});

test("acquireKeys falls back to the soonest-to-clear key when every key is cooling down", () => {
  const keys = ["key-a", "key-b"];
  const acquired = acquireKeys("groq", keys);
  for (const k of acquired) {
    reportKeyOutcome("groq", k.id, { code: "AI_RATE_LIMITED", message: "429" });
  }
  // Every key is cooling - acquireKeys must still hand back exactly one usable attempt rather
  // than an empty list, so a real request goes out instead of refusing outright.
  const stillTrying = acquireKeys("groq", keys);
  expect(stillTrying.length).toBe(1);
});
