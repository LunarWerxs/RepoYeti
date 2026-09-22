import { test, expect } from "bun:test";
import { argvRequestsRelaunch } from "../src/cli/lifecycle.ts";

// The auto-update successor is exempt from the single-instance probe, so reading the relaunch
// signal where there is none boots a second daemon beside the first (1.0 audit, delivery P2).

const BUN = ["bun", "src/index.ts", "start"];

test("--relaunch as a flag is the relaunch signal, wherever it sits", () => {
  expect(argvRequestsRelaunch([...BUN, "--relaunch"])).toBe(true);
  expect(argvRequestsRelaunch([...BUN, "--relaunch", "--root", "D:/code"])).toBe(true);
  expect(argvRequestsRelaunch([...BUN, "--root", "D:/code", "--relaunch"])).toBe(true);
  expect(argvRequestsRelaunch([...BUN, "--port", "7171", "--relaunch"])).toBe(true);
});

test("a --root or --port VALUE that reads --relaunch is a value, not the signal", () => {
  expect(argvRequestsRelaunch([...BUN, "--root", "--relaunch"])).toBe(false);
  expect(argvRequestsRelaunch([...BUN, "--port", "--relaunch"])).toBe(false);
  expect(argvRequestsRelaunch([...BUN, "--root", "--relaunch", "--relaunch"])).toBe(true);
});

test("no flag, no signal", () => {
  expect(argvRequestsRelaunch(BUN)).toBe(false);
  expect(argvRequestsRelaunch([...BUN, "--tunnel"])).toBe(false);
});
