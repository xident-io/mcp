import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configFromEnv } from "./config.js";
import { createRuntimeServer } from "./server.js";

/**
 * xident_start_verification through a real MCP tools/call: an MCP client and
 * the runtime server joined by the SDK's in-memory transport.
 *
 * Calling `.handler` directly skips the step where the MCP SDK checks the
 * arguments against the tool's input schema. A strict schema refused there
 * with the SDK's own text, so a real caller never saw MISSING_USER_ID or
 * INVALID_MIN_AGE (Astra finding 3). These tests go through that step.
 */

type Json = Record<string, unknown>;

const cfg = configFromEnv({ XIDENT_API_BASE_URL: "https://api.test" });
const valid = {
  callback_url: "https://example.com/done",
  user_id: "u-1",
  min_age: 18,
  idempotency_key: "k-1",
};

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tools-call-test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

/** Call the start tool for a caller with verification:write and parse the JSON payload. */
async function callStart(args: Json, f: ReturnType<typeof vi.fn>): Promise<{ payload: Json; isError: boolean }> {
  vi.stubGlobal("fetch", f);
  const client = await connect(createRuntimeServer(cfg, "xat_test_token", ["verification:write"]));
  try {
    const res = await client.callTool({ name: "xident_start_verification", arguments: args });
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("xident_start_verification through tools/call", () => {
  it.each([
    ["a missing user_id", { callback_url: valid.callback_url, min_age: 18, idempotency_key: "k" }, "MISSING_USER_ID"],
    ["a missing callback_url", { user_id: "u-1", min_age: 18, idempotency_key: "k" }, "MISSING_CALLBACK_URL"],
    ["min_age 26", { ...valid, min_age: 26 }, "INVALID_MIN_AGE"],
    ["min_age 11", { ...valid, min_age: 11 }, "INVALID_MIN_AGE"],
    ["min_age 18.5", { ...valid, min_age: 18.5 }, "INVALID_MIN_AGE"],
    ["an age verification with no min_age", { ...valid, min_age: undefined }, "INVALID_MIN_AGE"],
    ["an id verification with min_age 18", { ...valid, purpose: "id_verification" }, "INVALID_MIN_AGE"],
    ["an id verification with facial",
      { ...valid, min_age: undefined, purpose: "id_verification", verification_mode: "facial" },
      "INVALID_VERIFICATION_MODE"],
    ["an unknown verification_mode", { ...valid, verification_mode: "manual" }, "INVALID_VERIFICATION_MODE"],
    ["an unknown purpose", { ...valid, purpose: "kyc" }, "INVALID_PURPOSE"],
  ])("answers %s with the API's code and sends nothing", async (_label, args, code) => {
    // Fails if the schema refuses first again (the payload is then the SDK's
    // "Input validation error" text), or if the handler stops checking.
    const f = vi.fn(async () => jsonRes(201, {}));
    const { payload, isError } = await callStart(args as Json, f);
    expect(isError).toBe(false);
    expect(payload).toMatchObject({ error: true, status: 400, code, retryable: false });
    expect(String(payload["fix"])).not.toBe("");
    expect(f).not.toHaveBeenCalled();
  });

  it("sends a valid age verification to POST /verify/v1/init with every setting intact", async () => {
    // Fails if purpose, verification_mode, user_id or min_age is dropped or
    // changed on the way, or if the path, the bearer or the key changes.
    const f = vi.fn(async () => jsonRes(201, { success: true, data: { token: "xit_1", verify_url: "https://verify.xident.io?t=xit_1" } }));
    const { payload } = await callStart(
      { ...valid, min_age: 19, purpose: "age_verification", verification_mode: "document" }, f);

    expect(payload).toEqual({ token: "xit_1", verify_url: "https://verify.xident.io?t=xit_1" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.test/verify/v1/init");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("k-1");
    expect(JSON.stringify(headers)).toContain("xat_test_token");
    expect(JSON.parse(String(init.body))).toEqual({
      min_age: 19, purpose: "age_verification", verification_mode: "document",
      callback_url: "https://example.com/done", user_id: "u-1",
    });
  });

  it("accepts an id verification with min_age 0, as the API does", async () => {
    // Fails if the schema or the handler refuses the 0 the API accepts (Astra finding 2).
    const f = vi.fn(async () => jsonRes(201, { success: true, data: { token: "xit_2" } }));
    const { payload } = await callStart(
      { ...valid, min_age: 0, purpose: "id_verification", verification_mode: "document" }, f);

    expect(payload).toEqual({ token: "xit_2" });
    expect(JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body))).toEqual({
      min_age: 0, purpose: "id_verification", verification_mode: "document",
      callback_url: "https://example.com/done", user_id: "u-1",
    });
  });

  it("passes the API's own refusal through", async () => {
    // The API is the authority: a rule the tool does not check still comes back with its code.
    const f = vi.fn(async () => jsonRes(400, { success: false, error: { code: "INVALID_CALLBACK_URL", message: "callback_url must be a valid HTTPS URL" } }));
    const { payload } = await callStart({ ...valid, callback_url: "yourapp://done" }, f);
    expect(payload).toMatchObject({ error: true, status: 400, code: "INVALID_CALLBACK_URL" });
  });

  it("advertises only idempotency_key as required, and says in words what else is", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = await connect(createRuntimeServer(cfg, "xat_test_token", ["verification:write"]));
    try {
      const { tools } = await client.listTools();
      const start = tools.find((t) => t.name === "xident_start_verification")!;
      const schema = start.inputSchema as { required?: string[]; properties: Record<string, { description?: string; minimum?: number; maximum?: number; enum?: unknown }> };
      expect(schema.required ?? []).toEqual(["idempotency_key"]);
      expect(schema.properties["user_id"]!.description).toMatch(/^REQUIRED\./);
      expect(schema.properties["callback_url"]!.description).toMatch(/^REQUIRED\./);
      expect(schema.properties["min_age"]!.description).toContain("12 to 25");
      expect(schema.properties["min_age"]!.maximum).toBeUndefined();
      expect(schema.properties["verification_mode"]!.enum).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});

/** The API's result shapes, shared with packages/shared (see result.test.ts for their sources). */
const fixture = (name: string): Json =>
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "src", "__fixtures__", name), "utf8")) as Json;

async function callResult(args: Json, f: ReturnType<typeof vi.fn>): Promise<Json> {
  vi.stubGlobal("fetch", f);
  const client = await connect(createRuntimeServer(cfg, "xat_test_token", ["verification:read"]));
  try {
    const res = await client.callTool({ name: "xident_get_verification_result", arguments: args });
    return JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as Json;
  } finally {
    await client.close();
  }
}

describe("xident_get_verification_result access check through tools/call", () => {
  const api = (result: Json) => vi.fn(async () => jsonRes(200, { success: true, data: result }));
  const ask = { token: "xtk_1", expected_user_id: "cust-4711", required_min_age: 21 };

  it("returns the verdict verbatim when no check is asked", async () => {
    const doc = fixture("tenant_result_v1.golden.json");
    expect(await callResult({ token: "xtk_1" }, api(doc))).toEqual(doc);
  });

  it("decides on the five result shapes, and never accepts a test verdict here", async () => {
    const decide = async (name: string) => (await callResult(ask, api(fixture(name))))["access"];
    expect(await decide("tenant_result_v1.golden.json")).toMatchObject({ proves_age: true, same_user: true, granted: true });
    expect(await decide("tenant_result_xident_id_reuse.json")).toMatchObject({ granted: true });
    expect(await decide("tenant_result_eu_wallet.json")).toMatchObject({ granted: true });
    expect(await decide("tenant_result_id_no_gate.json")).toMatchObject({ proves_age: false, granted: false });
    expect(await decide("tenant_result_test_mode.json")).toMatchObject({ test: true, granted: false });
    // The runtime tool has no opt-in: an extra argument does not turn one on.
    const test = await callResult({ ...ask, allow_test_results: true }, api(fixture("tenant_result_test_mode.json")));
    expect(test["access"]).toMatchObject({ granted: false });
  });

  it("refuses half an access check with INVALID_ACCESS_CHECK and sends nothing", async () => {
    const f = api({});
    expect(await callResult({ token: "xtk_1", required_min_age: 21 }, f)).toMatchObject({ code: "INVALID_ACCESS_CHECK" });
    expect(f).not.toHaveBeenCalled();
  });
});
