import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useStore } from "@/store";
import { api } from "@/api";
import type { IdentityRule } from "@/types";

// A failed GET /api/identity-rules used to be indistinguishable from "0 rules": it cleared the
// list and marked itself ready, so the editor seeded blank and its whole-list PUT then replaced
// the rules still persisted on the daemon. These pin the store half of that fix.
describe("identities store — firewall rules load failures", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  const rule: IdentityRule = { pathPattern: "work/**", requiredIdentityId: "id-1" };

  it("keeps the last known rules and flags the error when a load fails", async () => {
    vi.spyOn(api, "identityRules").mockResolvedValueOnce([rule]);
    const store = useStore();
    await store.loadIdentityRules();
    expect(store.identityRules).toEqual([rule]);
    expect(store.identityRulesReady).toBe(true);
    expect(store.identityRulesError).toBe(false);

    vi.spyOn(api, "identityRules").mockRejectedValueOnce(new Error("offline"));
    await store.loadIdentityRules();

    // The failed GET must not blank the list (it used to) — an error is not an empty list.
    expect(store.identityRules).toEqual([rule]);
    expect(store.identityRulesError).toBe(true);
  });

  it("does not report ready after a first-load failure", async () => {
    vi.spyOn(api, "identityRules").mockRejectedValueOnce(new Error("offline"));
    const store = useStore();
    await store.loadIdentityRules();
    expect(store.identityRulesReady).toBe(false);
    expect(store.identityRulesError).toBe(true);
  });

  it("refuses the whole-list save while the load is in error, so persisted rules survive", async () => {
    const put = vi.spyOn(api, "setIdentityRules").mockResolvedValue([rule]);
    vi.spyOn(api, "identityRules").mockRejectedValueOnce(new Error("offline"));
    const store = useStore();
    await store.loadIdentityRules(); // fails → server state unknown

    await expect(store.setIdentityRules([rule])).rejects.toThrow();
    expect(put).not.toHaveBeenCalled(); // no wipe PUT on top of unread state
  });

  it("allows the save again once a reload succeeds", async () => {
    vi.spyOn(api, "setIdentityRules").mockResolvedValue([rule]);
    vi.spyOn(api, "identityRules")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([rule]);
    const store = useStore();
    await store.loadIdentityRules(); // fails
    await store.loadIdentityRules(); // recovers
    expect(store.identityRulesError).toBe(false);

    await store.setIdentityRules([rule]);
    expect(api.setIdentityRules).toHaveBeenCalledWith([rule]);
  });
});
