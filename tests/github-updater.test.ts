import { expect, test } from "bun:test";
import { assetForPlatform, isNewer, releaseTarget } from "../src/github-updater.ts";

const direct = {
  name: "repoyeti-windows-x64.exe",
  browser_download_url: "https://example.test/direct",
  size: 100,
};
const archive = {
  name: "repoyeti-windows-x64.zip",
  browser_download_url: "https://example.test/archive",
  size: 40,
};

test("compiled updater selects the Windows archive regardless of direct-exe upload order", () => {
  expect(assetForPlatform([direct, archive], "win32", "x64")).toEqual(archive);
  expect(assetForPlatform([archive, direct], "win32", "x64")).toEqual(archive);
});

test("compiled updater uses the public release target names", () => {
  expect(releaseTarget("win32", "x64")).toBe("windows-x64");
  expect(releaseTarget("darwin", "arm64")).toBe("macos-arm64");
  expect(releaseTarget("linux", "x64")).toBe("linux-x64");
});

test("release versions compare as numeric semver triples", () => {
  expect(isNewer("v0.14.1", "0.14.0")).toBe(true);
  expect(isNewer("0.14.0", "0.14.0")).toBe(false);
  expect(isNewer("0.13.9", "0.14.0")).toBe(false);
});
