// Browser-local appearance preferences for the History panel.
//
// These are global display choices (shared by every repo card), so they follow the same
// VueUse/localStorage pattern as the History changed-files view. They take effect immediately
// without becoming daemon settings.

import { useLocalStorage } from "@vueuse/core";
import type { HistoryActivityScale } from "@/types";

export type HistoryChangesDisplay = "numbers" | "bars";

export const historyActivityEnabled = useLocalStorage<boolean>(
  "repoyeti:historyActivityEnabled",
  true,
);

/** Shared across repo cards so the selected activity range survives card and app reopens. */
export const historyActivityScale = useLocalStorage<HistoryActivityScale>(
  "repoyeti:historyActivityScale",
  "daily",
);

export const historyGraphEnabled = useLocalStorage<boolean>(
  "repoyeti:historyGraphEnabled",
  true,
);

export const historyChangesDisplay = useLocalStorage<HistoryChangesDisplay>(
  "repoyeti:historyChangesDisplay",
  "numbers",
);
