import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Result of verifying a Xident webhook signature.
 * Always a value — never throws — so an agent can report the reason verbatim.
 */
export interface SignatureCheck {
  valid: boolean;
  reason?:
    | "malformed_header"
    | "signature_mismatch"
    | "timestamp_too_old"
    | "timestamp_in_future";
}

/** Default replay window, matching common webhook practice. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Build the string Xident actually signs: `<unix-timestamp>.<raw-body>`.
 * Mirrors api/internal/worker/webhook_deliver.go — the raw body, not a
 * re-serialized object. Re-serializing is the single most common cause of a
 * failing signature check, because key order and whitespace change the bytes.
 */
export function signedPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** Compute the hex HMAC-SHA256 Xident sends in the `v1=` field. */
export function computeSignature(
  timestamp: string,
  rawBody: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(signedPayload(timestamp, rawBody))
    .digest("hex");
}

/** Parse `t=<unix>,v1=<hex>`. Returns null when the header is not that shape. */
function parseHeader(header: string): { t: string; v1: string } | null {
  const parts = header.split(",");
  let t: string | undefined;
  let v1: string | undefined;
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") t = value;
    else if (key === "v1") v1 = value;
  }
  if (!t || !v1) return null;
  if (!/^\d+$/.test(t)) return null;
  if (!/^[0-9a-f]+$/i.test(v1)) return null;
  return { t, v1 };
}

/**
 * Verify an `X-Xident-Signature` header against the raw request body.
 *
 * @param rawBody  The body EXACTLY as received. Do not JSON.parse then re-stringify.
 * @param header   The `X-Xident-Signature` header value.
 * @param secret   The webhook signing secret.
 * @param nowSeconds Injectable clock, for tests.
 */
export function verifyWebhookSignature(
  rawBody: string,
  header: string,
  secret: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): SignatureCheck {
  const parsed = parseHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const age = now - Number(parsed.t);
  if (age > tolerance) return { valid: false, reason: "timestamp_too_old" };
  if (age < -tolerance) return { valid: false, reason: "timestamp_in_future" };

  const expected = computeSignature(parsed.t, rawBody, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(parsed.v1.toLowerCase(), "utf8");
  // timingSafeEqual throws on length mismatch, which is itself a mismatch.
  if (a.length !== b.length) return { valid: false, reason: "signature_mismatch" };
  if (!timingSafeEqual(a, b)) return { valid: false, reason: "signature_mismatch" };

  return { valid: true };
}
