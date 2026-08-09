import { describe, expect, it } from "vitest";
import { contextFromEnv, DEFAULT_BASE_URL } from "./context.js";

describe("contextFromEnv", () => {
  it("starts without a key so the offline tools still work", () => {
    const ctx = contextFromEnv({});
    expect(ctx.client).toBeNull();
    expect(ctx.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("recognises a sandbox secret key", () => {
    const ctx = contextFromEnv({ XIDENT_API_KEY: "sk_test_abc" });
    expect(ctx.kind).toBe("secret");
    expect(ctx.sandbox).toBe(true);
    expect(ctx.client).not.toBeNull();
  });

  it("recognises a live key as not sandbox", () => {
    expect(contextFromEnv({ XIDENT_API_KEY: "sk_live_abc" }).sandbox).toBe(false);
  });

  it("treats a whitespace-only key as absent", () => {
    expect(contextFromEnv({ XIDENT_API_KEY: "   " }).client).toBeNull();
  });

  it("honours a custom base URL", () => {
    expect(contextFromEnv({ XIDENT_BASE_URL: "http://localhost:8080" }).baseUrl).toBe("http://localhost:8080");
  });
});
