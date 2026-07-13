// Test-only wrapper around src/db.ts upsertRepo. upsertRepo returns `string | null` now (null =
// refused because the path is under the OS temp dir; see src/paths.ts isUnderTempDir and the
// owner directive in src/db.ts's upsertRepo doc comment). Every test in this suite seeds its
// scratch repos via tests/helpers/scratch.ts's mkScratchDir, which is deliberately NOT under the
// OS temp dir (see that file's doc comment), so upsertRepo is expected to always succeed here;
// this helper asserts that and gives callers back a plain `string`, so the ~90 existing call
// sites across the suite don't all need their own null-check boilerplate for a case that (by
// construction) never happens in these tests. The guard itself is exercised directly, against a
// real temp path, in tests/db-temp-guard.test.ts.
import { upsertRepo as upsertRepoImpl, type RepoSource } from "../../src/db.ts";
import type { VcsKind } from "../../src/vcs/types.ts";

export function mustUpsertRepo(
  absPath: string,
  name: string,
  source: RepoSource,
  isSubmodule: boolean,
  vcs?: VcsKind,
): string {
  const id = upsertRepoImpl(absPath, name, source, isSubmodule, vcs);
  if (!id) {
    throw new Error(
      `mustUpsertRepo: upsertRepo refused "${absPath}" (treated as under the OS temp dir). ` +
        `Check that this path was created via tests/helpers/scratch.ts's mkScratchDir, not tmpdir().`,
    );
  }
  return id;
}
