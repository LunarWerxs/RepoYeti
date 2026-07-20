// History commit-detail changed-files view: nested folder tree or the flat full-path list.
//
// A GLOBAL preference, unlike the Changes panel's per-repo display mode: the History detail is
// a compact read-only listing where one taste applies everywhere, so a single Settings switch
// (Appearance → "History files as folder tree") beats hunting a per-card toggle. Same
// localStorage pattern as @/lib/changes-view.
import { useLocalStorage } from "@vueuse/core";

export type HistoryFilesView = "tree" | "list";

/** How an expanded commit's changed files render in History. Default: folder tree. */
export const historyFilesView = useLocalStorage<HistoryFilesView>("repoyeti:historyFilesView", "tree");
