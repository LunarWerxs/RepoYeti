import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCloudflaredExecutable } from "../src/tunnel.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "gm-tunnel-"));

test("cloudflared resolver prefers bundled dist/vendor executable", () => {
  const root = tmp();
  const dist = join(root, "dist");
  const vendor = join(dist, "vendor");
  mkdirSync(vendor, { recursive: true });
  const bundled = join(vendor, "cloudflared");
  writeFileSync(bundled, "");
  chmodSync(bundled, 0o755);

  expect(resolveCloudflaredExecutable(join(dist, "gitmob"), "linux")).toBe(bundled);
});

test("cloudflared resolver falls back to PATH executable name", () => {
  const root = tmp();
  expect(resolveCloudflaredExecutable(join(root, "gitmob"), "win32")).toBe("cloudflared.exe");
});
