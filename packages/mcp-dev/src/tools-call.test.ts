import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { contextFromEnv } from "./context.js";
import { createServer } from "./server.js";

/**
 * xident_start_test_verification through a real MCP tools/call: an MCP
 * client and the dev server joined by the SDK's in-memory transport, so the
 * SDK's input-schema check runs exactly as it does for an agent. Calling
 * `.handler` directly skipped that check (Astra finding 3).
 */

type Json = Record<string, unknown>;

const cb = "https://example.com/done";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function call(name: string, args: Json, key: string, f: ReturnType<typeof vi.fn>): Promise<{ payload: Json; isError: boolean }> {
  const ctx = contextFromEnv({ XIDENT_API_KEY: key, XIDENT_BASE_URL: "https://api.test" }, f as never);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tools-call-test", version: "0.0.0" });
  await Promise.all([createServer(ctx).connect(serverSide), client.connect(clientSide)]);
  try {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text: string }>;
    let payload: Json;
    try {
      payload = JSON.parse(content[0]!.text) as Json;
    } catch {
      payload = { text: content[0]!.text };
    }
    return { payload, isError: res.isError === true };
  } finally {
    await client.close();
  }
}

const start = (args: Json, f: ReturnType<typeof vi.fn>, key = "sk_test_abc") =>
  call("xident_start_test_verification", args, key, f);

describe("xident_start_test_verification through tools/call", () => {
  it.each([
    ["a missing callback_url", { min_age: 18, user_id: "u-1" }, "MISSING_CALLBACK_URL"],
    ["a blank user_id", { callback_url: cb, min_age: 18, user_id: "" }, "MISSING_USER_ID"],
    ["min_age 26", { callback_url: cb, min_age: 26 }, "INVALID_MIN_AGE"],
    ["an age verification with no min_age", { callback_url: cb }, "INVALID_MIN_AGE"],
    ["an id verification with min_age 18", { callback_url: cb, purpose: "id_verification", min_age: 18 }, "INVALID_MIN_AGE"],
    ["an id verification with facial",
      { callback_url: cb, purpose: "id_verification", verification_mode: "facial" }, "INVALID_VERIFICATION_MODE"],
    ["an unknown verification_mode", { callback_url: cb, min_age: 18, verification_mode: "manual" }, "INVALID_VERIFICATION_MODE"],
    ["an unknown purpose", { callback_url: cb, min_age: 18, purpose: "kyc" }, "INVALID_PURPOSE"],
  ])("answers %s with the API's code and sends nothing", async (_label, args, code) => {
    // Fails if the schema refuses first again (the payload is then the SDK's
    // "Input validation error" text), or if the handler stops checking.
    const f = vi.fn(async () => json(200, {}));
    const { payload, isError } = await start(args as Json, f);
    expect(isError).toBe(false);
    expect(payload).toMatchObject({ error: true, status: 400, code, retryable: false });
    expect(f).not.toHaveBeenCalled();
  });

  it("creates the session with every setting intact and a generated user_id", async () => {
    // Fails if purpose, verification_mode or min_age is dropped on the way,
    // or if the default user_id is not sent.
    const f = vi.fn(async () => json(201, { token: "xit_1", verify_url: "https://verify.xident.io?t=xit_1" }));
    const { payload } = await start({ callback_url: cb, min_age: 19, purpose: "age_verification", verification_mode: "facial" }, f);

    expect(payload["created"]).toBe(true);
    const [url, init] = f.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.test/verify/v1/init");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Json;
    expect(body).toEqual({
      min_age: 19, purpose: "age_verification", verification_mode: "facial", callback_url: cb,
      user_id: expect.stringMatching(/^mcp-dev-[0-9a-f]{16}$/),
    });
    expect(payload["user_id"]).toBe(body["user_id"]);
  });

  it("accepts an id verification with min_age 0, as the API does", async () => {
    // Fails if the schema caps the age at 12 again (Astra finding 2).
    const f = vi.fn(async () => json(201, { token: "xit_2" }));
    const { payload } = await start({ callback_url: cb, purpose: "id_verification", min_age: 0, user_id: "u-1" }, f);
    expect(payload["created"]).toBe(true);
    expect(JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body))).toEqual({
      min_age: 0, purpose: "id_verification", callback_url: cb, user_id: "u-1",
    });
  });

  it("keeps the sandbox rule ahead of every settings check", async () => {
    // Guard: a live key is refused before any settings code, even for bad settings.
    const f = vi.fn(async () => json(200, {}));
    const { payload } = await start({ min_age: 99 }, f, "sk_live_abc");
    expect(payload["code"]).toBe("LIVE_KEY_REFUSED");
    expect(f).not.toHaveBeenCalled();
  });
});
