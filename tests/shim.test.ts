import { test, expect } from "bun:test";
import worker from "../shim/worker.ts";

const env = { ALLOWED_SUFFIXES: ".trycloudflare.com" };
const state = (o: string): string =>
  `${Buffer.from(JSON.stringify({ n: "x", o })).toString("base64url")}.mac`;

test("root path returns a friendly 200", async () => {
  const res = await worker.fetch(new Request("https://shim/"), env);
  expect(res.status).toBe(200);
});

test("valid bounce → 302 to <origin>/oauth/finish, code + state preserved", async () => {
  const s = state("https://demo.trycloudflare.com");
  const res = await worker.fetch(new Request(`https://shim/cb?code=C&state=${s}`), env);
  expect(res.status).toBe(302);
  const loc = res.headers.get("location") ?? "";
  expect(loc.startsWith("https://demo.trycloudflare.com/oauth/finish")).toBe(true);
  expect(loc).toContain("code=C");
  expect(loc).toContain(`state=${s}`);
});

test("loopback origin is allowed (Path B)", async () => {
  const s = state("http://127.0.0.1:7171");
  const res = await worker.fetch(new Request(`https://shim/cb?code=C&state=${s}`), env);
  expect(res.status).toBe(302);
});

test("disallowed origin → 403 (no open redirect)", async () => {
  const s = state("https://evil.example.com");
  const res = await worker.fetch(new Request(`https://shim/cb?code=C&state=${s}`), env);
  expect(res.status).toBe(403);
});

test("missing code → 400", async () => {
  const s = state("https://demo.trycloudflare.com");
  const res = await worker.fetch(new Request(`https://shim/cb?state=${s}`), env);
  expect(res.status).toBe(400);
});
