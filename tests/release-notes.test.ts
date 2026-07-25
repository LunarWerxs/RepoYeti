import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// The Release workflow builds its body with scripts/release-notes.mjs. If that script breaks or
// drifts from the CHANGELOG's shape, the failure lands on a published release page — after the
// tag is cut, when fixing it means editing the release by hand. So it is checked here against the
// real CHANGELOG.md rather than a fixture: the thing that actually ships is the thing under test,
// and an entry written in an unexpected shape fails the suite instead of the release.

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = resolve(ROOT, "scripts/release-notes.mjs");

async function run(version: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["node", SCRIPT, version], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
}

/** Every released version the changelog documents (skips the Unreleased heading). */
function releasedVersions(): string[] {
  const changelog = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8");
  return [...changelog.matchAll(/^##\s+\[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]!);
}

test("the current package version has a changelog section to release from", async () => {
  const { version } = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const { code } = await run(version);
  // Tagging a version with no changelog entry would publish binaries with no notes.
  expect(code).toBe(0);
});

test("a version with no changelog section fails instead of publishing empty notes", async () => {
  const { code } = await run("99.99.99");
  expect(code).toBe(1);
});

test("every changelog bullet becomes exactly one scannable headline", async () => {
  for (const version of releasedVersions()) {
    const { code, out } = await run(version);
    expect(code).toBe(0);

    const summary = out.slice(0, out.indexOf("<details>"));
    const detail = out.slice(out.indexOf("<details>"));
    const bulletsInDetail = (detail.match(/^- /gm) ?? []).length;
    const headlines = (summary.match(/^- /gm) ?? []).length;
    // One line up top per change documented below — nothing silently dropped on the way.
    expect(headlines).toBe(bulletsInDetail);
  }
});

/** The `- ` headlines from the scannable list above the `<details>` fold. */
function headlines(out: string): string[] {
  return out
    .slice(0, out.indexOf("<details>"))
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
}

test("headlines read as sentences, not truncated clauses", async () => {
  for (const version of releasedVersions()) {
    const { out } = await run(version);
    for (const text of headlines(out)) {
      // A bold lead-in covering only the opening clause used to be cut at the closing `**`,
      // producing "…off everywhere," as a headline. It must end as a sentence.
      expect(text).toMatch(/[.!?]$/);
      expect(text).not.toContain("**");
    }
  }
});

test("headlines for the version being released are actually condensed", async () => {
  // Length is only checked for the version that will ship next, because it is a property of the
  // ENTRY, not the script: bullets written "- **Headline.** detail…" condense to the bold run,
  // while the older entries here predate that convention and correctly fall back to their whole
  // first sentence. Asserting a cap across history would be asserting that already-published
  // releases were written differently than they were. This keeps the bar on what we write now.
  const { version } = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const { out } = await run(version);
  const lines = headlines(out);
  expect(lines.length).toBeGreaterThan(0);
  for (const text of lines) expect(text.length).toBeLessThanOrEqual(160);
});

test("the notes carry the install table and the changelog link", async () => {
  const { out } = await run(releasedVersions()[0]!);
  expect(out).toContain("repoyeti-windows-x64.zip");
  expect(out).toContain("repoyeti-macos-arm64.tar.gz");
  expect(out).toContain("repoyeti-linux-x64.tar.gz");
  expect(out).toContain("bundled `web` folder");
  expect(out).toContain("CHANGELOG.md");
});
