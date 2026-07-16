// Test-only wrapper around src/db.ts upsertRepo. upsertRepo returns `string | null` now (null =
// refused, for one of two reasons: the path is under the OS temp dir — see src/paths.ts
// isUnderTempDir and the owner directive in src/db.ts's upsertRepo doc comment — or the owner
// removed it and it's tombstoned in `ignored_paths`). Every test in this suite seeds its
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
      `mustUpsertRepo: upsertRepo refused "${absPath}" — either it's treated as under the OS temp ` +
        `dir (check it was created via tests/helpers/scratch.ts's mkScratchDir, not tmpdir()), or a ` +
        `previous forgetRepo() in this test tombstoned it (call unignorePath() first).`,
    );
  }
  return id;
}
