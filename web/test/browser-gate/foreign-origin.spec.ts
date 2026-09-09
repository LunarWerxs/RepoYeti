import { expect, test, type APIRequestContext } from "@playwright/test";
import { gate } from "./gate";

/**
 * Audit item 4, proven by the browser rather than by a header table.
 *
 * tests/loopback-guard.test.ts builds the headers itself and calls `createApp().request()`. That
 * is the right test for the DECISION TABLE, and it is not evidence about the premise the whole
 * fix rests on: that a page served from ANOTHER loopback port really is "same-site" with this
 * daemon, really can send a preflight-free mutating POST, and really does carry an Origin the
 * allowlist has to refuse. Only a browser can settle that.
 *
 * WHY THE PROOF IS THREE TESTS AND NOT A HEADER ASSERTION. Chromium adds `Origin` and
 * `Sec-Fetch-Site` in the network service, after the renderer has handed the request off, so
 * Playwright's `request.allHeaders()` does not carry them for a cross-origin fetch (measured:
 * they are simply absent), and a `no-cors` response body cannot be read back either
 * (Network.getResponseBody has nothing for an opaque resource). So the headers are established by
 * DIFFERENCE, from three observations the page cannot fake:
 *
 *   · a `no-cors` GET from the foreign page is answered 200. The guard's FIRST rule refuses
 *     `Sec-Fetch-Site: cross-site` outright, before any allowlist is consulted, so a 200 proves
 *     the browser classified this page as SAME-SITE — exactly the case the guard's default mode
 *     waves through, and the entire reason the exact-origin mode was turned on.
 *   · the identical simple POST from the daemon's OWN page is accepted (201) and the repository
 *     is really registered, so nothing about the method, the content type or the body is what the
 *     daemon objects to.
 *   · the same POST from the foreign page is refused 403 AND has no effect.
 *
 * Same site, same request shape, different origin, opposite outcome. The Origin allowlist is the
 * only thing left that can be deciding it.
 */

// gate() is called inside each test, never at module scope: Playwright loads spec files during
// collection (`--list`, --forbid-only) without running global setup, and a throw there reports as
// "no tests found" rather than as the missing environment it is.
const REGISTER = "/api/repos/register";

declare global {
  interface Window {
    driveByWrite: (path: string, body: unknown) => Promise<string>;
    driveByRead: (path: string) => Promise<{ status: number; type: string; body: string }>;
  }
}

async function registeredPaths(
  request: APIRequestContext,
  daemonOrigin: string,
): Promise<Array<string | undefined>> {
  const res = await request.get(`${daemonOrigin}/api/repos`);
  // `absPath`, not `path`: that is the field name on RepoView (src/db.ts).
  const body = (await res.json()) as { repos?: Array<{ absPath?: string }> };
  return (body.repos ?? []).map((r) => r.absPath);
}

test("the foreign page is same-site with the daemon, and still learns nothing by reading", async ({
  page,
}) => {
  const g = gate();
  await page.goto(`${g.foreignOrigin}/attack.html`);
  const answered = page.waitForResponse((r) => r.url() === `${g.daemonOrigin}/api/repos`);
  const result = await page.evaluate((path) => window.driveByRead(path), "/api/repos");
  const response = await answered;

  // The load-bearing observation for the whole file: the browser calls a page on another loopback
  // PORT same-site, which is the classification the default guard mode trusts.
  //
  // A no-cors GET also carries no Origin at all (browsers attach one to CORS-mode requests and to
  // non-GET methods), which is why the allowlist has nothing to judge and correctly stands aside:
  // that same absence is what lets curl, the tray probe and the MCP client work.
  expect(response.status()).toBe(200);

  // And it buys the page nothing: the response is opaque, so a foreign page that drove a read
  // still cannot see a single repository path.
  expect(result.type).toBe("opaque");
  expect(result.status).toBe(0);
  expect(result.body).toBe("");
});

test("the same simple POST from the daemon's own page is accepted", async ({ page, request }) => {
  const g = gate();
  const before = await registeredPaths(request, g.daemonOrigin);
  expect(before, "the seeded fixture should already be registered").toContain(g.fixtures.seeded);
  expect(before).not.toContain(g.fixtures.attackTarget);

  await page.goto(`${g.daemonOrigin}/`);
  const answered = page.waitForResponse((r) => r.url() === `${g.daemonOrigin}${REGISTER}`);
  const status = await page.evaluate(
    async ([path, repoPath]) => {
      const res = await fetch(path, {
        // The same CORS-safelisted content type the attack page uses, so this is the identical
        // preflight-free request shape.
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ path: repoPath }),
      });
      return res.status;
    },
    [REGISTER, g.fixtures.attackTarget] as const,
  );

  const response = await answered;
  expect(status).toBe(201);
  expect(response.status()).toBe(201);
  expect(await registeredPaths(request, g.daemonOrigin)).toContain(g.fixtures.attackTarget);
});

test("a page on another loopback port cannot drive the same mutating call", async ({ page, request }) => {
  const g = gate();
  const before = await registeredPaths(request, g.daemonOrigin);
  expect(before).not.toContain(g.fixtures.refusedTarget);

  await page.goto(`${g.foreignOrigin}/attack.html`);
  const answered = page.waitForResponse((r) => r.url() === `${g.daemonOrigin}${REGISTER}`);
  const responseType = await page.evaluate(
    ([path, repoPath]) => window.driveByWrite(path, { path: repoPath }),
    [REGISTER, g.fixtures.refusedTarget] as const,
  );
  // `no-cors` hides the answer from the page, which is exactly why a drive-by does not care what
  // it was. Playwright watches the network, so it sees what the page cannot.
  expect(responseType).toBe("opaque");

  const response = await answered;
  expect(response.status()).toBe(403);

  // The part that actually matters: nothing happened.
  const after = await registeredPaths(request, g.daemonOrigin);
  expect(after).not.toContain(g.fixtures.refusedTarget);
  expect(after).toEqual(before);
});
