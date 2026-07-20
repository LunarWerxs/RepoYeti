// Keyboard-shortcut preferences + the canonical list of the app's accelerators.
//
// One persisted switch drives everything (same useLocalStorage pattern as the theme /
// locale prefs): hotkeysEnabled — master switch; when off, every app accelerator is
// ignored. (A second "power user" opt-in tier used to gate Ctrl/⌘+Enter; it was one more
// toggle standing between the owner and a shortcut that already can't fire by accident,
// so the tier is gone and every documented accelerator is simply on by default.)
//
// Handlers gate themselves with shortcutsActive(); the Settings → Updates & shortcuts
// card renders SHORTCUTS as a reference list and binds the switch. Intrinsic behaviour
// (native form Enter-submit, ARIA tree navigation) is deliberately NOT gated.
import { useLocalStorage } from "@vueuse/core";

/** Master switch for all app keyboard shortcuts (persisted; on by default). */
export const hotkeysEnabled = useLocalStorage("repoyeti:hotkeysEnabled", true);

/** A documented accelerator, surfaced in Settings → Updates & shortcuts. */
export interface Shortcut {
  /** Stable id; the Settings card maps it to a translated description. */
  id: string;
  /** Key-cap labels to render as <kbd> chips. */
  keys: string[];
}

/** The app's toggleable accelerators (array order = display order in Settings). */
export const SHORTCUTS: Shortcut[] = [
  { id: "commit", keys: ["Ctrl/⌘", "Enter"] },
  { id: "viewerClose", keys: ["Esc"] },
  { id: "viewerSave", keys: ["Ctrl/⌘", "S"] },
  { id: "treeResize", keys: ["↑", "↓", "Del"] },
];

/** Whether shortcuts should fire right now (the one master switch). */
export function shortcutsActive(): boolean {
  return hotkeysEnabled.value;
}
