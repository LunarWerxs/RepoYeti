import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { audit, findRetryOptions } from "../scripts/check-rmsync-retry.ts";

// Fixtures are string literals, which the check blanks, so this file never flags itself.
describe("rmSync retry-options guardrail", () => {
  test("fires on the old shape that Bun silently ignores", () => {
    const old = "rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });";
    const found = findRetryOptions("scripts/demo.ts", old);
    expect(found.map((f) => f.option)).toEqual(["maxRetries"]);
    expect(found[0]!.line).toBe(1);
  });

  test("fires on a multi-line call and reports the line of the call", () => {
    const multi = [
      "const x = 1;",
      "rmSync(target, {",
      "  recursive: true,",
      "  force: true,",
      "  retryDelay: 250,",
      "});",
    ].join("\n");
    const found = findRetryOptions("scripts/demo.ts", multi);
    expect(found).toEqual([{ file: "scripts/demo.ts", line: 2, option: "retryDelay" }]);
  });

  test("fires on a quoted option key, which blanking alone would hide", () => {
    const quoted = "rmSync(target, { recursive: true, 'maxRetries': 4 });";
    expect(findRetryOptions("scripts/demo.ts", quoted).map((f) => f.option)).toEqual(["maxRetries"]);
  });

  test("passes the shape that really retries: a plain rmSync inside the helper", () => {
    const helper = "rmSync(path, { recursive: true, force: true });";
    expect(findRetryOptions("tests/helpers/rm-retry.ts", helper)).toEqual([]);
  });

  test("ignores the option names inside comments and strings", () => {
    const prose = [
      "// rmSync(target, { maxRetries: 4 }) was the old shape",
      "/* rmSync(target, { retryDelay: 250 }) */",
      "const doc = 'rmSync(target, { maxRetries: 4 })';",
      "rmRetry(target);",
    ].join("\n");
    expect(findRetryOptions("scripts/demo.ts", prose)).toEqual([]);
  });

  test("the repository itself has no rmSync call passing the ignored options", async () => {
    const res = await audit.run({ root: join(import.meta.dir, "..") });
    expect(res.report).toContain("No rmSync call");
    expect(res.failed).toBe(false);
  });
});
