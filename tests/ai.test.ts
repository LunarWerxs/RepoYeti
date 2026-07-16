import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { redactAi, resolveApiKey, type RepoYetiConfig } from "../src/config.ts";
import {
  parseModels,
  extractCompletion,
  cleanCommitMessage,
  userPromptFor,
  listModels,
  generateCommitMessage,
  AiError,
  type FetchFn,
} from "../src/ai.ts";
import { collectCommitDiff } from "../src/git-actions.ts";

const BASE: RepoYetiConfig = { roots: [], port: 7171, maxDepth: 6, maxRepos: 200 };

// ── redaction: the key must NEVER leave the daemon ──────────────────────────────
test("redactAi never emits an apiKey and reports configured providers", () => {
  const cfg: RepoYetiConfig = {
    ...BASE,
    ai: {
      providers: {
        openai: { apiKey: "sk-SECRET-openai", model: "gpt-4o" },
        anthropic: { apiKey: "sk-ant-SECRET", model: null },
      },
      defaultProvider: "openai",
      style: "conventional",
    },
  };
  const r = redactAi(cfg);
  expect(JSON.stringify(r)).not.toContain("SECRET");
  expect(r.providers.openai).toEqual({ configured: true, model: "gpt-4o" });
  expect(r.providers.anthropic).toEqual({ configured: true, model: null });
  expect(r.providers.gemini).toBeUndefined();
  expect(r.defaultProvider).toBe("openai");
  expect(r.style).toBe("conventional");
});

test("AI is unconfigured until the owner supplies a key", () => {
  const fresh = redactAi(BASE);
  expect(fresh.defaultProvider).toBeNull();
  expect(fresh.providers.groq).toBeUndefined();
  expect(fresh.providers.openai).toBeUndefined();
  expect(resolveApiKey(BASE, "groq")).toBeNull();
  expect(resolveApiKey(BASE, "openai")).toBeNull();

  // The owner's own Groq key enables the provider without exposing the key.
  const own: RepoYetiConfig = {
    ...BASE,
    ai: { providers: { groq: { apiKey: "gsk-OWN-KEY", model: "llama-3.1-8b-instant" } } },
  };
  expect(resolveApiKey(own, "groq")).toBe("gsk-OWN-KEY");
  expect(redactAi(own).providers.groq).toEqual({
    configured: true,
    model: "llama-3.1-8b-instant",
  });
  expect(JSON.stringify(redactAi(own))).not.toContain("OWN-KEY");
});

test("redactAi clears the default provider when the chosen default is not configured", () => {
  const r = redactAi({ ...BASE, ai: { providers: {}, defaultProvider: "openai" } });
  expect(r.defaultProvider).toBeNull();
  expect(r.providers.groq).toBeUndefined();
  expect(r.style).toBe("conventional");
});

// ── model-list parsers (pure, fixture JSON) ─────────────────────────────────────
test("openai parser keeps chat models and drops non-chat ones", () => {
  const ids = parseModels("openai", {
    data: [
      { id: "gpt-4o" },
      { id: "gpt-3.5-turbo" },
      { id: "o1-mini" },
      { id: "text-embedding-3-small" },
      { id: "whisper-1" },
      { id: "dall-e-3" },
      { id: "tts-1" },
    ],
  }).map((m) => m.id);
  expect(ids).toContain("gpt-4o");
  expect(ids).toContain("gpt-3.5-turbo");
  expect(ids).toContain("o1-mini");
  expect(ids).not.toContain("text-embedding-3-small");
  expect(ids).not.toContain("whisper-1");
  expect(ids).not.toContain("dall-e-3");
  expect(ids).not.toContain("tts-1");
});

test("anthropic parser keeps id + display_name label", () => {
  const models = parseModels("anthropic", {
    data: [{ id: "claude-3-5-sonnet-20241022", display_name: "Claude 3.5 Sonnet" }],
  });
  expect(models).toEqual([{ id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" }]);
});

test("gemini parser strips the models/ prefix and requires generateContent", () => {
  const models = parseModels("gemini", {
    models: [
      { name: "models/gemini-1.5-pro", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
    ],
  });
  expect(models).toEqual([{ id: "gemini-1.5-pro", label: "gemini-1.5-pro" }]);
});

test("deepseek parser keeps all chat ids", () => {
  const ids = parseModels("deepseek", {
    data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
  }).map((m) => m.id);
  expect(ids.sort()).toEqual(["deepseek-chat", "deepseek-reasoner"]);
});

// ── completion extraction + cleanup ─────────────────────────────────────────────
test("extractCompletion reads each provider's response shape", () => {
  expect(extractCompletion("anthropic", { content: [{ type: "text", text: "hi" }] })).toBe("hi");
  expect(extractCompletion("openai", { choices: [{ message: { content: "hi" } }] })).toBe("hi");
  expect(extractCompletion("deepseek", { choices: [{ message: { content: "hi" } }] })).toBe("hi");
  expect(extractCompletion("gemini", { candidates: [{ content: { parts: [{ text: "hi" }] } }] })).toBe("hi");
});

test("cleanCommitMessage strips code fences and wrapping quotes", () => {
  expect(cleanCommitMessage("```\nfix: thing\n```")).toBe("fix: thing");
  expect(cleanCommitMessage('"add a feature"')).toBe("add a feature");
  expect(cleanCommitMessage("  plain message  ")).toBe("plain message");
});

// Git's subject is everything up to the first blank line, so a body running straight on after
// line 1 makes the WHOLE message the subject. Observed live: llama-3.3-70b did exactly this
// despite the prompt asking for the blank line.
test("cleanCommitMessage forces git's blank line between subject and body", () => {
  expect(cleanCommitMessage("feat: add thing\n- one\n- two")).toBe("feat: add thing\n\n- one\n- two");
  // already correct → unchanged (no double-spacing)
  expect(cleanCommitMessage("feat: add thing\n\n- one")).toBe("feat: add thing\n\n- one");
  // subject-only stays a single line
  expect(cleanCommitMessage("feat: add thing")).toBe("feat: add thing");
  // a trailing space on the subject (also observed live) is trimmed
  expect(cleanCommitMessage("feat: add thing   \nbody")).toBe("feat: add thing\n\nbody");
  // blank-line-only tail collapses to a plain subject rather than trailing newlines
  expect(cleanCommitMessage("feat: add thing\n\n   ")).toBe("feat: add thing");
});

// Wrapping is CODE's job, not the model's: asking a model to wrap is asking it to count
// characters, and every surveyed tool that cares (aicommits' wrapLine) wraps client-side. The
// prompt no longer asks; this is what guarantees.
test("the body wraps at 72 with bullet continuation indent; the subject never wraps", () => {
  const longBullet =
    "- `decodeRow()` read a NULL timestamp as epoch 0 rather than skipping the field, so rows with no `updated_at` serialized wrong";
  const out = cleanCommitMessage(`fix: handle null timestamps\n\n${longBullet}`);
  const lines = out.split("\n");
  expect(lines[0]).toBe("fix: handle null timestamps"); // subject untouched
  for (const l of lines.slice(2)) expect(l.length).toBeLessThanOrEqual(72);
  expect(lines[2]!.startsWith("- ")).toBe(true);
  expect(lines[3]!.startsWith("  ")).toBe(true); // continuation stays visually inside the bullet
  expect(lines[3]!.startsWith("- ")).toBe(false); // and never becomes a fake second bullet
  // Re-joining (minus the indent) loses no words.
  const rejoined = lines.slice(2).map((l) => l.replace(/^ {2}/, "")).join(" ");
  expect(rejoined).toBe(longBullet);
  // A single over-long token (a path/URL) is left unbroken — a split path is worse.
  const url = `- see https://example.com/${"a".repeat(90)}`;
  expect(cleanCommitMessage(`fix: x\n\n${url}`)).toContain("a".repeat(90));
  // Short bodies pass through byte-identical.
  expect(cleanCommitMessage("fix: x\n\n- short")).toBe("fix: x\n\n- short");
});

// The bullet-floor anchor: a number the model can neither argue down (the files really changed)
// nor pad past (there are only N). Count, never diff size — a size quota forces invention.
test("userPromptFor anchors the body to the file count, and stays silent when it can't help", () => {
  expect(userPromptFor("DIFF", 5)).toContain("This change touches 5 files");
  expect(userPromptFor("DIFF", 5)).toContain("must not come back as a single line");
  // One file (or unknown): no anchor — "account for each of 1 files" is noise.
  expect(userPromptFor("DIFF", 1)).not.toContain("This change touches");
  expect(userPromptFor("DIFF")).not.toContain("This change touches");
  // The diff always follows, whatever the anchor did.
  expect(userPromptFor("DIFF", 5).endsWith("DIFF")).toBe(true);
});

// ── network paths behind an injected fetch (no real provider hit) ────────────────
function fakeFetch(status: number, body: unknown, capture?: (url: string, init?: RequestInit) => void): FetchFn {
  return async (url, init) => {
    capture?.(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

test("listModels parses a 200 body and maps 401 to AI_AUTH_FAILED", async () => {
  const ok = await listModels("openai", "sk-x", fakeFetch(200, { data: [{ id: "gpt-4o" }] }));
  expect(ok.map((m) => m.id)).toEqual(["gpt-4o"]);

  await expect(listModels("openai", "bad", fakeFetch(401, { error: { message: "bad key" } }))).rejects.toMatchObject({
    code: "AI_AUTH_FAILED",
  });
});

test("generateCommitMessage sends the model + returns a cleaned message", async () => {
  let sentUrl = "";
  let sentBody: { model?: string; messages?: Array<{ role?: string; content?: unknown }> } | null = null;
  const f = fakeFetch(200, { choices: [{ message: { content: "```\nfeat: add x\n```" } }] }, (url, init) => {
    sentUrl = url;
    sentBody = init?.body ? JSON.parse(String(init.body)) : null;
  });
  const msg = await generateCommitMessage("openai", "sk-x", "gpt-4o", "DIFF", "conventional", f);
  expect(msg).toBe("feat: add x");
  expect(sentUrl).toContain("/chat/completions");
  expect(sentBody!.model).toBe("gpt-4o");
  expect(sentBody!.messages?.some((m) => m.role === "user" && String(m.content).includes("DIFF"))).toBe(true);
});

test("generateCommitMessage throws on an empty model reply", async () => {
  await expect(
    generateCommitMessage("openai", "sk-x", "gpt-4o", "DIFF", "concise", fakeFetch(200, { choices: [{ message: { content: "" } }] })),
  ).rejects.toBeInstanceOf(AiError);
});

// ── diff collection (read-only; capped) ─────────────────────────────────────────
async function seededRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gm-ai-"));
  await $`git -c init.defaultBranch=main init -q ${dir}`.quiet();
  writeFileSync(join(dir, "base.txt"), "original\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m init`.quiet();
  return dir;
}

test("collectCommitDiff captures status + diff and never mutates the index", async () => {
  const dir = await seededRepo();
  writeFileSync(join(dir, "base.txt"), "changed\n");
  writeFileSync(join(dir, "new.txt"), "added\n");
  const out = await collectCommitDiff(dir);
  expect(out).toContain("# git status");
  expect(out).toContain("new.txt"); // untracked file shows up in the porcelain list
  expect(out).toContain("# git diff");
  expect(out).toContain("changed"); // the tracked modification is in the diff

  // read-only: nothing was staged
  const staged = (await $`git -C ${dir} diff --cached --name-only`.text()).trim();
  expect(staged).toBe("");
});

test("collectCommitDiff BOUNDS one huge file rather than spending the whole payload on it", async () => {
  const dir = await seededRepo();
  writeFileSync(join(dir, "base.txt"), "x\n".repeat(40_000)); // ~80 KB modification
  const out = await collectCommitDiff(dir);
  expect(out.length).toBeLessThan(25_000); // bounded, as it always was...
  // ...but now bounded PER FILE, not by lopping the tail off the whole payload. This used to ship
  // ~24k of one file's diff; a runaway file now costs only its slice — that class of file was 97%
  // of a real repo's diff. Structureless "x" lines have no declarations to map, so this is the
  // truncation path (see the condense tests in smart-commit.test.ts for the code-file path).
  expect(out.length).toBeLessThan(4_000);
  expect(out).toContain("diff lines folded"); // and it says what it dropped, in-band
  expect(out).toContain("base.txt"); // the file is still named + visible to the model
});

// NOTE on where condensing actually pays off, learned by measuring rather than assuming:
// symbol extraction needs SEPARATED hunks, because a hunk header only names a declaration when
// the hunk starts inside one. The PLANNER diffs at -U0, so a busy file yields many small hunks,
// each labelled → the map is rich. This MESSAGE path diffs with full context, so adjacent edits
// merge into one big hunk starting at line 1 ("@@ -1,131 +1,131 @@", no label) → nothing to map,
// and it correctly takes the truncation path. So condensing is tested at the foldLargeFileDiffs
// level (smart-commit.test.ts), where the input can be controlled; here we only pin the bound.

test("collectCommitDiff still truncates when the summed payload overruns the cap", async () => {
  const dir = await seededRepo();
  // Each file stays just UNDER its per-file slice (~1.7k of ~2k), so nothing condenses — but 20
  // of them sum past msgTotal. That's the backstop this guards: condensing shrinks INDIVIDUAL
  // files, it does not bound the total, so the payload cap still has to catch the sum.
  const body = Array.from({ length: 50 }, (_, j) => `pay-${String(j).padStart(4, "0")}-${"x".repeat(20)}`).join("\n");
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}.txt`), "seed\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m more`.quiet();
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}.txt`), body);
  const out = await collectCommitDiff(dir);
  expect(out.length).toBeLessThan(25_000);
  expect(out.endsWith("…[truncated]")).toBe(true);
});

// NOTE the dial's meaning shifted with condensing: perFile is now the THRESHOLD at which a file
// collapses to its symbol map, not how many of its lines get sent. So for a single always-over-cap
// file every setting yields the same map (correctly — the map is the whole change either way), and
// the dial shows up across a MIX of file sizes, which is the real-world shape.
test("the diff-detail dial changes what the message path sends", async () => {
  const dir = await seededRepo();
  // Fixed-width lines (~30 chars incl. the "+" and newline) so the sizes are arithmetic, not luck.
  // Resulting diff bodies ≈ 300 / 1500 / 3000 chars, which straddle the caps so that:
  //   lean(1200)     condenses d1 + d2   → smallest
  //   balanced(2000) condenses d2 only   → middle
  //   thorough(4000) condenses nothing   → largest
  const line = (i: number, j: number) => `d${i}-${String(j).padStart(4, "0")}-${"x".repeat(20)}`;
  const sizes = [10, 50, 100];
  for (const [i] of sizes.entries()) writeFileSync(join(dir, `d${i}.txt`), "seed\n");
  await $`git -C ${dir} add -A`.quiet();
  await $`git -C ${dir} -c user.name=Seed -c user.email=s@s.io commit -q -m sizes`.quiet();
  sizes.forEach((n, i) => {
    writeFileSync(join(dir, `d${i}.txt`), Array.from({ length: n }, (_, j) => line(i, j)).join("\n"));
  });

  const lean = await collectCommitDiff(dir, "lean");
  const balanced = await collectCommitDiff(dir, "balanced");
  const thorough = await collectCommitDiff(dir, "thorough");
  // leaner condenses MORE files → strictly less sent. ✨ Generate honors the dial, not just Auto.
  expect(lean.length).toBeLessThan(balanced.length);
  expect(balanced.length).toBeLessThan(thorough.length);
});
