import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { XidentClient } from "@xident/mcp-shared";
import { configFromEnv, DEFAULTS } from "./config.js";
import { bearerFrom, effectiveScopes, resolveToken } from "./auth.js";
import { challengeHeader, protectedResourceMetadata, SUPPORTED_SCOPES } from "./prm.js";
import { RUNTIME_TOOLS, toolsForScopes } from "./tools.js";

const cfg = configFromEnv({});

describe("config", () => {
  it("defaults to the production identities", () => {
    expect(cfg.resourceUrl).toBe(DEFAULTS.resourceUrl);
    expect(cfg.issuer).toBe(DEFAULTS.issuer);
  });

  it("strips trailing slashes so the audience compares exactly", () => {
    // The audience is compared as a string against the token's own value; a
    // stray slash would fail every request for no visible reason.
    expect(configFromEnv({ XIDENT_MCP_RESOURCE_URL: "https://mcp.xident.io///" }).resourceUrl)
      .toBe("https://mcp.xident.io");
  });

  it("falls back to the default port on nonsense", () => {
    expect(configFromEnv({ PORT: "not-a-number" }).port).toBe(DEFAULTS.port);
  });
});

describe("protected resource metadata (RFC 9728)", () => {
  const md = protectedResourceMetadata(cfg);

  it("names itself as the resource", () => {
    expect(md.resource).toBe("https://mcp.xident.io");
  });

  it("points at the AGENT issuer, not the identity provider", () => {
    // Pointing at https://api.xident.io would send clients to the end-user
    // OIDC provider, whose tokens this server must never accept.
    expect(md.authorization_servers).toEqual(["https://api.xident.io/agent"]);
  });

  it("advertises only grantable scopes", () => {
    expect(md.scopes_supported).toEqual([...SUPPORTED_SCOPES]);
    for (const forbidden of ["2fa:delete", "blacklist:write", "billing:write"]) {
      expect(md.scopes_supported).not.toContain(forbidden);
    }
  });
});

describe("WWW-Authenticate challenge", () => {
  it("always carries the discovery pointer", () => {
    // Without resource_metadata a client holding only the server URL has
    // nowhere to begin a consent flow.
    expect(challengeHeader(cfg)).toContain('resource_metadata="https://mcp.xident.io/.well-known/oauth-protected-resource"');
  });

  it("names the required scope so a client can ask for the right thing", () => {
    const h = challengeHeader(cfg, { error: "insufficient_scope", scope: "verification:read" });
    expect(h).toContain('error="insufficient_scope"');
    expect(h).toContain('scope="verification:read"');
  });
});

describe("bearerFrom", () => {
  it.each([
    ["Bearer abc123", "abc123"],
    ["bearer abc123", "abc123"],
    ["Basic abc123", null],
    ["Bearer", null],
    ["Bearer   ", null],
    ["", null],
    [undefined, null],
  ])("parses %s", (header, expected) => {
    expect(bearerFrom(header as string | undefined)).toBe(expected);
  });
});

describe("runtime tool surface", () => {
  it("exposes exactly the four planned tools", () => {
    expect(RUNTIME_TOOLS.map((t) => t.name)).toEqual([
      "xident_get_verification_result",
      "xident_start_verification",
      "xident_verify_face_2fa",
      "xident_list_blacklist",
    ]);
  });

  it("offers no tool for deletion, blacklist writes, or billing", () => {
    // Spec §4.3, enforced rather than promised.
    const names = RUNTIME_TOOLS.map((t) => t.name).join(" ");
    for (const word of ["delete", "remove", "enroll", "register", "billing", "budget"]) {
      expect(names).not.toContain(word);
    }
  });

  it("maps every tool to a real scope", () => {
    for (const t of RUNTIME_TOOLS) {
      expect(SUPPORTED_SCOPES).toContain(t.scope as never);
    }
  });

  it("hides tools the caller's scopes do not cover", () => {
    const readOnly = toolsForScopes(["verification:read"]);
    expect(readOnly.map((t) => t.name)).toEqual(["xident_get_verification_result"]);
  });

  it("shows nothing for an empty scope set", () => {
    expect(toolsForScopes([])).toHaveLength(0);
  });

  it("requires an idempotency key on the one tool that creates something", () => {
    const start = RUNTIME_TOOLS.find((t) => t.name === "xident_start_verification")!;
    // Required, not optional: an agent retries by nature, and without a key a
    // retry produces a second session and a second link for one person.
    expect(Object.keys(start.inputSchema)).toContain("idempotency_key");
    expect(start.inputSchema["idempotency_key"]!.isOptional()).toBe(false);
  });

  it("marks read tools read-only and no tool destructive", () => {
    for (const t of RUNTIME_TOOLS) {
      expect(t.annotations.destructiveHint).toBe(false);
    }
    expect(RUNTIME_TOOLS.find((t) => t.name === "xident_list_blacklist")!.annotations.readOnlyHint).toBe(true);
  });

  it("tells the agent not to infer a verdict", () => {
    const read = RUNTIME_TOOLS.find((t) => t.name === "xident_get_verification_result")!;
    expect(read.description).toMatch(/never infer/i);
  });
});

describe("resolveToken", () => {
  function jsonRes(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  it("returns the scopes the API reports", async () => {
    const f = vi.fn(async () => jsonRes(200, { success: true, data: { scopes: ["verification:read"], unrestricted: false } }));
    const out = await resolveToken(cfg, "xat_1", f as never);
    expect(out).toEqual({ ok: true, scopes: ["verification:read"], unrestricted: false });
  });

  it("forwards the bearer token to the API", async () => {
    const f = vi.fn(async () => jsonRes(200, { success: true, data: { scopes: [] } }));
    await resolveToken(cfg, "xat_secret", f as never);
    const init = f.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer xat_secret");
  });

  it("maps a 401 to invalid_token", async () => {
    const f = vi.fn(async () => jsonRes(401, {}));
    const out = await resolveToken(cfg, "xat_dead", f as never);
    expect(out).toMatchObject({ ok: false, status: 401, error: "invalid_token" });
  });

  it("fails closed when the API is unreachable", async () => {
    // Never fall back to "assume valid": the API is the only authority on
    // whether a token is live, and guessing would keep a revoked agent working
    // through an outage.
    const f = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const out = await resolveToken(cfg, "xat_1", f as never);
    expect(out.ok).toBe(false);
  });
});

describe("effectiveScopes", () => {
  it("gives an unrestricted credential every runtime tool", () => {
    const scopes = effectiveScopes({ ok: true, scopes: [], unrestricted: true }, SUPPORTED_SCOPES);
    expect(toolsForScopes(scopes)).toHaveLength(RUNTIME_TOOLS.length);
  });

  it("gives a scoped credential only what it holds", () => {
    const scopes = effectiveScopes({ ok: true, scopes: ["blacklist:read"], unrestricted: false }, SUPPORTED_SCOPES);
    expect(toolsForScopes(scopes).map((t) => t.name)).toEqual(["xident_list_blacklist"]);
  });
});

describe("xident_start_verification settings (api PR #44)", () => {
  const start = RUNTIME_TOOLS.find((t) => t.name === "xident_start_verification")!;
  const schema = z.object(start.inputSchema);
  const valid = {
    callback_url: "https://example.com/done",
    user_id: "u-1",
    min_age: 18,
    idempotency_key: "k-1",
  };

  function jsonRes(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  function clientWith(f: ReturnType<typeof vi.fn>): XidentClient {
    return new XidentClient({ baseUrl: "https://api.test", apiKey: "xat_1", fetchImpl: f as never });
  }

  it("publishes the settings fields with types only, so the handler sees every value", () => {
    // A strict schema makes the MCP SDK refuse with its own text before the
    // handler runs, which hid MISSING_USER_ID and INVALID_MIN_AGE from a real
    // tools/call (Astra finding 3). Fails if a bound, an enum or a required
    // flag comes back on these fields.
    for (const field of ["user_id", "callback_url", "min_age", "purpose", "verification_mode"]) {
      expect(start.inputSchema[field]!.isOptional(), field).toBe(true);
    }
    const { user_id: _omit, ...withoutUser } = valid;
    expect(schema.safeParse(withoutUser).success).toBe(true);
    for (const minAge of [0, 11, 26, 99, 18.5]) {
      expect(schema.safeParse({ ...valid, min_age: minAge }).success, String(minAge)).toBe(true);
    }
    expect(schema.safeParse({ ...valid, verification_mode: "manual", purpose: "kyc" }).success).toBe(true);
    // The tool's own rule stays in the schema.
    const { idempotency_key: _k, ...withoutKey } = valid;
    expect(schema.safeParse(withoutKey).success).toBe(false);
  });

  it("says in the descriptions which fields are required", () => {
    expect(start.inputSchema["user_id"]!.description ?? "").toMatch(/^REQUIRED\./);
    expect(start.inputSchema["callback_url"]!.description ?? "").toMatch(/^REQUIRED\./);
    expect(start.inputSchema["user_id"]!.description ?? "").toContain("MISSING_USER_ID");
  });

  it("explains the band rounding and the id_verification rule to the agent", () => {
    const d = start.inputSchema["min_age"]!.description ?? "";
    expect(d).toContain("12 to 25");
    expect(d).toContain("19 is enforced as 21");
    expect(d).toContain("id_verification");
    expect(start.inputSchema["verification_mode"]!.description ?? "").toContain("facial cannot be combined");
  });

  it("sends the age as given, with the user_id, to POST /verify/v1/init", async () => {
    // Fails if the tool rounds locally, drops user_id, or changes the path.
    const f = vi.fn(async () => jsonRes(201, { success: true, data: { token: "xit_1", verify_url: "https://v/x" } }));
    const out = await start.handler({ ...valid, min_age: 19 }, clientWith(f));
    expect(out).toMatchObject({ token: "xit_1" });
    expect(f.mock.calls[0]![0]).toBe("https://api.test/verify/v1/init");
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      min_age: 19, callback_url: "https://example.com/done", user_id: "u-1",
    });
  });

  it("sends purpose and verification_mode as given", async () => {
    // Fails if either is dropped after the check (Astra finding 4): the API
    // would then make an age session, or use the rule's default mode.
    const f = vi.fn(async () => jsonRes(201, { success: true, data: { token: "xit_3" } }));
    await start.handler({ ...valid, min_age: 21, purpose: "age_verification", verification_mode: "document" }, clientWith(f));
    expect(JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body))).toEqual({
      min_age: 21, purpose: "age_verification", verification_mode: "document",
      callback_url: "https://example.com/done", user_id: "u-1",
    });
  });

  it.each([
    ["a blank user_id", { ...valid, user_id: "   " }, "MISSING_USER_ID"],
    ["an age verification with no min_age", { ...valid, min_age: undefined }, "INVALID_MIN_AGE"],
    ["an id verification with min_age 18", { ...valid, purpose: "id_verification" }, "INVALID_MIN_AGE"],
    ["an id verification with facial",
      { ...valid, min_age: undefined, purpose: "id_verification", verification_mode: "facial" },
      "INVALID_VERIFICATION_MODE"],
  ])("refuses %s without a request", async (_label, args, code) => {
    // Fails if the handler stops calling checkInitArgs before the request.
    const f = vi.fn(async () => jsonRes(201, {}));
    const out = await start.handler(args as Record<string, unknown>, clientWith(f)) as Record<string, unknown>;
    expect(out).toMatchObject({ error: true, status: 400, code });
    expect(f).not.toHaveBeenCalled();
  });

  it("lets an id verification with document through, purpose and mode intact", async () => {
    // Fails if purpose or verification_mode is dropped from the body after
    // the check, or if an age is added (Astra finding 4).
    const f = vi.fn(async () => jsonRes(201, { success: true, data: { token: "xit_2" } }));
    await start.handler(
      { ...valid, min_age: undefined, purpose: "id_verification", verification_mode: "document" }, clientWith(f));
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe("https://api.test/verify/v1/init");
    expect(JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body))).toEqual({
      purpose: "id_verification", verification_mode: "document",
      callback_url: "https://example.com/done", user_id: "u-1",
    });
  });

  it("lets an id verification with min_age 0 through, as the API accepts it", async () => {
    // Fails if the tool refuses the 0 the API accepts (Astra finding 2).
    const f = vi.fn(async () => jsonRes(201, { success: true, data: { token: "xit_4" } }));
    await start.handler({ ...valid, min_age: 0, purpose: "id_verification" }, clientWith(f));
    expect(JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body))).toEqual({
      min_age: 0, purpose: "id_verification", callback_url: "https://example.com/done", user_id: "u-1",
    });
  });
});
