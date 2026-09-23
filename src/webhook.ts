import { createHmac, timingSafeEqual } from "node:crypto";
import { CleatSignatureError } from "./errors.js";
import type { WebhookEvent } from "./types.js";

/**
 * Verifying a Cleat webhook.
 *
 * The header looks like `cleat-signature: t=1789120961,v1=5d41...`, where `v1` is the
 * lowercase hex HMAC-SHA256 of `"<t>.<raw body>"`, keyed with the endpoint's signing
 * secret (it starts with `whsec_`).
 *
 * Two things matter and are easy to get wrong:
 *  - Verify the RAW bytes, exactly as they arrived. Parsing and re-serialising the JSON
 *    changes them, and the digest will not match.
 *  - Reject an old timestamp, or a captured delivery can be replayed at you forever.
 *
 * This module uses `node:crypto`, so it runs on Node, Bun, Deno and any worker runtime
 * with Node compatibility. On a runtime that has WebCrypto only, the same check is a
 * dozen lines of `crypto.subtle` — the `cleat-webhooks` examples repo has that version.
 */

/** The parsed pieces of a `cleat-signature` header. */
export interface ParsedSignature {
  /** Unix seconds, as the sender wrote them. */
  timestamp: number;
  /** The hex digest. */
  v1: string;
}

/** Options for {@link verifyWebhook}. */
export interface VerifyWebhookOptions {
  /**
   * How far from now `t` may be, in seconds, in either direction. Default 300.
   * Pass `Infinity` to skip the check, which you only want when replaying a stored
   * delivery on purpose.
   */
  toleranceSeconds?: number;
  /** Unix seconds to compare against, for tests. Defaults to now. */
  now?: number;
}

/**
 * Pull `t` and `v1` out of a `cleat-signature` header.
 * @throws {CleatSignatureError} `malformed_header` if either is missing or unusable.
 */
export function parseSignatureHeader(header: string | null | undefined): ParsedSignature {
  if (typeof header !== "string" || header.length === 0) {
    throw new CleatSignatureError("malformed_header", "No cleat-signature header on the request.");
  }

  const parts = new Map<string, string>();
  for (const piece of header.split(",")) {
    const at = piece.indexOf("=");
    if (at === -1) continue;
    parts.set(piece.slice(0, at).trim(), piece.slice(at + 1).trim());
  }

  const rawTimestamp = parts.get("t");
  const v1 = parts.get("v1");
  if (!rawTimestamp || !v1) {
    throw new CleatSignatureError("malformed_header", "cleat-signature is missing t or v1.");
  }
  if (!/^\d+$/.test(rawTimestamp)) {
    throw new CleatSignatureError("malformed_header", "cleat-signature t is not unix seconds.");
  }
  if (!/^[0-9a-f]+$/i.test(v1)) {
    throw new CleatSignatureError("malformed_header", "cleat-signature v1 is not hex.");
  }

  return { timestamp: Number(rawTimestamp), v1: v1.toLowerCase() };
}

/** A hex comparison that takes the same time whether or not the strings match. */
function hexEquals(a: string, b: string): boolean {
  // timingSafeEqual throws on a length mismatch, and a length mismatch is not a secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Check a webhook delivery and return the event it carries.
 *
 * @param secret The endpoint's signing secret from workspace settings, starting `whsec_`.
 * @param rawBody The request body exactly as it arrived. Pass the bytes if you have them.
 * @param header The `cleat-signature` request header.
 * @throws {CleatSignatureError} for anything that means "do not trust this". Answer 401.
 *
 * @example
 * ```ts
 * const event = verifyWebhook(process.env.CLEAT_WEBHOOK_SECRET!, rawBody, req.headers["cleat-signature"]);
 * if (event.type === "message.received") console.log(event.data.code ?? event.data.body);
 * ```
 */
export function verifyWebhook(
  secret: string,
  rawBody: Uint8Array | string,
  header: string | null | undefined,
  options: VerifyWebhookOptions = {},
): WebhookEvent {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new CleatSignatureError("malformed_header", "No signing secret was given to verifyWebhook.");
  }

  const { timestamp, v1 } = parseSignatureHeader(header);
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Number.isFinite(tolerance) && Math.abs(now - timestamp) > tolerance) {
    throw new CleatSignatureError(
      "stale_timestamp",
      `cleat-signature t is ${Math.abs(now - timestamp)}s away from now, outside the ${tolerance}s tolerance.`,
    );
  }

  // The signed string is the timestamp, a dot, then the body bytes untouched.
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");

  if (!hexEquals(v1, expected)) {
    throw new CleatSignatureError("signature_mismatch", "cleat-signature does not match the body.");
  }

  let event: unknown;
  try {
    event = JSON.parse(body.toString("utf8"));
  } catch {
    throw new CleatSignatureError("malformed_body", "The signed body is not JSON.");
  }
  if (typeof event !== "object" || event === null || typeof (event as WebhookEvent).type !== "string") {
    throw new CleatSignatureError("malformed_body", "The signed body is not a Cleat webhook envelope.");
  }

  return event as WebhookEvent;
}

/**
 * Build a `cleat-signature` header for a body. Cleat does the signing in production;
 * this exists so your own tests can produce a delivery that verifies.
 */
export function signWebhook(
  secret: string,
  rawBody: Uint8Array | string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const v1 = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}
