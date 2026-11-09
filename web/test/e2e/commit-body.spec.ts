import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Open a repo card and its History panel WITHOUT assuming they are shut. Blindly clicking the
// toggles collapses whatever was already open, and the panel state can carry over between runs,
// which showed up as this file passing alone and timing out inside the full suite.
async function openHistory(card: import("@playwright/test").Locator, page: import("@playwright/test").Page) {
  const cardToggle = card.getByRole("button").first();
  if ((await cardToggle.getAttribute("aria-expanded")) !== "true") await cardToggle.click();
  const history = card.getByRole("button", { name: /^History$/ }).first();
  await history.waitFor({ state: "visible" });
  if ((await history.getAttribute("aria-expanded")) !== "true") await history.click();
  await page.waitForTimeout(400);
}

const OUT = join(tmpdir(), "repoyeti-commit-body-e2e");
mkdirSync(OUT, { recursive: true });

test("long commit body clamps with an animated Show more", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/");
  const card = page.locator('[id^="repo-card-"]').filter({ hasText: "tallhist" }).first();
  await card.waitFor({ state: "visible" });
  await openHistory(card, page);

  const row = card.locator("div[aria-expanded]").filter({ hasText: /Add the widget subsystem/ }).first();
  // Keyboard operability: focus the row and fire it with Enter, not a mouse click.
  await row.focus();
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1600);

  const more = page.getByRole("button", { name: "Show more" });
  await expect(more).toBeVisible();
  const clamped = await page.evaluate(() => {
    const el = document.querySelector(".commit-body") as HTMLElement;
    return { h: Math.round(el.getBoundingClientRect().height), full: el.scrollHeight, transition: getComputedStyle(el).transitionProperty };
  });
  expect(clamped.h).toBeLessThan(clamped.full);        // actually clipped
  expect(clamped.transition).toContain("max-height");  // and it animates

  await more.click();
  await page.waitForTimeout(600);
  const opened = await page.evaluate(() => {
    const el = document.querySelector(".commit-body") as HTMLElement;
    return { h: Math.round(el.getBoundingClientRect().height), full: el.scrollHeight };
  });
  expect(opened.h).toBeGreaterThan(clamped.h);
  expect(Math.abs(opened.h - opened.full)).toBeLessThanOrEqual(2); // fully revealed
  await expect(page.getByRole("button", { name: "Show less" })).toBeVisible();

  const b = (await row.boundingBox())!;
  await page.screenshot({ path: `${OUT}/commit-body.png`, clip: { x: b.x, y: b.y, width: 760, height: 320 } });
});

test("a short commit body gets no toggle", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/");
  const card = page.locator('[id^="repo-card-"]').filter({ hasText: "tallhist" }).first();
  await card.waitFor({ state: "visible" });
  await openHistory(card, page);
  // Any commit other than the long-bodied one. Picked by position rather than by subject text:
  // matching on a specific message makes the test depend on the fixture's exact history.
  const rows = card.locator("div[aria-expanded]").filter({ hasText: /commit|subsystem/i });
  await rows.first().waitFor({ state: "visible" });
  await rows.nth(1).click();
  await page.waitForTimeout(1400);
  // No body at all on these commits — a toggle would be noise.
  await expect(page.getByRole("button", { name: "Show more" })).toHaveCount(0);
});

test("sections animate open and shut", async ({ page, request }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  const listed = await (await request.get("/api/repos")).json();
  const repos = listed.repos ?? [];
  for (const r of repos) if (r.pinned) await request.post(`/api/repos/${r.id}/pinned`, { data: { pinned: false } });
  await request.post(`/api/repos/${repos[0].id}/pinned`, { data: { pinned: true } });
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("repoyeti:sectionsCollapsed"));
  await page.reload();
  // Wait for the list itself, not a fixed delay: before the repos arrive the shell renders its
  // empty state, RepoList isn't mounted, and there is no .section-collapse to measure.
  await page.locator('[id^="repo-card-"]').first().waitFor({ state: "visible" });
  await page.locator(".section-collapse").first().waitFor({ state: "attached" });

  const anim = await page.evaluate(() => {
    const el = document.querySelector(".section-collapse") as HTMLElement;
    const cs = getComputedStyle(el);
    return { prop: cs.transitionProperty, dur: cs.transitionDuration, rows: cs.gridTemplateRows };
  });
  expect(anim.prop).toContain("grid-template-rows");
  expect(anim.dur).not.toBe("0s");

  await page.getByRole("button", { name: /Pinned/i }).first().click();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const el = document.querySelector(".section-collapse") as HTMLElement;
    return { h: Math.round(el.getBoundingClientRect().height), collapsed: el.classList.contains("is-collapsed") };
  });
  expect(after.collapsed).toBe(true);
  expect(after.h).toBeLessThan(4); // fully closed once the transition finished
  for (const r of repos) await request.post(`/api/repos/${r.id}/pinned`, { data: { pinned: false } });
});
