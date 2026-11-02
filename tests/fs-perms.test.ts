import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restrictDirToCurrentUser, restrictToCurrentUser } from "../src/fs-perms.ts";
import { useSuiteTimeout } from "./helpers/timeouts.ts";

// whoami and icacls are real processes here, not spies.
useSuiteTimeout();

describe.if(process.platform === "win32")("owner-only on Windows", () => {
  const savedName = process.env.USERNAME;
  const dirs: string[] = [];

  function scratchDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "fs-perms-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    process.env.USERNAME = savedName;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("an account named like its PC is not locked out of its file", () => {
    process.env.USERNAME = process.env.COMPUTERNAME;
    const file = join(scratchDir(), "session.key");
    writeFileSync(file, "old");
    restrictToCurrentUser(file);
    writeFileSync(file, "new");
    expect(readFileSync(file, "utf8")).toBe("new");
    const acl = spawnSync("icacls", [file], { encoding: "utf8", windowsHide: true, timeout: 5000 }).stdout;
    expect(acl).not.toMatch(/BUILTIN\\Users|Authenticated Users|Everyone/);
    expect(acl).toContain("NT AUTHORITY\\SYSTEM:(F)");
  });

  test("an account named like its PC can still use a folder it restricted", () => {
    process.env.USERNAME = process.env.COMPUTERNAME;
    const dir = scratchDir();
    restrictDirToCurrentUser(dir);
    const file = join(dir, "config.json");
    writeFileSync(file, "{}");
    expect(readFileSync(file, "utf8")).toBe("{}");
    const acl = spawnSync("icacls", [dir], { encoding: "utf8", windowsHide: true, timeout: 5000 }).stdout;
    expect(acl).not.toMatch(/BUILTIN\\Users|Authenticated Users|Everyone/);
    expect(acl).toContain("NT AUTHORITY\\SYSTEM:(OI)(CI)(F)");
  });
});
