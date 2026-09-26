import { describe, expect, it, vi } from "vitest";
import { contextFromEnv, type DevContext } from "../context.js";
import { getEndpointTool, searchDocsTool } from "./docs.js";
import {
  checkIntegrationTool, explainSessionTool, getResultTool,
  startTestVerificationTool, whoamiTool,
} from "./sessions.js";
import { simulateWebhookTool, verifySignatureTool } from "./webhooks.js";
import { computeSignature } from "@xident/mcp-shared";

type Json = Record<string, unknown>;

function sandboxCtx(fetchImpl: typeof fetch): DevContext {
  return contextFromEnv({ XIDENT_API_KEY: "sk_test_abc", XIDENT_BASE_URL: "https://api.test" }, fetchImpl);
}
function liveCtx(fetchImpl: typeof fetch): DevContext {
  return contextFromEnv({ XIDENT_API_KEY: "sk_live_abc", XIDENT_BASE_URL: "https://api.test" }, fetchImpl);
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("xident_search_docs", () => {
  it("returns endpoints as data, never a prose string", async () => {
    const out = await searchDocsTool.handler({ query: "init" }, contextFromEnv({})) as Json;
    expect(typeof out).toBe("object");
    expect(Array.isArray(out["endpoints"])).toBe(true);
  });

  it("returns an empty list rather than erroring on a nonsense query", async () => {
    const out = await searchDocsTool.handler({ query: "zzzzqqqq" }, contextFromEnv({})) as Json;
    expect(out["count"]).toBe(0);
  });
});

describe("xident_get_endpoint", () => {
  it("returns the real init schema", async () => {
    const out = await getEndpointTool.handler({ path: "/verify/v1/init", method: "POST" }, contextFromEnv({})) as Json;
    expect(out["method"]).toBe("POST");
    expect(out["auth"]).toBe("api_key");
  });

  it("tells an agent that account reuse needs the API key and the account token", async () => {
    const out = await getEndpointTool.handler({ path: "/verify/v1/accounts/reuse", method: "POST" }, contextFromEnv({})) as Json;
    expect(out["auth"]).toBe("api_key+account_token");
    const headers = (out["security"] as Array<Array<{ name?: string }>>).flat().map((c) => c.name);
    expect(headers).toEqual(["X-API-Key", "X-Account-Token"]);
  });

  it("tells an agent that reading the account profile needs both credentials", async () => {
    const out = await getEndpointTool.handler({ path: "/verify/v1/accounts/me", method: "GET" }, contextFromEnv({})) as Json;
    expect(out["auth"]).toBe("api_key+account_token");
    const headers = (out["security"] as Array<Array<{ name?: string }>>).flat().map((c) => c.name);
    expect(headers).toEqual(["X-API-Key", "X-Account-Token"]);
  });

  it("suggests near matches instead of just failing", async () => {
    const out = await getEndpointTool.handler({ path: "/verify/v1/inti", method: "POST" }, contextFromEnv({})) as Json;
    expect(out["code"]).toBe("ENDPOINT_NOT_FOUND");
    expect(String(out["fix"]).length).toBeGreaterThan(0);
  });
});

describe("xident_verify_webhook_signature", () => {
  const body = JSON.stringify({ event: "session.success" });
  const ts = String(Math.floor(Date.now() / 1000));

  it("confirms a good signature and names the signed-payload format", async () => {
    const header = `t=${ts},v1=${computeSignature(ts, body, "whsec")}`;
    const out = await verifySignatureTool.handler(
      { raw_body: body, signature_header: header, secret: "whsec" }, contextFromEnv({})) as Json;
    expect(out["valid"]).toBe(true);
    expect(out["signed_payload_format"]).toBe("<timestamp>.<raw_body>");
  });

  it("explains a mismatch with the most likely cause", async () => {
    const header = `t=${ts},v1=${computeSignature(ts, body, "whsec")}`;
    const out = await verifySignatureTool.handler(
      { raw_body: body, signature_header: header, secret: "wrong" }, contextFromEnv({})) as Json;
    expect(out["valid"]).toBe(false);
    expect(String(out["hint"])).toContain("re-serializing");
  });
});

describe("xident_whoami", () => {
  it("flags a public key as the wrong credential for server calls", async () => {
    const ctx = contextFromEnv({ XIDENT_API_KEY: "pk_test_abc" });
    const out = await whoamiTool.handler({}, ctx) as Json;
    expect(out["key_kind"]).toBe("public");
    expect(String((out["problems"] as string[]).join(" "))).toContain("PUBLIC key");
  });

  it("reports readiness for a sandbox secret key", async () => {
    const out = await whoamiTool.handler({}, contextFromEnv({ XIDENT_API_KEY: "sk_test_abc" })) as Json;
    expect(out["ready_for_test_verifications"]).toBe(true);
  });

  it("errors cleanly with no key configured", async () => {
    const out = await whoamiTool.handler({}, contextFromEnv({})) as Json;
    expect(out["code"]).toBe("NO_API_KEY");
  });
});

describe("xident_start_test_verification", () => {
  it("refuses to run against a live key", async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const out = await startTestVerificationTool.handler({}, liveCtx(fetchImpl as never)) as Json;
    expect(out["code"]).toBe("LIVE_KEY_REFUSED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("creates a session and sends an idempotency key", async () => {
    const fetchImpl = vi.fn(async () => json(200, { token: "xtk_1", verify_url: "https://verify.xident.io/x" }));
    const out = await startTestVerificationTool.handler({ min_age: 18 }, sandboxCtx(fetchImpl as never)) as Json;
    expect(out["created"]).toBe(true);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
    expect(JSON.parse(String(init.body))).toEqual({ min_age: 18 });
  });

  it("omits absent optional fields rather than sending nulls", async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    await startTestVerificationTool.handler({}, sandboxCtx(fetchImpl as never));
    expect(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))).toEqual({});
  });

  it("surfaces a billing error with its remedy", async () => {
    const fetchImpl = vi.fn(async () => json(402, { code: "ALLOWANCE_EXHAUSTED" }));
    const out = await startTestVerificationTool.handler({}, sandboxCtx(fetchImpl as never)) as Json;
    expect(out["code"]).toBe("ALLOWANCE_EXHAUSTED");
  });
});

describe("xident_get_result", () => {
  it("returns the API verdict verbatim", async () => {
    const golden = { token: "xtk_1", status: "success", verified: true, verification_mode: "full" };
    const fetchImpl = vi.fn(async () => json(200, golden));
    const out = await getResultTool.handler({ token: "xtk_1" }, sandboxCtx(fetchImpl as never)) as Json;
    expect(out).toMatchObject(golden);
  });

  it("url-encodes the token so a crafted value cannot alter the path", async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    await getResultTool.handler({ token: "../../admin/v1/tenants" }, sandboxCtx(fetchImpl as never));
    expect(String(fetchImpl.mock.calls[0]![0])).not.toContain("/admin/v1/");
  });
});

describe("xident_explain_session", () => {
  it("explains a reason code with no key and no network", async () => {
    const out = await explainSessionTool.handler({ reason: "liveness_failed" }, contextFromEnv({})) as Json;
    expect(out["retryable"]).toBe(true);
    expect(out["actor"]).toBe("end_user");
  });

  it("tells an agent not to retry a correct refusal", async () => {
    const out = await explainSessionTool.handler({ reason: "age_below_threshold" }, contextFromEnv({})) as Json;
    expect(out["retryable"]).toBe(false);
  });

  it("asks for input rather than guessing when given neither argument", async () => {
    const out = await explainSessionTool.handler({}, contextFromEnv({})) as Json;
    expect(out["code"]).toBe("MISSING_INPUT");
  });

  it("looks a token up when no reason is supplied", async () => {
    const fetchImpl = vi.fn(async () => json(200, { status: "failed", reason: "face_mismatch" }));
    const out = await explainSessionTool.handler({ token: "xtk_1" }, sandboxCtx(fetchImpl as never)) as Json;
    expect(out["reason"]).toBe("face_mismatch");
  });

  it("says so plainly when a session carries no reason yet", async () => {
    const fetchImpl = vi.fn(async () => json(200, { status: "pending" }));
    const out = await explainSessionTool.handler({ token: "xtk_1" }, sandboxCtx(fetchImpl as never)) as Json;
    expect(out["explanation"]).toBeNull();
  });
});

describe("xident_simulate_webhook", () => {
  it("refuses a non-local target, so it cannot be used as a request-forgery primitive", async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const out = await simulateWebhookTool.handler(
      { url: "https://evil.example.com/x", secret: "s", event: "session.success" },
      sandboxCtx(fetchImpl as never)) as Json;
    expect(out["code"]).toBe("NON_LOCAL_TARGET");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts a signature the shared verifier accepts", async () => {
    let captured: { body: string; sig: string } | null = null;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      captured = { body: String(init.body), sig: (init.headers as Record<string, string>)["X-Xident-Signature"]! };
      return json(200, {});
    });
    const out = await simulateWebhookTool.handler(
      { url: "http://localhost:3000/hook", secret: "whsec", event: "session.success" },
      sandboxCtx(fetchImpl as never)) as Json;
    expect(out["sent"]).toBe(true);
    const { verifyWebhookSignature } = await import("@xident/mcp-shared");
    expect(verifyWebhookSignature(captured!.body, captured!.sig, "whsec").valid).toBe(true);
  });

  it("points at the verifier when the handler rejects the delivery", async () => {
    const fetchImpl = vi.fn(async () => json(401, {}));
    const out = await simulateWebhookTool.handler(
      { url: "http://localhost:3000/hook", secret: "whsec", event: "session.failed" },
      sandboxCtx(fetchImpl as never)) as Json;
    expect(out["handler_accepted"]).toBe(false);
    expect(String(out["note"])).toContain("xident_verify_webhook_signature");
  });

  it("reports a refused connection instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const out = await simulateWebhookTool.handler(
      { url: "http://localhost:9/hook", secret: "s", event: "session.success" },
      sandboxCtx(fetchImpl as never)) as Json;
    expect(out["code"]).toBe("DELIVERY_FAILED");
  });
});

describe("xident_check_integration", () => {
  it("fails the sandbox check on a live key and still reports the others", async () => {
    const fetchImpl = vi.fn(async () => json(200, []));
    const out = await checkIntegrationTool.handler({}, liveCtx(fetchImpl as never)) as Json;
    const checks = out["checks"] as Array<{ check: string; passed: boolean }>;
    expect(checks.find((c) => c.check === "sandbox")!.passed).toBe(false);
    expect(checks.find((c) => c.check === "api_reachable")!.passed).toBe(true);
    expect(out["all_passed"]).toBe(false);
  });

  it("passes everything for a reachable sandbox secret key", async () => {
    const fetchImpl = vi.fn(async () => json(200, []));
    const out = await checkIntegrationTool.handler({}, sandboxCtx(fetchImpl as never)) as Json;
    expect(out["all_passed"]).toBe(true);
  });
});
