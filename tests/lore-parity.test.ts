import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  registerRepo,
  collectRepoDiff,
  searchChangedContent,
  planCommitInput,
  smartCommitRepo,
  stopWatching,
} from "../src/service/index.ts";

// Verifies the Lore feature-parity port (AI commit-diff, content search, smart-commit plan input +
// group staging) against a REAL `lore` CLI + a live local loreserver. Skipped when either is absent
// (e.g. CI), so it never flakes there; run locally after `loreserver` is up on the default ports.
const LORE = Bun.which("lore");
const GRPC = "lore://127.0.0.1:41337";
let SERVER_UP = false;
if (LORE) {
  try {
    SERVER_UP = (await fetch("http://127.0.0.1:41339/health_check")).ok;
  } catch {
    /* server not running → skip */
  }
}
const RUN = Boolean(LORE) && SERVER_UP;

test.skipIf(!RUN)("lore parity: AI diff · content search · plan input · smart-commit grouping", async () => {
  process.env.REPOYETI_LORE = "1"; // so detectVcs recognises the `.lore` working copy
  const root = mkdtempSync(join(tmpdir(), "ry-lore-"));
  const proj = join(root, "proj");
  await $`mkdir ${proj}`.nothrow().quiet();
  const name = `parity${Date.now()}`;
  await $`lore repository create ${GRPC}/${name}`.cwd(proj).quiet();
  writeFileSync(join(proj, "alpha.txt"), "needle apple\n");
  writeFileSync(join(proj, "beta.txt"), "banana\n");

  try {
    const reg = await registerRepo(proj);
    expect(reg.ok).toBe(true);
    expect(reg.repo?.vcs).toBe("lore");
    const id = reg.repo!.id;

    // ── SDK read path: structured status via @lore-vcs/sdk (proves the native binding loads and
    //    returns typed data — not the CLI text-scrape fallback) ──
    const { sdkStatus } = await import("../src/vcs/lore-sdk.ts");
    const sdk = await sdkStatus(proj);
    expect(sdk).not.toBeNull();
    expect(sdk?.branch).toBe("main");
    expect((sdk?.files ?? []).map((f) => f.path).sort()).toEqual(["alpha.txt", "beta.txt"]);
    expect((sdk?.files ?? []).every((f) => f.status === "A")).toBe(true); // both are new files → ADD

    // ── AI commit-diff: whole-tree `lore diff` + status summary ──
    const diff = await collectRepoDiff(id);
    expect(diff.ok).toBe(true);
    expect(diff.diff).toContain("alpha.txt");
    expect(diff.diff).toContain("beta.txt");

    // ── content search: JS scan, literal + case-insensitive, only matching files ──
    const found = await searchChangedContent(id, "NEEDLE");
    expect(found.ok).toBe(true);
    expect(found.paths).toContain("alpha.txt");
    expect(found.paths).not.toContain("beta.txt");

    // ── smart-commit plan input: the changed-file list drives grouping ──
    const plan = await planCommitInput(id);
    expect(plan.ok).toBe(true);
    expect((plan.input?.files ?? []).map((f) => f.path).sort()).toEqual(["alpha.txt", "beta.txt"]);

    // ── smart-commit group staging: two groups → two commits, each only its file ──
    const out = await smartCommitRepo(
      id,
      [
        { message: "feat: alpha", paths: ["alpha.txt"] },
        { message: "feat: beta", paths: ["beta.txt"] },
      ],
      false,
    );
    expect(out.ok).toBe(true);
    expect(out.committed?.length).toBe(2);
    expect(out.committed?.every((c) => c.ok)).toBe(true);

    const hist = (await $`lore history 10`.cwd(proj).quiet()).stdout.toString();
    expect(hist).toContain("feat: alpha");
    expect(hist).toContain("feat: beta");

    // ── SDK read paths for branches + log (structured, not CLI scrape) ──
    const { sdkBranches, sdkLog } = await import("../src/vcs/lore-sdk.ts");
    const br = await sdkBranches(proj);
    expect(br?.branches.some((b) => b.name === "main")).toBe(true);
    const log = await sdkLog(proj, 10);
    expect((log ?? []).map((c) => c.subject)).toEqual(expect.arrayContaining(["feat: alpha", "feat: beta"]));
  } finally {
    stopWatching();
    rmSync(root, { recursive: true, force: true });
  }
});
