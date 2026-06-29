# GitMob performance and scalability todo

Ordered by severity/importance. P1 is the highest priority.

- [ ] **P1 - Bound cross-repo git subprocess fanout.**
  - Evidence: startup runs `await Promise.all(repos.map((r) => refreshRepo(r.id, r.absPath)))` across every watchable repo in `src/index.ts:128-130`; the default repo cap is 200 in `src/config.ts:160-165`; each `readStatus` can run `git.status()` plus `git.getRemotes(true)` in `src/status.ts:37-46`; git calls use a 30s block timeout in `src/git.ts:35-43`; the operation queue only serializes per key, and different keys intentionally run independently (`src/opqueue.ts:11-23`, `tests/opqueue.test.ts:25-35`).
  - Risk/impact: boot or a multi-client burst can spawn hundreds of git children at once. On large repos, slow disks, Windows Defender, network shares, or many fetch/pull/push calls, this can exhaust process/disk resources, make the daemon unavailable until hydration completes, and amplify one slow filesystem into whole-machine sluggishness.
  - Suggested fix: add a daemon-wide semaphore/pool for git child processes, with separate limits for local status reads and remote network actions. Hydrate initial statuses progressively with a small concurrency limit, start the HTTP server before the full scan finishes, and broadcast each repo as it becomes ready.

- [ ] **P1 - Coalesce and cap per-repo refresh work.**
  - Evidence: each watcher event schedules `onChange` after 250ms in `src/watcher.ts:25-27`, `watchOne` fires `void refreshRepo(repoId, absPath)` in `src/service.ts:34-39`, and `refreshRepo` always enqueues a new `readStatus` before deciding whether to persist or broadcast in `src/service.ts:49-58`. The queue is a promise chain with no length, dedupe, cancellation, or priority in `src/opqueue.ts:9-23`.
  - Risk/impact: a busy repo can accumulate redundant status reads behind a slow fetch/pull/push or a 30s git timeout. That makes the UI stale, delays user actions, and can grow memory with work that will be obsolete by the time it runs.
  - Suggested fix: track `refreshInFlight` and `refreshPending` per repo so multiple watcher/manual refresh requests collapse into one trailing refresh. Add queue-depth metrics and a hard cap/drop policy for stale watcher refreshes, while keeping explicit user actions prioritized.

- [ ] **P2 - Add backpressure to SSE fanout.**
  - Evidence: `broadcast` synchronously pushes every serialized event to every listener in `src/bus.ts:18-20`. Each SSE connection owns an unbounded `queue` in `src/daemon.ts:359-367`, then drains it with `queue.shift()` in `src/daemon.ts:392-394`.
  - Risk/impact: one slow or suspended browser tab can accumulate every repo event indefinitely. `shift()` also makes draining large queues O(n^2), so a burst during startup or mass repo updates can turn into CPU and memory pressure.
  - Suggested fix: replace the array with a bounded ring/deque, coalesce `repo_state_changed` by repo id, and disconnect or drop frames for clients that stay behind. Track queue size per connection for diagnostics.

- [ ] **P2 - Put changed-file reads behind the per-repo queue.**
  - Evidence: `/api/repos/:id/changes` calls `getChanges` in `src/daemon.ts:214-218`; `getChanges` calls `readChanges` directly in `src/service.ts:141-145`; `readChanges` runs `git.status()` in `src/status.ts:20-34`. Unlike `refreshRepo`, `fetch`, `pull`, `push`, `commit`, and AI diff collection, this path bypasses `enqueue`.
  - Risk/impact: expanding a dirty repo can race with `git add -A`, commit, pull, or fetch on the same repo. It can also add extra git status processes while the queue is already managing a slow operation, undermining the repo-level serialization guarantee.
  - Suggested fix: route `getChanges` through `enqueue(repoId, ...)`, or serve it from the most recent queued status snapshot when possible. Consider returning a 409/202 while a mutating operation is in progress if freshness matters.

- [ ] **P2 - Cap and virtualize large changed-file trees.**
  - Evidence: `readChanges` maps every changed file returned by `git.status()` in `src/status.ts:20-34`; the API returns the full array in `src/daemon.ts:214-218`; the browser rebuilds a tree from all files in `web/src/lib/util.ts:7-51`; `buildChangeTree` uses `children.find(...)` for each path segment in `web/src/lib/util.ts:10-24`; `ChangesTree` recursively renders every node with `v-for` in `web/src/components/ChangesTree.vue:21-50`; the scroll area in `web/src/components/RepoCard.vue:333-345` limits height but not DOM size.
  - Risk/impact: a dirty repo with thousands of files can produce a large JSON response, O(n^2)-ish tree construction in wide directories, and a huge recursive DOM. The browser can freeze even though the panel is only 300px tall.
  - Suggested fix: add a server-side changed-file limit with a truncation marker, paginate or lazy-load directories, and use a `Map`-backed tree builder. For the client, render a virtual list or a capped summary until the user asks for more.

- [ ] **P2 - Stream or pre-limit AI diff collection instead of buffering full diffs.**
  - Evidence: `collectRepoDiff` does `readStatus` and then `collectCommitDiff` in the repo queue (`src/service.ts:164-168`). `collectCommitDiff` awaits the full `git diff HEAD` output, builds a combined string, and only then slices it to `DIFF_CAP` in `src/git-actions.ts:143-166`.
  - Risk/impact: very large textual diffs, generated files, or binary-ish outputs can be fully buffered by git/simple-git before the 24 KB cap is applied. This can block the repo queue, consume memory, and make commit-message generation feel hung.
  - Suggested fix: collect a bounded diff using a streaming child process and kill it after N bytes, or use cheaper summaries first (`git status --porcelain`, `git diff --stat`, limited context, `--no-ext-diff`). Avoid a second status read when `collectRepoDiff` already knows the tree is dirty.

- [ ] **P3 - Make discovery non-blocking and progressive.**
  - Evidence: discovery uses synchronous recursive `readdirSync` in `src/discovery.ts:36-72`; startup performs `discover(...)` and upserts all found repos before status hydration and before `Bun.serve` is called in `src/index.ts:122-138`.
  - Risk/impact: a large root, slow external drive, network share, or permission-heavy home directory can block the event loop and delay the daemon from serving anything. The max depth/repo caps help, but they do not prevent slow directory reads before the cap is reached.
  - Suggested fix: run discovery asynchronously with a small directory-read concurrency limit, start the daemon first, expose scan progress over SSE, and allow configurable excludes/timeouts per root.

- [ ] **P3 - Surface watcher failures and add a fallback.**
  - Evidence: `watchRepo` catches watch creation failures and ignores them in `src/watcher.ts:30-35`; `startWatching` has no health reporting in `src/service.ts:41-46`.
  - Risk/impact: hitting OS watcher limits or unsupported filesystems silently disables live updates for affected repos. Users then see stale state and may repeatedly force refresh, adding manual git status load.
  - Suggested fix: record watcher health per repo, log and broadcast a daemon warning, and add a low-frequency polling fallback with jitter/backoff for repos whose watchers could not be installed.

- [ ] **P3 - Reduce redundant status and remote lookups on hot paths.**
  - Evidence: every `readStatus` runs `git.status()` and then tries `git.getRemotes(true)` in `src/status.ts:37-50`; pull, commit, and push preflight with `readStatus` in `src/git-actions.ts:94-105`, `src/git-actions.ts:117-129`, and `src/git-actions.ts:170-179`; `runAction` then calls `refreshRepo`, causing another status read after the action in `src/service.ts:67-77`.
  - Risk/impact: common actions can do two full working-tree scans plus remote parsing. Watcher refreshes also re-read remote URLs even though remotes change rarely, doubling subprocess work in the main live-update loop.
  - Suggested fix: cache remote metadata until `.git/config` changes, return/reuse preflight status where possible, and consider a single raw `git status --porcelain=v2 --branch` parser for status reads instead of multiple simple-git commands.

- [ ] **P3 - Add timeouts to OIDC discovery and token exchange.**
  - Evidence: OIDC discovery uses plain `fetch` in `src/auth.ts:76-83`; token exchange uses plain `fetch` in `src/auth.ts:203-218`. AI provider calls already use `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` in `src/ai.ts:37` and `src/ai.ts:208`.
  - Risk/impact: a slow or unreachable identity provider can leave login/finish requests hanging much longer than intended, tying up request work and making tunnel login failures hard to distinguish from local daemon issues.
  - Suggested fix: wrap auth fetches with `AbortSignal.timeout`, return stable error codes/pages for timeout vs auth failure, and add a TTL to discovery cache so transient IdP failures do not poison the process indefinitely.

- [ ] **P3 - Remove or isolate the shared built-in AI provider key.**
  - Evidence: the default config includes a hard-coded public Groq key and model in `src/config.ts:103-116`; `effectiveDefaultProvider` can select it automatically in `src/config.ts:133-140`; `/api/repos/:id/commit-message` uses the effective provider by default in `src/daemon.ts:321-349`.
  - Risk/impact: every install shares one public free-tier quota. Rate limits or provider abuse become the default user's slow path, with 20s provider timeouts from `src/ai.ts:37` before the UI can recover.
  - Suggested fix: make AI opt-in or gate the shared key behind a local trial flag with a strict circuit breaker/rate limiter. Prefer a clear setup prompt for user-owned keys, and cache provider failures briefly so repeated clicks fail fast.

- [ ] **P4 - Avoid full-list reorder writes for every drag.**
  - Evidence: drag end sends every repo id in `web/src/components/RepoList.vue:15-21`; the route accepts up to 10,000 ids in `src/daemon.ts:129-138`; persistence clears all `sort_order` values and updates each id in a transaction in `src/db.ts:194-202`.
  - Risk/impact: one reorder is O(n) writes and takes a DB write lock. This is fine for small lists, but it scales poorly if `maxRepos` is raised or several clients reorder from the dashboard.
  - Suggested fix: send only moved id plus before/after anchor, or compute and update only changed positions. Debounce repeated reorder requests and cap the accepted order length to the actual repo count.

- [ ] **P4 - Move config persistence off request hot paths.**
  - Evidence: `saveConfig` uses synchronous `writeFileSync` in `src/config.ts:191-195`; settings/provider routes call it from request handlers in `src/daemon.ts:240-255`, `src/daemon.ts:258-274`, `src/daemon.ts:293-318`; first-use OAuth ownership also writes config during auth completion in `src/auth.ts:229-235`.
  - Risk/impact: the file is small and writes are rare, but a slow home directory or antivirus lock can block the event loop during API/auth requests. Partial writes would also leave the config unreadable, causing `loadConfig` to fall back to defaults in `src/config.ts:176-188`.
  - Suggested fix: use atomic write-rename persistence, serialize config writes through a small async queue, and surface write failures instead of silently risking default fallback on the next restart.
