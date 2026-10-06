/**
 * The Cloudflare API token behind Artifacts remotes (see src/artifacts.ts).
 *
 * Owner-plane like everything that stores a credential (share/policy.ts lists both routes): a
 * guest who could set this would decide which Cloudflare account the owner's pushes authenticate
 * against. The token is write-only. GET and PUT report only whether one is saved, and the bytes go
 * straight to the OS keychain with no config.json copy, so a host with no secret service gets a
 * clear refusal instead of a plaintext credential on disk.
 */
import type { Hono } from "hono";
import { jsonError } from "../../contract.ts";
import { setSecret, deleteSecret, CLOUDFLARE_API_TOKEN } from "../../secrets.ts";
import { artifactsTokenSaved, forgetArtifactsCredentials } from "../../artifacts.ts";
import { parseBody, ArtifactsSettingsSchema } from "../../schemas.ts";

export function register(app: Hono): void {
  app.get("/api/artifacts", async (c) => c.json({ ok: true, configured: await artifactsTokenSaved() }));

  app.put("/api/artifacts", async (c) => {
    const p = await parseBody(c, ArtifactsSettingsSchema);
    if (!p.ok) return p.res;
    const token = p.data.token;
    const stored = token ? await setSecret(CLOUDFLARE_API_TOKEN, token) : await deleteSecret(CLOUDFLARE_API_TOKEN);
    // Forget the memo and every repo token minted from the old value even when the store refused:
    // a clear must stop new pushes now, and a failed save must not keep serving the previous token.
    forgetArtifactsCredentials();
    if (!stored) {
      return jsonError(
        c,
        "ERROR",
        token
          ? "the OS keychain refused the token, so it was not saved"
          : "the OS keychain refused to delete the token; it may still be stored",
        500,
      );
    }
    return c.json({ ok: true, configured: await artifactsTokenSaved() });
  });
}
