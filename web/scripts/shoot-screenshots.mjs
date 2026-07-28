/**
 * Marketing screenshots for the README and the repoyeti.com site.
 *
 * Shoots every view at BOTH a phone and a desktop viewport. The app is mobile-first, so the phone
 * shots are the hero — but "run git from your phone" still gets opened on a laptop, and shipping
 * only 400px-wide images made the desktop layout look like it did not exist.
 *
 * Point this at a dev server that is proxying to a DEMO daemon, never at a real one:
 *
 *   node scripts/shoot-screenshots.mjs --url http://localhost:4320
 *
 * The demo workspace comes from scripts/make-demo-workspace.ts at the repo root. Screenshots of
 * somebody's actual repositories leak private project names into a public README, which is why the
 * fixture exists at all.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const OUT_README = join(REPO, ".github", "screenshots");
const OUT_SITE = join(REPO, "site", "shots");

const args = process.argv.slice(2);
const urlArg = args.indexOf("--url");
const BASE = urlArg >= 0 ? args[urlArg + 1] : "http://localhost:4320";

/** Phone first: it is the product's primary form factor, and its shots are the README hero. */
const VIEWPORTS = [
  { name: "mobile", width: 400, height: 850, dsf: 3 },
  { name: "desktop", width: 1440, height: 900, dsf: 2 },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function dismissGate(page) {
  const local = page.getByRole("button", { name: /continue local/i });
  if (await local.isVisible().catch(() => false)) {
    await local.click();
    await wait(1500);
  }
}

/** Settle animations, lazy images and the row transition group before the shutter. */
async function settle(page, ms = 900) {
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await wait(ms);
}

/**
 * Trim the empty space below the content. The app is a single centred column, so at a desktop
 * viewport a short page leaves half the image as dead background — which reads as an app with
 * nothing in it. Clip to what is actually drawn instead of shipping the padding.
 */
async function contentBox(page, viewport) {
  const measured = await page
    .evaluate(() => {
      // Only real content anchors. Measuring `main` or `#app > *` is useless: those are
      // viewport-sized containers, so the result is always the full viewport and nothing is
      // trimmed. Repo cards are the app's actual content column.
      const cards = [...document.querySelectorAll("[id^='repo-card-']")];
      const footer = [...document.querySelectorAll("footer")];
      // The file viewer is an <aside> teleported to <body>, OUTSIDE the card column. Measuring
      // cards alone cropped the diff pane clean off the diff screenshot — the one thing it exists
      // to show — so anything docked on screen has to count as content too.
      const panels = [...document.querySelectorAll("aside")];
      const els = [...cards, ...footer, ...panels].filter(
        (el) => el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().width > 0,
      );
      if (!els.length) return null;
      return els.reduce(
        (acc, el) => {
          const r = el.getBoundingClientRect();
          return {
            left: Math.min(acc.left, r.left),
            right: Math.max(acc.right, r.right),
            bottom: Math.max(acc.bottom, r.bottom),
          };
        },
        { left: Infinity, right: 0, bottom: 0 },
      );
    })
    .catch(() => null);

  if (!measured) return { x: 0, y: 0, width: viewport.width, height: viewport.height };

  // The app is a centred column, so on a desktop viewport roughly a third of the frame is empty
  // background on each side. Cropping to the column makes the UI render far larger for the same
  // on-page width — the difference between a readable screenshot and a decorative one.
  const pad = 24;
  const x = Math.max(0, Math.floor(measured.left - pad));
  const right = Math.min(viewport.width, Math.ceil(measured.right + pad));
  const height = Math.max(320, Math.min(viewport.height, Math.ceil(measured.bottom) + pad));
  return { x, y: 0, width: Math.max(320, right - x), height };
}

async function shoot(page, name, viewport, opts = {}) {
  mkdirSync(OUT_README, { recursive: true });
  const file = join(OUT_README, `${name}-${viewport.name}.png`);
  await settle(page);
  // Phone shots are NEVER trimmed: they sit three-across in the README, and a short one
  // (the repo grid) next to two tall ones made the row look broken. Uniform height beats a
  // tighter crop, and at 400px wide there is no dead margin to reclaim anyway.
  let clip = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  if (viewport.name !== "mobile") {
    const box = await contentBox(page, viewport);
    // fullViewport: the shot was deliberately scrolled to frame something, so the vertical
    // measurement would clip to the wrong region — but the horizontal crop still applies.
    clip = opts.fullViewport ? { ...box, y: 0, height: viewport.height } : box;
  }
  await page.screenshot({ path: file, clip });
  console.log(`  shot ${name}-${viewport.name}.png (${clip.width}x${clip.height})`);
  return file;
}

async function firstCard(page) {
  const card = page.locator('[id^="repo-card-"]').first();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  return card;
}

/** Expand a card by clicking its disclosure control, then wait for the body to mount. */
async function expandCard(card) {
  const toggle = card.getByRole("button", { name: /^(Expand|Collapse)$/ }).first();
  const label = await toggle.getAttribute("aria-label").catch(() => null);
  if (label !== "Collapse") await toggle.click();
  await wait(1200);
}

async function run() {
  const browser = await chromium.launch();
  const produced = [];

  for (const vp of VIEWPORTS) {
    console.log(`\n== ${vp.name} ${vp.width}x${vp.height} ==`);
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dsf,
      isMobile: vp.name === "mobile",
      hasTouch: vp.name === "mobile",
      colorScheme: "dark",
    });
    const page = await ctx.newPage();
    // NOT "networkidle": the dashboard holds a live event stream open for as long as it is on
    // screen, so the network is never idle and the wait can only ever time out.
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[id^="repo-card-"], button', { timeout: 60_000 });
    await dismissGate(page);
    await page.waitForSelector('[id^="repo-card-"]', { timeout: 60_000 });
    await wait(2500);

    // ── 1. the repo grid ────────────────────────────────────────────────────────
    produced.push(await shoot(page, "dashboard", vp));

    // ── 2. history + activity overview ──────────────────────────────────────────
    const card = await firstCard(page);
    await expandCard(card);
    const history = card.getByRole("button", { name: /^History$/ }).first();
    if (await history.isVisible().catch(() => false)) {
      await history.click();
      await wait(2500);
      // Frame the History section itself. Shooting from the top of the card fills the image with
      // the commit box and pushes the graph — the actual subject — below the fold.
      await page
        .locator(".history-scroll")
        .first()
        .evaluate((el) => {
          el.scrollTop = 0;
        })
        .catch(() => {});
      await page
        .getByTestId("history-activity")
        .first()
        .evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }))
        .catch(() => {});
      await wait(600);
      produced.push(await shoot(page, "graph", vp, { fullViewport: true }));
    } else {
      console.log("  !! History button not found, skipping graph");
    }

    // ── 3. diff viewer ──────────────────────────────────────────────────────────
    // Deliberately payments-api: the fixture gives it a readable function-body change
    // (src/refunds.ts) chosen to look like something, rather than a one-line config tweak.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[id^="repo-card-"]', { timeout: 60_000 });
    await wait(2000);
    const payments = page.locator('[id^="repo-card-"]').filter({ hasText: "payments-api" }).first();
    if (await payments.isVisible().catch(() => false)) {
      await expandCard(payments);
      // File rows are labelled with their path; do NOT anchor on `$`, the row also carries
      // status and line-count text after the name.
      const fileBtn = payments
        .locator("button")
        .filter({ hasText: /refunds\.ts/ })
        .first();
      const target = (await fileBtn.count()) > 0
        ? fileBtn
        : payments.locator("button").filter({ hasText: /\.(ts|tsx|go|md|ya?ml|json)\b/ }).first();
      if (await target.isVisible().catch(() => false)) {
        await target.click();
        await wait(3500); // Monaco is lazy-loaded
        produced.push(await shoot(page, "diff", vp));
      } else {
        console.log("  !! no changed file row found, skipping diff");
      }
    } else {
      console.log("  !! payments-api card not found, skipping diff");
    }

    await ctx.close();
  }

  await browser.close();

  // The site reuses the same images; keep the two copies identical rather than shooting twice.
  mkdirSync(OUT_SITE, { recursive: true });
  for (const f of produced) {
    copyFileSync(f, join(OUT_SITE, f.split(/[\\/]/).pop()));
  }
  console.log(`\nwrote ${produced.length} shots to .github/screenshots and site/shots`);
  if (produced.length < VIEWPORTS.length * 3) {
    console.error("EXPECTED 3 shots per viewport — some were skipped, see !! lines above");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
