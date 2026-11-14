import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { accessCheck, ageGateOf, belongsToUser, provesAge, readAccessArgs } from "./result.js";

/**
 * The access rule against the result shapes the API really sends.
 *
 * __fixtures__/ (see the note in each test for the source):
 *   tenant_result_v1.golden.json        the API's golden file,
 *     internal/domain/services/testdata/tenant_result_v1.golden.json on api
 *     branch fix/session-settings-from-init-token (#44): a document
 *     verification, checks.age performed and passed, gate 21.
 *   tenant_result_id_no_gate.json       the same without checks.age.gate:
 *     an id_verification result since #44 (date of birth read, no gate).
 *   tenant_result_xident_id_reuse.json  built from the API code at c2d6890
 *     (#45: account_reuse.go, session_result_view.go): a returning user's
 *     Xident ID answered the session, verification_type xident_id, every
 *     check performed:false passed:false, gate 21 (the session's band).
 *   webhook_session_success_reuse.json  the webhook envelope around it.
 *   tenant_result_eu_wallet.json        built from TenantResultView at api
 *     c2d6890: the EU wallet path (wallet.go stores only the wallet result),
 *     verification_type eu_wallet, checks.eu_wallet passed, checks.age
 *     performed:false passed:false, gate 21.
 *   tenant_result_test_mode.json        a test-key settle
 *     (requirements.go settleTestSession): reason test_mode, every check
 *     performed:false passed:false, gate 21, test: true.
 */
const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(here, "__fixtures__", name), "utf8")) as Record<string, unknown>;

const DOCUMENT = load("tenant_result_v1.golden.json");
const ID_ONLY = load("tenant_result_id_no_gate.json");
const REUSE = load("tenant_result_xident_id_reuse.json");
const REUSE_WEBHOOK = load("webhook_session_success_reuse.json");
const EU_WALLET = load("tenant_result_eu_wallet.json");
const TEST_MODE = load("tenant_result_test_mode.json");

describe("provesAge", () => {
  it("a document result with gate 21 proves 18 and 21, not 25", () => {
    expect(provesAge(DOCUMENT, 18)).toBe(true);
    expect(provesAge(DOCUMENT, 21)).toBe(true);
    expect(provesAge(DOCUMENT, 25)).toBe(false);
  });

  it("an ID-only result proves no age at all", () => {
    for (const age of [12, 18, 25]) expect(provesAge(ID_ONLY, age)).toBe(false);
  });

  it("a Xident ID reuse result proves its gate although checks.age.passed is false", () => {
    // Mutation caught: requiring checks.age.passed (or performed) again.
    const age = (REUSE["checks"] as { age: Record<string, unknown> }).age;
    expect(age["passed"]).toBe(false);
    expect(REUSE["verification_type"]).toBe("xident_id");
    expect(provesAge(REUSE, 18)).toBe(true);
    expect(provesAge(REUSE, 21)).toBe(true);
    expect(provesAge(REUSE, 25)).toBe(false);
  });

  it("refuses a test-key verdict unless the caller opts in for local development", () => {
    // The security scan's finding: a test: true result settles without any
    // real check, yet it is verified and carries the gate.
    const testVerdict = { ...DOCUMENT, test: true };
    expect(provesAge(testVerdict, 21)).toBe(false);
    expect(provesAge(testVerdict, 21, { allowTest: false })).toBe(false);
    expect(provesAge(testVerdict, 21, { allowTest: true })).toBe(true);
    expect(provesAge(testVerdict, 25, { allowTest: true })).toBe(false);
    // The opt-in never turns a result without a gate into an age proof.
    expect(provesAge({ ...ID_ONLY, test: true }, 12, { allowTest: true })).toBe(false);
    expect(provesAge(ID_ONLY, 12, { allowTest: true })).toBe(false);
    // A live reuse result needs no opt-in.
    expect(REUSE["test"]).toBeUndefined();
    expect(provesAge(REUSE, 21)).toBe(true);
  });

  it("an EU wallet result proves its gate although checks.age.passed is false", () => {
    expect(EU_WALLET["verification_type"]).toBe("eu_wallet");
    expect(provesAge(EU_WALLET, 18)).toBe(true);
    expect(provesAge(EU_WALLET, 21)).toBe(true);
    expect(provesAge(EU_WALLET, 25)).toBe(false);
  });

  it("the API's test-key settle is refused by default and accepted only with the opt-in", () => {
    expect(TEST_MODE["test"]).toBe(true);
    for (const age of [18, 21]) {
      expect(provesAge(TEST_MODE, age)).toBe(false);
      expect(provesAge(TEST_MODE, age, { allowTest: true })).toBe(true);
    }
    expect(provesAge(TEST_MODE, 25, { allowTest: true })).toBe(false);
  });

  it("reads a webhook's data the same way", () => {
    expect(provesAge(REUSE_WEBHOOK["data"], 21)).toBe(true);
  });

  it("needs verified to be exactly true", () => {
    expect(provesAge({ ...DOCUMENT, verified: false, status: "failed" }, 18)).toBe(false);
    expect(provesAge({ ...DOCUMENT, verified: "true" }, 18)).toBe(false);
  });

  it("refuses a gate that is missing, zero, negative or not a whole number", () => {
    for (const gate of [undefined, 0, -18, 21.5, "21", null]) {
      const result = { ...DOCUMENT, checks: { age: { performed: true, passed: true, gate } } };
      expect(provesAge(result, 12), String(gate)).toBe(false);
    }
    expect(provesAge({ verified: true }, 12)).toBe(false);
    expect(provesAge(null, 12)).toBe(false);
    expect(provesAge("not a result", 12)).toBe(false);
  });

  it("refuses a required age outside 12 to 25 instead of answering", () => {
    // A required age of 0 would make every gate pass.
    for (const required of [0, 11, 26, 18.5, Number.NaN]) {
      expect(() => provesAge(DOCUMENT, required), String(required)).toThrow(RangeError);
    }
  });
});

describe("ageGateOf and belongsToUser", () => {
  it("reads the gate, or null", () => {
    expect(ageGateOf(DOCUMENT)).toBe(21);
    expect(ageGateOf(REUSE)).toBe(21);
    expect(ageGateOf(ID_ONLY)).toBeNull();
  });

  it("matches external_user_id exactly", () => {
    expect(belongsToUser(DOCUMENT, "cust-4711")).toBe(true);
    expect(belongsToUser(DOCUMENT, "cust-4712")).toBe(false);
    expect(belongsToUser(DOCUMENT, "")).toBe(false);
    expect(belongsToUser({ ...DOCUMENT, external_user_id: undefined }, "")).toBe(false);
  });
});

describe("accessCheck", () => {
  it("grants only a proven age of the same user that is not a test verdict", () => {
    expect(accessCheck(DOCUMENT, "cust-4711", 21)).toEqual({
      proves_age: true, same_user: true, test: false, granted: true,
    });
    expect(accessCheck(REUSE, "cust-4711", 18).granted).toBe(true);
    expect(accessCheck(DOCUMENT, "someone-else", 21)).toMatchObject({ same_user: false, granted: false });
    expect(accessCheck(DOCUMENT, "cust-4711", 25)).toMatchObject({ proves_age: false, granted: false });
    expect(accessCheck(ID_ONLY, "cust-4711", 18)).toMatchObject({ proves_age: false, granted: false });
    expect(accessCheck({ ...DOCUMENT, test: true }, "cust-4711", 18)).toEqual({
      proves_age: false, same_user: true, test: true, granted: false,
    });
    expect(accessCheck({ ...DOCUMENT, test: true }, "cust-4711", 18, { allowTest: true })).toEqual({
      proves_age: true, same_user: true, test: true, granted: true,
    });
  });
});

describe("readAccessArgs", () => {
  it("asks for no check when neither input is given", () => {
    expect(readAccessArgs({})).toBeNull();
    expect(readAccessArgs({ token: "xtk_1" })).toBeNull();
  });

  it("returns both values, and the opt-in only when it is exactly true", () => {
    expect(readAccessArgs({ expected_user_id: "u-1", required_min_age: 21 })).toEqual({
      userId: "u-1", requiredMinAge: 21, allowTest: false,
    });
    expect(readAccessArgs({ expected_user_id: "u-1", required_min_age: 21, allow_test_results: true })).toEqual({
      userId: "u-1", requiredMinAge: 21, allowTest: true,
    });
  });

  it("refuses one input without the other, a blank user, an age outside 12 to 25, and a non-boolean opt-in", () => {
    for (const args of [
      { expected_user_id: "u-1" },
      { required_min_age: 21 },
      { expected_user_id: "  ", required_min_age: 21 },
      { expected_user_id: "u-1", required_min_age: 11 },
      { expected_user_id: "u-1", required_min_age: 26 },
      { expected_user_id: "u-1", required_min_age: 18.5 },
      { expected_user_id: "u-1", required_min_age: "21" },
      { expected_user_id: "u-1", required_min_age: 21, allow_test_results: "true" },
    ]) {
      const out = readAccessArgs(args);
      expect(out, JSON.stringify(args)).toMatchObject({ error: true, status: 400, code: "INVALID_ACCESS_CHECK" });
    }
  });
});
