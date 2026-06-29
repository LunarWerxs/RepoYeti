// Keyboard-shortcut preferences + the canonical list of the app's accelerators.
//
// Two persisted switches drive everything (same useLocalStorage pattern as the theme /
// locale prefs):
//   • hotkeysEnabled — master switch; when off, every app accelerator is ignored.
//   • powerShortcuts — opt-in group for advanced combos (Ctrl/⌘+Enter to commit).
//
// Handlers gate themselves with shortcutsActive(); the Settings → Keyboard shortcuts
// card renders SHORTCUTS as a reference list and binds the two switches. Intrinsic
// behaviour (native form Enter-submit, ARIA tree navigation) is deliberately NOT gated.
import { useLocalStorage } from "@vueuse/core";

/** Master switch for all app keyboard shortcuts (persisted; on by default). */
export const hotkeysEnabled = useLocalStorage("gitmob:hotkeysEnabled", true);

/** Power-user shortcuts — e.g. Ctrl/⌘+Enter to commit (persisted; off by default). */
export const powerShortcuts = useLocalStorage("gitmob:powerShortcuts", false);

/** A documented accelerator, surfaced in Settings → Keyboard shortcuts. */
export interface Shortcut {
  /** Stable id; the Settings card maps it to a translated description. */
  id: string;
  /** Key-cap labels to render as <kbd> chips. */
  keys: string[];
  /** Power-user shortcuts only fire when `powerShortcuts` is also on. */
  power?: boolean;
}

/** The app's toggleable accelerators (array order = display order in Settings). */
export const SHORTCUTS: Shortcut[] = [
  { id: "commit", keys: ["Ctrl/⌘", "Enter"], power: true },
  { id: "viewerClose", keys: ["Esc"] },
  { id: "viewerSave", keys: ["Ctrl/⌘", "S"] },
  { id: "treeResize", keys: ["↑", "↓", "Del"] },
];

/**
 * Whether a shortcut should fire right now. Pass `power = true` for accelerators in the
 * power-user group — they additionally require `powerShortcuts`. The master switch
 * (`hotkeysEnabled`) gates everything.
 */
export function shortcutsActive(power = false): boolean {
  return hotkeysEnabled.value && (!power || powerShortcuts.value);
}
