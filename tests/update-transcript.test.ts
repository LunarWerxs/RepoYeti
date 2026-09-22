import { test, expect } from "bun:test";
import { failedUpdateTranscript } from "../src/updater.ts";

// A failed source update carries the engine's step transcript on its rejection (issue #24). These
// pin what the daemon hands back to the dashboard and writes to the log.

test("a plain error, or a missing/odd output field, has no transcript", () => {
  expect(failedUpdateTranscript(new Error("x"))).toEqual([]);
  expect(failedUpdateTranscript(null)).toEqual([]);
  expect(failedUpdateTranscript(Object.assign(new Error("x"), { output: "not a list" }))).toEqual([]);
});

test("the transcript comes back in order, and non-string entries are dropped", () => {
  const e = Object.assign(new Error("x"), { output: ["$ git pull\nok", 42, "$ bun run build\nerror: boom"] });
  expect(failedUpdateTranscript(e)).toEqual(["$ git pull\nok", "$ bun run build\nerror: boom"]);
});

test("an oversized transcript keeps the END, where the failing step is", () => {
  const huge = "x".repeat(70_000);
  const e = Object.assign(new Error("x"), { output: ["$ first\nok", huge, "$ build\nerror: the reason"] });
  const kept = failedUpdateTranscript(e);
  expect(kept.at(-1)).toBe("$ build\nerror: the reason");
  expect(kept.join("").length).toBeLessThanOrEqual(64_001 + "$ build\nerror: the reason".length);
  expect(kept).not.toContain("$ first\nok");
});
