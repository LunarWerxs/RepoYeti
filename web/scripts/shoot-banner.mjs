/**
 * Render .github/banner.png from a real screenshot.
 *
 * The old banner had a hand-drawn phone baked into a flat PNG: wrong proportions, thick bezel,
 * and a repo list that never matched what the app actually renders. This lays the real phone
 * capture into the same phone shell the website uses, so the banner and the site agree and both
 * track the product.
 *
 *   node scripts/shoot-banner.mjs
 *
 * Reads .github/screenshots/dashboard-mobile.png, writes .github/banner.png (1200x520 @2x).
 */
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SHOT = join(REPO, ".github", "screenshots", "dashboard-mobile.png");
const OUT = join(REPO, ".github", "banner.png");

const shotB64 = readFileSync(SHOT).toString("base64");
const markB64 = readFileSync(join(REPO, "site", "favicon.svg")).toString("base64");

const W = 1200;
// Tall enough to contain a 9:19.5 phone whole. At 420 the device ran off the bottom edge,
// which reads as a mistake rather than a crop.
const H = 520;

// Same tokens as the site, so the banner cannot drift from repoyeti.com's palette.
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  :root {
    --bg: oklch(0.145 0 0); --fg: oklch(0.985 0 0); --muted-fg: oklch(0.708 0 0);
    --faint: oklch(0.58 0 0); --border: oklch(1 0 0 / 10%); --green: #3ddc84;
    --mono: ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    width: ${W}px; height: ${H}px; background: var(--bg); color: var(--fg);
    font-family: Inter, system-ui, sans-serif; overflow: hidden;
    display: grid; grid-template-columns: 1fr 420px; align-items: center;
    /* the same soft green wash the site's hero sits on */
    background-image: radial-gradient(680px 340px at 88% 46%, rgba(61,220,132,.10), transparent 70%);
  }
  .left { padding: 0 0 0 64px; }
  .brand { display: flex; align-items: center; gap: 13px; margin-bottom: 26px; }
  .brand img { width: 40px; height: 40px; border-radius: 50%; }
  .brand span { font-size: 25px; font-weight: 650; letter-spacing: -0.01em; }
  h1 { font-size: 55px; font-weight: 700; line-height: 1.03; letter-spacing: -0.028em; }
  p { margin-top: 17px; font-size: 19px; color: var(--muted-fg); max-width: 27ch; line-height: 1.5; }
  .tags { margin-top: 27px; display: flex; gap: 9px; flex-wrap: wrap; }
  .tag {
    font-family: var(--mono); font-size: 12.5px; color: var(--muted-fg);
    border: 1px solid var(--border); border-radius: 7px; padding: 6px 11px;
    display: flex; align-items: center; gap: 7px;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); }
  /* The site's phone shell, to the pixel: 9:19.5, 5px bezel, concentric radii. */
  .stage { display: flex; justify-content: center; align-items: center; height: 100%; }
  .phone {
    width: 215px; border-radius: 34px; padding: 5px;
    background: linear-gradient(180deg, #2a2a2e, #131315);
    box-shadow: 0 40px 80px -30px rgba(0,0,0,.9), inset 0 1px 0 rgba(255,255,255,.06);
  }
  .screen { aspect-ratio: 9 / 19.5; border-radius: 29px; overflow: hidden; background: var(--bg); }
  .screen img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
</style></head><body>
  <div class="left">
    <div class="brand"><img src="data:image/svg+xml;base64,${markB64}" alt="" /><span>RepoYeti</span></div>
    <h1>Run git from<br />your phone.</h1>
    <p>A daemon on your machine, a dashboard in your pocket.</p>
    <div class="tags">
      <div class="tag"><span class="dot"></span>Live repo grid</div>
      <div class="tag"><span class="dot"></span>Git-graph history</div>
      <div class="tag"><span class="dot"></span>Monaco diffs</div>
    </div>
  </div>
  <div class="stage"><div class="phone"><div class="screen">
    <img src="data:image/png;base64,${shotB64}" alt="" />
  </div></div></div>
</body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts?.ready).catch(() => {});
await page.waitForTimeout(700);
await page.screenshot({ path: OUT });
await ctx.close();
await browser.close();
console.log(`wrote ${OUT}`);
