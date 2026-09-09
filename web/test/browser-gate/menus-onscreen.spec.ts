import { expect, test } from "@playwright/test";
import { gate } from "./gate";

/**
 * Issue #15, the runtime half.
 *
 * scripts/checks/popper-trigger-inside-tooltip.mjs reads the templates and proves the anchor
 * wiring is structurally correct, which is the right guard for the CAUSE that shipped four
 * times. What it cannot see is the effect: a menu whose PopperRoot never got an anchor keeps its
 * pre-position style `transform: translate(0, -200%)` and opens two menu-heights above the top
 * of the window, with correct aria, every item in the DOM, and nothing logged. To the static
 * check and to a jsdom mount that does not lay anything out, that menu looks open and fine.
 *
 * So this sweeps every menu/popover trigger the dashboard actually renders and asks the browser
 * where the content landed. Generic on purpose: the defect spread by copy-paste across four
 * independent components, so a spec listing today's components by name would miss the fifth one
 * the same way the original tests did.
 */

const VIEWPORT = { width: 1280, height: 900 };
/** Sub-pixel rounding is fine; a control off the edge of the window is not. */
const EDGE_TOLERANCE = 1;

test("every menu and popover the dashboard renders opens inside the window", async ({ page }) => {
  const g = gate();
  await page.setViewportSize(VIEWPORT);
  await page.goto(`${g.daemonOrigin}/`);
  await expect(page.getByText(g.names.seeded, { exact: false }).first()).toBeVisible();

  // Menus, popovers and selects all announce themselves this way, whatever component renders
  // them, so new ones are covered on the day they are written.
  const triggers = page.locator(
    '[aria-haspopup="menu"]:visible, [aria-haspopup="dialog"]:visible, [aria-haspopup="listbox"]:visible',
  );
  const count = await triggers.count();
  // A selector that silently matches nothing is the classic way for a sweep like this to pass
  // forever while proving nothing.
  expect(count, "the dashboard should render several menu/popover triggers").toBeGreaterThanOrEqual(3);

  const offscreen: string[] = [];
  /** Triggers that opened but whose content could not be located, with why. A failure that just
   *  says "measured 1" sends the next person hunting; this says which control went quiet. */
  const skipped: string[] = [];
  let measured = 0;
  for (let i = 0; i < count; i++) {
    const trigger = triggers.nth(i);
    if (!(await trigger.isVisible()) || !(await trigger.isEnabled())) continue;
    const label =
      (await trigger.getAttribute("aria-label")) ?? (await trigger.innerText().catch(() => "")) ?? `#${i}`;

    await trigger.click();
    // Floating UI positions on the next frame, and the content animates in. Wait for the trigger
    // to admit it is open rather than for a fixed delay.
    await expect(trigger).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });

    // Two ways to find what just opened, and the second one matters more than it looks.
    //
    // `aria-controls` is the precise link, but it is not universal: several triggers here open
    // their content through a portal and never set it, so keying the sweep on it alone silently
    // skipped two of the dashboard's three header menus and left this test measuring ONE thing
    // while claiming to sweep everything. The fallback asks the browser for the visible menu,
    // dialog or listbox that is now on screen, which is what the test is actually about, and it
    // turns those silent skips into real measurements.
    const controls = await trigger.getAttribute("aria-controls");
    // An attribute selector rather than `#id`: this runs in Node, where CSS.escape does not
    // exist, and reka's generated ids are not guaranteed to be bare CSS identifiers.
    const byId = controls ? page.locator(`[id="${controls.replaceAll('"', '\\"')}"]`) : null;
    let content: ReturnType<typeof page.locator> | null = null;
    if (byId && (await byId.count()) === 1) content = byId;
    else {
      const byRole = page.locator('[role="menu"]:visible, [role="dialog"]:visible, [role="listbox"]:visible');
      if ((await byRole.count()) === 1) content = byRole;
      else skipped.push(`${label}: ${await byRole.count()} open menu/dialog/listbox elements, expected 1`);
    }
    const contentCount = content ? await content.count() : 0;
    if (content && contentCount === 1) {
      measured++;
      await expect(content).toBeVisible();
      const box = await content.boundingBox();
      if (!box) {
        offscreen.push(`${label}: the open content has no box at all`);
      } else if (
        box.y < -EDGE_TOLERANCE ||
        box.x < -EDGE_TOLERANCE ||
        box.y + box.height > VIEWPORT.height + EDGE_TOLERANCE ||
        box.x + box.width > VIEWPORT.width + EDGE_TOLERANCE
      ) {
        offscreen.push(
          `${label}: opened at (${Math.round(box.x)}, ${Math.round(box.y)}) ` +
            `${Math.round(box.width)}x${Math.round(box.height)}, outside a ` +
            `${VIEWPORT.width}x${VIEWPORT.height} window`,
        );
      } else {
        // On screen is necessary, not sufficient: the historical failure is a control that reads
        // as dead. Whatever is at the content's own centre must belong to the content.
        const reachable = await content.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return !!hit && el.contains(hit);
        });
        if (!reachable) offscreen.push(`${label}: something else is on top of the open content`);
      }
    }

    await page.keyboard.press("Escape");
    await expect(trigger).not.toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });
  }

  expect(offscreen, offscreen.join("\n")).toEqual([]);
  // Without this the sweep is vacuous: a trigger with no `aria-controls` is skipped silently, so
  // a refactor that stopped setting it would leave a green test measuring nothing at all.
  expect(
    measured,
    `the sweep must actually have measured some open content; skipped: ${skipped.join(" | ")}`,
  ).toBeGreaterThanOrEqual(3);
});
