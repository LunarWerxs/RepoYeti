import { expect, test } from "@playwright/test";
import { gate } from "./gate";

/**
 * Audit item 7, proven against a real EventSource and a real daemon.
 *
 * web/test/store/snapshot-event-order.test.ts mocks `@vueuse/core` and drives a fake stream, so
 * it proves the ORDERING RULES and nothing about the stream. What an owner actually hits is a
 * phone that slept through a change: the connection dies, work happens without it, the stream
 * comes back. `loadAll()` doubles as the reconnect resync, and it only runs when the store SEES
 * the status leave OPEN and return — a condition no mocked EventSource can put under test.
 *
 * HOW THE DROP IS MADE, and why it is not simply `context.setOffline(true)`. Measured here:
 * Chromium's offline emulation stops NEW connections but does not tear down a response that is
 * already streaming, so the EventSource never errors, the store never leaves OPEN, and the page
 * sits there looking connected. Aborting the route has the same limit — interception applies to
 * requests that have not started. So the stream is closed the way the browser closes it on a real
 * drop: `close()` (readyState 2, connection torn down for real) followed by the `error` event
 * that vueuse's autoReconnect keys on. Everything after that point is genuine — a new
 * EventSource, real HTTP, the daemon's own snapshot — and offline emulation plus an aborting
 * route keep the reconnect attempts failing for real while the page is meant to be blind.
 *
 * WHAT THIS DOES AND DOES NOT COVER, stated plainly so a green run is not read as more than it
 * is: it covers the reconnect path end to end (drop, retry, resync, render). It does NOT isolate
 * item 7's held-event replay or its `updatedAt` guard — those are ordering rules between a
 * snapshot request and events arriving during it, and the unit tests are the right place to pin
 * them down deterministically. Reverting item 7 would not turn this spec red.
 */

declare global {
  interface Window {
    /** Installed below; returns how many live EventSources it dropped. */
    dropLiveStreams: () => number;
  }
}

test("a dashboard that loses the stream converges on the daemon's truth when it returns", async ({
  page,
  context,
  request,
}) => {
  const g = gate();

  await page.addInitScript(() => {
    const Native = window.EventSource;
    const live = new Set<EventSource>();
    class Tracked extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        live.add(this);
      }
    }
    window.EventSource = Tracked as unknown as typeof EventSource;
    window.dropLiveStreams = () => {
      let dropped = 0;
      for (const stream of live) {
        live.delete(stream);
        // Order matters: vueuse only reconnects when readyState is CLOSED at the moment the
        // error arrives, which is exactly the state a browser is in after a dropped connection.
        stream.close();
        stream.dispatchEvent(new Event("error"));
        dropped++;
      }
      return dropped;
    };
  });

  let streamAttempts = 0;
  page.on("request", (req) => {
    if (req.url().includes("/api/events")) streamAttempts++;
  });

  const streamed = page.waitForResponse(
    (r) =>
      r.url().includes("/api/events") &&
      r.status() === 200 &&
      (r.headers()["content-type"] ?? "").includes("text/event-stream"),
  );
  await page.goto(`${g.daemonOrigin}/`);
  await streamed;

  // Hydrated: the seeded repository is on screen before anything is taken away.
  await expect(page.getByText(g.names.seeded, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(g.names.offlineArrival, { exact: false })).toHaveCount(0);
  const attemptsWhileConnected = streamAttempts;

  // Cut the wire, then drop the stream that was already running.
  await page.route("**/api/events**", (route) => route.abort());
  await context.setOffline(true);
  expect(await page.evaluate(() => window.dropLiveStreams()), "the page had no live stream to drop").toBe(
    1,
  );

  // Work happens while the page is blind. Node sends no Origin, so this is the daemon's own
  // owner-side path, not a browser request the guard would weigh in on.
  const registered = await request.post(`${g.daemonOrigin}/api/repos/register`, {
    data: { path: g.fixtures.offlineArrival },
  });
  expect(registered.status()).toBe(201);

  // The dashboard is genuinely trying to come back and genuinely failing.
  await expect
    .poll(() => streamAttempts, {
      message: "the dashboard should keep trying to re-open the stream after a drop",
      timeout: 30_000,
    })
    .toBeGreaterThan(attemptsWhileConnected);
  await expect(
    page.getByText(g.names.offlineArrival, { exact: false }),
    "the page must not have learned about the new repository while it was offline",
  ).toHaveCount(0);

  await page.unroute("**/api/events**");
  await context.setOffline(false);

  // The reconnect resync is what has to produce this: no `repo_added` event was ever delivered
  // to this page, so only a fresh snapshot can put it on screen.
  await expect(page.getByText(g.names.offlineArrival, { exact: false }).first()).toBeVisible({
    timeout: 60_000,
  });
  // And the earlier repository is still there: a resync that replaced the list wholesale with a
  // partial answer would show up here.
  await expect(page.getByText(g.names.seeded, { exact: false }).first()).toBeVisible();
});
