import { describe, expect, it, vi } from "vitest";
import { contextFromEnv, type DevContext } from "../context.js";
import { getEndpointTool, searchDocsTool } from "./docs.js";
import {
  checkIntegrationTool, DEV_USER_ID_PREFIX, explainSessionTool, generateDevUserId, getResultTool,
  startTestVerificationTool, whoamiTool,
} from "./sessions.js";
import { z } from "zod";
import { simulateWebhookTool, verifySignatureTool } from "./webhooks.js";
import { computeSignature } from "@xident/mcp-shared";

type Json = Record<string, unknown>;

function sandboxCtx(fetchImpl: typeof fetch): DevContext {
  return contextFromEnv({ XIDENT_API_KEY: "sk_test_abc", XIDENT_BASE_URL: "https://api.test" }, fetchImpl);
}
function liveCtx(fetchImpl: typeof fetch): DevContext {
  return contextFromEnv({ XIDENT_API_KEY: "sk_live_abc", XIDENT_BASE_URL: "https://api.test" }, fetchImpl);
}
function agentCtx(fetchImpl: typeof fetch, key = "ak_test_abc"): DevContext {
  return contextFromEnv({ XIDENT_API_KEY: key, XIDENT_BASE_URL: "https://api.test" }, fetchImpl);
}
/** A fake API that answers GET /verify/v1/token-info with these scopes, and [] elsewhere. */
function tokenInfoApi(info: { scopes: string[]; unrestricted?: boolean } | number) {
  return vi.fn(async (url: string) => {
    if (String(url).endsWith("/verify/v1/token-info")) {
      return typeof info === "number"
        ? json(info, { success: false, error: { code: "UNAUTHORIZED", message: "invalid key" } })
        : json(200, { success: true, data: { key_kind: "agent", unrestricted: false, ...info } });
    }
    return json(200, { data: [] });
  });
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

  it("reports a sandbox agent key with verification:write as ready, after asking the API", async () => {
    const fetchImpl = tokenInfoApi({ scopes: ["verification:read", "verification:write"] });
    const out = await whoamiTool.handler({}, agentCtx(fetchImpl as never)) as Json;
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.test/verify/v1/token-info");
    expect(out["key_kind"]).toBe("agent");
    expect(out["scopes"]).toEqual(["verification:read", "verification:write"]);
    expect(out["ready_for_test_verifications"]).toBe(true);
    expect(out["problems"]).toEqual([]);
  });

  it("reports an unrestricted sandbox agent key as ready", async () => {
    const out = await whoamiTool.handler({}, agentCtx(tokenInfoApi({ scopes: [], unrestricted: true }) as never)) as Json;
    expect(out["ready_for_test_verifications"]).toBe(true);
  });

  it("says why a sandbox agent key without verification:write is not ready", async () => {
    const out = await whoamiTool.handler({}, agentCtx(tokenInfoApi({ scopes: ["verification:read"] }) as never)) as Json;
    expect(out["ready_for_test_verifications"]).toBe(false);
    expect((out["problems"] as string[]).join(" ")).toContain("without verification:write");
  });

  it("is not ready when the API cannot say what the agent key may do", async () => {
    const out = await whoamiTool.handler({}, agentCtx(tokenInfoApi(401) as never)) as Json;
    expect(out["ready_for_test_verifications"]).toBe(false);
    expect((out["problems"] as string[]).join(" ")).toContain("Could not read the agent key's scopes");
  });

  it("never reports a live agent key as ready, even with verification:write", async () => {
    const fetchImpl = tokenInfoApi({ scopes: ["verification:write"] });
    const out = await whoamiTool.handler({}, agentCtx(fetchImpl as never, "ak_live_abc")) as Json;
    expect(out["ready_for_test_verifications"]).toBe(false);
  });
});

describe("xident_start_test_verification", () => {
  it("refuses to run against a live key", async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const out = await startTestVerificationTool.handler({}, liveCtx(fetchImpl as never)) as Json;
    expect(out["code"]).toBe("LIVE_KEY_REFUSED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  const cb = "https://example.com/done";

  it("creates a session and sends an idempotency key", async () => {
    const fetchImpl = vi.fn(async () => json(200, { token: "xit_1", verify_url: "https://verify.xident.io/x" }));
    const out = await startTestVerificationTool.handler(
      { min_age: 18, callback_url: cb, user_id: "u-1" }, sandboxCtx(fetchImpl as never)) as Json;
    expect(out["created"]).toBe(true);
    expect(out["user_id"]).toBe("u-1");
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
    expect(JSON.parse(String(init.body))).toEqual({ min_age: 18, callback_url: cb, user_id: "u-1" });
  });

  it("omits absent optional fields rather than sending nulls", async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    await startTestVerificationTool.handler(
      { min_age: 18, callback_url: cb, user_id: "u-1" }, sandboxCtx(fetchImpl as never));
    expect(Object.keys(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))).sort())
      .toEqual(["callback_url", "min_age", "user_id"]);
  });

  it("surfaces a billing error with its remedy", async () => {
    const fetchImpl = vi.fn(async () => json(402, { code: "ALLOWANCE_EXHAUSTED" }));
    const out = await startTestVerificationTool.handler(
      { min_age: 18, callback_url: cb }, sandboxCtx(fetchImpl as never)) as Json;
    expect(out["code"]).toBe("ALLOWANCE_EXHAUSTED");
  });

  it("generates a user_id when none is given, and sends and returns it", async () => {
    // Fails if the default is dropped: the API answers 400 MISSING_USER_ID.
    const fetchImpl = vi.fn(async () => json(200, { token: "xit_1" }));
    const out = await startTestVerificationTool.handler(
      { min_age: 18, callback_url: cb }, sandboxCtx(fetchImpl as never)) as Json;
    const sent = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as Json;
    expect(String(sent["user_id"])).toMatch(/^mcp-dev-[0-9a-f]{16}$/);
    expect(out["user_id"]).toBe(sent["user_id"]);
  });

  it("refuses a blank user_id instead of replacing it", async () => {
    // Fails if a blank value is silently swapped for the generated one.
    const fetchImpl = vi.fn(async () => json(200, {}));
    const out = await startTestVerificationTool.handler(
      { min_age: 18, callback_url: cb, user_id: "  " }, sandboxCtx(fetchImpl as never)) as Json;
    expect(out["code"]).toBe("MISSING_USER_ID");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["no callback_url", { min_age: 18 }, "MISSING_CALLBACK_URL"],
    ["an age verification with no min_age", { callback_url: cb }, "INVALID_MIN_AGE"],
    ["min_age 26", { callback_url: cb, min_age: 26 }, "INVALID_MIN_AGE"],
    ["an id verification with min_age 18", { callback_url: cb, purpose: "id_verification", min_age: 18 }, "INVALID_MIN_AGE"],
    ["an id verification with facial",
      { callback_url: cb, purpose: "id_verification", verification_mode: "facial" }, "INVALID_VERIFICATION_MODE"],
  ])("refuses %s without a request", async (_label, args, code) => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const out = await startTestVerificationTool.handler(
      args as Record<string, unknown>, sandboxCtx(fetchImpl as never)) as Json;
    expect(out).toMatchObject({ error: true, status: 400, code });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the sandbox rule ahead of the settings check", async () => {
    // Guard: a live key is refused even with valid settings.
    const fetchImpl = vi.fn(async () => json(200, {}));
    const out = await startTestVerificationTool.handler(
      { min_age: 18, callback_url: cb }, liveCtx(fetchImpl as never)) as Json;
    expect(out["code"]).toBe("LIVE_KEY_REFUSED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("publishes the settings fields with types only, so the handler sees every value", () => {
    // A strict schema made the MCP SDK refuse with its own text before the
    // handler ran (Astra finding 3), and refused the min_age 0 an ID
    // verification may send (finding 2). The rules live in checkInitArgs.
    const schema = z.object(startTestVerificationTool.inputSchema);
    for (const field of ["callback_url", "user_id", "min_age", "purpose", "verification_mode"]) {
      expect(startTestVerificationTool.inputSchema[field]!.isOptional(), field).toBe(true);
    }
    for (const age of [0, 11, 26, 120, 18.5]) {
      expect(schema.safeParse({ callback_url: cb, min_age: age }).success, String(age)).toBe(true);
    }
    expect(schema.safeParse({ min_age: 18, verification_mode: "manual" }).success).toBe(true);
    expect(startTestVerificationTool.inputSchema["callback_url"]!.description ?? "").toMatch(/^REQUIRED\./);
  });

  it("sends purpose, verification_mode, user_id and min_age to POST /verify/v1/init as given", async () => {
    // Fails if any of them is dropped after the check (Astra finding 4).
    const fetchImpl = vi.fn(async () => json(200, { token: "xit_1" }));
    await startTestVerificationTool.handler(
      { min_age: 21, purpose: "age_verification", verification_mode: "document", callback_url: cb, user_id: "u-9" },
      sandboxCtx(fetchImpl as never));
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.test/verify/v1/init");
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))).toEqual({
      min_age: 21, purpose: "age_verification", verification_mode: "document", callback_url: cb, user_id: "u-9",
    });
  });

  it("sends an id verification with min_age 0, as the API accepts it", async () => {
    const fetchImpl = vi.fn(async () => json(200, { token: "xit_2" }));
    await startTestVerificationTool.handler(
      { min_age: 0, purpose: "id_verification", verification_mode: "document", callback_url: cb, user_id: "u-9" },
      sandboxCtx(fetchImpl as never));
    expect(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))).toEqual({
      min_age: 0, purpose: "id_verification", verification_mode: "document", callback_url: cb, user_id: "u-9",
    });
  });
});

describe("generateDevUserId", () => {
  it("is mcp-dev- and 16 hex characters, different on every call", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateDevUserId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^mcp-dev-[0-9a-f]{16}$/);
  });

  it("never looks like a Xident credential and never forces a failure", () => {
    // The API refuses a user_id that starts with one of these (init.go credentialPrefixes),
    // and a test session whose user_id ends in +fail is settled as failed.
    for (let i = 0; i < 50; i++) {
      const id = generateDevUserId();
      for (const prefix of ["xat_", "sk_", "ak_", "xtk_", "xit_", "pk_"]) {
        expect(id.startsWith(prefix)).toBe(false);
      }
      expect(id.startsWith(DEV_USER_ID_PREFIX)).toBe(true);
      expect(id.endsWith("+fail")).toBe(false);
    }
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

  it("passes everything for a sandbox agent key with verification:write", async () => {
    const out = await checkIntegrationTool.handler({}, agentCtx(tokenInfoApi({ scopes: ["verification:write"] }) as never)) as Json;
    const keyType = (out["checks"] as Array<{ check: string; passed: boolean; detail: string }>).find((c) => c.check === "key_type")!;
    expect(keyType.passed).toBe(true);
    expect(keyType.detail).toContain("Agent key (ak_) with verification:write");
    expect(out["all_passed"]).toBe(true);
  });

  it("fails the key check for an agent key without verification:write, and does not ask for an sk_ key", async () => {
    const out = await checkIntegrationTool.handler({}, agentCtx(tokenInfoApi({ scopes: ["verification:read"] }) as never)) as Json;
    const keyType = (out["checks"] as Array<{ check: string; passed: boolean; detail: string }>).find((c) => c.check === "key_type")!;
    expect(keyType.passed).toBe(false);
    expect(keyType.detail).toContain("without verification:write");
    expect(keyType.detail).not.toContain("require a secret key");
    expect(out["all_passed"]).toBe(false);
  });

  it("fails the key check for a public key", async () => {
    const fetchImpl = vi.fn(async () => json(200, []));
    const ctx = contextFromEnv({ XIDENT_API_KEY: "pk_test_abc", XIDENT_BASE_URL: "https://api.test" }, fetchImpl as never);
    const out = await checkIntegrationTool.handler({}, ctx) as Json;
    expect((out["checks"] as Array<{ check: string; passed: boolean }>).find((c) => c.check === "key_type")!.passed).toBe(false);
  });
});
