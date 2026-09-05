import { ref } from "vue";
import { api } from "../api";
import type { AutoCommitIncident } from "../types";

/**
 * Auto-commit incident ledger (src/http/routes/auto-commit-incidents.ts): the reviewable record
 * of a repo the unattended auto-commit timer skipped, or only partially synced, while nobody
 * happened to be watching the dashboard. Owner-only, loaded on demand when Settings → Automation
 * opens (mirrors IdentityFirewallSection's on-open refresh pattern) rather than on every boot,
 * since it's a review list, not something the main dashboard needs live.
 */
export function useAutoCommitIncidents() {
  const incidents = ref<AutoCommitIncident[]>([]);
  const unacked = ref(0);
  const incidentsReady = ref(false);
  const incidentsLoading = ref(false);

  async function loadAutoCommitIncidents(): Promise<void> {
    if (incidentsLoading.value) return;
    incidentsLoading.value = true;
    try {
      const r = await api.autoCommitIncidents.list({ limit: 100 });
      incidents.value = r.incidents;
      unacked.value = r.unacked;
    } catch {
      incidents.value = [];
      unacked.value = 0;
    } finally {
      incidentsReady.value = true;
      incidentsLoading.value = false;
    }
  }

  /** Mark one incident reviewed; optimistic (the badge count and row update immediately), rolls
   *  back to the server's list on failure. Throws ApiError (NOT_FOUND) past the rollback so the
   *  caller can toast. */
  async function ackAutoCommitIncident(id: string): Promise<void> {
    const prev = incidents.value;
    const row = prev.find((i) => i.id === id);
    if (!row || row.ackedAt != null) return; // already acked / unknown: nothing to do
    incidents.value = prev.map((i) => (i.id === id ? { ...i, ackedAt: Date.now() } : i));
    unacked.value = Math.max(0, unacked.value - 1);
    try {
      await api.autoCommitIncidents.ack(id);
    } catch (e) {
      incidents.value = prev;
      unacked.value = prev.filter((i) => i.ackedAt == null).length;
      throw e;
    }
  }

  return {
    incidents,
    unacked,
    incidentsReady,
    incidentsLoading,
    loadAutoCommitIncidents,
    ackAutoCommitIncident,
  };
}
