import type { Context, Hono } from "hono";
import type { Deps } from "../deps.ts";
import { saveConfig, type BuzzCommunity } from "../../config.ts";
import {
  buzzGitUrlMatchesCommunity,
  buzzConfigView,
  normalizeBuzzGitUrl,
  normalizeBuzzPublicUrl,
  preflightBuzz,
} from "../../buzz.ts";
import {
  BuzzCommunitySchema,
  BuzzPreflightSchema,
  BuzzSettingsSchema,
  parseBody,
} from "../../schemas.ts";
import { jsonError } from "../../contract.ts";

const MAX_BUZZ_COMMUNITIES = 100;

function replaceBuzzConfig(
  cfg: Deps["cfg"],
  patch: { enabled?: boolean; communities?: BuzzCommunity[] },
): void {
  const current = buzzConfigView(cfg);
  cfg.buzz = {
    enabled: patch.enabled ?? current.enabled,
    communities: patch.communities ?? current.communities,
  };
  saveConfig(cfg);
}

function getBuzz(c: Context, cfg: Deps["cfg"]) {
  return c.json({ config: buzzConfigView(cfg) });
}

async function putBuzz(c: Context, cfg: Deps["cfg"]) {
  const parsed = await parseBody(c, BuzzSettingsSchema);
  if (!parsed.ok) return parsed.res;
  replaceBuzzConfig(cfg, { enabled: parsed.data.enabled });
  return c.json({ ok: true, config: buzzConfigView(cfg) });
}

async function postBuzzCommunity(c: Context, cfg: Deps["cfg"]) {
  const parsed = await parseBody(c, BuzzCommunitySchema);
  if (!parsed.ok) return parsed.res;
  const url = normalizeBuzzPublicUrl(parsed.data.url);
  if (!url) {
    return jsonError(
      c,
      "BAD_REQUEST",
      "expected a public http(s) or ws(s) Buzz community URL without embedded credentials",
    );
  }
  const gitUrl = parsed.data.gitUrl ? normalizeBuzzGitUrl(parsed.data.gitUrl) : undefined;
  if (parsed.data.gitUrl && !gitUrl) {
    return jsonError(
      c,
      "BAD_REQUEST",
      "expected a Buzz Git URL like https://relay.example.com/git/owner/repo.git",
    );
  }
  if (gitUrl && !buzzGitUrlMatchesCommunity(url, gitUrl)) {
    return jsonError(c, "BAD_REQUEST", "Buzz Git URL must use the saved community origin");
  }
  const current = buzzConfigView(cfg);
  if (current.communities.length >= MAX_BUZZ_COMMUNITIES) {
    return jsonError(c, "BAD_REQUEST", `at most ${MAX_BUZZ_COMMUNITIES} Buzz communities may be saved`);
  }
  const community: BuzzCommunity = {
    id: crypto.randomUUID(),
    name: parsed.data.name?.trim() || new URL(url).host,
    url,
    ...(gitUrl ? { gitUrl } : {}),
  };
  replaceBuzzConfig(cfg, { communities: [...current.communities, community] });
  return c.json({ ok: true, community, config: buzzConfigView(cfg) }, 201);
}

function deleteBuzzCommunity(c: Context, cfg: Deps["cfg"]) {
  const id = c.req.param("id");
  const current = buzzConfigView(cfg);
  if (!current.communities.some((community) => community.id === id)) {
    return jsonError(c, "NOT_FOUND", "Buzz community not found");
  }
  replaceBuzzConfig(cfg, {
    communities: current.communities.filter((community) => community.id !== id),
  });
  return c.json({ ok: true, config: buzzConfigView(cfg) });
}

async function postBuzzPreflight(c: Context, cfg: Deps["cfg"]) {
  const parsed = await parseBody(c, BuzzPreflightSchema);
  if (!parsed.ok) return parsed.res;
  const current = buzzConfigView(cfg);
  if (!current.enabled) {
    return jsonError(c, "BAD_REQUEST", "enable Buzz support before running preflight checks");
  }
  const community = parsed.data.communityId
    ? current.communities.find((candidate) => candidate.id === parsed.data.communityId)
    : current.communities[0];
  if (parsed.data.communityId && !community) {
    return jsonError(c, "NOT_FOUND", "Buzz community not found");
  }
  return c.json(await preflightBuzz(community));
}

export function register(app: Hono, { cfg }: Deps): void {
  // All routes are owner-only through the normal /api/* auth gate and share allowlist. Responses
  // are built by buzzConfigView(), so even a manually polluted legacy config cannot expose a key.
  app.get("/api/buzz", (c) => getBuzz(c, cfg));
  app.put("/api/buzz", (c) => putBuzz(c, cfg));
  app.post("/api/buzz/communities", (c) => postBuzzCommunity(c, cfg));
  app.delete("/api/buzz/communities/:id", (c) => deleteBuzzCommunity(c, cfg));
  app.post("/api/buzz/preflight", (c) => postBuzzPreflight(c, cfg));
}
