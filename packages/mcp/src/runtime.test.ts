import { describe, expect, it, vi } from "vitest";
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
