/**
 * `repoyeti token [new|revoke|show]` — manage the OPTIONAL API Bearer token by driving the
 * ALREADY-RUNNING local daemon over its HTTP API (src/cli/client.ts). Like the other CLI verbs it
 * never imports the in-process service/read layers (check-boundaries.ts enforces this).
 *
 * The token is a separate, LOCAL credential (never touches connections.icu) that lets a
 * remote/headless agent authenticate over the tunnel via `Authorization: Bearer <token>`.
 *
 *   new      mint (or overwrite) the token and print it — the ONLY time the value is shown
 *   revoke   delete the token (back to OIDC-only)
 *   show     (default) report whether a token is configured (never the value)
 */
import { get, post, del, ApiError } from "./client.ts";
import { bold, dim, green, red } from "./format.ts";

export async function runTokenVerb(sub: string): Promise<void> {
  try {
    if (sub === "new") {
      const { token } = await post<{ ok: boolean; token: string }>("/api/auth/token");
      console.log(`${green("✓")} API token minted (shown once — store it now):\n`);
      console.log(`  ${bold(token)}\n`);
      console.log(
        dim(
          `  set REPOYETI_TOKEN=${token} for remote CLI/MCP, or send Authorization: Bearer ${token}`,
        ),
      );
      return;
    }
    if (sub === "revoke") {
      await del<{ ok: boolean }>("/api/auth/token");
      console.log(`${green("✓")} API token revoked (Bearer auth disabled; OIDC-only).`);
      return;
    }
    // show / no sub
    const { configured } = await get<{ ok: boolean; configured: boolean }>("/api/auth/token");
    console.log(
      configured
        ? `${green("✓")} API token: ${bold("configured")}`
        : `${dim("•")} API token: ${dim("not configured")}`,
    );
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(red(`✗ ${e.code}: ${e.message}`));
    } else {
      console.error(red(`✗ ${e instanceof Error ? e.message : String(e)}`));
    }
    process.exitCode = 1;
  }
}
