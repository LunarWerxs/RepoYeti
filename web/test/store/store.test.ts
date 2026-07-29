import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useStore } from "@/store";
import { api } from "@/api";
import {
  MAX_RETAINED_GIT_REPO_CACHES,
  MAX_RETAINED_LOG_COMMITS,
} from "@/store/git-ops";
import { MAX_RETAINED_CHANGE_REPOS } from "@/store/repo";
import type { ChangedFile, LogEntry, LogResult } from "@/types";

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
    store.repos.push({ id: "repo-1" } as never);
    await store.loadChanges("repo-1");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("/api/repos/repo-1/changes");
    expect(store.changesByRepo["repo-1"]).toEqual(files);
    expect(store.changesLoading["repo-1"]).toBeUndefined();
  });

  it("loadChanges degrades to an empty list when the API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "ERROR", message: "boom" }, false, 500)));
    const store = useStore();
    store.repos.push({ id: "repo-2" } as never);
    await store.loadChanges("repo-2");
    expect(store.changesByRepo["repo-2"]).toEqual([]);
  });

  it("bounds heavy per-repo caches even when many live cards have been opened", async () => {
    vi.spyOn(api, "changes").mockImplementation(async (id) => ({
      files: [{ path: `${id}.txt`, status: "M", staged: false }],
    }));
    vi.spyOn(api, "log").mockImplementation(async (id) => logRes([entry(String(id))]));
    const store = useStore();
    const count = Math.max(MAX_RETAINED_CHANGE_REPOS, MAX_RETAINED_GIT_REPO_CACHES) + 3;
    for (let i = 0; i < count; i++) {
      store.repos.push({ id: `cache-${i}` } as never);
    }
    for (let i = 0; i < count; i++) {
      await store.loadChanges(`cache-${i}`);
      await store.loadLog(`cache-${i}`);
    }

    expect(Object.keys(store.changesByRepo)).toHaveLength(MAX_RETAINED_CHANGE_REPOS);
    expect(Object.keys(store.logByRepo)).toHaveLength(MAX_RETAINED_GIT_REPO_CACHES);
    expect(store.changesByRepo["cache-0"]).toBeUndefined();
    expect(store.logByRepo["cache-0"]).toBeUndefined();
    expect(store.changesByRepo[`cache-${count - 1}`]).toBeDefined();
    expect(store.logByRepo[`cache-${count - 1}`]).toBeDefined();
  });

  it("URL-encodes exact author identities in the History log query", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(logRes([])));
    vi.stubGlobal("fetch", fetchMock);

    await api.log("repo-1", 25, 5, "all", {
      name: "A. Dev [bot]",
      email: "a+git@example.test",
    });

    const requested = new URL(fetchMock.mock.calls[0]![0] as string, "http://localhost");
    expect(requested.searchParams.get("limit")).toBe("25");
    expect(requested.searchParams.get("skip")).toBe("5");
    expect(requested.searchParams.get("refs")).toBe("all");
    expect(requested.searchParams.get("authorName")).toBe("A. Dev [bot]");
    expect(requested.searchParams.get("authorEmail")).toBe("a+git@example.test");
  });
});

// #9 — loadLog pagination (append on skip>0) and, critically, its error branch: a failed "load more"
// must NOT wipe the commits already on screen (a flaky network would otherwise blank the history).
describe("store.loadLog pagination", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useStore().repos.push({ id: "r" } as never);
  });
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

  it("bounds retained history and retires the infinite-scroll sentinel at the cap", async () => {
    const first = Array.from({ length: MAX_RETAINED_LOG_COMMITS - 5 }, (_, i) =>
      entry(`first-${i}`),
    );
    const next = Array.from({ length: 20 }, (_, i) => entry(`next-${i}`));
    vi.spyOn(api, "log")
      .mockResolvedValueOnce(logRes(first, true))
      .mockResolvedValueOnce(logRes(next, true));

    const store = useStore();
    await store.loadLog("r", first.length);
    await store.loadLog("r", next.length, first.length);

    expect(store.logByRepo.r.commits).toHaveLength(MAX_RETAINED_LOG_COMMITS);
    expect(store.logByRepo.r.commits.at(-1)?.hash).toBe("next-4");
    expect(store.logByRepo.r.hasMore).toBe(false);
  });

  it("forwards the same exact author identity across filtered pages", async () => {
    const author = { name: "Ada Lovelace", email: "ada+git@example.test" };
    const logSpy = vi.spyOn(api, "log")
      .mockResolvedValueOnce(logRes([entry("ada-1"), entry("ada-2")], true))
      .mockResolvedValueOnce(logRes([entry("ada-3")], false));
    const store = useStore();

    await store.loadLog("r", 2, 0, "all", author);
    await store.loadLog("r", 2, 2, "all", author);

    expect(logSpy).toHaveBeenNthCalledWith(1, "r", 2, 0, "all", author);
    expect(logSpy).toHaveBeenNthCalledWith(2, "r", 2, 2, "all", author);
    expect(store.logByRepo.r.commits.map((commit) => commit.hash)).toEqual([
      "ada-1",
      "ada-2",
      "ada-3",
    ]);
  });

  it.each([275, MAX_RETAINED_LOG_COMMITS])(
    "atomically refreshes a %i-row retained window in one API snapshot",
    async (count) => {
      const old = Array.from({ length: count }, (_, i) => entry(`old-${i}`));
      const fresh = Array.from({ length: count }, (_, i) => entry(`fresh-${i}`));
      let resolveLog!: (result: LogResult) => void;
      const logSpy = vi.spyOn(api, "log").mockImplementationOnce(
        () =>
          new Promise<LogResult>((resolve) => {
            resolveLog = resolve;
          }),
      );
      const store = useStore();
      store.logByRepo.r = logRes(old, true);

      const pending = store.loadLog("r", count, 0, "all");
      await vi.waitFor(() => expect(logSpy).toHaveBeenCalledOnce());

      // The old graph stays complete until the daemon's single git-log snapshot is ready.
      expect(store.logByRepo.r.commits.map((commit) => commit.hash)).toEqual(
        old.map((commit) => commit.hash),
      );
      expect(logSpy).toHaveBeenCalledWith("r", count, 0, "all");

      resolveLog(logRes(fresh, true));
      await pending;

      expect(logSpy).toHaveBeenCalledOnce();
      expect(store.logByRepo.r.commits.map((commit) => commit.hash)).toEqual(
        fresh.map((commit) => commit.hash),
      );
      expect(store.logByRepo.r.hasMore).toBe(count < MAX_RETAINED_LOG_COMMITS);
    },
  );

  it("releases per-repo view caches after a successful removal", async () => {
    vi.spyOn(api, "removeRepo").mockResolvedValue({ ok: true, code: "OK" });
    const store = useStore();
    store.changesByRepo.r = [{ path: "large.bin", status: "M", staged: false }];
    store.logByRepo.r = logRes([entry("aaa")]);
    store.branchesByRepo.r = {
      ok: true,
      code: "OK",
      current: "main",
      detached: false,
      branches: [],
    };

    await store.removeRepo("r");

    expect(store.changesByRepo.r).toBeUndefined();
    expect(store.logByRepo.r).toBeUndefined();
    expect(store.branchesByRepo.r).toBeUndefined();
  });

  it("ignores a changed-file response that lands after its repo was removed", async () => {
    let resolveChanges!: (value: { files: ChangedFile[] }) => void;
    vi.spyOn(api, "changes").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveChanges = resolve;
        }),
    );
    vi.spyOn(api, "removeRepo").mockResolvedValue({ ok: true, code: "OK" });
    const store = useStore();

    const pending = store.loadChanges("r");
    await Promise.resolve();
    await store.removeRepo("r");
    resolveChanges({ files: [{ path: "late.txt", status: "M", staged: false }] });
    await pending;

    expect(store.changesByRepo.r).toBeUndefined();
    expect(store.changesLoading.r).toBeUndefined();
  });

  it("keeps the newest history scope when an older request resolves last", async () => {
    let resolveAll!: (value: LogResult) => void;
    let resolveHead!: (value: LogResult) => void;
    vi.spyOn(api, "log").mockImplementation((_id, _limit, _skip, refs) => {
      return new Promise((resolve) => {
        if (refs === "all") resolveAll = resolve;
        else resolveHead = resolve;
      });
    });
    const store = useStore();

    const all = store.loadLog("r", 50, 0, "all");
    const head = store.loadLog("r", 50, 0, "head");
    resolveHead(logRes([entry("head")]));
    await head;
    resolveAll(logRes([entry("all")]));
    await all;

    expect(store.logByRepo.r.commits.map((commit) => commit.hash)).toEqual(["head"]);
  });

  it("keeps the newest author filter when an older author request resolves last", async () => {
    let resolveAda!: (value: LogResult) => void;
    let resolveSam!: (value: LogResult) => void;
    vi.spyOn(api, "log").mockImplementation((_id, _limit, _skip, _refs, author) =>
      new Promise((resolve) => {
        if (author?.email === "ada@example.test") resolveAda = resolve;
        else resolveSam = resolve;
      })
    );
    const store = useStore();

    const ada = store.loadLog("r", 50, 0, "all", {
      name: "Ada",
      email: "ada@example.test",
    });
    const sam = store.loadLog("r", 50, 0, "all", {
      name: "Sam",
      email: "sam@example.test",
    });
    resolveSam(logRes([entry("sam")]));
    await sam;
    resolveAda(logRes([entry("ada")]));
    await ada;

    expect(store.logByRepo.r.commits.map((commit) => commit.hash)).toEqual(["sam"]);
  });
});

// ── AI settings writers ─────────────────────────────────────────────────────────
//
// The write path behind Settings → AI (and the smart-commit header's style picker). Covered here
// rather than by driving the real dropdowns: the headless preview pane can't open reka-ui Select
// portals — it pauses the animation frames they mount on while document.hidden — so the UI click
// was the one thing left unverified. The component handlers are one-liners onto these, so this is
// where the behaviour actually lives, including the rollback, which nothing exercised before.
describe("AI settings writers", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  const settings = (over: Record<string, unknown> = {}) => ({
    providers: {},
    defaultProvider: null,
    style: "conventional",
    diffDetail: "lean",
    yolo: false,
    commitEnabled: true,
    ...over,
  });

  it("setDiffDetail sends only the dial and adopts what the daemon echoes back", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(settings({ diffDetail: "lean" })));
    vi.stubGlobal("fetch", fetchMock);
    const store = useStore();

    await store.setDiffDetail("lean");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/ai/settings");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ diffDetail: "lean" }); // no collateral fields
    expect(store.aiSettings.diffDetail).toBe("lean");
  });

  it("setDiffDetail rolls back when the daemon rejects it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "ERROR", message: "nope" }, false, 500)));
    const store = useStore();
    expect(store.aiSettings.diffDetail).toBe("lean"); // DEFAULT_DIFF_DETAIL

    await expect(store.setDiffDetail("thorough")).rejects.toThrow();
    expect(store.aiSettings.diffDetail).toBe("lean"); // never left lying about the daemon
  });

  it("setStyle sends the style and rolls back on failure", async () => {
    const ok = vi.fn(async () => jsonResponse(settings({ style: "detailed" })));
    vi.stubGlobal("fetch", ok);
    const store = useStore();
    await store.setStyle("detailed");
    const [, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ style: "detailed" });
    expect(store.aiSettings.style).toBe("detailed");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "ERROR" }, false, 500)));
    await expect(store.setStyle("concise")).rejects.toThrow();
    expect(store.aiSettings.style).toBe("detailed"); // reverted to the last known-good
  });
});
