/**
 * The VCS-agnostic backend abstraction (src/vcs/*). Proves the git backend satisfies the
 * contract, that the registry resolves both kinds, and — critically — that the Lore backend
 * is gated behind REPOYETI_LORE so the default git path is unchanged.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitBackend } from "../src/vcs/git.ts";
import { loreBackend } from "../src/vcs/lore.ts";
import { detectVcs, backendFor, isLoreEnabled } from "../src/vcs/index.ts";

describe("vcs backend abstraction", () => {
  const created: string[] = [];
  const origLore = process.env.REPOYETI_LORE;

  afterEach(() => {
    if (origLore === undefined) delete process.env.REPOYETI_LORE;
    else process.env.REPOYETI_LORE = origLore;
    for (const d of created.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  });

  it("git backend maps the contract to the real git plumbing", () => {
    expect(gitBackend.kind).toBe("git");
    expect(gitBackend.marker).toBe(".git");
    expect(gitBackend.capabilities).toEqual({ stash: true, fetch: true, multipleRemotes: true, fileModels: true });
    expect(backendFor("git")).toBe(gitBackend);
    expect(backendFor("lore")).toBe(loreBackend);
  });

  it("lore backend declares its centralized capabilities", () => {
    expect(loreBackend.kind).toBe("lore");
    expect(loreBackend.marker).toBe(".lore");
    expect(loreBackend.capabilities).toEqual({ stash: false, fetch: false, multipleRemotes: false, fileModels: false });
  });

  it("detects git always, but Lore only when REPOYETI_LORE is set", () => {
    const gitRepo = mkdtempSync(join(tmpdir(), "ry-git-"));
    created.push(gitRepo);
    mkdirSync(join(gitRepo, ".git"));
    const loreRepo = mkdtempSync(join(tmpdir(), "ry-lore-"));
    created.push(loreRepo);
    mkdirSync(join(loreRepo, ".lore"));

    delete process.env.REPOYETI_LORE;
    expect(isLoreEnabled()).toBe(false);
    expect(detectVcs(gitRepo)).toBe("git");
    expect(detectVcs(loreRepo)).toBe(null); // .lore ignored while Lore is disabled

    process.env.REPOYETI_LORE = "1";
    expect(isLoreEnabled()).toBe(true);
    expect(detectVcs(loreRepo)).toBe("lore");
    expect(detectVcs(gitRepo)).toBe("git"); // git still wins / still works
  });

  it("lore stash mutations are refused, reads come back empty", async () => {
    expect((await loreBackend.stashSave("/nowhere", null)).ok).toBe(false);
    const stashes = await loreBackend.readStashes("/nowhere");
    expect(stashes.ok).toBe(true);
    expect(stashes.stashes).toEqual([]);
  });
});
