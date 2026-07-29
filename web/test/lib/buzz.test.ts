import { describe, expect, it } from "vitest";
import {
  buildBuzzCloneUrl,
  hasBuzzCloneSource,
  isFullBuzzGitUrl,
} from "@/lib/buzz";

describe("Buzz clone URL construction", () => {
  it("uses a full HTTP(S) URL without requiring a saved community", () => {
    const url = "https://relay.example/git/owner/repository.git";
    expect(isFullBuzzGitUrl(url)).toBe(true);
    expect(hasBuzzCloneSource("", url)).toBe(true);
    expect(buildBuzzCloneUrl("", url)).toBe(url);
  });

  it("requires a community for owner/repository shorthand", () => {
    expect(hasBuzzCloneSource("", "owner/repository")).toBe(false);
    expect(hasBuzzCloneSource("wss://relay.example", "owner/repository")).toBe(true);
    expect(buildBuzzCloneUrl("wss://relay.example", "owner/repository")).toBe(
      "https://relay.example/git/owner/repository.git",
    );
  });
});
