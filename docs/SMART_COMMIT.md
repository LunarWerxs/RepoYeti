# RepoYeti — Smart Commit (AI multi-commit splitter)

> **Goal.** One tap turns a pile of uncommitted changes — the kind several AI agents
> produce when they edit a repo in parallel — into a set of small, logically-scoped,
> well-named commits instead of one giant dump. The AI reads the whole working tree,
> decides *what happened* as a whole and per file, proposes an ordered set of commits,
> and (after you review/edit) creates them. Optional one-tap sync afterward.
>
> This is an **opt-in button**, never the default. The normal "stage-all + commit" path
> is untouched.

---

## 1. The one decision that shapes everything: granularity

**v1 splits at the FILE level — whole files are grouped into commits; a file is never
split across two commits.**

Why not line/hunk level (the "even smarter" option)?

- RepoYeti's **central, non-negotiable invariant** (MARCHING_ORDERS.md §7, gap-analysis
  header): *"the daemon never leaves a repo in an unsafe / half-merged state."* Hunk-level
  staging means programmatically applying a **subset of a file's hunks** to the index
  (`git apply --cached` of a partial patch). That can fail/conflict and leave a file
  **partially staged** — exactly the stranded state the whole product is designed to avoid.
  The gap analysis already files hunk-level staging under **Tier 3 — rejected by design**.
- File-level staging is the opposite: **Tier 2 — planned** ("`git add <paths>` then commit
  without `-A`"). Every individual commit is atomic; if the sequence is interrupted, the
  result is "some commits made, the rest still uncommitted in the working tree" — a
  perfectly normal, safe, recoverable git state.
- It's not an intelligence limit. The model is plenty capable of per-file intent. The
  limiter is **execution safety on a phone with no undo**.
- **Prior art agrees.** GitKraken's shipping *AI Commit Composer* (Jan 2026) groups at
  **file level only** — you can't split one file's hunks across commits in its UI either.
  This is the proven, safe shape.

**Mixed-concern files** (one file with two unrelated changes) are handled the
industry-standard way at file granularity: the file is assigned to its **dominant**
commit and the secondary change is **noted in that commit's body**. We never create a
broken commit to chase purity.

> **Future, explicitly deferred:** a hunk-level "deep split" mode *can* be layered on later
> as an opt-in power-user toggle (see §10). The architecture below is built so that adding
> it is additive, not a rewrite. It stays off until/unless we decide to relax the invariant.

---

## 2. Prior art (what we borrowed)

| Source | What we take |
|---|---|
| **GitKraken AI Commit Composer** | The whole UX shape: AI proposes a set of commits → user reorders / edits messages / **moves files between commits** / regenerates → "Create commits". File-level only. |
| **llm-git "compose mode"** | (a) snapshot the change-set *once* before the AI call so live edits can't contaminate; (b) **topologically order** commits so prerequisites land first; (c) error loudly if execution would produce zero commits while changes remain. |
| **jj absorb / GitButler** | Principle: when attribution is ambiguous, **refuse to guess** rather than make a mess. Surfaces as our "leftovers" group. |
| **Atomizer / SmartCommit / ColaUntangle (academic)** | Pure-LLM grouping misfires on (a) over-grouping similar-but-distinct changes, (b) cross-file relationships, (c) cosmetic edits. We mitigate with an explicit prompt taxonomy + a deterministic fallback, and keep a human in the loop. |
| **Atomic-commit best practice** | Conventional-Commits taxonomy; co-change clustering (source+test+types+docs together); foundation-first ordering; lockfile-with-manifest; cosmetic isolation. Encoded in the prompt. |

---

## 3. Architecture: **Plan → Review → Execute**

Three clean stages, mapping onto RepoYeti's existing layering (read-only inspection vs.
op-queue mutation vs. routes vs. store/UI).

```
                 ┌── Plan (read-only, no mutation) ──────────────────────────┐
 [Smart Commit]  │ collect changed files + bounded per-file diffs            │
   button  ───►  │ → AI returns a structured JSON plan (groups + messages)   │
                 │ → validate / fall back → return plan to UI. NOTHING runs. │
                 └───────────────────────────────────────────────────────────┘
                                        │
                 ┌── Review (full editor, client-side) ──────────────────────┐
                 │ ordered commit cards: edit subject/body, move files        │
                 │ between groups, merge / split / reorder / collapse-to-one, │
                 │ regenerate plan or one message. Nothing committed yet.     │
                 └───────────────────────────────────────────────────────────┘
                                        │  "Commit all N"  (+ optional sync)
                 ┌── Execute (one op-queue slot, atomic per commit) ─────────┐
                 │ re-validate plan vs CURRENT tree → for each group:         │
                 │   git add -- <paths> ; git -c user.* commit -m <msg>       │
                 │ → optional pull-ff + push → refresh → per-commit result.   │
                 └───────────────────────────────────────────────────────────┘
```

### Why two endpoints (plan and execute are decoupled)
The AI plan is a *suggestion*. The user edits it freely in the browser. Execution takes
the **edited** plan, not the AI's original — so the server re-validates the submitted
groups against the live working tree before touching anything. This also means a flaky/slow
provider can never block or corrupt a commit: planning and committing are independent calls.

---

## 4. Data shapes

```ts
// A single proposed commit (shared daemon ⇄ web).
interface CommitGroup {
  type: string;        // conventional type: feat|fix|refactor|test|docs|chore|style|perf|build|ci
  scope?: string;      // optional lowercase subsystem, e.g. "auth", "web/settings"
  subject: string;     // imperative, ≤72 chars (the message subject line)
  body?: string;       // optional body (used for the "secondary change" note, etc.)
  files: string[];     // repo-relative paths assigned to this commit
  rationale?: string;  // one-line "why these belong together" — shown as a hint, not committed
}

interface CommitPlan {
  groups: CommitGroup[];
  // Files the AI couldn't confidently place. Surfaced as an editable "Unassigned" group;
  // execution refuses while anything is unassigned.
  leftovers?: string[];
  degraded?: boolean;  // true when this came from the deterministic fallback, not the AI
  truncated?: boolean; // true when the diff sent to the AI was capped (large change-set)
}

// What the daemon feeds the AI (built locally, bounded).
interface CommitPlanInput {
  files: Array<{ path: string; status: string; from?: string; additions: number; removals: number; binary: boolean }>;
  diff: string;        // per-file-delimited, bounded unified diff
  truncated: boolean;
}

// What the UI POSTs to execute (the EDITED plan).
interface SmartCommitRequest {
  commits: Array<{ message: string; paths: string[] }>;  // message = subject + optional body
  sync?: boolean;      // after all commits: pull --ff-only then push (mirrors CommitMode 'sync')
}
```

### The final commit message
`message` is assembled client-side as `"<type>(<scope>): <subject>"` + (`\n\n` + body if
present). Conventional formatting is applied in the UI so the user sees and can edit the
exact final text, and the server commits it verbatim (same as the existing commit route).

---

## 5. AI layer (`src/ai.ts`)

Add a sibling to `generateCommitMessage` — **`generateCommitPlan`** — reusing the existing
adapter map, `requestJson`, and per-provider `buildBody`/`extractCompletion`. No adapter is
rewritten; we add **structured-JSON support** as an optional adapter capability.

- **Prompt.** A new system prompt that (a) states the file-level rule and the
  Conventional-Commits taxonomy, (b) gives the grouping heuristics (co-change:
  source+test+types+docs together; cosmetic isolated; lockfile with its manifest; new files
  before dependents), (c) demands **strict JSON only** matching the `CommitPlan` schema,
  (d) requires **every supplied path to appear in exactly one group** (or in `leftovers`
  only if genuinely ambiguous), (e) requires foundation-first ordering.
  The user message carries the `CommitPlanInput` (file list + numstat + bounded diff).
- **JSON mode (robustness).** Extend `AiAdapter` with an optional `jsonBody` builder:
  - OpenAI-compatible (openai/deepseek/groq/openrouter): add
    `response_format: { type: "json_object" }`.
  - Gemini: add `generationConfig.responseMimeType: "application/json"`.
  - Anthropic: no native flag needed — prompt-enforced JSON; we parse defensively.
  Bump `max_tokens` for this call (JSON is wordier → ~4096) and the request timeout (→ ~40s).
- **Parsing.** A dedicated parser: strip an accidental ```` ```json ```` fence, `JSON.parse`,
  then **validate with a zod schema**. Do **not** run `cleanCommitMessage` (it would corrupt
  JSON). On parse/validate failure: one retry with a terser "return ONLY JSON" reminder;
  still failing → throw `AiError("AI_ERROR", …)` so the route can fall back.
- **Validation (pure, unit-tested):** every input path appears exactly once across
  `groups[].files ∪ leftovers`; no unknown paths; subjects non-empty; types in the allowed
  set (unknown type → coerced to `chore`). Returns a normalized `CommitPlan`.

### Deterministic fallback (no AI / AI failed / changeset too big)
A pure function `heuristicPlan(input)` groups files **without a model**:
- bucket by **top-level directory / module** (e.g. `src/`, `web/src/components/`, `tests/`,
  `docs/`), with new-vs-modified-vs-deleted as a secondary split, lockfiles pinned to their
  manifest's bucket;
- templated conventional subjects (`chore(<scope>): update N files`, `test(<scope>): …`,
  `docs: …`), `degraded: true`.
The UI shows a banner: *"AI couldn't structure this — here's a basic grouping. Edit before
committing."* This guarantees Smart Commit **always produces an editable plan**, even with
no key configured (though the button is gated on `aiEnabled` for the AI path).

---

## 6. Git layer (`src/git-actions.ts`)

### Read: `collectCommitPlanInput(absPath): Promise<CommitPlanInput>`
Read-only, bounded, never mutates the index (same discipline as `collectCommitDiff`):
- `git status --porcelain=v1` → file list + statuses (+ rename `from→to` via `-M`/`status`).
- `git diff HEAD --numstat -M` → per-file additions/removals + binary detection (`-` rows).
- A **per-file-delimited** bounded diff with a **larger budget** than the message path
  (~40 KB total) and a **per-file cap** (so one huge file can't starve the rest). Files
  whose diff is omitted still carry path+status+numstat for grouping. Untracked files are
  included by name (their content counts as additions). Uses the same `boundedGit`
  streaming-with-early-kill helper.

### Mutate: `gitCommitGroups(absPath, identity, commits): Promise<CommitGroupsResult>`
The heart of execution. **All of it runs inside a single op-queue slot** (the service
wrapper enqueues once — never per commit — and refreshes *after* the slot releases, per the
documented same-key-nesting deadlock rule).

```
preflight (readStatus): DETACHED_HEAD → fail; dirty === 0 → NOTHING_TO_COMMIT
git reset -q                       # MIXED reset: index → HEAD. Working tree UNTOUCHED.
                                   # (Safe; same family as discardFile's reset. NOT --hard.)
for (const c of commits) {
  git add -A -- <c.paths>          # stage exactly this group: mods, new files, deletions,
                                   #   and a rename's old+new path (we include `from`)
  git -c user.* commit -m c.message
  → record { ok, code?, message?, subject }
  if a commit fails (e.g. a pre-commit hook rejects): STOP, return partial result.
}
```
- After each commit the index returns to clean, so the next `add` stages only the next
  group. Disjoint+complete validation upstream guarantees no overlap.
- **Identity** is injected per commit exactly like `gitCommitAll` (`identityConfigArgs`),
  so global/repo config stays byte-identical (acceptance criterion #10).
- **Partial failure is a SAFE state**, reported honestly: "committed K of N; the remaining
  changes are still in your working tree." No half-merge, no rollback needed, nothing lost.
- **Renames:** the changed-file reader is enriched to expose `from` for `R` entries; a
  rename's group includes both `from` and `to` so the deletion of the old path is staged
  with the addition of the new one.

> Note on `git reset` (mixed): it only moves the index pointer back to HEAD — it **never
> touches the working tree** and is fully reversible (just re-stage). This is categorically
> different from the forbidden `reset --hard`. It guarantees each group's commit contains
> exactly that group's files regardless of any pre-existing staged state.

---

## 7. Service layer (`src/service.ts`)

- `planCommitInput(repoId)` — like `collectRepoDiff`: enqueue a `readStatus` (refuse
  submodule / `NOTHING_TO_COMMIT`), then `collectCommitPlanInput`. Read-only.
- `smartCommitRepo(repoId, commits, sync)` —
  1. Look up repo + identity; guard NOT_FOUND / submodule.
  2. **Re-validate** the submitted `commits` against a fresh `readChanges`: every path is
     currently changed, paths are disjoint across commits, and the union covers the changed
     set (extra/vanished paths → `PLAN_STALE`, prompting the UI to re-plan).
  3. `enqueue(repoId, () => gitCommitGroups(...))` — one slot for the whole sequence.
  4. If `sync` and all commits succeeded: reuse the existing pull-ff + push legs.
  5. `refreshRepo` **after** the slot releases.
  Returns `{ ok, committed: [...], remaining, synced?, code }`.

## 8. Contract + schemas + routes

- **`src/contract.ts`** — new codes (mirrored in `web/src/types.ts`):
  `PLAN_STALE` (409), `EMPTY_PLAN` (400), `PLAN_PATHS_INVALID` (400),
  `AI_PLAN_FAILED` (502, when AI structuring fails *and* fallback is disabled — normally we
  fall back instead). Reuse `AI_*`, `NOTHING_TO_COMMIT`, `DETACHED_HEAD`, `NO_*`.
- **`src/schemas.ts`** —
  `CommitPlanSchema = { provider?: string }` (mirror of `CommitMessageSchema`);
  `SmartCommitSchema = { commits: [{ message: nonEmpty, paths: string[].min(1) }].min(1), sync?: boolean }`.
- **`src/daemon.ts`** —
  - `POST /api/repos/:id/commit-plan` → resolve provider/key/model → `planCommitInput` →
    `generateCommitPlan` (fall back to `heuristicPlan` on AI failure) → `{ ok, plan }`.
    409 on `NOTHING_TO_COMMIT`.
  - `POST /api/repos/:id/smart-commit` → `parseBody(SmartCommitSchema)` → `smartCommitRepo`
    → map result via `statusForCode`.

## 9. Web (`web/`)

- **`api.ts`** — `ai.commitPlan(repoId, provider?)` and `smartCommit(repoId, commits, sync?)`.
- **`types.ts`** — `CommitGroup`, `CommitPlan`, the new codes.
- **`store.ts`** — `genCommitPlan(repoId)`, `smartCommit(repoId, commits, sync)`, and plan
  state (the in-progress plan per repo so the editor is reactive).
- **UI** — a new **`SmartCommitPlan.vue`** (a responsive Sheet/dialog, matching the existing
  shadcn-vue Sheet pattern used by Settings/Identity) opened from a **Smart Commit** button
  beside the existing commit box in `RepoCard.vue` (visible when `aiEnabled` and there are
  changes). The **full editor**:
  - ordered, drag-reorderable commit cards (reuse `@formkit/drag-and-drop`, already a dep);
  - per-card: type/scope badge + editable subject + expandable body + file chips;
  - **move a file** to another card (drag a chip, or a "move to…" menu);
  - **merge** two cards, **split** a card, **delete** a card (its files → Unassigned),
    **collapse to one commit**, **regenerate** the whole plan or one card's message;
  - a live preview of each final `type(scope): subject` line;
  - footer: **Commit all N** and **Commit all & sync**, plus **Cancel** (discards the plan,
    no git change); a banner when `degraded`/`truncated`; an "Unassigned" group blocks commit.
- **`locales/en.json`** — all new strings (i18n scaffolding is retained even though the app
  ships English-only).

## 10. Safety analysis (invariant compliance)

| Risk | Mitigation |
|---|---|
| Half-staged / half-merged tree | File-level only; `git add -- <paths>` + `commit` per group; index normalized first; never `apply --cached` partial hunks. End state is always either fully committed or "some commits + clean remainder". |
| Interrupted mid-sequence | Each commit is atomic. Partial result reported; remaining changes sit safely in the working tree. No rollback needed, nothing lost. |
| Plan stale (tree changed between plan and execute) | Server re-validates submitted paths vs. live `readChanges`; mismatch → `PLAN_STALE`, UI re-plans. |
| Op-queue race / deadlock | Whole sequence in **one** `enqueue(repoId)` slot; `refreshRepo` only **after** it releases. |
| AI key leakage | Unchanged daemon-proxy model — the key never leaves the host; the browser only ever sees paths + messages. |
| Identity / config mutation | Per-commit `-c user.*` injection; global/repo config untouched. |
| Push divergence | `sync` reuses the existing pull-ff + non-force push guards (409/403). Splitting changes none of that. |
| Provider returns garbage | Strict zod validation + one retry + deterministic fallback. Never executes an unvalidated plan. |
| Reversibility from the phone | Commits are **local** until you choose `sync` — no worse than today's commit button. (Auto-branching for extra safety is a possible future, deliberately not in v1; it's off-pattern for RepoYeti.) |

## 11. Edge cases

- **Untracked / new files** — staged via `git add -- <path>`; counted as additions in stats.
- **Deletions** — `git add -- <deletedpath>` stages the removal (git ≥2.0).
- **Renames** — old+new path travel together in one group (reader exposes `from`).
- **Binary / large files** — flagged in the plan input (no textual diff sent); grouped by
  path/stat; can be isolated by the model or the user.
- **Lockfiles** — prompt rule pins them to their manifest's group; fallback buckets them with
  the manifest's directory.
- **>2000 changed files** — `getChanges` already caps at `MAX_CHANGED_FILES`; Smart Commit
  shows the same "N of M" truncation and operates on the visible set (banner warns).
- **Single logical change** — the AI may legitimately return one group; the UI still lets you
  "Commit all" (== a normal commit) so the button is never a dead end.

## 12. Implementation plan (build order)

1. **AI core** — `ai.ts`: `generateCommitPlan` + JSON-mode adapter capability + zod plan
   schema + `parseCommitPlan` + `heuristicPlan`. Unit-test parsing/validation/fallback.
2. **Git core** — `git-actions.ts`: `collectCommitPlanInput` + `gitCommitGroups`; enrich the
   changed-file reader with rename `from`. Test multi-commit execution on a real temp repo.
3. **Service + contract + schemas** — `planCommitInput`, `smartCommitRepo`, new codes/schemas.
4. **Daemon routes** — `commit-plan`, `smart-commit`. HTTP route tests (incl. `PLAN_STALE`).
5. **Web data layer** — `api.ts`, `types.ts`, `store.ts`.
6. **Web UI** — `SmartCommitPlan.vue` + `RepoCard.vue` button + `en.json`.
7. **Verify** — `bun test` green; `vue-tsc`/build green; runtime smoke test over HTTP.

## 12b. YOLO mode (shipped)

A global owner setting (`cfg.ai.yolo`, Settings → AI) flips the Smart Commit button from
**plan → review → execute** to **plan → execute** with no editor: it generates the plan and
commits it immediately. For an owner who trusts the AI and won't edit the plan. Guard rails
that stay on even in YOLO:
- **Never auto-pushes** — committing is local and undoable at the desk; pushing is outward-facing,
  so it's left to an explicit Push/Sync tap.
- **Nothing is silently dropped** — any planner `leftovers` are committed as a final
  `chore: miscellaneous changes` commit.
- Same server-side re-validation (`PLAN_STALE`/`PLAN_PATHS_INVALID`) and single-op-queue-slot
  execution as the reviewed path.
The button shows a small **YOLO** tag when the mode is on.

## 12c. Token efficiency (shipped)

The planner's diff is **token-trimmed** so more change-sets fit a provider's rate limit (the free
Groq tier is 6000 tokens/min) and every call is cheaper — without any external dependency or model:
- **Zero-context diffs** (`git diff -U0`) — just the changed lines, no surrounding context (grouping
  doesn't need it; *message* generation still uses full context).
- **Noise folding** (`isNoisyPath`) — the diff *bodies* of lockfiles, `*.min.js/.css`, `*.map`,
  `*.snap`, `*.lock` are dropped; the file **list** still carries them (with stat) so grouping a
  lockfile *with its manifest* still works. The model only needs to *know* they changed, not read
  thousands of generated lines.

Measured ~99.9% diff reduction on a lockfile-heavy change (136 KB → 151 chars), with the AI plan
still `degraded:false`. (Concept borrowed from claw-compactor's "diff folding"; implemented as ~40
lines in `collectCommitPlanInput`, kept in that one function so a future TS compressor can drop in.
A generic compressor like LLMLingua was rejected — it can corrupt code semantics and needs a bundled
model; the only diff-specific tool, claw-compactor, is Python and can't live in the Bun binary.)

## 13. Future (deferred, additive)

- **Hunk-level "deep split"** opt-in (would require an explicit decision to relax the
  invariant + a partial-patch apply path with conflict-safe fallback to whole-file).
- **Per-commit test gate** (`--compose-test-after-each`-style) before each commit.
- **Auto-branch** the plan for one-tap undo.
- **Topological auto-ordering** from import/symbol scanning (today ordering is the model's
  judgment + manual reorder).
</content>
</invoke>
