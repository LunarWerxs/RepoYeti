/** A full Git URL can be cloned without a saved Buzz community. */
export function isFullBuzzGitUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** Whether the Advanced Buzz clone form has enough source information to submit. */
export function hasBuzzCloneSource(communityUrl: string, repoInput: string): boolean {
  const repo = repoInput.trim();
  return repo.length > 0 && (isFullBuzzGitUrl(repo) || communityUrl.length > 0);
}

/**
 * Turn an owner/repository slug into Buzz's standard Smart HTTP path. Full HTTP(S) clone URLs
 * remain untouched and continue through the ordinary Git clone validation on the daemon.
 */
export function buildBuzzCloneUrl(communityUrl: string, repoInput: string): string {
  const repo = repoInput.trim();
  if (isFullBuzzGitUrl(repo)) return repo;
  const community = new URL(communityUrl);
  if (community.protocol === "ws:") community.protocol = "http:";
  if (community.protocol === "wss:") community.protocol = "https:";
  const repoPath = repo.replace(/^\/+|\/+$/g, "");
  community.pathname = `${community.pathname.replace(/\/+$/, "")}/git/${repoPath}${repoPath.endsWith(".git") ? "" : ".git"}`;
  community.search = "";
  community.hash = "";
  return community.toString();
}
