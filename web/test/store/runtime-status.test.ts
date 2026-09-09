/**
 * The runtime-status synchroniser (1.0 audit, item 21).
 *
 * The whole point of the table this covers is that a snapshot and a patch mean DIFFERENT things
 * by an absent key, and that the two used to be stated in different places in different ways. So
 * these tests pin both semantics, the handful of fields that deviate from them, and the side
 * effects each path fires. The last test is the anti-drift one: it walks every field the module
 * owns and fails by name if a full snapshot leaves any of them untouched, which is what a table
 * row with the wrong `statusKey` would look like (the `satisfies` check catches a MISSING row at
 * build time; a row pointing at a key the daemon never sends compiles perfectly).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import type { RuntimeStatus } from "@/api";
import { useRuntimeStatus, type PatchHooks, type SnapshotHooks } from "@/store/runtime-status";

vi.mock("@/lib/relay-home", () => ({ rememberRelayHome: vi.fn() }));
import { rememberRelayHome } from "@/lib/relay-home";

function hooks(): { snapshot: SnapshotHooks; patch: PatchHooks } {
  return {
    snapshot: { notifyAiKeyInvalid: vi.fn() },
    patch: { loadSyncStatus: vi.fn(), loadEditors: vi.fn(), editorsLoaded: ref(false) },
  };
}

/**
 * An owner snapshot in which EVERY field differs from the module's constructed default, so any
 * field the table fails to fill shows up as "still at its default".
 */
function fullOwnerStatus(): RuntimeStatus {
  return {
    ok: true,
    version: "9.9.9",
    mode: "remote",
    tunnelActive: true,
    tunnelUrl: "https://tunnel.example",
    tunnel: { hostname: "stable.example", hasToken: true, tokenFromEnv: true, named: true },
    relay: { enabled: false, url: "https://relay.example", id: "abc", defaultUrl: "https://x.example" },
    relayUrl: "https://relay.example/abc",
    relayAnnounced: true,
    relayError: "announce failed",
    diffStats: true,
    changesStatDisplay: "bars",
    changesChars: false,
    minContentSearch: 5,
    remoteEditing: false,
    remoteBrowse: false,
    diffPatchBytes: 1024,
    diffPatchEnabled: false,
    syncCheck: true,
    syncIntervalSecs: 60,
    keepInSync: true,
    autoCommit: true,
    autoCommitMode: "daily",
    autoCommitIntervalSecs: 30,
    autoCommitAt: "07:30",
    autoCommitPull: false,
    autoCommitPush: false,
    autoCommitAiFallback: "basic",
    autoUpdate: true,
    updateNotify: false,
    autoScan: true,
    loreServersEnabled: false,
    portableMode: true,
    hideTrayIcon: true,
    mcpApprovalGate: false,
    mcpApprovalTimeoutSecs: 30,
    mcpAutoDeny: false,
    mcpAutoApprove: true,
    mcpAutoApproveTimeoutSecs: 45,
    defaultEditor: "vscode",
  } as unknown as RuntimeStatus;
}

/** The narrow projection routes/health.ts hands a share-link guest. */
function guestStatus(): RuntimeStatus {
  return {
    ok: true,
    version: "9.9.9",
    mode: "remote",
    tunnelActive: true,
    tunnelUrl: null,
    diffStats: true,
    remoteEditing: false,
    remoteBrowse: false,
    changesStatDisplay: "bars",
    changesChars: false,
    diffPatchBytes: 2048,
    diffPatchEnabled: false,
    minContentSearch: 4,
    share: { label: "guest", perm: "read", expiresAt: null, collaborative: false },
  } as unknown as RuntimeStatus;
}

describe("runtime status: the snapshot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("installs every field an owner snapshot carries", () => {
    const rt = useRuntimeStatus();
    const h = hooks();
    rt.applySnapshot(fullOwnerStatus(), h.snapshot);

    expect(rt.serverVersion.value).toBe("9.9.9");
    expect(rt.mode.value).toBe("remote");
    expect(rt.tunnelUrl.value).toBe("https://tunnel.example");
    expect(rt.tunnelConfig.value.hostname).toBe("stable.example");
    expect(rt.relayConfig.value.enabled).toBe(false);
    expect(rt.contentSearchMin.value).toBe(5);
    expect(rt.autoCommitAt.value).toBe("07:30");
    expect(rt.loreServersEnabled.value).toBe(false);
    expect(rt.defaultEditor.value).toBe("vscode");
    expect(rememberRelayHome).toHaveBeenCalledWith("https://relay.example/abc", true);
  });

  it("resets an absent field to the daemon's own default, which is what a guest gets", () => {
    const rt = useRuntimeStatus();
    const h = hooks();
    // Start from an owner snapshot, then hand it the narrow guest one: everything the guest
    // projection withholds has to fall back, not keep the owner's value from a previous session.
    rt.applySnapshot(fullOwnerStatus(), h.snapshot);
    rt.applySnapshot(guestStatus(), h.snapshot);

    expect(rt.autoCommit.value).toBe(false);
    expect(rt.autoCommitMode.value).toBe("interval");
    expect(rt.autoCommitIntervalSecs.value).toBe(900);
    expect(rt.mcpApprovalGate.value).toBe(true); // the SAFE default, not the last owner value
    expect(rt.mcpAutoDeny.value).toBe(true);
    expect(rt.updateNotify.value).toBe(true);
    expect(rt.loreServersEnabled.value).toBe(true);
    expect(rt.defaultEditor.value).toBeNull();
    expect(rt.relayUrl.value).toBeNull();
    expect(rt.relayAnnounced.value).toBe(false);
    expect(rt.relayError.value).toBeNull();
    // What the guest DOES carry still lands.
    expect(rt.remoteEditing.value).toBe(false);
    expect(rt.diffPatchBytes.value).toBe(2048);
  });

  it("keeps the redacted tunnel and relay blobs when a snapshot omits them", () => {
    const rt = useRuntimeStatus();
    const h = hooks();
    rt.applySnapshot(fullOwnerStatus(), h.snapshot);
    rt.applySnapshot(guestStatus(), h.snapshot);
    // The guest projection withholds these entirely. Resetting them to a constructed default
    // would tell the Settings panel the owner's stable address and relay were never configured.
    expect(rt.tunnelConfig.value.hostname).toBe("stable.example");
    expect(rt.relayConfig.value.id).toBe("abc");
  });

  it("announces every dead AI key the daemon found at boot", () => {
    const rt = useRuntimeStatus();
    const h = hooks();
    const s = { ...fullOwnerStatus(), aiKeyInvalid: [{ label: "openai" }, { label: "anthropic" }] };
    rt.applySnapshot(s as unknown as RuntimeStatus, h.snapshot);
    expect(h.snapshot.notifyAiKeyInvalid).toHaveBeenCalledWith("openai");
    expect(h.snapshot.notifyAiKeyInvalid).toHaveBeenCalledWith("anthropic");
  });
});

describe("runtime status: settings_changed is a patch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("touches only the keys the payload carries", () => {
    const rt = useRuntimeStatus();
    const h = hooks();
    rt.applySnapshot(fullOwnerStatus(), h.snapshot);
    rt.applySettingsChanged({ autoCommit: false }, h.patch);

    expect(rt.autoCommit.value).toBe(false);
    // Everything else stays exactly where the snapshot left it.
    expect(rt.autoCommitAt.value).toBe("07:30");
    expect(rt.syncIntervalSecs.value).toBe(60);
    expect(rt.mcpApprovalGate.value).toBe(false);
  });

  it("ignores a value of the wrong shape rather than installing it", () => {
    const rt = useRuntimeStatus();
    const h = hooks();
    rt.applySettingsChanged({ autoCommit: "yes", syncIntervalSecs: "300", changesStatDisplay: "bar" }, h.patch);
    expect(rt.autoCommit.value).toBe(false);
    expect(rt.syncIntervalSecs.value).toBe(300);
    expect(rt.changesStatDisplay.value).toBe("numbers");
  });

  it("treats a null defaultEditor as cleared, not as absent", () => {
    const rt = useRuntimeStatus();
    const h = hooks();
    rt.applySnapshot(fullOwnerStatus(), h.snapshot);
    rt.applySettingsChanged({ defaultEditor: null }, h.patch);
    expect(rt.defaultEditor.value).toBeNull();
  });

  it("refreshes the editor catalogue only for a tab that already loaded it", () => {
    const rt = useRuntimeStatus();
    const h = hooks();
    rt.applySettingsChanged({ defaultEditor: "cursor" }, h.patch);
    expect(h.patch.loadEditors).not.toHaveBeenCalled();

    h.patch.editorsLoaded.value = true;
    rt.applySettingsChanged({ defaultEditor: "cursor" }, h.patch);
    expect(h.patch.loadEditors).toHaveBeenCalledWith(true);
  });

  it("re-reads sync status when the daemon applied a pulled cloud document", () => {
    const rt = useRuntimeStatus();
    const h = hooks();
    rt.applySettingsChanged({ autoScan: true }, h.patch);
    expect(h.patch.loadSyncStatus).not.toHaveBeenCalled();
    rt.applySettingsChanged({ cloudSync: { enabled: true } }, h.patch);
    expect(h.patch.loadSyncStatus).toHaveBeenCalled();
  });

  it("does not accept daemon_status-only fields from a settings broadcast, or the reverse", () => {
    const rt = useRuntimeStatus();
    const h = hooks();
    rt.applySnapshot(fullOwnerStatus(), h.snapshot);
    // tunnelActive rides daemon_status; autoCommit rides settings_changed. Each channel carries
    // what the daemon actually sends on it, and nothing else.
    rt.applySettingsChanged({ tunnelActive: false }, h.patch);
    expect(rt.tunnelActive.value).toBe(true);
    rt.applyDaemonStatus({ autoCommit: false });
    expect(rt.autoCommit.value).toBe(true);
  });
});

describe("runtime status: daemon_status is a patch too", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not erase a healthy tunnel URL when only relay fields arrive", () => {
    // The regression this rule exists for: the relay announces after the tunnel comes up and
    // emits relay fields only. Reading its absent tunnelUrl as null blanked a working quick
    // tunnel and left the UI spinning forever.
    const rt = useRuntimeStatus();
    const h = hooks();
    rt.applySnapshot(fullOwnerStatus(), h.snapshot);
    rt.applyDaemonStatus({ relayUrl: "https://relay.example/new", relayAnnounced: true });

    expect(rt.tunnelUrl.value).toBe("https://tunnel.example");
    expect(rt.tunnelActive.value).toBe(true);
    expect(rt.relayUrl.value).toBe("https://relay.example/new");
    expect(rememberRelayHome).toHaveBeenLastCalledWith("https://relay.example/new", true);
  });

  it("clears the tunnel URL when the daemon says the tunnel is gone", () => {
    const rt = useRuntimeStatus();
    const h = hooks();
    rt.applySnapshot(fullOwnerStatus(), h.snapshot);
    rt.applyDaemonStatus({ tunnelUrl: null, tunnelActive: false });
    expect(rt.tunnelUrl.value).toBeNull();
    expect(rt.tunnelActive.value).toBe(false);
  });

  it("ignores a payload that is not an object at all", () => {
    const rt = useRuntimeStatus();
    const h = hooks();
    rt.applySnapshot(fullOwnerStatus(), h.snapshot);
    rt.applyDaemonStatus(null);
    rt.applyDaemonStatus("nonsense");
    rt.applySettingsChanged(42, h.patch);
    expect(rt.tunnelUrl.value).toBe("https://tunnel.example");
    expect(rt.autoCommit.value).toBe(true);
  });
});

describe("runtime status: the table covers every field it owns", () => {
  it("leaves no field at its default after a full owner snapshot", () => {
    const rt = useRuntimeStatus();
    const h = hooks();
    const fields = Object.entries(rt).filter(
      (entry): entry is [string, { value: unknown }] =>
        typeof entry[1] === "object" && entry[1] !== null && "value" in entry[1],
    );
    expect(fields.length).toBeGreaterThan(30);
    const before = new Map(fields.map(([name, r]) => [name, JSON.stringify(r.value)]));

    rt.applySnapshot(fullOwnerStatus(), h.snapshot);

    const untouched = fields
      .filter(([name, r]) => before.get(name) === JSON.stringify(r.value))
      .map(([name]) => name);
    // A row whose statusKey does not match what the daemon sends compiles fine and silently
    // never fires. This is the only thing that would catch it.
    expect(untouched, `these fields were not filled from the snapshot: ${untouched.join(", ")}`).toEqual(
      [],
    );
  });
});
