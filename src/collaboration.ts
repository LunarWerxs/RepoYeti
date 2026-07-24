/**
 * Peer working-tree collaboration.
 *
 * Passive presence never proxies a checkout. A collaborator maps a local repo to a repo covered
 * by an existing share invitation, then periodically publishes a compact status + changed-path
 * snapshot directly to the owner's tunnel. The snapshot is AES-256-GCM encrypted with a key
 * derived from the 256-bit share token. The address relay is used only to resolve a moved quick
 * tunnel; presence never enters its KV. Revoking/rotating the share makes future snapshots
 * unacceptable immediately.
 *
 * The passive path is state collaboration, not filesystem synchronization. A bounded tracked-file
 * patch is visible only after owner-side decryption; credentials, absolute paths, remotes, and
 * commit identities are excluded. An accepted link may separately read status/diffs or request a
 * guarded commit-and-sync through the ordinary share routes; its token stays in the accepting
 * daemon. The owner gets Mine / Theirs / Combined awareness, while the existing share permission
 * independently decides whether the guest may operate on the owner's checkout.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createCollaborationLink,
  deleteCollaborationLink,
  getRepo,
  getShareByTokenHash,
  listCollaborationLinks,
  listShares,
  shareCoversRepo,
  updateCollaborationOrigin,
  type CollaborationLink,
  type RepoStatus,
} from "./db.ts";
import type { RepoYetiConfig } from "./config.ts";
import { readChanges, type ChangedFile } from "./read/status.ts";
import { hashToken, shareIsLive } from "./share/index.ts";
import { collectPathsDiff } from "./git-actions/diff.ts";
import { pathWithin } from "./paths.ts";

const SNAPSHOT_VERSION = 1;
const MAX_PEERS = 50;
const PUBLISH_INTERVAL_MS = 2500;
const REQUEST_TIMEOUT_MS = 10_000;
const SNAPSHOT_MAX_BYTES = 350_000;
const SNAPSHOT_FRESH_MS = 30_000;
/** A remote dirty tree must remain byte-for-byte unchanged under observation for this long before
 *  an MCP agent may commit it. This is in addition to the normal MCP approval gate and the remote
 *  share's control permission. */
export const REMOTE_COMMIT_IDLE_MS = 10 * 60 * 1000;

export interface CollaborationSnapshot {
  version: 1;
  participantId: string;
  label: string;
  /** The owner's repo id this peer deliberately mapped their local checkout to. */
  repoId: string;
  localRepoName: string;
  status: RepoStatus | null;
  changes: ChangedFile[];
  /** Bounded unified diff for tracked edits. Untracked files remain path + stat only. */
  diff: string | null;
  updatedAt: number;
}

export interface CollaborationInvite {
  inviteUrl: string;
  token: string;
  remoteOrigin: string;
  relayUrl: string;
  daemonId: string | null;
  channelId: string;
  share: {
    label: string;
    perm: "view" | "control";
    collaborative: boolean;
  };
  repos: Array<{ id: string; name: string; displayName: string | null }>;
}

export interface AcceptedCollaborationSummary {
  id: string;
  localRepoId: string;
  localRepoName: string;
  remoteRepoId: string;
  enabled: boolean;
  createdAt: number;
}

export interface AcceptedCollaborationStatus {
  collaborationId: string;
  localRepoId: string;
  localRepoName: string;
  remoteRepo: {
    id: string;
    name: string;
    displayName: string | null;
    vcs: string;
    status: RepoStatus | null;
  };
  share: {
    label: string;
    perm: "view" | "control";
    collaborative: boolean;
  };
  changes: ChangedFile[];
  /** False when a changed file was too large/unreadable to include in the opaque activity hash.
   *  Status remains useful, but remote commit is refused because ten quiet minutes cannot be
   *  proven safely. */
  observationComplete: boolean;
  observedAt: number;
  unchangedSince: number;
  stableForMs: number;
  commitEligibleAt: number;
}

const FINGERPRINT_FILE_MAX_BYTES = 1024 * 1024;
const FINGERPRINT_TOTAL_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Opaque dirty-state activity fingerprint computed on the checkout owner.
 *
 * Normal-sized changed files are content-hashed, while deletes carry their path/status. Only the
 * final digest leaves the owner. Oversized/unreadable sets `complete:false`, which still permits
 * remote status/diff inspection but makes automated remote commit ineligible.
 */
export async function collaborationFingerprint(repoId: string): Promise<{
  fingerprint: string;
  complete: boolean;
}> {
  const repo = getRepo(repoId);
  if (!repo) throw new Error("unknown repository");
  const changes = (await readChanges(repo.absPath, true)).slice(0, 2_000);
  let remaining = FINGERPRINT_TOTAL_MAX_BYTES;
  let complete = changes.length < 2_000;
  const files: Array<{
    path: string;
    status: string;
    staged: boolean;
    size: number | null;
    mtimeMs: number | null;
    content: string | null;
  }> = [];
  for (const change of changes) {
    const absolute = resolve(repo.absPath, change.path);
    if (!pathWithin(repo.absPath, absolute)) {
      complete = false;
      continue;
    }
    try {
      const info = await stat(absolute);
      if (!info.isFile()) {
        files.push({
          path: change.path,
          status: change.status,
          staged: change.staged,
          size: info.size,
          mtimeMs: info.mtimeMs,
          content: null,
        });
        complete = false;
        continue;
      }
      let content: string | null = null;
      if (info.size <= FINGERPRINT_FILE_MAX_BYTES && info.size <= remaining) {
        const bytes = await readFile(absolute);
        remaining -= bytes.byteLength;
        content = createHash("sha256").update(bytes).digest("base64url");
      } else {
        complete = false;
      }
      files.push({
        path: change.path,
        status: change.status,
        staged: change.staged,
        size: info.size,
        mtimeMs: info.mtimeMs,
        content,
      });
    } catch {
      // A deleted file is expected not to exist. Its path/status still makes the digest stable.
      files.push({
        path: change.path,
        status: change.status,
        staged: change.staged,
        size: null,
        mtimeMs: null,
        content: null,
      });
      if (change.status !== "D") complete = false;
    }
  }
  return {
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ repoId, changes, files }))
      .digest("base64url"),
    complete,
  };
}

function collaborationStatus(status: RepoStatus | null): RepoStatus | null {
  if (!status) return null;
  return {
    branch: status.branch,
    detached: status.detached,
    dirty: status.dirty,
    ahead: status.ahead,
    behind: status.behind,
    remote: null,
    error: status.error ? "Repository status unavailable" : null,
    fetchedAt: null,
    diff: status.diff ?? null,
    conflicted: status.conflicted,
    gitOperation: status.gitOperation,
    updatedAt: status.updatedAt,
  };
}

function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function snapshotKey(token: string): Buffer {
  return createHash("sha256").update(`repoyeti-collaboration-key\0${token}`).digest();
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\0");
}

function relativePath(value: unknown): value is string {
  if (!boundedText(value, 2_048) || !value) return false;
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value)) return false;
  return !value.split(/[\\/]/).includes("..");
}

function validChanges(value: unknown): value is ChangedFile[] {
  if (!Array.isArray(value) || value.length > 2_000) return false;
  return value.every((file) => {
    if (!file || typeof file !== "object") return false;
    const f = file as Partial<ChangedFile>;
    if (
      !relativePath(f.path) ||
      typeof f.status !== "string" ||
      !/^[MADRUC]$/.test(f.status) ||
      typeof f.staged !== "boolean" ||
      (f.from !== undefined && !relativePath(f.from))
    ) {
      return false;
    }
    if (f.stat !== undefined) {
      const values = [
        f.stat.addedLines,
        f.stat.removedLines,
        f.stat.addedChars,
        f.stat.removedChars,
      ];
      if (!values.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000)) {
        return false;
      }
    }
    return true;
  });
}

function validStatus(value: unknown): value is RepoStatus | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<RepoStatus>;
  return (
    (s.branch === null || boundedText(s.branch, 500)) &&
    typeof s.detached === "boolean" &&
    Number.isSafeInteger(s.dirty) &&
    Number.isSafeInteger(s.ahead) &&
    Number.isSafeInteger(s.behind) &&
    (s.error === null || boundedText(s.error, 1_000)) &&
    Number.isSafeInteger(s.updatedAt)
  );
}

export function collaborationChannel(token: string): string {
  return createHash("sha256")
    .update(`repoyeti-collaboration-channel\0${token}`)
    .digest("base64url");
}

export function encryptSnapshot(token: string, snapshot: CollaborationSnapshot): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", snapshotKey(token), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(snapshot), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return b64url(Buffer.concat([iv, tag, ciphertext]));
}

export function decryptSnapshot(token: string, encoded: string): CollaborationSnapshot | null {
  try {
    const packed = fromB64url(encoded);
    if (packed.length < 29) return null;
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", snapshotKey(token), iv);
    decipher.setAuthTag(tag);
    const raw = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const value = JSON.parse(raw) as Partial<CollaborationSnapshot>;
    if (
      value.version !== SNAPSHOT_VERSION ||
      !/^[a-f0-9]{32}$/.test(value.participantId ?? "") ||
      !boundedText(value.label, 200) ||
      !boundedText(value.repoId, 200) ||
      !boundedText(value.localRepoName, 300) ||
      !validStatus(value.status) ||
      !validChanges(value.changes) ||
      !(value.diff === null || boundedText(value.diff, 20_000)) ||
      !Number.isSafeInteger(value.updatedAt)
    ) {
      return null;
    }
    return value as CollaborationSnapshot;
  } catch {
    return null;
  }
}

interface ParsedInvitation {
  token: string;
  directOrigin: string | null;
  relayOrigin: string | null;
  daemonId: string | null;
}

/** Accept direct `/s/<token>` links and relay `/r/<id>#/s/<token>` links only. */
export function parseCollaborationInvitation(raw: string): ParsedInvitation {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("the invitation must use HTTPS");
  }
  const direct = /^\/s\/([^/]+)\/?$/.exec(url.pathname);
  if (direct) {
    return {
      token: decodeURIComponent(direct[1]!),
      directOrigin: url.origin,
      relayOrigin: null,
      daemonId: null,
    };
  }
  const relay = /^\/r\/([A-Za-z0-9]{16,64})\/?$/.exec(url.pathname);
  const fragment = /^#\/s\/([^/]+)\/?$/.exec(url.hash);
  if (!relay || !fragment) throw new Error("not a RepoYeti share invitation");
  return {
    token: decodeURIComponent(fragment[1]!),
    directOrigin: null,
    relayOrigin: url.origin,
    daemonId: relay[1]!,
  };
}

async function resolveRemoteOrigin(parsed: ParsedInvitation): Promise<string> {
  if (parsed.directOrigin) return parsed.directOrigin;
  const response = await fetch(
    `${parsed.relayOrigin}/resolve/${encodeURIComponent(parsed.daemonId!)}`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!response.ok) throw new Error("the invitation's RepoYeti is not reachable");
  const body = (await response.json()) as { origin?: string };
  const origin = body.origin ? new URL(body.origin) : null;
  if (origin?.protocol !== "https:") throw new Error("the invitation resolved to an invalid address");
  return origin.origin;
}

function cookieFrom(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

function acceptedSummary(link: CollaborationLink): AcceptedCollaborationSummary {
  const local = getRepo(link.localRepoId);
  return {
    id: link.id,
    localRepoId: link.localRepoId,
    localRepoName: local?.displayName ?? local?.name ?? "Missing repository",
    remoteRepoId: link.remoteRepoId,
    enabled: link.enabled,
    createdAt: link.createdAt,
  };
}

export function listAcceptedCollaborations(): AcceptedCollaborationSummary[] {
  return listCollaborationLinks().map(acceptedSummary);
}

function resolveAcceptedCollaboration(idOrName: string): CollaborationLink {
  const needle = idOrName.trim();
  if (!needle) throw new Error("a collaboration id or mapped repository name is required");
  const links = listCollaborationLinks().filter((link) => link.enabled);
  const exact = links.find((link) => link.id === needle);
  if (exact) return exact;
  const matches = links.filter((link) => {
    const local = getRepo(link.localRepoId);
    return (
      link.localRepoId === needle ||
      link.remoteRepoId === needle ||
      local?.name === needle ||
      local?.displayName === needle
    );
  });
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`ambiguous collaboration "${needle}" — use the collaboration id`);
  }
  throw new Error(`no accepted collaboration matches "${needle}"`);
}

interface RemoteSession {
  origin: string;
  cookie: string;
}

async function redeemRemoteSessionAt(
  link: CollaborationLink,
  origin: string,
): Promise<RemoteSession> {
  const redeemed = await fetch(
    `${origin.replace(/\/+$/, "")}/s/${encodeURIComponent(link.token)}`,
    {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const cookie = cookieFrom(redeemed);
  if (redeemed.status < 300 || redeemed.status >= 400 || !cookie) {
    throw new Error("the collaboration invitation is invalid, expired, or revoked");
  }
  return { origin: origin.replace(/\/+$/, ""), cookie };
}

/**
 * Redeem the retained invitation into a short-lived guest session. If a hosted quick-tunnel link
 * moved, resolve it only after the stored origin fails, mirroring presence publishing.
 */
async function redeemAcceptedCollaboration(link: CollaborationLink): Promise<RemoteSession> {
  try {
    return await redeemRemoteSessionAt(link, link.remoteOrigin);
  } catch (firstError) {
    if (!link.relayUrl || !link.daemonId) throw firstError;
    const origin = await resolveRemoteOrigin({
      token: link.token,
      directOrigin: null,
      relayOrigin: link.relayUrl,
      daemonId: link.daemonId,
    });
    updateCollaborationOrigin(link.id, origin);
    link.remoteOrigin = origin;
    return redeemRemoteSessionAt(link, origin);
  }
}

async function remoteJson<T>(
  session: RemoteSession,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("cookie", session.cookie);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${session.origin}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  const envelope = body as { ok?: boolean; code?: string; message?: string };
  if (!response.ok || envelope.ok === false) {
    throw new Error(envelope.message || envelope.code || `remote RepoYeti returned HTTP ${response.status}`);
  }
  return body as T;
}

interface RemoteRepo {
  id: string;
  name: string;
  displayName?: string | null;
  vcs: string;
  status: RepoStatus | null;
}

interface Observation {
  signature: string;
  unchangedSince: number;
}

const remoteObservations = new Map<string, Observation>();

function observationSignature(
  repo: RemoteRepo,
  changes: ChangedFile[],
  remoteFingerprint: string,
): string {
  const s = repo.status;
  return createHash("sha256")
    .update(
      JSON.stringify({
        repo: repo.id,
        branch: s?.branch ?? null,
        detached: s?.detached ?? false,
        dirty: s?.dirty ?? 0,
        ahead: s?.ahead ?? 0,
        behind: s?.behind ?? 0,
        error: s?.error ?? null,
        conflicted: s?.conflicted ?? false,
        gitOperation: s?.gitOperation ?? null,
        changes,
        remoteFingerprint,
      }),
    )
    .digest("base64url");
}

/**
 * Read the sharer's current checkout through the accepted link's ordinary guest scope. The token
 * stays in this daemon; MCP receives only the remote repo projection and changed paths.
 *
 * `now` is injectable solely for deterministic tests. Production callers omit it.
 */
export async function readAcceptedCollaborationStatus(
  idOrName: string,
  now = Date.now(),
): Promise<AcceptedCollaborationStatus> {
  const link = resolveAcceptedCollaboration(idOrName);
  const session = await redeemAcceptedCollaboration(link);
  const [runtime, reposBody, changesBody] = await Promise.all([
    remoteJson<{
      share?: { label?: string; perm?: "view" | "control"; collaborative?: boolean };
    }>(session, "/api/status"),
    remoteJson<{ repos?: RemoteRepo[] }>(session, "/api/repos"),
    remoteJson<{ files?: ChangedFile[] }>(
      session,
      `/api/repos/${encodeURIComponent(link.remoteRepoId)}/changes`,
    ),
  ]);
  const share = runtime.share;
  if (!share) throw new Error("the remote endpoint did not return a share session");
  const repo = (reposBody.repos ?? []).find((candidate) => candidate.id === link.remoteRepoId);
  if (!repo) throw new Error("the mapped repository is no longer covered by this share");
  const changes = (changesBody.files ?? []).slice(0, 2_000);
  let fingerprint = "";
  let observationComplete = false;
  try {
    const remote = await remoteJson<{ fingerprint?: string; complete?: boolean }>(
      session,
      `/api/repos/${encodeURIComponent(link.remoteRepoId)}/collaboration-fingerprint`,
    );
    fingerprint = typeof remote.fingerprint === "string" ? remote.fingerprint : "";
    observationComplete = !!fingerprint && remote.complete === true;
  } catch {
    // Older peers do not have the fingerprint route. Their status is still readable, but this
    // installation will not perform unattended remote commits without a complete observation.
  }
  const signature = observationSignature(repo, changes, fingerprint);
  const previous = remoteObservations.get(link.id);
  const unchangedSince = previous?.signature === signature ? previous.unchangedSince : now;
  remoteObservations.set(link.id, { signature, unchangedSince });
  return {
    collaborationId: link.id,
    localRepoId: link.localRepoId,
    localRepoName: acceptedSummary(link).localRepoName,
    remoteRepo: {
      id: repo.id,
      name: repo.name,
      displayName: repo.displayName ?? null,
      vcs: repo.vcs,
      status: repo.status,
    },
    share: {
      label: share.label || "Shared workspace",
      perm: share.perm === "control" ? "control" : "view",
      collaborative: share.collaborative === true,
    },
    changes,
    observationComplete,
    observedAt: now,
    unchangedSince,
    stableForMs: Math.max(0, now - unchangedSince),
    commitEligibleAt: unchangedSince + REMOTE_COMMIT_IDLE_MS,
  };
}

export async function readAcceptedCollaborationDiff(
  idOrName: string,
  path: string,
): Promise<unknown> {
  if (!relativePath(path)) throw new Error("a safe repo-relative path is required");
  const link = resolveAcceptedCollaboration(idOrName);
  const session = await redeemAcceptedCollaboration(link);
  return remoteJson(
    session,
    `/api/repos/${encodeURIComponent(link.remoteRepoId)}/diff?path=${encodeURIComponent(path)}`,
  );
}

/**
 * Commit, fast-forward pull, and push the sharer's mapped checkout.
 *
 * Three independent rails must all pass: the share is still collaborative and control-tier; the
 * local MCP mutation is approved through the existing Safety Rail; and this daemon has observed
 * the exact same remote dirty state for at least ten minutes. There is no force/amend path.
 */
export async function commitAndSyncAcceptedCollaboration(
  idOrName: string,
  message: string,
  now = Date.now(),
): Promise<unknown> {
  const cleanMessage = message.trim();
  if (!cleanMessage) throw new Error("commit message required");
  const status = await readAcceptedCollaborationStatus(idOrName, now);
  if (!status.share.collaborative) {
    throw new Error("the sharer has disabled live collaboration for this link");
  }
  if (status.share.perm !== "control") {
    throw new Error("this collaboration is view-only; the sharer must grant commit access");
  }
  if (!status.changes.length || (status.remoteRepo.status?.dirty ?? 0) < 1) {
    throw new Error("the remote working tree has nothing to commit");
  }
  if (!status.observationComplete) {
    throw new Error("the remote dirty state could not be fingerprinted completely; commit it on the sharer's machine");
  }
  const remoteStatus = status.remoteRepo.status;
  if (
    !remoteStatus ||
    remoteStatus.error ||
    remoteStatus.detached ||
    remoteStatus.conflicted ||
    remoteStatus.gitOperation
  ) {
    throw new Error("the remote working tree is not safe to commit");
  }
  if (remoteStatus.behind > 0) {
    throw new Error("the remote branch is behind; ask the sharer to reconcile it before committing");
  }
  if (status.stableForMs < REMOTE_COMMIT_IDLE_MS) {
    const remaining = Math.ceil((REMOTE_COMMIT_IDLE_MS - status.stableForMs) / 60_000);
    throw new Error(
      `the remote changes have only been observed unchanged for ${Math.floor(status.stableForMs / 60_000)} minute(s); wait ${remaining} more minute(s)`,
    );
  }
  if (status.remoteRepo.vcs !== "lore" && !remoteStatus.remote) {
    throw new Error("the remote repository has no configured remote to sync");
  }

  const link = resolveAcceptedCollaboration(status.collaborationId);
  const session = await redeemAcceptedCollaboration(link);
  const repoPath = `/api/repos/${encodeURIComponent(link.remoteRepoId)}`;
  const commit = await remoteJson(session, `${repoPath}/commit`, {
    method: "POST",
    body: JSON.stringify({ message: cleanMessage, amend: false }),
  });
  let pull: unknown;
  try {
    pull = await remoteJson(session, `${repoPath}/pull`, {
      method: "POST",
      body: "{}",
    });
  } catch (e) {
    throw new Error(`remote commit succeeded, but sync pull failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  let push: unknown;
  try {
    push = await remoteJson(session, `${repoPath}/push`, {
      method: "POST",
      body: "{}",
    });
  } catch (e) {
    throw new Error(`remote commit and pull succeeded, but push failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  remoteObservations.delete(link.id);
  return {
    ok: true,
    collaborationId: link.id,
    localRepoId: link.localRepoId,
    remoteRepoId: link.remoteRepoId,
    commit,
    pull,
    push,
  };
}

/**
 * Redeem an invitation server-to-server and inspect only the guest projection. This never asks
 * for owner APIs, and the remote daemon's normal share scope still filters the repo list.
 */
export async function inspectCollaborationInvitation(raw: string): Promise<CollaborationInvite> {
  const parsed = parseCollaborationInvitation(raw);
  const remoteOrigin = await resolveRemoteOrigin(parsed);
  const redeemed = await fetch(`${remoteOrigin}/s/${encodeURIComponent(parsed.token)}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const cookie = cookieFrom(redeemed);
  if (redeemed.status < 300 || redeemed.status >= 400 || !cookie) {
    throw new Error("the share invitation is invalid, expired, or revoked");
  }
  const headers = { cookie };
  const [statusResponse, reposResponse] = await Promise.all([
    fetch(`${remoteOrigin}/api/status`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
    fetch(`${remoteOrigin}/api/repos`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  ]);
  if (!statusResponse.ok || !reposResponse.ok) throw new Error("the invitation could not be inspected");
  const status = (await statusResponse.json()) as {
    share?: {
      label?: string;
      perm?: "view" | "control";
      collaborative?: boolean;
    };
  };
  const reposBody = (await reposResponse.json()) as {
    repos?: Array<{ id?: string; name?: string; displayName?: string | null }>;
  };
  const share = status.share;
  if (!share) throw new Error("the remote endpoint did not return a share session");
  return {
    inviteUrl: raw,
    token: parsed.token,
    remoteOrigin,
    relayUrl: parsed.relayOrigin?.replace(/\/+$/, "") ?? "",
    daemonId: parsed.daemonId,
    channelId: collaborationChannel(parsed.token),
    share: {
      label: share.label || "Shared workspace",
      perm: share.perm === "control" ? "control" : "view",
      collaborative: share.collaborative === true,
    },
    repos: (reposBody.repos ?? [])
      .filter((r): r is { id: string; name: string; displayName?: string | null } =>
        typeof r.id === "string" && typeof r.name === "string",
      )
      .map((r) => ({ id: r.id, name: r.name, displayName: r.displayName ?? null })),
  };
}

export async function joinCollaboration(
  cfg: RepoYetiConfig,
  inviteUrl: string,
  localRepoId: string,
  remoteRepoId: string,
): Promise<CollaborationLink> {
  const local = getRepo(localRepoId);
  if (!local) throw new Error("unknown local repository");
  const invite = await inspectCollaborationInvitation(inviteUrl);
  if (!invite.share.collaborative) throw new Error("this share link does not allow live collaboration");
  if (!invite.repos.some((r) => r.id === remoteRepoId)) {
    throw new Error("the selected remote repository is not covered by this invitation");
  }
  const label = cfg.oauth?.ownerEmail?.trim() || cfg.oauth?.ownerSub?.trim();
  if (!label) throw new Error("sign in with Connections before joining a collaboration");
  const link = createCollaborationLink({
    inviteUrl,
    token: invite.token,
    relayUrl: invite.relayUrl,
    channelId: invite.channelId,
    remoteOrigin: invite.remoteOrigin,
    daemonId: invite.daemonId,
    participantId: randomUUID().replace(/-/g, ""),
    localRepoId,
    remoteRepoId,
    label,
  });
  // Persist the mapping even if the owner's daemon is between tunnel addresses right now. The
  // background publisher retries and, for a hosted invitation, re-resolves the destination.
  await publishCollaboration(link).catch(() => {});
  return link;
}

async function postSnapshot(
  link: CollaborationLink,
  origin: string,
  encoded: string,
): Promise<Response> {
  return fetch(
    `${origin.replace(/\/+$/, "")}/c/${link.channelId}/${link.participantId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${link.token}`,
      },
      body: JSON.stringify({ data: encoded }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
}

interface PublishState {
  signature: string;
  diff: string | null;
  lastSentAt: number;
}

const publishState = new Map<string, PublishState>();
const HEARTBEAT_MS = 10_000;

async function publishCollaboration(link: CollaborationLink): Promise<void> {
  const repo = getRepo(link.localRepoId);
  if (!repo || !link.enabled) return;
  // Paths + totals provide the overview. A bounded patch makes "see their edits" literal for
  // tracked files; both forms travel only inside the encrypted snapshot.
  const changes = (await readChanges(repo.absPath, true)).slice(0, 2000);
  const signature = createHash("sha256").update(JSON.stringify(changes)).digest("base64url");
  const previous = publishState.get(link.id);
  if (previous?.signature === signature && Date.now() - previous.lastSentAt < HEARTBEAT_MS) {
    return;
  }
  const diff =
    previous?.signature === signature
      ? previous.diff
      : changes.length
        ? await collectPathsDiff(
            repo.absPath,
            changes.map((change) => change.path),
            "lean",
          )
        : null;
  const snapshot: CollaborationSnapshot = {
    version: SNAPSHOT_VERSION,
    participantId: link.participantId,
    label: link.label,
    repoId: link.remoteRepoId,
    localRepoName: repo.displayName ?? repo.name,
    status: collaborationStatus(repo.status),
    changes,
    diff,
    updatedAt: Date.now(),
  };
  const encoded = encryptSnapshot(link.token, snapshot);
  let response: Response | null = null;
  try {
    response = await postSnapshot(link, link.remoteOrigin, encoded);
  } catch {
    // A rotated quick-tunnel hostname normally fails at DNS/connect time rather than returning an
    // HTTP status. Treat both forms alike and resolve the stable invitation below.
  }
  // A hosted invitation can survive the owner's quick-tunnel rotation. Avoid hitting the relay
  // on the healthy hot path; resolve only after the saved destination actually fails.
  if (!response?.ok && link.relayUrl && link.daemonId) {
    const nextOrigin = await resolveRemoteOrigin({
      token: link.token,
      directOrigin: null,
      relayOrigin: link.relayUrl,
      daemonId: link.daemonId,
    });
    updateCollaborationOrigin(link.id, nextOrigin);
    link.remoteOrigin = nextOrigin;
    response = await postSnapshot(link, nextOrigin, encoded);
  }
  if (!response?.ok) {
    throw new Error(
      `collaboration endpoint returned ${response?.status ?? "no response"}`,
    );
  }
  publishState.set(link.id, { signature, diff, lastSentAt: Date.now() });
}

export async function publishAllCollaborations(): Promise<void> {
  const links = listCollaborationLinks();
  const liveIds = new Set(links.map((link) => link.id));
  for (const id of publishState.keys()) {
    if (!liveIds.has(id)) publishState.delete(id);
  }
  await Promise.all(links.map((link) => publishCollaboration(link).catch(() => {})));
}

interface Presence {
  shareId: string;
  tokenHash: string;
  snapshot: CollaborationSnapshot;
  receivedAt: number;
}

const presence = new Map<string, Presence>();

function prunePresence(now = Date.now()): void {
  for (const [key, entry] of presence) {
    if (now - entry.receivedAt > SNAPSHOT_FRESH_MS) presence.delete(key);
  }
}

/**
 * Receive a peer snapshot directly on the owner's daemon. The public route supplies the share
 * token, but the snapshot is still authenticated ciphertext so intermediaries and malformed
 * clients cannot manufacture visible state.
 */
export function receiveCollaborationSnapshot(
  token: string,
  channelId: string,
  participantId: string,
  encoded: string,
): boolean {
  if (
    collaborationChannel(token) !== channelId ||
    !/^[a-f0-9]{32}$/.test(participantId) ||
    encoded.length > SNAPSHOT_MAX_BYTES
  ) {
    return false;
  }
  const tokenHash = hashToken(token);
  const share = getShareByTokenHash(tokenHash);
  if (!share?.collaborative || !shareIsLive(share)) return false;
  const snapshot = decryptSnapshot(token, encoded);
  if (
    !snapshot ||
    snapshot.participantId !== participantId ||
    !shareCoversRepo(share, snapshot.repoId) ||
    Math.abs(Date.now() - snapshot.updatedAt) > SNAPSHOT_FRESH_MS
  ) {
    return false;
  }
  prunePresence();
  const shareEntries = [...presence.entries()]
    .filter(([, entry]) => entry.shareId === share.id)
    .sort((a, b) => a[1].receivedAt - b[1].receivedAt);
  while (shareEntries.length >= MAX_PEERS) {
    presence.delete(shareEntries.shift()![0]);
  }
  presence.set(`${share.id}:${participantId}`, {
    shareId: share.id,
    tokenHash,
    snapshot,
    receivedAt: Date.now(),
  });
  return true;
}

export function readCollaborationSnapshots(): CollaborationSnapshot[] {
  prunePresence();
  const liveShares = new Map(
    listShares()
      .filter((share) => share.collaborative && !!share.token && shareIsLive(share))
      .map((share) => [share.id, share]),
  );
  const out: CollaborationSnapshot[] = [];
  for (const entry of presence.values()) {
    const share = liveShares.get(entry.shareId);
    if (
      !share?.token ||
      hashToken(share.token) !== entry.tokenHash ||
      !shareCoversRepo(share, entry.snapshot.repoId)
    ) {
      continue;
    }
    out.push(entry.snapshot);
  }
  return out;
}

export { listCollaborationLinks, deleteCollaborationLink };

let timer: ReturnType<typeof setInterval> | null = null;

export function startCollaborationSync(): void {
  if (timer) return;
  void publishAllCollaborations();
  timer = setInterval(() => void publishAllCollaborations(), PUBLISH_INTERVAL_MS);
  timer.unref?.();
}

export function stopCollaborationSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
