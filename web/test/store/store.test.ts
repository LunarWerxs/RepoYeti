import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useStore } from "@/store";
import { api } from "@/api";
import type { LogEntry, LogResult } from "@/types";

// Minimal Response-like for the api.ts `req()` helper (it reads .ok/.status and awaits .text()).
function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, statusText: ok ? "OK" : "ERR", text: async () => JSON.stringify(body) };
}

const entry = (hash: string): LogEntry => ({
  hash,
  shortHash: hash.slice(0, 7),
  subject: `s-${hash}`,
  authorName: "a",
  authorEmail: "a@x",
  date: 0,
  refs: "",
});
const logRes = (commits: LogEntry[], hasMore = false): LogResult => ({ ok: true, code: "OK", commits, hasMore });

describe("store (smoke)", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it("starts empty with AI disabled by default", () => {
    const store = useStore();
    expect(store.repos).toEqual([]);
    expect(store.aiEnabled).toBe(false); // no default provider configured
  });

  it("loadChanges populates changesByRepo from the API", async () => {
    const files = [
      { path: "src/a.ts", status: "M", staged: false },
      { path: "b.txt", status: "A", staged: false },
    ];
    const fetchMock = vi.fn(async () => jsonResponse({ files }));
    vi.stubGlobal("fetch", fetchMock);

    const store = useStore();
    await store.loadChanges("repo-1");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("/api/repos/repo-1/changes");
    expect(store.changesByRepo["repo-1"]).toEqual(files);
    expect(store.changesLoading["repo-1"]).toBe(false);
  });

  it("loadChanges degrades to an empty list when the API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "ERROR", message: "boom" }, false, 500)));
    const store = useStore();
    await store.loadChanges("repo-2");
    expect(store.changesByRepo["repo-2"]).toEqual([]);
  });
});

// #9 — loadLog pagination (append on skip>0) and, critically, its error branch: a failed "load more"
// must NOT wipe the commits already on screen (a flaky network would otherwise blank the history).
describe("store.loadLog pagination", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it("appends commits on a paginated load (skip>0) instead of replacing", async () => {
    vi.spyOn(api, "log")
      .mockResolvedValueOnce(logRes([entry("aaa"), entry("bbb")], true))
      .mockResolvedValueOnce(logRes([entry("ccc")], false));
    const store = useStore();
    await store.loadLog("r"); // first page
    await store.loadLog("r", 50, 2); // "load more"
    expect(store.logByRepo.r.commits.map((c) => c.hash)).toEqual(["aaa", "bbb", "ccc"]);
    expect(store.logByRepo.r.hasMore).toBe(false);
  });

  it("keeps already-loaded commits when a paginated 'load more' fails", async () => {
    vi.spyOn(api, "log")
      .mockResolvedValueOnce(logRes([entry("aaa"), entry("bbb")], true))
      .mockRejectedValueOnce(new Error("network blip"));
    const store = useStore();
    await store.loadLog("r"); // first page ok
    await store.loadLog("r", 50, 2); // load-more fails
    expect(store.logByRepo.r.commits.map((c) => c.hash)).toEqual(["aaa", "bbb"]); // preserved
  });

  it("surfaces the empty/error state on a first-page failure", async () => {
    vi.spyOn(api, "log").mockRejectedValueOnce(new Error("network blip"));
    const store = useStore();
    await store.loadLog("r");
    expect(store.logByRepo.r.commits).toEqual([]);
    expect(store.logByRepo.r.ok).toBe(false);
  });
});
