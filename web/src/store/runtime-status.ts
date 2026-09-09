/**
 * The daemon-owned runtime state, and the ONE table that says how each field is filled.
 *
 * WHY THIS FILE EXISTS (1.0 audit, item 21). These forty-odd fields used to be declared in the
 * root store, defaulted again in one snapshot function, re-validated again in six `settings_*`
 * handlers, and threaded through a forty-line dependency bundle so those handlers could reach
 * them. Adding one setting meant four coordinated edits in four distant blocks, and forgetting
 * any of them was silent: the field simply never updated, or updated everywhere except on a
 * reconnect, which is exactly the state-drift shape this project has already fixed twice
 * elsewhere. Now a setting is ONE entry in `FIELDS`, and leaving it out is a compile error.
 *
 * THE TWO SEMANTICS, which are genuinely different and must stay that way:
 *
 *   · GET /api/status is a SNAPSHOT. An absent key means "the daemon does not have this", so the
 *     field resets to the daemon's own absent-key default. That matters for real: a share-link
 *     guest gets a deliberately narrow projection (routes/health.ts hand-picks what to keep), so
 *     most of these keys are genuinely missing rather than false.
 *   · `settings_changed` and `daemon_status` are PATCHES. An absent key means "unchanged, leave
 *     it alone". `daemon_status` in particular is emitted by the relay with only relay fields in
 *     it, and treating its absent `tunnelUrl` as null once erased a healthy quick-tunnel URL and
 *     left the UI spinning forever.
 *
 * A field that wants "leave it alone" on a SNAPSHOT too says so with `KEEP` (the redacted tunnel
 * and relay blobs, which the guest projection omits entirely and which have no meaningful
 * client-side default).
 */
import { ref, type Ref } from "vue";
import type { AccessMode, RelayStatus, RuntimeStatus, TunnelStatus } from "@/api";
import type { ChangesStatDisplay } from "@/types";
import { rememberRelayHome } from "@/lib/relay-home";

/** An absent snapshot key that must NOT reset the field. See the header. */
const KEEP = Symbol("keep");

/**
 * Which broadcasts carry a field.
 * `settings` = the `settings_changed` event; `daemon` = `daemon_status`. A field on neither is
 * snapshot-only, which is a statement about the daemon, not an oversight to fix here.
 */
type PatchChannel = "settings" | "daemon";

/** Accept a value off the wire, or return undefined to mean "not something I can use". */
type Accept<T> = (raw: unknown) => T | undefined;

const bool: Accept<boolean> = (v) => (typeof v === "boolean" ? v : undefined);
const num: Accept<number> = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str: Accept<string> = (v) => (typeof v === "string" ? v : undefined);
/**
 * A field the daemon sends as `string | null`, where a present-but-not-a-string value means
 * "cleared" rather than "ignore this". `defaultEditor: null` is a legitimate value (the owner
 * cleared their pick), so gating on truthiness would silently drop it.
 */
const clearableStr: Accept<string | null> = (v) =>
  v === undefined ? undefined : typeof v === "string" ? v : null;
const oneOf =
  <T extends string>(...allowed: readonly T[]): Accept<T> =>
  (v) =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
/** A whole redacted config blob (tunnel/relay). Its shape is the daemon's; refuse non-objects. */
const blob =
  <T>(): Accept<T> =>
  (v) =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as T) : undefined;

interface FieldSpec<T> {
  ref: Ref<T>;
  /** Key in GET /api/status. */
  statusKey: string;
  /** Key in the patch payloads, when it differs from `statusKey`. */
  patchKey?: string;
  /** Which broadcasts carry this field. Omit for snapshot-only. */
  patchOn?: readonly PatchChannel[];
  /** What an ABSENT (or unusable) snapshot value means: this value, or KEEP to leave it alone. */
  whenAbsent: T | typeof KEEP;
  accept: Accept<T>;
}

/**
 * A field with its type erased, so one array can hold all of them while each entry's own
 * assignment stays type-checked inside `field<T>()`.
 */
interface ErasedField {
  statusKey: string;
  patchKey: string;
  patchOn: readonly PatchChannel[];
  fromSnapshot: (raw: unknown) => void;
  fromPatch: (raw: unknown) => void;
}

function field<T>(spec: FieldSpec<T>): ErasedField {
  return {
    statusKey: spec.statusKey,
    patchKey: spec.patchKey ?? spec.statusKey,
    patchOn: spec.patchOn ?? [],
    fromSnapshot: (raw) => {
      const accepted = spec.accept(raw);
      if (accepted !== undefined) spec.ref.value = accepted;
      else if (spec.whenAbsent !== KEEP) spec.ref.value = spec.whenAbsent as T;
    },
    fromPatch: (raw) => {
      const accepted = spec.accept(raw);
      if (accepted !== undefined) spec.ref.value = accepted;
    },
  };
}

/**
 * The side effects a SNAPSHOT triggers, handed in at the call site rather than at construction.
 *
 * They come from useSettings, which in turn takes most of the refs below as arguments, so a
 * constructor-injected dependency would be a cycle. Passing them per call also keeps this module
 * free of any opinion about who owns them.
 */
export interface SnapshotHooks {
  notifyAiKeyInvalid: (label: string) => void;
}

/** The side effects a `settings_changed` PATCH triggers. Same reasoning as SnapshotHooks. */
export interface PatchHooks {
  loadSyncStatus: () => unknown;
  loadEditors: (force?: boolean) => unknown;
  /** Whether this tab has loaded the editor catalogue at all. */
  editorsLoaded: Ref<boolean>;
}

export type RuntimeStatusStore = ReturnType<typeof useRuntimeStatus>;

export function useRuntimeStatus() {
  // Public cloudflared tunnel URL (null until one exists) + whether a tunnel is up. Surfaced in
  // the connection panel so the owner can open RepoYeti on their phone.
  const tunnelUrl = ref<string | null>(null);
  const tunnelActive = ref(false);
  // Redacted named-tunnel config (stable hostname + token-presence flags; never the token).
  // Drives the Settings "Stable address" editor.
  const tunnelConfig = ref<TunnelStatus>({
    hostname: null,
    hasToken: false,
    tokenFromEnv: false,
    named: false,
  });
  // Redacted relay config (opt-in flag, base URL, public id; never the keypair) plus the permanent
  // forwarding URL it yields and whether the daemon's address is actually registered there.
  const relayConfig = ref<RelayStatus>({
    // Match the daemon's effective default before /api/status finishes loading. Starting this at
    // false made the Settings panel briefly, and sometimes permanently, select the temporary
    // Cloudflare address when it mounted during startup, even though the daemon was relay-on.
    enabled: true,
    url: null,
    id: null,
    defaultUrl: "https://app.repoyeti.com",
  });
  const relayUrl = ref<string | null>(null);
  const relayAnnounced = ref(false);
  const relayError = ref<string | null>(null);
  // Access mode + local/remote auth state (see /api/auth/status).
  const mode = ref<AccessMode>("local");
  // Version of the DAEMON this dashboard is talking to — not of the bundle it is running. With
  // auto-update on, the phone is often the only place the owner can see what actually got
  // installed, so Settings shows this rather than a build-time constant baked into the SPA.
  const serverVersion = ref("");

  // Owner setting: show added/removed line + char counts per file and per repo.
  const diffStatsEnabled = ref(false);
  // Work-tree appearance. Daemon settings (not localStorage) so they follow the owner across
  // devices; the defaults in the table below match config.ts's absent-key ones.
  const changesStatDisplay = ref<ChangesStatDisplay>("numbers");
  const changesCharsEnabled = ref(true);
  // Owner setting: allow editing/saving files over the remote tunnel (local edits always on).
  const remoteEditing = ref(true);
  const remoteBrowse = ref(true);
  // Owner setting: changed files larger than this (bytes, either side) open as a compact patch in
  // the viewer's Diff tab instead of a side-by-side load.
  const diffPatchBytes = ref(512 * 1024);
  // Owner setting: whether large files may use the compact patch at all (false = side-by-side).
  const diffPatchEnabled = ref(true);
  // Owner setting: run a periodic background fetch so the dashboard can warn when a repo falls
  // behind its remote, and how often.
  const syncCheckEnabled = ref(false);
  const syncIntervalSecs = ref(300);
  // Owner setting: after the check, auto fast-forward repos that can safely take new commits.
  const keepInSync = ref(false);
  // Owner settings: the auto-commit timer (opt-in globally here + per-repo on each card).
  const autoCommit = ref(false);
  const autoCommitMode = ref<"interval" | "daily">("interval");
  const autoCommitIntervalSecs = ref(900);
  const autoCommitAt = ref("18:00");
  const autoCommitPull = ref(true);
  const autoCommitPush = ref(true);
  const autoCommitAiFallback = ref<"skip" | "basic">("skip");
  // Owner setting: silently auto-update + restart the app on a schedule (opt-in).
  const autoUpdate = ref(false);
  // Owner setting: announce an available update (a bell entry + a prompt offering to install).
  // ON by default: it only tells you; installing still takes a click, or `autoUpdate` above.
  const updateNotify = ref(true);
  // Owner setting: sweep the whole machine for repos on every app start. See AppShell.vue's
  // scheduleIdle(() => autoScan && startScan()) on mount.
  const autoScan = ref(false);
  // Owner setting: open the app UI in a chromeless Chromium app window instead of a browser tab.
  // The desktop launcher/tray follows the same preference (read off runtime.json, not this).
  const portableMode = ref(false);
  // Owner setting: hide the system-tray notification-area icon. The daemon keeps running either
  // way; the tray reads the same flag off runtime.json so it can act before the daemon is up.
  const hideTrayIcon = ref(false);
  // ⭐ Agent Safety Rail: whether mutating MCP tool calls are gated behind owner approve/deny,
  // whether a pending approval auto-denies (default ON) or auto-approves (default OFF) at its
  // timeout, and those timeouts in seconds. Gated-on is the safe default until status loads.
  const mcpApprovalGate = ref(true);
  const mcpApprovalTimeoutSecs = ref(120);
  const mcpAutoDeny = ref(true);
  const mcpAutoApprove = ref(false);
  const mcpAutoApproveTimeoutSecs = ref(120);
  // Owner setting: default "Open with…" external editor id (null = auto-pick the first
  // installed). The catalogue + availability come from a separate GET /api/editors.
  const defaultEditor = ref<string | null>(null);
  // Min query length before the changed-files "search content" toggle greps. Server-owned, so the
  // UI gate never drifts from the daemon's.
  const contentSearchMin = ref(3);
  // Owner setting: whether the Lore-servers settings section is expanded (collapsed by default
  // for owners who do not use Lore). True until status loads so the section does not flash
  // collapsed-then-open for existing users. useSources borrows this ref for its optimistic
  // toggle; it is a daemon setting like every other one here, and the whole point of this file
  // is that they are synchronised in one place.
  const loreServersEnabled = ref(true);

  /** Every ref this module owns. The table below must cover each one, or it will not compile. */
  const owned = {
    tunnelUrl,
    tunnelActive,
    tunnelConfig,
    relayConfig,
    relayUrl,
    relayAnnounced,
    relayError,
    mode,
    serverVersion,
    diffStatsEnabled,
    changesStatDisplay,
    changesCharsEnabled,
    remoteEditing,
    remoteBrowse,
    diffPatchBytes,
    diffPatchEnabled,
    syncCheckEnabled,
    syncIntervalSecs,
    keepInSync,
    autoCommit,
    autoCommitMode,
    autoCommitIntervalSecs,
    autoCommitAt,
    autoCommitPull,
    autoCommitPush,
    autoCommitAiFallback,
    autoUpdate,
    updateNotify,
    autoScan,
    portableMode,
    hideTrayIcon,
    mcpApprovalGate,
    mcpApprovalTimeoutSecs,
    mcpAutoDeny,
    mcpAutoApprove,
    mcpAutoApproveTimeoutSecs,
    defaultEditor,
    contentSearchMin,
    loreServersEnabled,
  };

  /**
   * THE TABLE. One entry per daemon-owned field: where it comes from in the snapshot, what an
   * absent snapshot value means, which broadcasts patch it, and what a patch value has to look
   * like to be believed.
   *
   * `satisfies Record<...>` is the point of the whole file: adding a ref above without a row here
   * fails the build, and so does a row for a ref that no longer exists. That is the coordinated
   * edit this item was about, made impossible to forget rather than merely documented.
   */
  const FIELDS = {
    // ── connection / remote access ────────────────────────────────────────────────────────
    // The daemon's own version, not this bundle's. Snapshot-only.
    serverVersion: field({ ref: serverVersion, statusKey: "version", whenAbsent: "", accept: str }),
    mode: field({ ref: mode, statusKey: "mode", whenAbsent: "local", accept: oneOf("local", "remote") }),
    tunnelActive: field({
      ref: tunnelActive,
      statusKey: "tunnelActive",
      patchOn: ["daemon"],
      whenAbsent: false,
      accept: bool,
    }),
    tunnelUrl: field({
      ref: tunnelUrl,
      statusKey: "tunnelUrl",
      patchOn: ["daemon"],
      whenAbsent: null,
      accept: clearableStr,
    }),
    // KEEP: the guest projection omits the redacted blobs entirely, and there is no sensible
    // client-side default to reset to — the constructed initial value is the whole story.
    tunnelConfig: field({
      ref: tunnelConfig,
      statusKey: "tunnel",
      patchOn: ["settings"],
      whenAbsent: KEEP,
      accept: blob<TunnelStatus>(),
    }),
    relayConfig: field({
      ref: relayConfig,
      statusKey: "relay",
      patchOn: ["settings", "daemon"],
      whenAbsent: KEEP,
      accept: blob<RelayStatus>(),
    }),
    relayUrl: field({
      ref: relayUrl,
      statusKey: "relayUrl",
      patchOn: ["daemon"],
      whenAbsent: null,
      accept: clearableStr,
    }),
    relayAnnounced: field({
      ref: relayAnnounced,
      statusKey: "relayAnnounced",
      patchOn: ["daemon"],
      whenAbsent: false,
      accept: bool,
    }),
    relayError: field({
      ref: relayError,
      statusKey: "relayError",
      patchOn: ["daemon"],
      whenAbsent: null,
      accept: clearableStr,
    }),

    // ── work-tree display ─────────────────────────────────────────────────────────────────
    diffStatsEnabled: field({
      ref: diffStatsEnabled,
      statusKey: "diffStats",
      patchOn: ["settings"],
      whenAbsent: false,
      accept: bool,
    }),
    changesStatDisplay: field({
      ref: changesStatDisplay,
      statusKey: "changesStatDisplay",
      patchOn: ["settings"],
      whenAbsent: "numbers",
      accept: oneOf("numbers", "bars"),
    }),
    changesCharsEnabled: field({
      ref: changesCharsEnabled,
      statusKey: "changesChars",
      patchOn: ["settings"],
      whenAbsent: true,
      accept: bool,
    }),
    diffPatchBytes: field({
      ref: diffPatchBytes,
      statusKey: "diffPatchBytes",
      patchOn: ["settings"],
      whenAbsent: 512 * 1024,
      accept: num,
    }),
    diffPatchEnabled: field({
      ref: diffPatchEnabled,
      statusKey: "diffPatchEnabled",
      patchOn: ["settings"],
      whenAbsent: true,
      accept: bool,
    }),
    // Server-owned so the UI's "search content" gate can never drift from the daemon's grep gate.
    // Snapshot-only: the daemon treats it as a constant, not a setting.
    contentSearchMin: field({
      ref: contentSearchMin,
      statusKey: "minContentSearch",
      whenAbsent: 3,
      accept: num,
    }),

    // ── remote permissions ────────────────────────────────────────────────────────────────
    // Both are pinned false in the guest projection, so the absent-key default only ever applies
    // to an owner talking to a daemon too old to send them.
    remoteEditing: field({
      ref: remoteEditing,
      statusKey: "remoteEditing",
      patchOn: ["settings"],
      whenAbsent: true,
      accept: bool,
    }),
    remoteBrowse: field({
      ref: remoteBrowse,
      statusKey: "remoteBrowse",
      patchOn: ["settings"],
      whenAbsent: true,
      accept: bool,
    }),

    // ── background sync ───────────────────────────────────────────────────────────────────
    syncCheckEnabled: field({
      ref: syncCheckEnabled,
      statusKey: "syncCheck",
      patchOn: ["settings"],
      whenAbsent: false,
      accept: bool,
    }),
    syncIntervalSecs: field({
      ref: syncIntervalSecs,
      statusKey: "syncIntervalSecs",
      patchOn: ["settings"],
      whenAbsent: 300,
      accept: num,
    }),
    keepInSync: field({
      ref: keepInSync,
      statusKey: "keepInSync",
      patchOn: ["settings"],
      whenAbsent: false,
      accept: bool,
    }),

    // ── auto-commit ───────────────────────────────────────────────────────────────────────
    autoCommit: field({
      ref: autoCommit,
      statusKey: "autoCommit",
      patchOn: ["settings"],
      whenAbsent: false,
      accept: bool,
    }),
    autoCommitMode: field({
      ref: autoCommitMode,
      statusKey: "autoCommitMode",
      patchOn: ["settings"],
      whenAbsent: "interval",
      accept: oneOf("interval", "daily"),
    }),
    autoCommitIntervalSecs: field({
      ref: autoCommitIntervalSecs,
      statusKey: "autoCommitIntervalSecs",
      patchOn: ["settings"],
      whenAbsent: 900,
      accept: num,
    }),
    autoCommitAt: field({
      ref: autoCommitAt,
      statusKey: "autoCommitAt",
      patchOn: ["settings"],
      whenAbsent: "18:00",
      accept: str,
    }),
    autoCommitPull: field({
      ref: autoCommitPull,
      statusKey: "autoCommitPull",
      patchOn: ["settings"],
      whenAbsent: true,
      accept: bool,
    }),
    autoCommitPush: field({
      ref: autoCommitPush,
      statusKey: "autoCommitPush",
      patchOn: ["settings"],
      whenAbsent: true,
      accept: bool,
    }),
    autoCommitAiFallback: field({
      ref: autoCommitAiFallback,
      statusKey: "autoCommitAiFallback",
      patchOn: ["settings"],
      whenAbsent: "skip",
      accept: oneOf("skip", "basic"),
    }),

    // ── updates, scanning, presentation ───────────────────────────────────────────────────
    autoUpdate: field({
      ref: autoUpdate,
      statusKey: "autoUpdate",
      patchOn: ["settings"],
      whenAbsent: false,
      accept: bool,
    }),
    updateNotify: field({
      ref: updateNotify,
      statusKey: "updateNotify",
      patchOn: ["settings"],
      whenAbsent: true,
      accept: bool,
    }),
    autoScan: field({
      ref: autoScan,
      statusKey: "autoScan",
      patchOn: ["settings"],
      whenAbsent: false,
      accept: bool,
    }),
    loreServersEnabled: field({
      ref: loreServersEnabled,
      statusKey: "loreServersEnabled",
      patchOn: ["settings"],
      whenAbsent: true,
      accept: bool,
    }),
    portableMode: field({
      ref: portableMode,
      statusKey: "portableMode",
      patchOn: ["settings"],
      whenAbsent: false,
      accept: bool,
    }),
    hideTrayIcon: field({
      ref: hideTrayIcon,
      statusKey: "hideTrayIcon",
      patchOn: ["settings"],
      whenAbsent: false,
      accept: bool,
    }),

    // ── agent safety rail ─────────────────────────────────────────────────────────────────
    mcpApprovalGate: field({
      ref: mcpApprovalGate,
      statusKey: "mcpApprovalGate",
      patchOn: ["settings"],
      whenAbsent: true,
      accept: bool,
    }),
    mcpApprovalTimeoutSecs: field({
      ref: mcpApprovalTimeoutSecs,
      statusKey: "mcpApprovalTimeoutSecs",
      patchOn: ["settings"],
      whenAbsent: 120,
      accept: num,
    }),
    mcpAutoDeny: field({
      ref: mcpAutoDeny,
      statusKey: "mcpAutoDeny",
      patchOn: ["settings"],
      whenAbsent: true,
      accept: bool,
    }),
    mcpAutoApprove: field({
      ref: mcpAutoApprove,
      statusKey: "mcpAutoApprove",
      patchOn: ["settings"],
      whenAbsent: false,
      accept: bool,
    }),
    mcpAutoApproveTimeoutSecs: field({
      ref: mcpAutoApproveTimeoutSecs,
      statusKey: "mcpAutoApproveTimeoutSecs",
      patchOn: ["settings"],
      whenAbsent: 120,
      accept: num,
    }),

    // ── editors ───────────────────────────────────────────────────────────────────────────
    defaultEditor: field({
      ref: defaultEditor,
      statusKey: "defaultEditor",
      patchOn: ["settings"],
      whenAbsent: null,
      accept: clearableStr,
    }),
  } satisfies Record<keyof typeof owned, ErasedField>;

  const ALL: readonly ErasedField[] = Object.values(FIELDS);

  /**
   * Install a whole GET /api/status answer. Absent keys reset to the daemon's defaults, which is
   * what makes this safe to run again on every reconnect.
   */
  function applySnapshot(s: RuntimeStatus, hooks: SnapshotHooks): void {
    const raw = s as unknown as Record<string, unknown>;
    for (const f of ALL) f.fromSnapshot(raw[f.statusKey]);
    // The PWA follows the relay home when a rotating quick-tunnel origin moves (lib/relay-home).
    rememberRelayHome(relayUrl.value, relayAnnounced.value);
    // Dead AI keys the daemon found at boot: surface them now (deduped per session inside
    // notifyAiKeyInvalid), so a dashboard opened AFTER boot still sees them, not only one that
    // was already connected for the one-shot SSE broadcast.
    const invalid = raw.aiKeyInvalid;
    if (Array.isArray(invalid)) {
      for (const entry of invalid) {
        const label = (entry as { label?: unknown } | null)?.label;
        if (typeof label === "string") hooks.notifyAiKeyInvalid(label);
      }
    }
  }

  /** Assign only the keys a patch payload actually carries. Returns the payload as a record, or
   *  null when it was not one at all. */
  function patchFields(channel: PatchChannel, payload: unknown): Record<string, unknown> | null {
    if (payload === null || typeof payload !== "object") return null;
    const raw = payload as Record<string, unknown>;
    for (const f of ALL) {
      if (!f.patchOn.includes(channel) || !(f.patchKey in raw)) continue;
      f.fromPatch(raw[f.patchKey]);
    }
    return raw;
  }

  /**
   * `daemon_status`: the tunnel/relay half. A PATCH, not a snapshot. The relay announces after
   * the tunnel comes up and emits only relay fields; treating its absent `tunnelUrl` as null once
   * erased a healthy quick-tunnel URL and left the UI spinning forever.
   */
  function applyDaemonStatus(payload: unknown): void {
    if (!patchFields("daemon", payload)) return;
    // A tunnel that came up or went away re-announces (or invalidates) the permanent link, so the
    // relay's registered state rides this event rather than needing a poll.
    rememberRelayHome(relayUrl.value, relayAnnounced.value);
  }

  /** `settings_changed`: every owner setting the daemon just persisted, and only those. */
  function applySettingsChanged(payload: unknown, hooks: PatchHooks): void {
    const raw = patchFields("settings", payload);
    if (!raw) return;
    // The daemon applied a pulled cloud-sync document (possibly from another device): re-fetch
    // status and re-apply the synced appearance (loadSyncStatus applies it internally).
    if (raw.cloudSync) void hooks.loadSyncStatus();
    // The stored default editor just changed elsewhere (another tab or device), so the resolved
    // effectiveEditor that drives the Open-with dropdown's "current default" tick is now stale.
    // Re-fetch the catalogue, but only for a tab that already uses it.
    if ("defaultEditor" in raw && hooks.editorsLoaded.value) void hooks.loadEditors(true);
  }

  return { ...owned, applySnapshot, applyDaemonStatus, applySettingsChanged };
}
