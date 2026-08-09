import { describe, expect, it } from "vitest";
import { computeSignature, verifyWebhookSignature } from "./hmac.js";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ event: "verification.completed", data: { verified: true } });
const NOW = 1_754_000_000;

function header(ts: number, body = BODY, secret = SECRET): string {
  return `t=${ts},v1=${computeSignature(String(ts), body, secret)}`;
}

describe("verifyWebhookSignature", () => {
  it("accepts a signature produced the way the Go worker produces it", () => {
    expect(verifyWebhookSignature(BODY, header(NOW), SECRET, { nowSeconds: NOW }))
      .toEqual({ valid: true });
  });

  it("rejects a tampered body", () => {
    const h = header(NOW);
    const tampered = JSON.stringify({ event: "verification.completed", data: { verified: false } });
    expect(verifyWebhookSignature(tampered, h, SECRET, { nowSeconds: NOW }))
      .toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejects the wrong secret", () => {
    expect(verifyWebhookSignature(BODY, header(NOW), "whsec_other", { nowSeconds: NOW }))
      .toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejects a replayed signature outside the tolerance window", () => {
    expect(verifyWebhookSignature(BODY, header(NOW - 3600), SECRET, { nowSeconds: NOW }))
      .toEqual({ valid: false, reason: "timestamp_too_old" });
  });

  it("rejects a timestamp far in the future", () => {
    expect(verifyWebhookSignature(BODY, header(NOW + 3600), SECRET, { nowSeconds: NOW }))
      .toEqual({ valid: false, reason: "timestamp_in_future" });
  });

  it.each([
    ["empty", ""],
    ["missing v1", "t=1754000000"],
    ["missing t", "v1=abcdef"],
    ["non-numeric t", "t=nope,v1=abcdef"],
    ["non-hex v1", "t=1754000000,v1=zzzz"],
    ["bare token", "abcdef"],
  ])("returns malformed_header for a %s header rather than throwing", (_name, h) => {
    expect(verifyWebhookSignature(BODY, h, SECRET, { nowSeconds: NOW }))
      .toEqual({ valid: false, reason: "malformed_header" });
  });

  it("tolerates uppercase hex, which some proxies produce", () => {
    const ts = String(NOW);
    const h = `t=${ts},v1=${computeSignature(ts, BODY, SECRET).toUpperCase()}`;
    expect(verifyWebhookSignature(BODY, h, SECRET, { nowSeconds: NOW }).valid).toBe(true);
  });

  it("is sensitive to re-serialization, the most common integration mistake", () => {
    const h = header(NOW);
    // Same data, different key order — different bytes, so a different signature.
    const reserialized = JSON.stringify({ data: { verified: true }, event: "verification.completed" });
    expect(verifyWebhookSignature(reserialized, h, SECRET, { nowSeconds: NOW }).valid).toBe(false);
  });
});
