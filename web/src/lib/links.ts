/**
 * Where this app points people at itself. One module, so a rename or a move can't leave a dead
 * link in whichever component happened to hardcode the address.
 */

/** The repository. Canonical owner/repo casing — see docs/STABLE_ADDRESS.md. */
export const SOURCE_URL = "https://github.com/LunarWerxs/RepoYeti";

/**
 * The changelog, read on the default branch rather than the Releases page (issue #20).
 *
 * A source checkout updates straight off `main`, so it routinely sits on commits no published
 * release covers yet. Releases would render more prettily on a phone and describe a version the
 * running daemon may not be on — the file is the destination that matches what actually installed.
 */
export const CHANGELOG_URL = `${SOURCE_URL}/blob/main/CHANGELOG.md`;
