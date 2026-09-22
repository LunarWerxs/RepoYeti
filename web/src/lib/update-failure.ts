import { toast } from "vue-sonner";
import { ApiError } from "./httpClient";

/**
 * The build transcript a failed self-update hands back (POST /api/updates/apply → `output`).
 *
 * Before RepoYeti issue #24 was finished, a failed update reached the owner as one toast line and
 * nothing else: the engine recorded every step's `$ command` and output, then threw the array away
 * on every failure path. The daemon now returns it (and logs it), and this is the one place the
 * dashboard reads it, so both update entry points offer the same "Copy build log".
 */
export function updateFailureLog(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const output = (e.body as { output?: unknown } | undefined)?.output;
  if (!Array.isArray(output)) return null;
  const text = output.filter((entry): entry is string => typeof entry === "string").join("\n\n");
  return text || null;
}

/** Toast a failed update: its one-line reason, plus a copy action when a transcript came back.
 *  A transcript keeps the toast up longer, because the action is the point of it. */
export function toastUpdateFailure(title: string, e: unknown, t: (key: string) => string): void {
  const log = updateFailureLog(e);
  toast.error(title, {
    description: e instanceof Error ? e.message : undefined,
    ...(log
      ? {
          duration: 30_000,
          action: { label: t("notify.updateCopyLog"), onClick: () => void copyLog(log, t) },
        }
      : {}),
  });
}

async function copyLog(log: string, t: (key: string) => string): Promise<void> {
  try {
    await navigator.clipboard.writeText(log);
    toast.success(t("notify.updateLogCopied"));
  } catch {
    // Plain-http LAN origins have no clipboard API. The daemon logged the same transcript.
    toast.error(t("notify.updateLogCopyFailed"));
  }
}
