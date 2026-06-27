// Mirrors the daemon's API shapes (src/db.ts / src/git-actions.ts).

export interface RepoStatus {
  branch: string | null;
  detached: boolean;
  dirty: number;
  ahead: number;
  behind: number;
  remote: string | null;
  error: string | null;
  fetchedAt: number | null;
  updatedAt: number;
}

export type RepoSource = "auto" | "pinned" | "created";

export interface Repo {
  id: string;
  name: string;
  absPath: string;
  source: RepoSource;
  isSubmodule: boolean;
  identityId: string | null;
  status: RepoStatus | null;
  updatedAt: number;
}

export interface Identity {
  id: string;
  displayName: string;
  gitUsername: string;
  gitEmail: string;
  sshKeyPath: string | null;
}

export type ActionName = "fetch" | "pull" | "push" | "refresh" | "commit";

export interface ActionResult {
  ok: boolean;
  code: string;
  message: string;
  repoId?: string;
}
