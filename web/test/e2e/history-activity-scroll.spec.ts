import { test, expect } from "@playwright/test";

// The activity overview is ordinary content at the top of the commit list: it scrolls out of sight
// as you read down and is there again when you come back to the top. It is deliberately NOT a
// header that hides and reveals itself — that version moved on its own while you were reading,
// which is what made it annoying.
//
// This needs a real layout engine, so it stays an e2e test rather than a DOM-attribute assertion:
// "scrolled out of view" is a fact about boxes and clipping, not about a class being present.
async function openHistory(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  // Local-only gate: this is a fresh browser context with no session.
  const localBtn = page.getByRole("button", { name: /continue local/i });
  if (await localBtn.isVisible().catch(() => false)) {
    await localBtn.click();
    await page.waitForTimeout(1200);
  }

  const card = page.locator('[id^="repo-card-"]').first();
  await card.waitFor({ state: "visible" });
  await card.getByRole("button").first().click();
  await page.waitForTimeout(900);
  await card.getByRole("button", { name: /^History$/ }).first().click();
  await page.waitForTimeout(2000);
  return card;
}

test("the activity overview scrolls out of sight and comes back at the top", async ({ page }) => {
  const card = await openHistory(page);
  const chart = card.getByTestId("history-activity");
  const list = card.locator(".history-scroll");
  await chart.waitFor({ state: "visible" });

  // It starts on screen, inside the scroller rather than above it.
  const startsInside = await chart.evaluate(
    (el, sel) => el.closest(sel) !== null,
    ".history-scroll",
  );
  expect(startsInside, "the overview should live inside the scrolling list").toBe(true);

  const listBox = (await list.boundingBox())!;
  const openBox = (await chart.boundingBox())!;
  expect(openBox.height, "the overview should have real height").toBeGreaterThan(40);
  expect(openBox.y).toBeLessThan(listBox.y + listBox.height);

  // Read downward. The chart should travel up and out of the scroller's viewport.
  await list.hover();
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(400);

  const scrolledBox = await chart.boundingBox();
  const scrolledOut = scrolledBox === null || scrolledBox.y + scrolledBox.height <= listBox.y + 1;
  expect(scrolledOut, "the overview should be scrolled above the visible list").toBe(true);

  // Its height never changed — it moved, it did not collapse. That is the whole point.
  if (scrolledBox) {
    expect(Math.round(scrolledBox.height)).toBe(Math.round(openBox.height));
  }

  // A small upward nudge should move it partway back, immediately, with no gesture threshold.
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(300);
  const nudged = await chart.boundingBox();
  expect(nudged, "a small scroll up should move the overview, not be swallowed").not.toBeNull();
  expect(nudged!.y).toBeGreaterThan(scrolledBox ? scrolledBox.y : -Infinity);

  // Back at the top it is fully visible again.
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  const backBox = (await chart.boundingBox())!;
  expect(Math.round(backBox.height)).toBe(Math.round(openBox.height));
  expect(backBox.y).toBeGreaterThanOrEqual(listBox.y - 1);
});

test("the overview stays reachable by keyboard while it is on screen", async ({ page }) => {
  const card = await openHistory(page);
  const chart = card.getByTestId("history-activity");
  await chart.waitFor({ state: "visible" });

  // Nothing is inert or visibility-hidden any more, so its scale buttons are ordinary controls.
  const focusable = await chart.evaluate((el) => {
    let landed = 0;
    for (const b of el.querySelectorAll("button")) {
      (b as HTMLElement).focus();
      if (document.activeElement === b) landed++;
    }
    return landed;
  });
  expect(focusable, "the overview's controls should be focusable while visible").toBeGreaterThan(0);
});
