import { test, expect } from "bun:test";
import { parseGhAccounts } from "../src/gh-cli.ts";

test("parseGhAccounts reads login, active flag, protocol and scopes", () => {
  const accounts = parseGhAccounts(
    JSON.stringify({
      hosts: {
        "github.com": [
          { active: true, host: "github.com", login: "L0garithmic", gitProtocol: "https", scopes: "gist, repo", tokenSource: "keyring" },
          { active: false, host: "github.com", login: "LunarWerxs", gitProtocol: "https", tokenSource: "keyring" },
        ],
      },
    }),
  );

  expect(accounts.map((a) => a.login)).toEqual(["L0garithmic", "LunarWerxs"]);
  expect(accounts.find((a) => a.login === "L0garithmic")?.active).toBe(true);
  expect(accounts.find((a) => a.login === "LunarWerxs")?.active).toBe(false);
  expect(accounts[0]?.scopes).toEqual(["gist", "repo"]);
  expect(accounts[1]?.scopes).toEqual([]); // missing scopes → empty list, never undefined
});

test("parseGhAccounts never surfaces token material", () => {
  const [a] = parseGhAccounts(
    JSON.stringify({
      hosts: {
        "github.com": [{ active: true, login: "octocat", gitProtocol: "https", oauthToken: "gho_secret", scopes: "repo" }],
      },
    }),
  );

  expect(a?.login).toBe("octocat");
  expect(JSON.stringify(a)).not.toContain("gho_secret");
  expect(a).not.toHaveProperty("oauthToken");
});

test("parseGhAccounts tolerates malformed / empty input", () => {
  expect(parseGhAccounts("")).toEqual([]);
  expect(parseGhAccounts("not json")).toEqual([]);
  expect(parseGhAccounts(JSON.stringify({}))).toEqual([]);
  expect(parseGhAccounts(JSON.stringify({ hosts: {} }))).toEqual([]);
  expect(parseGhAccounts(JSON.stringify({ hosts: { "github.com": [] } }))).toEqual([]);
  expect(parseGhAccounts(JSON.stringify({ hosts: { "github.com": [{ active: true }] } }))).toEqual([]); // no login → skipped
});

test("parseGhAccounts handles multiple hosts (GitHub Enterprise)", () => {
  const accounts = parseGhAccounts(
    JSON.stringify({
      hosts: {
        "github.com": [{ active: true, login: "me", gitProtocol: "https" }],
        "ghe.example.com": [{ active: true, login: "work", gitProtocol: "ssh" }],
      },
    }),
  );

  expect(accounts).toHaveLength(2);
  const work = accounts.find((a) => a.host === "ghe.example.com");
  expect(work?.login).toBe("work");
  expect(work?.gitProtocol).toBe("ssh");
});
