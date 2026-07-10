import { test, expect } from "bun:test";
import {
  createIdentity,
  deleteIdentity,
  getAccountIdentity,
  setAccountIdentity,
  accountIdentityMap,
} from "../src/db.ts";

test("account-identity link: set, read, map, overwrite, and clear", () => {
  const id = createIdentity({ displayName: "Work", gitUsername: "Work Bot", gitEmail: "work@example.com" });

  expect(getAccountIdentity("github.com", "octo-work")).toBeNull(); // absent by default

  setAccountIdentity("github.com", "octo-work", id);
  expect(getAccountIdentity("github.com", "octo-work")).toBe(id);

  const map = accountIdentityMap();
  expect(Object.values(map)).toContain(id);
  expect(Object.keys(map).some((k) => k.includes("octo-work"))).toBe(true);

  // overwriting the same (host, login) keeps a single row (upsert, not a duplicate)
  const id2 = createIdentity({ displayName: "Work2", gitUsername: "W2", gitEmail: "w2@example.com" });
  setAccountIdentity("github.com", "octo-work", id2);
  expect(getAccountIdentity("github.com", "octo-work")).toBe(id2);

  setAccountIdentity("github.com", "octo-work", null); // clear
  expect(getAccountIdentity("github.com", "octo-work")).toBeNull();
});

test("deleting an identity clears any account links pointing at it", () => {
  const id = createIdentity({ displayName: "Temp", gitUsername: "Temp", gitEmail: "temp@example.com" });
  setAccountIdentity("github.com", "octo-temp", id);
  expect(getAccountIdentity("github.com", "octo-temp")).toBe(id);

  deleteIdentity(id);
  expect(getAccountIdentity("github.com", "octo-temp")).toBeNull();
});
