import { test, expect } from "@playwright/test";

// The auto-hiding activity overview, verified in a browser that actually does LAYOUT.
//
// The scroll RULES are unit-tested (test/lib/auto-hide-scroll.test.ts) and the Vue plumbing can be
// driven from a headless page, but neither can see whether the block physically collapses — and
// that is precisely where this broke. `grid-template-rows: 0fr` looked correct, the class applied,
// the rule matched, and the height stayed at its full 191px, because a plain `0fr` track still has
// an `auto` MINIMUM that resolves to the content height. Only a real layout engine catches that,
// so the collapse gets an e2e test rather than another DOM-attribute assertion.
test("the activity overview collapses as you read down, and hands its space to the commit list", async ({
  page,
}) => {
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

  const wrap = card.locator("[data-history-activity-wrap]");
  const list = card.locator(".history-scroll");
  await wrap.waitFor({ state: "visible" });

  const openHeight = (await wrap.boundingBox())!.height;
  expect(openHeight, "the overview should have real height while open").toBeGreaterThan(40);
  const openListMax = await list.evaluate((el) => Number.parseFloat(getComputedStyle(el).maxHeight));

  // Read downward with real wheel events.
  await list.hover();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(800); // clears the 360ms collapse with room to spare

  const hiddenHeight = (await wrap.boundingBox().catch(() => null))?.height ?? 0;
  expect(hiddenHeight, `overview should be collapsed, was ${Math.round(hiddenHeight)}px`).toBeLessThan(4);

  // …and the list actually got that space, which is the whole reason for hiding it.
  const grownListMax = await list.evaluate((el) => Number.parseFloat(getComputedStyle(el).maxHeight));
  expect(grownListMax).toBeGreaterThan(openListMax + openHeight - 8);

  // Small upward drift must NOT bring it back (this is the anti-flicker rule).
  await page.mouse.wheel(0, -30);
  await page.waitForTimeout(700);
  expect((await wrap.boundingBox().catch(() => null))?.height ?? 0).toBeLessThan(4);

  // A committed pull up does.
  await page.mouse.wheel(0, -260);
  await page.waitForTimeout(800);
  const reopened = (await wrap.boundingBox())!.height;
  expect(reopened, "a real pull upward should bring the overview back").toBeGreaterThan(40);
});

test("a collapsed overview leaves the tab order", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const localBtn = page.getByRole("button", { name: /continue local/i });
  if (await localBtn.isVisible().catch(() => false)) {
    await localBtn.click();
    await page.waitForTimeout(1200);
  }
  const card = page.locator('[id^="repo-card-"]').first();
  await card.getByRole("button").first().click();
  await page.waitForTimeout(900);
  await card.getByRole("button", { name: /^History$/ }).first().click();
  await page.waitForTimeout(2000);

  const wrap = card.locator("[data-history-activity-wrap]");
  const list = card.locator(".history-scroll");
  await list.hover();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(800);

  // Its scale buttons and author chips must not be focusable inside a zero-height box.
  await expect(wrap).toHaveAttribute("inert", "");
  // Assert FOCUSABILITY, not `offsetParent`: a collapsed grid track still gives its children layout
  // boxes, so offsetParent stays non-null (only `display: none` clears it) — the first version of
  // this test failed for that reason while the behaviour was already correct. `inert` plus
  // `visibility: hidden` is what actually takes them out of the tab order, and the honest way to
  // check that is to try to focus each one and see that focus refuses to land.
  const focusable = await wrap.evaluate((el) => {
    let landed = 0;
    for (const b of el.querySelectorAll("button")) {
      (b as HTMLElement).focus();
      if (document.activeElement === b) landed++;
    }
    return landed;
  });
  expect(focusable, "nothing inside a collapsed overview should take focus").toBe(0);
  await expect(wrap.locator("button").first()).toBeHidden();
});
