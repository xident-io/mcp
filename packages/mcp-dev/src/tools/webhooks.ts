import { z } from "zod";
import { computeSignature, verifyWebhookSignature } from "@xident/mcp-shared";
import { fail, ok, requireClient, type ToolDef } from "./types.js";

/**
 * Verify a signature locally. No key, no network — which matters, because this
 * is the tool a developer reaches for when their handler is rejecting real
 * traffic and they need an answer immediately.
 */
export const verifySignatureTool: ToolDef = {
  name: "xident_verify_webhook_signature",
  title: "Verify a Xident webhook signature",
  description:
    "Check an X-Xident-Signature header against a raw webhook body, entirely locally. " +
    "Use this to debug a webhook handler that rejects genuine deliveries. " +
    "Pass the body EXACTLY as received — re-serialized JSON produces different bytes and will not verify.",
  inputSchema: {
    raw_body: z.string().describe("The raw request body, byte-for-byte as received"),
    signature_header: z.string().describe("The X-Xident-Signature header value, e.g. t=1754000000,v1=abc..."),
    secret: z.string().describe("The webhook signing secret"),
    tolerance_seconds: z.number().int().min(0).optional().describe("Replay window (default 300)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiresKey: false,
  handler: async (args) => {
    const rawBody = String(args["raw_body"] ?? "");
    const header = String(args["signature_header"] ?? "");
    const secret = String(args["secret"] ?? "");
    const tolerance = typeof args["tolerance_seconds"] === "number" ? args["tolerance_seconds"] : undefined;
    const result = verifyWebhookSignature(rawBody, header, secret, tolerance !== undefined ? { toleranceSeconds: tolerance } : {});

    const hints: Record<string, string> = {
      malformed_header: "The header is not in `t=<unix>,v1=<hex>` form. Read the raw header value, not a parsed object.",
      signature_mismatch: "Bytes differ. The usual cause is re-serializing the JSON body before verifying; capture the raw body in your framework instead.",
      timestamp_too_old: "Outside the replay window. If this is a genuine retry, widen the tolerance; otherwise treat it as a replay.",
      timestamp_in_future: "The signature timestamp is ahead of local time. Check clock skew on this machine.",
    };

    return ok({
      valid: result.valid,
      reason: result.reason ?? null,
      hint: result.reason ? hints[result.reason] ?? null : null,
      signed_payload_format: "<timestamp>.<raw_body>",
      algorithm: "HMAC-SHA256, hex",
    });
  },
};

/**
 * Send a correctly-signed sample event at a local endpoint. Needs a key only so
 * the server can refuse to aim at anything but a developer's own machine.
 */
export const simulateWebhookTool: ToolDef = {
  name: "xident_simulate_webhook",
  title: "Send a signed test webhook",
  description:
    "POST a correctly-signed sample Xident webhook to a local URL, so a handler can be tested " +
    "without running a full verification. Localhost targets only.",
  inputSchema: {
    url: z.string().url().describe("Target URL — must be localhost or 127.0.0.1"),
    secret: z.string().describe("The webhook signing secret your handler expects"),
    event: z.enum(["verification.completed", "verification.failed", "verification.expired"])
      .describe("Which lifecycle event to simulate"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  requiresKey: true,
  handler: async (args, ctx) => {
    const guard = requireClient(ctx);
    if (guard) return guard;

    const url = String(args["url"] ?? "");
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return fail("INVALID_URL", `Not a valid URL: ${url}`, "Pass an absolute http URL such as http://localhost:3000/webhooks/xident.");
    }
    // Local targets only. This tool exists to test a developer's own handler;
    // letting it aim anywhere would make it a request-forgery primitive.
    if (!["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) {
      return fail(
        "NON_LOCAL_TARGET",
        `Refusing to send a simulated webhook to ${host}.`,
        "This tool only targets localhost. To test a deployed endpoint, run a real sandbox verification instead.",
      );
    }

    const secret = String(args["secret"] ?? "");
    const event = String(args["event"] ?? "verification.completed");
    const verified = event === "verification.completed";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      data: {
        token: "xtk_simulated0001",
        status: verified ? "success" : "failed",
        verified,
        verification_mode: "full",
        ...(verified ? {} : { reason: "liveness_failed" }),
      },
    });
    const signature = `t=${timestamp},v1=${computeSignature(timestamp, body, secret)}`;

    const doFetch = ctx.fetchImpl ?? fetch;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Xident-Signature": signature },
        body,
      });
      return ok({
        sent: true, url, event,
        response_status: res.status,
        handler_accepted: res.ok,
        signature_header: signature,
        note: res.ok ? null : "Your handler rejected the delivery. Use xident_verify_webhook_signature with this exact body and header to find out why.",
      });
    } catch (err) {
      return fail(
        "DELIVERY_FAILED",
        err instanceof Error ? err.message : String(err),
        "Is the local server running and listening on that path?",
      );
    }
  },
};
