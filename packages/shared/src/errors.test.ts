import { describe, expect, it } from "vitest";
import { toAgentError } from "./errors.js";
import { explainReason, knownReasons } from "./reasons.js";

describe("toAgentError", () => {
  it("gives billing-specific guidance for an exhausted allowance", () => {
    const e = toAgentError(402, { code: "ALLOWANCE_EXHAUSTED", message: "out of allowance" });
    expect(e.code).toBe("ALLOWANCE_EXHAUSTED");
    expect(e.retryable).toBe(false);
    expect(e.fix).toContain("prepaid pack");
  });

  it("distinguishes a budget stop from an allowance stop, because the remedies differ", () => {
    expect(toAgentError(402, { code: "BUDGET_EXCEEDED" }).fix)
      .not.toEqual(toAgentError(402, { code: "ALLOWANCE_EXHAUSTED" }).fix);
  });

  it("marks 429 and 5xx retryable, and 4xx not", () => {
    expect(toAgentError(429, {}).retryable).toBe(true);
    expect(toAgentError(503, {}).retryable).toBe(true);
    expect(toAgentError(400, {}).retryable).toBe(false);
  });

  it("reads a nested error object", () => {
    expect(toAgentError(403, { error: { code: "INSUFFICIENT_SCOPE", message: "nope" } }).code)
      .toBe("INSUFFICIENT_SCOPE");
  });

  it("survives a null body", () => {
    expect(toAgentError(500, null).code).toBe("HTTP_500");
  });
});

describe("explainReason", () => {
  it("explains every reason the API can emit", () => {
    for (const r of knownReasons()) {
      const e = explainReason(r);
      expect(e.meaning.length).toBeGreaterThan(0);
      expect(e.fix.length).toBeGreaterThan(0);
    }
  });

  it("marks a correct refusal as not retryable, so an agent does not loop on it", () => {
    expect(explainReason("age_below_threshold").retryable).toBe(false);
    expect(explainReason("blacklist_match").retryable).toBe(false);
  });

  it("marks capture problems retryable by the end user", () => {
    expect(explainReason("liveness_failed")).toMatchObject({ retryable: true, actor: "end_user" });
  });

  it("degrades honestly on an unknown code rather than inventing a meaning", () => {
    const e = explainReason("something_new_from_the_server");
    expect(e.retryable).toBe(false);
    expect(e.meaning).toContain("not in the local table");
  });
});
