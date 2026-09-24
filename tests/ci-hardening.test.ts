import { test, expect } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "./helpers/repo-root.ts";
import { mkScratchDir } from "./helpers/scratch.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// CI hardening: the release workflow's token scope, the browser gate's diagnostics artifact, and the
// release smoke test's scratch-dir cleanup all failed only on paths (tag push, red gate, failed
// spawn) that no unit test reaches. These assertions pin the workflow files' contract and the smoke
// script's unconditional cleanup so the same regressions cannot come back silently.
useSuiteTimeout();

// Walk up to the app root (package.json + .git) instead of hop-counting `..`: a fixed hop count
// silently points at the wrong directory — with no error, just a wrong answer — the moment this
// file moves, which turns the workflow assertions below into a fake pass.
const appRoot = findRepoRoot(import.meta.dir);

interface WorkflowStep {
  run?: string;
  env?: Record<string, string>;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface WorkflowJob {
  permissions?: { contents?: string };
  steps: WorkflowStep[];
}
interface Workflow {
  permissions?: { contents?: string };
  jobs: Record<string, WorkflowJob>;
}

function workflow(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(join(appRoot, ".github", "workflows", name), "utf8")) as Workflow;
}

test("release.yml grants contents: read workflow-wide; only the publish job holds write", () => {
  const release = workflow("release.yml");

  // A workflow-level `contents: write` was inherited by preflight/browser/build, which only read the
  // repo but run `bun install` (dependency lifecycle scripts) and third-party actions. Narrow it.
  expect(release.permissions?.contents).toBe("read");

  const jobs = release.jobs;
  const writers = Object.entries(jobs)
    .filter(([, job]) => job.permissions?.contents === "write")
    .map(([name]) => name);
  // Exactly the publish job needs write, and it must still have it to create the release.
  expect(writers).toEqual(["release"]);
});

test("the browser gate keeps its diagnostics directory alive for the artifact upload", () => {
  // Both workflows run the same gate and upload the same daemon.log.
  for (const name of ["ci.yml", "release.yml"]) {
    const wf = workflow(name);
    const steps = wf.jobs.browser!.steps;
    const gateStep = steps.find((step) => step.run === "bun run --cwd web test:gate");
    // global-setup.ts's teardown deletes web/.playwright/browser-gate (where daemon.log and gate.json
    // live) unless REPOYETI_GATE_KEEP=1, so without this the upload-artifact step had nothing to keep.
    expect(gateStep?.env?.REPOYETI_GATE_KEEP).toBe("1");

    const upload = steps.find((step) => String(step.uses ?? "").startsWith("actions/upload-artifact"));
    expect(upload?.with?.path).toContain("web/.playwright/browser-gate/daemon.log");
  }
});

test("smoke-release.ts removes its scratch dir even when the child never spawns", async () => {
  // Reproduce the pre-try failure: the executable exists but cannot be launched, so Bun.spawn throws
  // before the script's try block was entered. The scratch dir (created with mkdtempSync under the OS
  // temp dir) previously leaked on every such failure.
  const bundle = mkScratchDir("gm-ci-bundle-");
  writeFileSync(join(bundle, process.platform === "win32" ? "repoyeti.exe" : "repoyeti"), "not a binary");

  // ownTmp is what the smoke script sees as tmpdir(); override every env var tmpdir() consults so the
  // scratch it creates (and must delete) lands inside a directory this test owns.
  const ownTmp = mkScratchDir("gm-ci-tmp-");
  const proc = Bun.spawn([process.execPath, join(appRoot, "scripts", "smoke-release.ts"), bundle], {
    cwd: appRoot,
    env: { ...process.env, TMPDIR: ownTmp, TEMP: ownTmp, TMP: ownTmp },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  expect(code).not.toBe(0);

  expect(readdirSync(ownTmp)).toEqual([]);
});
