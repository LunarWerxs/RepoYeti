/**
 * Guardrail: every released heading in CHANGELOG.md must carry its comparison link.
 *
 * Keep a Changelog's `## [0.21.0]` heading only renders as a link if a matching `[0.21.0]: <url>`
 * reference exists at the bottom; without one it renders as literal bracketed text and the reader
 * has no way to reach that release's diff.
 *
 * WHY THIS EXISTS. Nothing enforced it, so it rotted silently and at scale: by 0.21.0, SEVENTEEN
 * consecutive releases had headings with no reference — every version from 0.15.3 onward. It is
 * exactly the class of omission that is invisible in review (the changelog still reads fine in
 * plain text) and that nobody goes back to fix, because by the time you notice, it is seventeen
 * entries of archaeology rather than one line.
 *
 * A release that adds a heading and forgets the reference now fails here instead.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CHANGELOG = resolve(ROOT, "CHANGELOG.md");

const text = readFileSync(CHANGELOG, "utf8");

const headings = [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]!);
const refs = new Set([...text.matchAll(/^\[(\d+\.\d+\.\d+)\]:\s*\S+/gm)].map((m) => m[1]!));

if (headings.length === 0) {
  console.error("✗ CHANGELOG.md has no `## [x.y.z]` release headings — is the format still Keep a Changelog?");
  process.exit(1);
}

const missing = headings.filter((v) => !refs.has(v));
if (missing.length > 0) {
  console.error(
    `✗ ${missing.length} release heading(s) in CHANGELOG.md have no link reference: ${missing.join(", ")}`,
  );
  console.error(
    "  Add one per version at the bottom of the file, newest first, e.g.\n" +
      `  [${missing[0]}]: https://github.com/LunarWerxs/RepoYeti/compare/v<previous>...v${missing[0]}`,
  );
  process.exit(1);
}

// A reference with no heading is the rarer direction (a deleted or renamed entry), and just as
// misleading: it implies a release the changelog no longer documents.
const orphans = [...refs].filter((v) => !headings.includes(v));
if (orphans.length > 0) {
  console.error(`✗ CHANGELOG.md link reference(s) with no matching release heading: ${orphans.join(", ")}`);
  process.exit(1);
}

console.log(`✓ all ${headings.length} CHANGELOG release headings carry a link reference`);
