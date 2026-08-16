// ───────────────────────────────────────────────────────────────────────────────
// The auto-update relaunch argv. Every failure this locks down is SILENT: the spawn
// succeeds, the SUCCESSOR is what dies, so the relaunch hook's catch never fires and the
// predecessor shuts down 800ms later believing a replacement is coming up. The user sees
// "localhost stopped working and I have to start it by hand", with nothing in the log
// saying an update did it.
//
// Three separate ways that happened, all live at once before this file existed:
//   1. compiled builds respawned process.argv[0..1], which inside a `bun --compile` binary
//      is the placeholder pair ["bun", "B:/~BUN/root/repoyeti.exe"] — not a runnable command
//   2. `start` is IMPLICIT on a bare launch (the documented "just run the .exe" path), so
//      appending --relaunch put a FLAG in the command slot: `Unknown command: --relaunch`
//   3. the successor was handed the PREFERRED port, not the bound one, so it waited out its
//      full 8s on a socket nobody was releasing and then bound a port the open tab isn't on
// ───────────────────────────────────────────────────────────────────────────────
import { expect, test } from "bun:test";
import { buildRelaunchArgv } from "../src/cli/lifecycle.ts";

const EXE = "C:\\Apps\\RepoYeti\\repoyeti.exe";
const BUN = "C:\\Users\\me\\.bun\\bin\\bun.exe";
const SCRIPT = "D:\\PublicProjects\\RepoYeti\\src\\index.ts";

/** What a compiled `bun build --compile` binary really reports (verified, Bun 1.3.14): argv[0] is
 *  the literal string "bun" and argv[1] is a virtual path inside the running binary. */
const compiledArgv = (...args: string[]) => ["bun", "B:/~BUN/root/repoyeti.exe", ...args];
const sourceArgv = (...args: string[]) => [BUN, SCRIPT, ...args];

/** Re-parse a built argv the way src/cli/main.ts + start() do, so these tests assert what the
 *  SUCCESSOR will actually conclude rather than just the token order. */
function dispatch(argv: string[], isCompiled: boolean): { command: string; port: number | null; relaunch: boolean } {
  const cli = argv.slice(isCompiled ? 1 : 2); // [exe, ...cli] compiled; [exe, script, ...cli] source
  const command = cli[0] ?? "start";
  const rest = cli.slice(1);
  let port: number | null = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--root" && rest[i + 1]) i++;
    else if (rest[i] === "--port" && rest[i + 1]) port = Number(rest[++i]);
  }
  return { command, port, relaunch: rest.includes("--relaunch") };
}

test("compiled: never respawns the placeholder argv pair", () => {
  const out = buildRelaunchArgv(compiledArgv(), EXE, true, 7172);
  expect(out[0]).toBe(EXE);
  expect(out.join(" ")).not.toContain("B:/~BUN/root");
  expect(out).not.toContain("bun");
});

test("compiled + bare launch: the successor still dispatches on `start`, not on a flag", () => {
  // The regression: a double-clicked release .exe has NO args, so `start` is implicit. Appending
  // flags to that empty list used to put --relaunch in the command slot and the successor exited 1.
  const out = buildRelaunchArgv(compiledArgv(), EXE, true, 7172);
  expect(dispatch(out, true)).toEqual({ command: "start", port: 7172, relaunch: true });
});

test("source: keeps the real script path as the argument to the runtime", () => {
  const out = buildRelaunchArgv(sourceArgv("start", "--port", "7171"), BUN, false, 7172);
  expect(out[0]).toBe(BUN);
  expect(out[1]).toBe(SCRIPT);
  expect(dispatch(out, false)).toEqual({ command: "start", port: 7172, relaunch: true });
});

test("the successor is handed the BOUND port, never the inherited preferred one", () => {
  const out = buildRelaunchArgv(sourceArgv("start", "--port", "7171"), BUN, false, 7172);
  expect(dispatch(out, false).port).toBe(7172);
  // The stale pair is dropped outright rather than left for last-wins parsing to sort out.
  expect(out.filter((a) => a === "--port")).toHaveLength(1);
  expect(out).not.toContain("7171");
});

test("other start flags survive the rebuild", () => {
  const out = buildRelaunchArgv(
    sourceArgv("start", "--root", "D:\\code", "--tunnel", "--port", "7171"),
    BUN,
    false,
    7172,
  );
  expect(out).toContain("--tunnel");
  expect(out.slice(out.indexOf("--root"), out.indexOf("--root") + 2)).toEqual(["--root", "D:\\code"]);
  expect(dispatch(out, false).port).toBe(7172);
});

test("a --root value is never mistaken for a flag", () => {
  // start()'s own loop consumes --root's value; this must too, or a path that happens to read
  // like a flag would be dropped (and its neighbour silently eaten).
  const out = buildRelaunchArgv(sourceArgv("start", "--root", "--port"), BUN, false, 7172);
  expect(out.slice(out.indexOf("--root"), out.indexOf("--root") + 2)).toEqual(["--root", "--port"]);
  expect(dispatch(out, false).port).toBe(7172);
});

test("argv does not grow across successive updates", () => {
  // Generation N's argv is generation N+1's INPUT. Blind appending grew it by two tokens per
  // update forever; Windows command lines are capped, and a relaunch loop should be a fixed point.
  const gen1 = buildRelaunchArgv(sourceArgv("start", "--port", "7171"), BUN, false, 7172);
  const gen2 = buildRelaunchArgv(gen1, BUN, false, 7172);
  const gen3 = buildRelaunchArgv(gen2, BUN, false, 7172);
  expect(gen2).toEqual(gen1);
  expect(gen3).toEqual(gen1);
  expect(gen3.filter((a) => a === "--relaunch")).toHaveLength(1);
});

test("a daemon that hopped again hands over its NEW port", () => {
  const gen1 = buildRelaunchArgv(sourceArgv("start", "--port", "7171"), BUN, false, 7172);
  const gen2 = buildRelaunchArgv(gen1, BUN, false, 7173); // hopped once more
  expect(dispatch(gen2, false).port).toBe(7173);
  expect(gen2).not.toContain("7172");
});
