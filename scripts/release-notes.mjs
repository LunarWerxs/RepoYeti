// Build a GitHub Release body from CHANGELOG.md.
//
// WHY THIS EXISTS: the Release workflow used `generate_release_notes: true` alone, which
// summarises the COMMITS in the range. This repo ships one squashed commit per release, so that
// produced a body containing nothing but a "Full Changelog" compare link — a release page that
// tells you nothing and makes you go find the changelog yourself. The changelog entry is already
// written for humans; this just puts it on the release page.
//
// Shape: a scannable one-line-per-change list up top (the bolded lead-in of each bullet, which is
// written to stand alone), then the full prose folded away for anyone who wants the detail, then
// where to get the binaries. The workflow still appends its generated "Full Changelog" link.
//
// Usage: node scripts/release-notes.mjs <version> [--repo owner/name] > notes.md
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const version = (argv[0] ?? "").replace(/^v/, "");
const repoAt = argv.indexOf("--repo");
const repo = repoAt === -1 ? "LunarWerxs/RepoYeti" : (argv[repoAt + 1] ?? "LunarWerxs/RepoYeti");

if (!version) {
  console.error("usage: node scripts/release-notes.mjs <version> [--repo owner/name]");
  process.exit(2);
}

/** The `## [1.2.3] - date` block for `version`, up to the next `## [` heading. */
function sectionFor(changelog, v) {
  const lines = changelog.split(/\r?\n/);
  // Escape the dots so "0.8.0" can't match "0x8y0"; headings are `## [0.8.0] - 2026-07-18`.
  const head = new RegExp(`^##\\s+\\[${v.replace(/\./g, "\\.")}\\]`);
  const start = lines.findIndex((l) => head.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+\[/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * One scannable line per change: the bolded lead-in that opens each bullet.
 *
 * Every changelog bullet here is written as "- **Headline sentence.** explanation…", so the bold
 * run IS the summary and needs no rewriting. Bullets that don't follow the pattern fall back to
 * their first sentence rather than being dropped — a silently missing entry would be worse than
 * a slightly long one. Group headings (### Added) are kept so the list stays sorted by kind.
 *
 * A bold run that stops mid-sentence (emphasis covering only the opening clause, "**…off
 * everywhere,** including inside the tree") is carried on to the end of that sentence: cutting at
 * the closing `**` would emit a headline ending in a comma.
 */
function condense(section) {
  const out = [];
  const bullets = section.split(/\n(?=- )|\n(?=### )/);
  for (const raw of bullets) {
    const block = raw.trim();
    if (!block) continue;
    if (block.startsWith("### ")) {
      out.push(`\n**${block.replace(/^###\s+/, "").trim()}**\n`);
      continue;
    }
    if (!block.startsWith("- ")) continue;
    // Unwrap the hard-wrapped bullet into one line before matching across the wrap.
    const flat = block.replace(/^- /, "").replace(/\s*\n\s*/g, " ").trim();
    const bold = /^\*\*(.+?)\*\*/.exec(flat);
    let headline = bold ? bold[1].trim() : "";
    if (!/[.!?]$/.test(headline)) {
      // No bold lead-in, or one that ends mid-sentence: take the first whole sentence of the
      // bullet with the emphasis markers stripped, so the headline reads as a sentence either way.
      const plain = flat.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
      headline = (/^(.+?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain).trim();
    }
    out.push(`- ${headline}`);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const changelog = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8");
const section = sectionFor(changelog, version);
if (!section) {
  console.error(`release-notes: no CHANGELOG.md section for ${version}`);
  process.exit(1);
}

const body = `## What's new

${condense(section)}

<details>
<summary>Full notes</summary>

${section}

</details>

## Install

Download the bundle for your platform, extract the whole folder, and run the RepoYeti executable.
No install step or runtime is required; keep the bundled \`web\` folder beside the executable.

| Platform | Asset |
| --- | --- |
| Linux (x64) | \`repoyeti-linux-x64.tar.gz\` |
| macOS (Apple silicon) | \`repoyeti-macos-arm64.tar.gz\` |
| Windows (x64) | \`repoyeti-windows-x64.zip\` |

Source checkouts can update in-app. Portable-bundle installs update by downloading and extracting
the newer archive; nothing is installed without your say-so.
Full history: [CHANGELOG.md](https://github.com/${repo}/blob/main/CHANGELOG.md)
`;

process.stdout.write(body);
