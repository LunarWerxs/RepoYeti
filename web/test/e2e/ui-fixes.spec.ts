import { test, expect } from "@playwright/test";

// Runtime cover for a batch of UI fixes that are all about GEOMETRY or MODE, and so can't be
// proven by a unit test: they only exist once a real browser has laid the page out.
// Needs the Vite dev server (:4319) + a live daemon with at least one repo.

test("settings tab indicator sits exactly on its tab", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");

  // Header ⋮ → Settings
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();

  const tablist = page.getByRole("tablist").first();
  await expect(tablist).toBeVisible();

  // For every tab: select it, then compare the sliding indicator's box to the tab's own box.
  // The indicator used to be offset by the container's padding (it sat at `left-1` AND
  // translated by an offset that already included that padding), which read as dead space on
  // one side of a wide tab.
  const tabs = tablist.getByRole("tab");
  const count = await tabs.count();
  expect(count).toBeGreaterThan(1);

  for (let i = 0; i < count; i++) {
    const tab = tabs.nth(i);
    await tab.click();
    // The indicator transition is 200ms; wait it out rather than racing it.
    await page.waitForTimeout(320);
    const drift = await tablist.evaluate((list) => {
      const indicator = list.querySelector<HTMLElement>('[aria-hidden="true"]');
      const active = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!indicator || !active) return null;
      const a = indicator.getBoundingClientRect();
      const b = active.getBoundingClientRect();
      return { left: Math.abs(a.left - b.left), right: Math.abs(a.right - b.right) };
    });
    expect(drift).not.toBeNull();
    // Sub-pixel rounding only — no systematic offset on either edge.
    expect(drift!.left).toBeLessThanOrEqual(1);
    expect(drift!.right).toBeLessThanOrEqual(1);
  }
});

test("the settings tabs stay put when the panel is scrolled", async ({ page }) => {
  // Reported off a phone screenshot in issue #20: "Settings" and "General" superimposed. The
  // panel's body is deliberately pulled up underneath its translucent title bar so rows shimmer
  // through as they scroll — but the TAB ROW was in that scroller too, so it slid up behind the
  // title and then past it into the panel's clipped top edge. Only a laid-out browser shows this.
  // Short as well as narrow, so the panel definitely overflows. At a phone's full height the
  // General tab can just fit, and then this test scrolls nothing and passes on an unfixed build.
  await page.setViewportSize({ width: 420, height: 420 });
  await page.goto("/");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();

  const tablist = page.getByRole("tablist").first();
  await expect(tablist).toBeVisible();

  const overlap = async (): Promise<number> =>
    await page.evaluate(() => {
      const list = document.querySelector('[role="tablist"]')!.getBoundingClientRect();
      const header = document.querySelector('[data-slot="sidebar"] header')!.getBoundingClientRect();
      return header.bottom - list.top; // > 0 means the tabs have gone under the title
    });

  expect(await overlap()).toBeLessThanOrEqual(0);

  // Scroll well past where the tab row used to disappear, and again to the very bottom.
  const body = page.locator('[data-slot="sidebar"] > div').first();
  for (const top of [140, 1e6]) {
    const moved = await body.evaluate((el, y) => {
      el.scrollTo({ top: y, behavior: "instant" });
      return el.scrollTop;
    }, top);
    expect(moved, "the panel has to actually scroll for this to prove anything").toBeGreaterThan(0);
    await page.waitForTimeout(200);
    expect(await overlap(), `tabs slid under the title at scrollTop ${top}`).toBeLessThanOrEqual(0);
  }

  // Still the control it was, not just a decoration parked under the header.
  await tablist.getByRole("tab", { name: "Advanced" }).click();
  await expect(tablist.getByRole("tab", { name: "Advanced" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("multi-select mode selects repos and raises the bulk bar", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  await page.locator('[id^="repo-card-"]').first().waitFor({ state: "visible" });

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Select multiple" }).click();

  // Bulk bar appears, starting at zero.
  const bar = page.getByText(/^0 selected$/);
  await expect(bar).toBeVisible();

  // Clicking a card now PICKS it rather than expanding it.
  const cards = page.locator('[id^="repo-card-"]');
  await cards.nth(0).getByRole("button").first().click();
  await cards.nth(1).getByRole("button").first().click();
  await expect(page.getByText(/^2 selected$/)).toBeVisible();

  // The row reports its pressed state, and did not expand.
  await expect(cards.nth(0).getByRole("button").first()).toHaveAttribute("aria-pressed", "true");
  await expect(cards.nth(0).getByRole("button").first()).not.toHaveAttribute("aria-expanded", "true");

  // Select-all then clear.
  await page.getByRole("button", { name: "Select all" }).click();
  await expect(page.getByText(/^0 selected$/)).toBeHidden();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByText(/^0 selected$/)).toBeVisible();

  // Leaving select mode restores normal expand behaviour.
  await page.getByRole("button", { name: "Done selecting" }).click();
  await expect(page.getByText(/^0 selected$/)).toBeHidden();
  await cards.nth(0).getByRole("button").first().click();
  await expect(cards.nth(0).getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
});

test('"Select all" respects an active filter', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  await page.locator('[id^="repo-card-"]').first().waitFor({ state: "visible" });

  const total = await page.locator('[id^="repo-card-"]').count();
  expect(total).toBeGreaterThan(2);

  // Narrow the list with the filter bar's search box.
  await page.getByPlaceholder(/Filter repositories/i).fill("c");
  await expect
    .poll(async () => page.locator('[id^="repo-card-"]').count())
    .toBeLessThan(total);
  const shown = await page.locator('[id^="repo-card-"]').count();
  expect(shown).toBeGreaterThan(0);

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Select multiple" }).click();
  await page.getByRole("button", { name: "Select all" }).click();

  // It must tick exactly what's ON SCREEN — not every non-hidden repo. Getting this wrong
  // meant a following bulk Remove would delete repos the filter was hiding.
  await expect(page.getByText(new RegExp(`^${shown} selected$`))).toBeVisible();

  await page.getByRole("button", { name: "Done selecting" }).click();
});

test("the bulk bar stays clear of the file viewer drawer", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");

  // Open a file so the viewer drawer docks on the right.
  const dirtyCard = page.locator('[id^="repo-card-"]').filter({ hasText: /files changed/ }).first();
  await dirtyCard.waitFor({ state: "visible" });
  await dirtyCard.getByRole("button").first().click();
  // File rows only — a folder row would just toggle its subtree (folders carry aria-expanded).
  await dirtyCard.locator("button[data-tree-row]:not([aria-expanded])").first().click();
  const drawer = page.locator("aside").first();
  await expect(drawer).toBeVisible();

  // Now enter select mode; the bar must not end up underneath the drawer. Scope to the page
  // header: an expanded card carries its own ⋮ (it moved there in item 9).
  await page.getByRole("banner").getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Select multiple" }).click();

  const exit = page.getByRole("button", { name: "Done selecting" });
  await expect(exit).toBeVisible();
  const overlap = await exit.evaluate((btn) => {
    const aside = document.querySelector("aside");
    if (!aside) return null;
    const b = btn.getBoundingClientRect();
    const a = aside.getBoundingClientRect();
    const covered = !(b.right <= a.left || b.left >= a.right || b.bottom <= a.top || b.top >= a.bottom);
    // Whatever the browser says is actually on top at the button's centre.
    const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
    return { covered, hitIsTheButton: btn.contains(hit) };
  });
  expect(overlap).not.toBeNull();
  expect(overlap!.covered).toBe(false); // the inset keeps it out of the drawer entirely
  expect(overlap!.hitIsTheButton).toBe(true); // and it's the top-most thing at its own centre

  await exit.click();
});

test("a toast never lands on top of the bulk bar", async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  await page.locator('[id^="repo-card-"]').first().waitFor({ state: "visible" });

  // This test needs a real toast, so it performs a real bulk action and undoes it. If it dies
  // between the two, the stars it set would leak into whatever runs next — so clear them
  // afterwards over the API regardless of how this test ends.
  const unstarAll = async (): Promise<void> => {
    const listed = await (await request.get("/api/repos")).json();
    for (const r of (listed.repos ?? []) as { id: string; starred?: boolean }[]) {
      if (r.starred) await request.post(`/api/repos/${r.id}/starred`, { data: { starred: false } });
    }
  };

  // Toasts moved to bottom-RIGHT, which is where the bulk bar's buttons live. The bar is
  // bottom-anchored across the whole content width, so at the default inset a toast covers its
  // right-hand end — and the toast carrying Undo would be the thing burying the previous
  // action's Undo. App.vue lifts the toaster by the bar's measured height while select mode is on.
  await page.getByRole("banner").getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Select multiple" }).click();
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: "Star", exact: true }).click();

  const toast = page.locator("[data-sonner-toast]").first();
  await expect(toast).toBeVisible();
  // Sonner slides the toast UP into place, so mid-animation it genuinely is over the bar for a
  // frame or two. Let it land before measuring, or this reads the entrance, not the resting spot.
  await toast.evaluate(async (el) => {
    await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})));
  });

  const boxes = await toast.evaluate((el) => {
    // The bar is the fixed container holding the "Done selecting" control.
    const exit = [...document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Done selecting" || b.title === "Done selecting",
    );
    const bar = exit?.closest("div.fixed");
    if (!bar) return null;
    const t = el.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    return {
      overlaps: !(t.right <= b.left || t.left >= b.right || t.bottom <= b.top || t.top >= b.bottom),
      toastBottom: t.bottom,
      barTop: b.top,
      toastRight: t.right,
      viewportWidth: window.innerWidth,
    };
  });

  expect(boxes, "expected to find the bulk bar").not.toBeNull();
  expect(boxes!.overlaps).toBe(false);
  // …and it's above the bar, not off-screen somewhere.
  expect(boxes!.toastBottom).toBeLessThanOrEqual(boxes!.barTop);
  // Only the BOTTOM inset may change. Sonner's `offset` sets all four edges from a single
  // number, so an unwary fix lifts the stack and shoves it left at the same time — the toasts
  // visibly slide sideways on entering select mode. The right edge must stay put.
  expect(boxes!.viewportWidth - boxes!.toastRight).toBeLessThanOrEqual(24);

  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Done selecting" }).click();
  await unstarAll();
});

test("a second toast stacks above the first instead of burying its Undo", async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  await page.locator('[id^="repo-card-"]').first().waitFor({ state: "visible" });

  const reset = async (): Promise<void> => {
    const listed = await (await request.get("/api/repos")).json();
    for (const r of (listed.repos ?? []) as { id: string; starred?: boolean; pinned?: boolean }[]) {
      if (r.starred) await request.post(`/api/repos/${r.id}/starred`, { data: { starred: false } });
      if (r.pinned) await request.post(`/api/repos/${r.id}/pinned`, { data: { pinned: false } });
    }
  };
  await reset();

  await page.getByRole("banner").getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Select multiple" }).click();
  await page.getByRole("button", { name: "Select all" }).click();

  // Two undoable actions back to back — the first toast is still up when the second arrives.
  await page.getByRole("button", { name: "Star", exact: true }).click();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(2);

  const toasts = page.locator("[data-sonner-toast]");
  await toasts.first().evaluate(async (el) => {
    await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})));
  });

  // Sonner's DEFAULT would park the older toast behind the newer one at nearly the same
  // coordinates, leaving its Undo unclickable. Expanded, they occupy separate rows.
  const layout = await page.evaluate(() => {
    const els = [...document.querySelectorAll("[data-sonner-toast]")] as HTMLElement[];
    if (els.length < 2) return null;
    const boxes = els.map((e) => e.getBoundingClientRect()).sort((a, b) => a.top - b.top);
    const [upper, lower] = boxes;
    // Every toast's Undo must be the top-most thing at its own centre — that's the property
    // that actually matters; "not overlapping" is just how it's achieved.
    const undoReachable = els.every((e) => {
      const btn = [...e.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Undo");
      if (!btn) return false;
      const r = btn.getBoundingClientRect();
      return btn.contains(document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2));
    });
    return { overlap: upper!.bottom > lower!.top, verticalGap: lower!.top - upper!.bottom, undoReachable };
  });

  expect(layout, "expected two toasts on screen").not.toBeNull();
  expect(layout!.overlap).toBe(false);
  expect(layout!.verticalGap).toBeGreaterThan(0);
  expect(layout!.undoReachable).toBe(true);

  await page.getByRole("button", { name: "Done selecting" }).click();
  await reset();
});

test("a bulk hide can be undone from its toast", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");
  await page.locator('[id^="repo-card-"]').first().waitFor({ state: "visible" });
  const before = await page.locator('[id^="repo-card-"]').count();

  await page.getByRole("banner").getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Select multiple" }).click();

  // Hide two repos.
  const cards = page.locator('[id^="repo-card-"]');
  const firstId = await cards.nth(0).getAttribute("id");
  await cards.nth(0).getByRole("button").first().click();
  await cards.nth(1).getByRole("button").first().click();
  await page.getByRole("button", { name: "Hide", exact: true }).click();

  // They leave the dashboard...
  await expect.poll(async () => cards.count()).toBe(before - 2);

  // ...and the toast's Undo puts them back, including the exact repos that went away.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => cards.count(), { timeout: 15_000 }).toBe(before);
  await expect(page.locator(`[id="${firstId}"]`)).toBeVisible();

  await page.getByRole("button", { name: "Done selecting" }).click();
});

test("undoing a bulk pin leaves already-pinned repos pinned", async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });

  // Start from a known pin state instead of inheriting one. This test pins repos, and an
  // earlier run that died mid-way (or any other spec here) can leave some pinned — which
  // silently changes what "undo restored the prior value" is even asserting. Reset over the
  // API rather than the UI: it's setup, not the behaviour under test.
  const listed = await (await request.get("/api/repos")).json();
  for (const r of (listed.repos ?? []) as { id: string; pinned?: boolean }[]) {
    if (r.pinned) await request.post(`/api/repos/${r.id}/pinned`, { data: { pinned: false } });
  }

  await page.goto("/");
  const cards = page.locator('[id^="repo-card-"]');
  await cards.first().waitFor({ state: "visible" });

  // Pin ONE repo up front, individually. Undo of a later bulk pin must not touch this one.
  await cards.first().getByRole("button").first().click(); // expand for its ⋮
  const preId = await cards.first().getAttribute("id");
  await cards.first().getByRole("button", { name: "More actions" }).click();
  // Tolerate a repo left pinned by an earlier (or aborted) run — the menu item reads "Unpin"
  // then, and insisting on "Pin" would hang on a state this test is about to create anyway.
  const pinItem = page.getByRole("menuitem", { name: "Pin", exact: true });
  if (await pinItem.isVisible().catch(() => false)) await pinItem.click();
  else await page.keyboard.press("Escape");
  await expect(page.locator("section").first().locator(`[id="${preId}"]`)).toBeVisible();

  // Now bulk-pin everything, then undo. The individual pin's toast may still be on screen —
  // in `expand` mode it takes its own row rather than burying this one, which means BOTH Undos
  // are live at once. So scope to the toast that reports the bulk pin; an unscoped "Undo" would
  // resolve to whichever came first and quietly undo the wrong action.
  await page.getByRole("banner").getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Select multiple" }).click();
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  const bulkToast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: /Pinned \d+ repositor/ })
    .first();
  await expect(bulkToast).toBeVisible();
  await bulkToast.getByRole("button", { name: "Undo" }).click();

  // The pre-pinned repo is STILL pinned — undo restored each repo's own prior value, it did
  // not blanket-unpin. A naive "set them all false" would have dropped this one.
  await expect(page.locator("section").first().locator(`[id="${preId}"]`)).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => page.locator("section").first().locator('[id^="repo-card-"]').count()).toBe(1);

  // Clean up.
  await page.getByRole("button", { name: "Done selecting" }).click();
  const pinnedCard = page.locator("section").first().locator(`[id="${preId}"]`);
  await pinnedCard.getByRole("button").first().click();
  await pinnedCard.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Unpin" }).click();
});

test("a pinned repo drops the pin badge inside the Pinned section", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");

  const firstCard = page.locator('[id^="repo-card-"]').first();
  await firstCard.waitFor({ state: "visible" });
  const repoId = await firstCard.getAttribute("id");
  await firstCard.getByRole("button").first().click(); // expand, so the ⋮ is reachable
  await firstCard.getByRole("button", { name: "More actions" }).click();
  // Tolerate a repo left pinned by an earlier run: only pin when it isn't already.
  const pinItem = page.getByRole("menuitem", { name: "Pin", exact: true });
  if (await pinItem.isVisible().catch(() => false)) await pinItem.click();
  else await page.keyboard.press("Escape");

  // It now lives in the Pinned section (the first one RepoList renders)...
  const pinnedSection = page.locator("section").first();
  const pinned = pinnedSection.locator(`[id="${repoId}"]`);
  await expect(pinned).toBeVisible();
  // ...so the pin badge, which only restates that heading, is gone from the card.
  await expect(pinned.locator('[aria-label="Pinned"]')).toHaveCount(0);

  // Clean up so the run is repeatable. Pinning re-renders the card into a different section,
  // which collapses it, so the ⋮ (in the expanded body) has to be re-revealed first.
  await pinned.getByRole("button").first().click();
  await pinned.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Unpin" }).click();
  await expect(page.locator("section").first().locator(`[id="${repoId}"]`)).toHaveCount(0);
});

test("AI providers list only what's connected, behind an Add provider picker", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Automation" }).click();

  // With nothing connected the catalogue is NOT dumped on screen.
  await expect(page.getByText("No providers connected yet.")).toBeVisible();
  const addBtn = page.getByRole("button", { name: "Add provider" });
  await expect(addBtn).toBeVisible();

  // Picking one from the menu reveals exactly that provider's key form.
  await addBtn.click();
  const firstOption = page.getByRole("menuitem").first();
  // The item is "<label>" plus a Suggested/Free-tier badge; the label is its first span.
  const providerName = (await firstOption.locator("span").first().textContent())!.trim();
  await firstOption.click();
  await expect(page.getByLabel(`${providerName} API key`)).toBeVisible();

  // Dismissing it puts the list back to empty.
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await expect(page.getByText("No providers connected yet.")).toBeVisible();
});

test("remove dialog does not scroll sideways on a long path", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/");

  const card = page.locator('[id^="repo-card-"]').first();
  await card.waitFor({ state: "visible" });
  await card.getByRole("button").first().click(); // expand

  await card.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Remove Repo" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The dialog itself must not be horizontally scrollable — the path's own box absorbs it.
  const box = await dialog.evaluate((d) => ({
    scrollWidth: d.scrollWidth,
    clientWidth: d.clientWidth,
    width: Math.round(d.getBoundingClientRect().width),
  }));
  expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
  // And it stays within a sane modal width rather than stretching to fit the path.
  expect(box.width).toBeLessThanOrEqual(520);

  // A copy button rides alongside the path box.
  await expect(dialog.getByRole("button", { name: "Copy path" })).toBeVisible();
});

test("repo sections collapse, and stay collapsed across a reload", async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });

  // Needs a Pinned section to exist: the catch-all section is only collapsible when a section
  // above it does, so with nothing pinned there is deliberately no toggle to test.
  const listed = await (await request.get("/api/repos")).json();
  const repos = (listed.repos ?? []) as { id: string; pinned?: boolean }[];
  for (const r of repos) if (r.pinned) await request.post(`/api/repos/${r.id}/pinned`, { data: { pinned: false } });
  await request.post(`/api/repos/${repos[0]!.id}/pinned`, { data: { pinned: true } });

  // Clear the stored preference ONCE for a known baseline. Deliberately not via addInitScript:
  // that re-runs on every navigation, including the reload below, which would wipe the very
  // state this test exists to check and let a broken persistence path pass.
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("repoyeti:sectionsCollapsed"));
  await page.reload();

  const pinnedHeader = page.getByRole("button", { name: /Pinned/i }).first();
  await expect(pinnedHeader).toBeVisible();
  await expect(pinnedHeader).toHaveAttribute("aria-expanded", "true");

  const pinnedSection = page.locator("section").first();
  const pinnedCards = pinnedSection.locator('[id^="repo-card-"]');
  await expect(pinnedCards.first()).toBeVisible();

  await pinnedHeader.click();
  await expect(pinnedHeader).toHaveAttribute("aria-expanded", "false");
  // The cards are hidden, not unmounted — the drag library holds the parent element.
  await expect(pinnedCards.first()).toBeHidden();
  await expect(pinnedHeader).toBeVisible(); // …and the way back is still on screen

  // The whole point: a layout you set up once. A reload must not undo it.
  await page.reload();
  const afterReload = page.getByRole("button", { name: /Pinned/i }).first();
  await expect(afterReload).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("section").first().locator('[id^="repo-card-"]').first()).toBeHidden();

  await afterReload.click();
  await expect(afterReload).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("section").first().locator('[id^="repo-card-"]').first()).toBeVisible();

  for (const r of repos) await request.post(`/api/repos/${r.id}/pinned`, { data: { pinned: false } });
});

test("the pull caret matches the Pull button it is joined to", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/");
  const card = page.locator('[id^="repo-card-"]').filter({ hasText: "behind-demo" }).first();
  await card.waitFor({ state: "visible" });
  await card.getByRole("button").first().click();
  await page.waitForTimeout(900);

  await expect(card.getByRole("button", { name: "Pull options" })).toBeVisible();
  const geo = await page.evaluate(() => {
    const caret = [...document.querySelectorAll('button[aria-label="Pull options"]')].pop() as HTMLElement;
    const pull = caret.previousElementSibling as HTMLElement;
    const b = pull.getBoundingClientRect(), k = caret.getBoundingClientRect();
    const ks = getComputedStyle(caret), bs = getComputedStyle(pull);
    return {
      pullH: Math.round(b.height), caretH: Math.round(k.height), caretW: Math.round(k.width),
      leftRadii: [ks.borderTopLeftRadius, ks.borderBottomLeftRadius],
      rightRadius: ks.borderTopRightRadius,
      sameBg: ks.backgroundColor === bs.backgroundColor,
      pullBg: bs.backgroundColor,
    };
  });

  // Same height, and the same colour — Pull goes accent when the repo is behind (this repo is),
  // and a hardcoded variant on the caret used to leave a grey stub welded to a green button.
  expect(geo.caretH).toBe(geo.pullH);
  expect(geo.sameBg).toBe(true);
  expect(geo.pullBg).not.toBe("rgba(0, 0, 0, 0)"); // i.e. it really is in the filled state
  // Squared where the two meet, still rounded on the outer edge.
  expect(geo.leftRadii).toEqual(["0px", "0px"]);
  expect(geo.rightRadius).not.toBe("0px");
  // Narrower than it is tall: a caret, not a second button.
  expect(geo.caretW).toBeLessThan(geo.pullH);
});

test("work-tree folders have their own right-click menu", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto("/");
  const card = page.locator('[id^="repo-card-"]').filter({ hasText: "alpha" }).first();
  await card.waitFor({ state: "visible" });
  await card.getByRole("button").first().click();
  await page.waitForTimeout(1200);

  // Folder rows are the ones carrying aria-expanded (they toggle a subtree).
  const folder = card.locator("button[data-tree-row][aria-expanded]").first();
  await expect(folder).toBeVisible();
  await folder.click({ button: "right" });

  // Ignoring a build directory used to mean one right-click per file inside it.
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByText("Stage folder")).toBeVisible();
  await expect(menu.getByText("Add to .gitignore")).toBeVisible();
  await expect(menu.getByText("Copy path")).toBeVisible();
  // Open / Open in editor are file-only: there is no folder to show in a diff viewer.
  await expect(menu.getByText("Open in editor")).toHaveCount(0);
  await page.keyboard.press("Escape");
});
