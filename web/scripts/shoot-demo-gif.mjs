/**
 * Capture the hero demo loop as a GIF of the REAL app.
 *
 * The site used to fake this with a hand-written HTML mock of the repo grid, which meant the
 * first thing a visitor saw was a drawing of the product rather than the product. This drives
 * the actual dashboard against the demo workspace and records it.
 *
 * Frames come off an explicit timeline, not a real-time recording, so pacing is exact and the
 * loop is reproducible. Each frame: move the real pointer (so genuine hover/press state fires),
 * move a drawn touch dot to the same place (a GIF has no cursor, so without it the taps look
 * like they happen by themselves), then screenshot.
 *
 *   node scripts/shoot-demo-gif.mjs --url http://127.0.0.1:4320 --out ../site/demo.gif
 *
 * Encoded at native resolution on purpose. Scaling resamples every pixel and defeats ffmpeg's
 * frame-diff optimisation, so a smaller GIF comes out with a BIGGER file.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const BASE = arg("--url", "http://127.0.0.1:4320");
const OUT = resolve(HERE, arg("--out", "../../site/demo.gif"));
const FRAMES = join(HERE, "..", ".gif-frames");

const W = 400;
const H = 850;
const FPS = 12;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const browser = await chromium.launch({ args: ["--hide-scrollbars", "--font-render-hinting=none"] });
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark",
});
const page = await ctx.newPage();
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(BASE, { waitUntil: "domcontentloaded" });
const local = page.getByRole("button", { name: /continue local/i });
if (await local.isVisible().catch(() => false)) {
  await local.click();
  await wait(1500);
}
await page.waitForSelector('[id^="repo-card-"]', { timeout: 60_000 });
await wait(2500);

// The pointer really moves, so it really triggers hover, and a tooltip fires wherever the touch
// dot happens to rest between beats. On a phone recording that reads as a glitch: no thumb
// summons a tooltip. Suppress them for the take.
await page.addStyleTag({
  content: '[role="tooltip"], [data-reka-popper-content-wrapper] { display: none !important; }',
});

// ------------------------------------------------------------------ drawn touch point
// A finger, not an arrow: this is a phone UI, and a mouse pointer on it reads as a mistake.
await page.evaluate(() => {
  const host = document.createElement("div");
  host.id = "__touch";
  host.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
  host.innerHTML = `
    <div id="__ring" style="position:absolute;left:0;top:0;width:0;height:0;border-radius:999px;
         border:2px solid rgba(61,220,132,.9);opacity:0;transform:translate(-50%,-50%);"></div>
    <div style="position:absolute;left:0;top:0;width:26px;height:26px;border-radius:999px;
         transform:translate(-50%,-50%);background:rgba(255,255,255,.26);
         border:1.5px solid rgba(255,255,255,.72);
         box-shadow:0 2px 10px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.35);"></div>`;
  document.body.appendChild(host);
  window.__cur = (x, y) => {
    host.style.transform = `translate(${x}px, ${y}px)`;
  };
  window.__ring = (t) => {
    const r = document.getElementById("__ring");
    if (t >= 1) {
      r.style.opacity = "0";
      return;
    }
    r.style.width = r.style.height = `${18 + 54 * t}px`;
    r.style.opacity = String((1 - t) * 0.85);
  };
});

// ------------------------------------------------------------------ frame engine
const REST = { x: 340, y: 800 };
let frame = 0;
let cursor = { ...REST };
let ring = { i: 999, n: 5 };

async function paint(x, y) {
  await page.mouse.move(x, y);
  const t = ring.i >= ring.n ? 1 : ring.i / ring.n;
  await page.evaluate(
    ([px, py, pt]) => {
      window.__cur(px, py);
      window.__ring(pt);
    },
    [x, y, t],
  );
  if (ring.i < ring.n) ring.i++;
}

async function snap() {
  await page.screenshot({ path: `${FRAMES}/f${String(frame).padStart(4, "0")}.png` });
  frame++;
}

async function hold(sec) {
  for (let i = 0; i < Math.round(sec * FPS); i++) {
    await paint(cursor.x, cursor.y);
    await snap();
  }
}

async function moveTo(pt, sec) {
  if (!pt) return;
  const n = Math.max(1, Math.round(sec * FPS));
  const from = { ...cursor };
  for (let i = 1; i <= n; i++) {
    const t = easeInOut(i / n);
    await paint(
      Math.round(from.x + (pt.x - from.x) * t),
      Math.round(from.y + (pt.y - from.y) * t),
    );
    await snap();
  }
  cursor = { x: pt.x, y: pt.y };
}

async function tap() {
  await page.mouse.click(cursor.x, cursor.y);
  ring = { i: 0, n: 5 };
}

/** Smoothly scroll a scroller (or the page) and record every step of it. */
async function scrollBy(selector, delta, sec) {
  const n = Math.max(1, Math.round(sec * FPS));
  for (let i = 1; i <= n; i++) {
    const step = delta / n;
    await page.evaluate(
      ([s, d]) => {
        const el = s ? document.querySelector(s) : null;
        if (el) el.scrollTop += d;
        else window.scrollBy(0, d);
      },
      [selector, step],
    );
    await paint(cursor.x, cursor.y);
    await snap();
  }
}

/**
 * Centre point of an element that is ACTUALLY IN THE VIEWPORT, scrolling it into view first.
 * A non-zero bounding box is not enough: an element parked above or below the fold still
 * measures fine, so a tap aimed at it lands on whatever happens to be at those coordinates.
 */
async function onScreen(pick) {
  const found = await page.evaluate((src) => {
    const el = new Function(`return (${src})()`)();
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    return true;
  }, pick.toString());
  if (!found) return null;
  await wait(350);
  return page.evaluate((src) => {
    const el = new Function(`return (${src})()`)();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    if (r.bottom < 0 || r.top > window.innerHeight) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, pick.toString());
}

/** Centre point of the first button/link whose visible text starts with `text`. */
const byText = async (text) =>
  page.evaluate((t) => {
    const e = [...document.querySelectorAll("button, a, summary")].find((b) =>
      `${(b.getAttribute("aria-label") || b.textContent || "").trim()} `.startsWith(`${t} `),
    );
    if (!e) return null;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, text);

// ------------------------------------------------------------------ the timeline
await page.evaluate(([x, y]) => window.__cur(x, y), [cursor.x, cursor.y]);

// 1. Let the eye land on the grid before anything moves.
await hold(0.7);

// 2. Open a repo. Deliberately payments-api: the fixture gives it a readable function-body
//    change (src/refunds.ts), where the first card's only edit is a one-line YAML tweak.
await moveTo(
  await onScreen(() => {
    const card = [...document.querySelectorAll('[id^="repo-card-"]')].find((c) =>
      (c.textContent || "").includes("payments-api"),
    );
    return card?.querySelector('button[aria-label="Expand"]') ?? null;
  }),
  0.4,
);
await tap();
await hold(1.3);

// 3. A real diff, tapped from the file tree. This runs FIRST because the tree is on screen the
//    moment the card opens; doing it after History pushed it off the viewport and the tap
//    silently missed, which is how the first cut of this loop shipped without its best beat.
const file = await onScreen(
  () =>
    [...document.querySelectorAll("button")].find((x) =>
      /refunds\.ts/.test((x.textContent || "").trim()),
    ) ?? null,
);
if (file) {
  await moveTo(file, 0.4);
  await tap();
  // Monaco is lazy-loaded. A fixed hold here spent its first second recording an empty pane and
  // a spinner, so wait for real rendered lines and only then start counting frames.
  await page
    .waitForFunction(
      () => (document.querySelectorAll(".monaco-editor .view-line").length ?? 0) > 3,
      null,
      { timeout: 20_000 },
    )
    .catch(() => {});
  await wait(400);
  await hold(2.0); // the diff is what people came to see, so it gets the longest hold
  const close = await onScreen(() =>
    [...document.querySelectorAll("button")].find((x) =>
      /close/i.test(x.getAttribute("aria-label") || ""),
    ),
  );
  if (close) {
    await moveTo(close, 0.32);
    await tap();
    await hold(0.7);
  }
}

// 4. Down through the working copy: the commit box and the git actions.
await scrollBy(null, 250, 0.6);
await hold(0.6);

// 5. History: activity chart, then the graph. The closing payoff gets the longest hold.
const history = await byText("History");
if (history) {
  await moveTo(history, 0.35);
  await tap();
  await hold(1.6);
  await scrollBy(".history-scroll", 220, 0.8);
  await hold(1.2);
}

// 6. Close the loop on the frame it opened with, so the seam does not jump.
await scrollBy(null, -1400, 0.6);
const collapse = await byText("Collapse");
if (collapse) {
  await moveTo(collapse, 0.3);
  await tap();
  await hold(0.8);
}
await moveTo(REST, 0.45);
await hold(0.5);

console.log(`frames: ${frame} (${(frame / FPS).toFixed(1)}s at ${FPS}fps)`);
await ctx.close();
await browser.close();

// ------------------------------------------------------------------ encode
mkdirSync(dirname(OUT), { recursive: true });
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-framerate", String(FPS),
    "-i", `${FRAMES}/f%04d.png`,
    "-vf",
    "split[a][b];[a]palettegen=stats_mode=diff:max_colors=200[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
    "-loop", "0",
    OUT,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
rmSync(FRAMES, { recursive: true, force: true });

if (!existsSync(OUT)) throw new Error(`ffmpeg produced no file at ${OUT}`);
console.log(`wrote ${OUT} (${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB)`);
