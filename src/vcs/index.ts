/**
 * VCS backend registry — the one place "which VCS?" is answered.
 *
 * service.ts / discovery / the watcher resolve a backend here instead of importing git
 * functions directly. While Lore is a pre-1.x spike it's OFF by default: detectVcs only ever
 * returns "git" (or null) unless the owner opts in with REPOYETI_LORE=1, so the running daemon's
 * behavior is byte-for-byte unchanged until Lore is deliberately enabled.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitBackend } from "./git.ts";
import { loreBackend } from "./lore.ts";
import type { VcsBackend, VcsKind } from "./types.ts";

/** Opt-in flag for the experimental Lore backend: REPOYETI_LORE=1|true|yes|on. */
export function isLoreEnabled(): boolean {
  const v = (process.env.REPOYETI_LORE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

const BACKENDS: Record<VcsKind, VcsBackend> = {
  git: gitBackend,
  lore: loreBackend,
};

export function backendFor(kind: VcsKind): VcsBackend {
  return BACKENDS[kind];
}

/**
 * Which VCS owns the working copy at `absPath`, or null if neither marker is present. Lore is
 * checked first but ONLY when enabled — so with the flag off this is exactly today's behavior
 * ("git" when `.git` exists, else null), and a stray `.lore` dir is ignored.
 */
export function detectVcs(absPath: string): VcsKind | null {
  if (isLoreEnabled() && existsSync(join(absPath, ".lore"))) return "lore";
  if (existsSync(join(absPath, ".git"))) return "git";
  return null;
}

export type { VcsBackend, VcsKind, VcsCapabilities } from "./types.ts";
