import { describe, expect, it, vi } from "vitest";
import { isSandboxKey, keyKind, unwrapEnvelope, XidentClient } from "./client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("keyKind", () => {
  it.each([
    ["sk_test_abc", "secret"],
    ["pk_live_abc", "public"],
    ["ak_live_abc", "agent"],
    ["nonsense", "unknown"],
  ])("classifies %s", (key, expected) => {
    expect(keyKind(key)).toBe(expected);
  });
});

describe("isSandboxKey", () => {
  it("recognises test and sandbox keys", () => {
    expect(isSandboxKey("sk_test_abc")).toBe(true);
    expect(isSandboxKey("sk_sandbox_abc")).toBe(true);
  });
  it("does not mistake a live key for sandbox", () => {
    expect(isSandboxKey("sk_live_abc")).toBe(false);
  });
});

describe("XidentClient", () => {
  it("unwraps the response envelope every endpoint returns", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      success: true, data: { token: "xtk_1", verify_url: "https://verify.xident.io/x" }, meta: { request_id: "r1" },
    }));
    const c = new XidentClient({ baseUrl: "https://api.example.com", apiKey: "sk_test_x", fetchImpl: fetchImpl as never });
    const res = await c.request<{ token: string; verify_url: string }>("POST", "/verify/v1/init", { body: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.token).toBe("xtk_1");
      expect((res.data as Record<string, unknown>)["success"]).toBeUndefined();
    }
  });

  it("sends bearer auth and returns parsed data", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { token: "xtk_1" }));
    const c = new XidentClient({ baseUrl: "https://api.example.com/", apiKey: "sk_test_x", fetchImpl: fetchImpl as never });
    const res = await c.request<{ token: string }>("GET", "/verify/v1/result/xtk_1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.token).toBe("xtk_1");
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk_test_x");
  });

  it("strips a trailing slash from the base URL so paths do not double up", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const c = new XidentClient({ baseUrl: "https://api.example.com///", apiKey: "sk_test_x", fetchImpl: fetchImpl as never });
    await c.request("GET", "/verify/v1/x");
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.example.com/verify/v1/x");
  });

  it("forwards an idempotency key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const c = new XidentClient({ baseUrl: "https://api.example.com", apiKey: "sk_test_x", fetchImpl: fetchImpl as never });
    await c.request("POST", "/verify/v1/init", { body: {}, idempotencyKey: "idem-1" });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem-1");
  });

  it("converts an error response into structured guidance", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(402, { code: "ALLOWANCE_EXHAUSTED", message: "no" }));
    const c = new XidentClient({ baseUrl: "https://api.example.com", apiKey: "sk_test_x", fetchImpl: fetchImpl as never });
    const res = await c.request("POST", "/verify/v1/init", { body: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("ALLOWANCE_EXHAUSTED");
  });

  it("reports a network failure as retryable instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("econnrefused"); });
    const c = new XidentClient({ baseUrl: "https://api.example.com", apiKey: "sk_test_x", fetchImpl: fetchImpl as never });
    const res = await c.request("GET", "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) { expect(res.error.code).toBe("NETWORK_ERROR"); expect(res.error.retryable).toBe(true); }
  });

  it("leaves a bare payload alone", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { token: "xtk_1" }));
    const c = new XidentClient({ baseUrl: "https://api.example.com", apiKey: "sk_test_x", fetchImpl: fetchImpl as never });
    const res = await c.request<{ token: string }>("GET", "/x");
    if (res.ok) expect(res.data.token).toBe("xtk_1");
  });

  it("handles a non-JSON body without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    const c = new XidentClient({ baseUrl: "https://api.example.com", apiKey: "sk_test_x", fetchImpl: fetchImpl as never });
    const res = await c.request("GET", "/x");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.status).toBe(502);
  });
});

describe("unwrapEnvelope", () => {
  it("unwraps only a real envelope", () => {
    expect(unwrapEnvelope({ success: true, data: { a: 1 }, meta: {} })).toEqual({ a: 1 });
  });

  it("does not unwrap a payload that merely has a data field", () => {
    const payload = { data: { a: 1 }, other: 2 };
    expect(unwrapEnvelope(payload)).toEqual(payload);
  });

  it("unwraps an envelope whose data is null without inventing an object", () => {
    expect(unwrapEnvelope({ success: true, data: null, meta: {} })).toBeNull();
  });

  it("passes arrays and primitives through", () => {
    expect(unwrapEnvelope([1, 2])).toEqual([1, 2]);
    expect(unwrapEnvelope("x")).toBe("x");
    expect(unwrapEnvelope(null)).toBeNull();
  });
});
