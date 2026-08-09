import { describe, expect, it } from "vitest";
import { contextFromEnv } from "../context.js";
import { ALL_TOOLS, OFFLINE_TOOLS, toolsFor } from "./registry.js";

describe("registry", () => {
  it("exposes exactly the nine planned tools", () => {
    expect(ALL_TOOLS.map((t) => t.name)).toEqual([
      "xident_search_docs",
      "xident_get_endpoint",
      "xident_verify_webhook_signature",
      "xident_whoami",
      "xident_start_test_verification",
      "xident_get_result",
      "xident_explain_session",
      "xident_simulate_webhook",
      "xident_check_integration",
    ]);
  });

  it("has no duplicate tool names", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("namespaces every tool, so it cannot collide with another server's tools", () => {
    for (const t of ALL_TOOLS) expect(t.name.startsWith("xident_")).toBe(true);
  });

  it("offers four tools with no key configured", () => {
    const ctx = contextFromEnv({});
    expect(toolsFor(ctx).map((t) => t.name)).toEqual([
      "xident_search_docs",
      "xident_get_endpoint",
      "xident_verify_webhook_signature",
      "xident_explain_session",
    ]);
  });

  it("offers everything once a key is configured", () => {
    expect(toolsFor(contextFromEnv({ XIDENT_API_KEY: "sk_test_x" })).length).toBe(ALL_TOOLS.length);
  });

  it("marks every offline tool read-only", () => {
    for (const t of OFFLINE_TOOLS) expect(t.annotations.readOnlyHint).toBe(true);
  });

  it("marks no tool destructive, because none is exposed", () => {
    for (const t of ALL_TOOLS) expect(t.annotations.destructiveHint).toBe(false);
  });

  it("gives every tool a description long enough to trigger correctly", () => {
    for (const t of ALL_TOOLS) expect(t.description.length).toBeGreaterThan(60);
  });
});

describe("never-exposed rule", () => {
  // Spec §4.3. This test is the enforcement; the prose is only a reminder.
  const FORBIDDEN = ["delete", "remove", "blacklist_add", "enroll", "revoke", "purge"];

  it("exposes no tool whose name suggests deletion or fraud-control writes", () => {
    for (const t of ALL_TOOLS) {
      for (const word of FORBIDDEN) {
        expect(t.name.includes(word)).toBe(false);
      }
    }
  });

  it("exposes no tool that can reach a destructive route", () => {
    const source = ALL_TOOLS.map((t) => t.handler.toString()).join("\n");
    expect(source).not.toContain("/2fa/users/");
    expect(source).not.toContain("/blacklist");
    expect(source).not.toContain('"DELETE"');
  });
});
