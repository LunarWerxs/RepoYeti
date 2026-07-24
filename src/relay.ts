/**
 * Relay client — publishes "here is my current address" to a RepoYeti relay (see relay/worker.js).
 *
 * WHY: a zero-config quick tunnel re-hosts itself on every start, so any share link already sent
 * stops resolving. The relay gives this daemon one permanent URL that forwards to wherever it
 * currently lives; this module is the half that keeps that mapping honest.
 *
 * IDENTITY: an Ed25519 keypair generated once and kept with the daemon's other secrets. The public
 * half registers on first announce; every later announce is signed, so only this machine can move
 * its own address. That signature is the whole security story — without it, anyone could repoint
 * someone else's link at their own server, turning a convenience into a phishing kit.
 *
 * DEFAULT ADDRESS. app.repoyeti.com is the zero-input stable-address choice; selecting the
 * generated Cloudflare address disables this relay hop, and a named/custom tunnel does not need it.
 * The only thing announced is (id, origin, timestamp, signature) — never a repo name, share token,
 * or path. The share token rides in the URL FRAGMENT, which browsers do not transmit, so the relay
 * cannot see it in principle.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";

/** Public shape of this daemon's relay identity. The private key never leaves this module. */
export interface RelayIdentity {
  /** Stable, random, 32 hex chars. Appears in every share URL, so it is an identifier, not a secret. */
  id: string;
  /** base64url raw Ed25519 public key — what the relay pins on first announce. */
  publicKey: string;
  /** base64url PKCS8 private key. Persisted with the daemon's secrets; never transmitted. */
  privateKey: string;
}

const b64url = (b: Buffer): string => b.toString("base64url");

/** Mint a fresh relay identity. Called once, the first time the owner turns the relay on. */
export function createRelayIdentity(): RelayIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    id: randomBytes(16).toString("hex"),
    // "raw" is what WebCrypto's importKey wants on the Worker side; Node calls that format "jwk"'s
    // x coordinate, reachable via the SPKI export's trailing 32 bytes.
    publicKey: b64url(publicKey.export({ format: "der", type: "spki" }).subarray(-32)),
    privateKey: b64url(privateKey.export({ format: "der", type: "pkcs8" })),
  };
}

/** Re-derive the raw public key from a stored private key — used to check a persisted pair agrees. */
export function publicKeyFor(privateKeyB64: string): string {
  const priv = createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  // Node derives a public KeyObject from a private one at runtime, but @types/node's overloads
  // for createPublicKey don't admit a KeyObject argument, so this narrows through the documented
  // behaviour rather than reimplementing Ed25519 point derivation by hand.
  const spki = createPublicKey(priv as unknown as Parameters<typeof createPublicKey>[0]).export({
    format: "der",
    type: "spki",
  }) as Buffer;
  return b64url(spki.subarray(-32));
}

/**
 * The exact bytes both sides sign over. Field order is fixed here AND in relay/worker.js — a
 * mismatch fails verification, which is the safe direction to fail in.
 */
export function announcePayload(id: string, origin: string, ts: number): Buffer {
  return Buffer.from(`${id}\n${origin}\n${ts}`, "utf8");
}

export function signAnnounce(identity: RelayIdentity, origin: string, ts: number): string {
  const key = createPrivateKey({
    key: Buffer.from(identity.privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  return b64url(sign(null, announcePayload(identity.id, origin, ts), key));
}

export interface AnnounceResult {
  ok: boolean;
  /** The permanent URL this daemon is reachable at, when the relay accepted us. */
  url?: string;
  error?: string;
}

/**
 * Tell the relay where we are now. Best-effort by design: the relay being down must never affect
 * local git management, so every failure is reported and swallowed by the caller.
 */
export async function announce(
  relayUrl: string,
  identity: RelayIdentity,
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AnnounceResult> {
  const base = relayUrl.trim().replace(/\/+$/, "");
  if (!base) return { ok: false, error: "no relay configured" };
  // Refuse to publish anything that isn't a real https origin — the relay enforces this too, but
  // sending a path or a localhost URL is a bug worth catching here rather than round-tripping.
  let clean: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:") return { ok: false, error: "origin must be https" };
    clean = u.origin;
  } catch {
    return { ok: false, error: "origin is not a URL" };
  }

  const ts = Date.now();
  try {
    const res = await fetchImpl(`${base}/announce`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": signAnnounce(identity, clean, ts),
      },
      body: JSON.stringify({
        id: identity.id,
        origin: clean,
        ts,
        // Sent every time; the relay pins the FIRST one and ignores it afterwards, so this can
        // never be used to take over an id that already exists.
        publicKey: identity.publicKey,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
    if (!res.ok || !body.ok) return { ok: false, error: body.error ?? `relay returned ${res.status}` };
    return { ok: true, url: body.url ?? `${base}/r/${identity.id}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The share URL to hand out for a token, given a relay identity.
 *
 * The token sits after '#' ON PURPOSE: a URL fragment is never sent to a server, so the relay
 * forwards the visitor without ever being able to see — or redeem — the link it is forwarding.
 */
export function relayShareUrl(relayUrl: string, id: string, token: string): string {
  const base = relayUrl.trim().replace(/\/+$/, "");
  return `${base}/r/${id}#/s/${token}`;
}
