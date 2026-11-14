import { describe, expect, it } from "vitest";
import {
  checkInitArgs, ID_VERIFICATION_FACIAL_MESSAGE, INVALID_MIN_AGE_MESSAGE, INVALID_PURPOSE_MESSAGE,
  INVALID_VERIFICATION_MODE_MESSAGE, MISSING_USER_ID_MESSAGE,
} from "./init-args.js";

const base = { callback_url: "https://example.com/done", user_id: "u-1" };

/**
 * The settings rules of POST /verify/v1/init (api PR #44), checked before a
 * request. Each case names the change to checkInitArgs that would make it fail.
 */
describe("checkInitArgs", () => {
  it("accepts an age verification at both ends of 12 to 25", () => {
    // Fails if the floor or the ceiling moves inward.
    expect(checkInitArgs({ ...base, min_age: 12 })).toBeNull();
    expect(checkInitArgs({ ...base, min_age: 25 })).toBeNull();
    expect(checkInitArgs({ ...base, min_age: 19 })).toBeNull();
  });

  it.each([
    ["11", 11],
    ["26", 26],
    ["0", 0],
    ["99, the old ceiling", 99],
    ["1, the old floor", 1],
    ["a fraction", 18.5],
    ["a numeric string", "18"],
  ])("refuses an age verification with min_age %s", (_label, minAge) => {
    // Fails if the range goes back to 1 to 99, or if non-integers pass.
    const out = checkInitArgs({ ...base, min_age: minAge });
    expect(out).toMatchObject({ error: true, status: 400, code: "INVALID_MIN_AGE", retryable: false });
    expect(out!.message).toBe(INVALID_MIN_AGE_MESSAGE);
  });

  it("refuses an age verification without min_age", () => {
    // Fails if a missing age is treated as "no age check".
    expect(checkInitArgs({ ...base })!.code).toBe("INVALID_MIN_AGE");
    expect(checkInitArgs({ ...base, purpose: "age_verification" })!.code).toBe("INVALID_MIN_AGE");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["spaces only", "   "],
    ["not a string", 42],
  ])("refuses a user_id that is %s", (_label, userId) => {
    // Fails if user_id goes back to optional, or if a blank one passes.
    const args: Record<string, unknown> = { callback_url: base.callback_url, min_age: 18 };
    if (userId !== undefined) args["user_id"] = userId;
    const out = checkInitArgs(args);
    expect(out).toMatchObject({ status: 400, code: "MISSING_USER_ID" });
    expect(out!.message).toBe(MISSING_USER_ID_MESSAGE);
  });

  it("refuses a missing or blank callback_url", () => {
    expect(checkInitArgs({ user_id: "u-1", min_age: 18 })!.code).toBe("MISSING_CALLBACK_URL");
    expect(checkInitArgs({ user_id: "u-1", min_age: 18, callback_url: " " })!.code).toBe("MISSING_CALLBACK_URL");
  });

  it("accepts an id verification with no min_age or with 0", () => {
    expect(checkInitArgs({ ...base, purpose: "id_verification" })).toBeNull();
    expect(checkInitArgs({ ...base, purpose: "id_verification", min_age: 0 })).toBeNull();
  });

  it("refuses an id verification with a minimum age", () => {
    // Fails if an ID verification accepts an age again (it stored 18 before).
    expect(checkInitArgs({ ...base, purpose: "id_verification", min_age: 18 })!.code).toBe("INVALID_MIN_AGE");
  });

  it("refuses an id verification with verification_mode facial", () => {
    // Fails if the pair is let through: facial would drop the document.
    const out = checkInitArgs({ ...base, purpose: "id_verification", verification_mode: "facial" });
    expect(out).toMatchObject({ status: 400, code: "INVALID_VERIFICATION_MODE" });
    expect(out!.message).toBe(ID_VERIFICATION_FACIAL_MESSAGE);
  });

  it("accepts an id verification with document or auto", () => {
    expect(checkInitArgs({ ...base, purpose: "id_verification", verification_mode: "document" })).toBeNull();
    expect(checkInitArgs({ ...base, purpose: "id_verification", verification_mode: "auto" })).toBeNull();
  });

  it("keeps facial for an age verification", () => {
    // Guard: only the ID pairing is refused.
    expect(checkInitArgs({ ...base, min_age: 18, verification_mode: "facial" })).toBeNull();
  });

  it.each([["manual"], ["Document"], ["documents"]])("refuses the unknown verification_mode %s", (mode) => {
    // Fails if an unknown mode is let through: the tools' schemas no longer
    // carry the enum, so this check is the only place it is refused.
    const out = checkInitArgs({ ...base, min_age: 18, verification_mode: mode });
    expect(out).toMatchObject({ status: 400, code: "INVALID_VERIFICATION_MODE" });
    expect(out!.message).toBe(INVALID_VERIFICATION_MODE_MESSAGE);
  });

  it("accepts every known verification_mode, and an empty one as not sent", () => {
    for (const mode of ["auto", "document", "facial", ""]) {
      expect(checkInitArgs({ ...base, min_age: 18, verification_mode: mode }), mode).toBeNull();
    }
  });

  it.each([["kyc"], ["age"], ["ID_VERIFICATION"]])("refuses the unknown purpose %s", (purpose) => {
    // Fails if an unknown purpose is read as an age verification.
    const out = checkInitArgs({ ...base, min_age: 18, purpose });
    expect(out).toMatchObject({ status: 400, code: "INVALID_PURPOSE" });
    expect(out!.message).toBe(INVALID_PURPOSE_MESSAGE);
  });

  it("reads an empty purpose as an age verification, as the API does", () => {
    expect(checkInitArgs({ ...base, purpose: "", min_age: 18 })).toBeNull();
    expect(checkInitArgs({ ...base, purpose: "" })!.code).toBe("INVALID_MIN_AGE");
  });

  it("gives the code the API gives first when two settings are wrong", () => {
    // The API checks purpose, then the age, then the mode (init.go).
    expect(checkInitArgs({ ...base, purpose: "kyc", min_age: 99 })!.code).toBe("INVALID_PURPOSE");
    expect(checkInitArgs({ ...base, min_age: 99, verification_mode: "manual" })!.code).toBe("INVALID_MIN_AGE");
    expect(checkInitArgs({ ...base, purpose: "id_verification", min_age: 18, verification_mode: "facial" })!.code)
      .toBe("INVALID_MIN_AGE");
    expect(checkInitArgs({ ...base, purpose: "id_verification", verification_mode: "manual" })!.message)
      .toBe(INVALID_VERIFICATION_MODE_MESSAGE);
  });

  it("gives every refusal a remedy an agent can act on", () => {
    for (const code of ["MISSING_USER_ID", "INVALID_MIN_AGE", "INVALID_VERIFICATION_MODE", "MISSING_CALLBACK_URL", "INVALID_PURPOSE"]) {
      const args: Record<string, unknown> =
        code === "MISSING_USER_ID" ? { callback_url: base.callback_url, min_age: 18 }
          : code === "INVALID_MIN_AGE" ? { ...base, min_age: 30 }
            : code === "INVALID_VERIFICATION_MODE" ? { ...base, purpose: "id_verification", verification_mode: "facial" }
              : code === "INVALID_PURPOSE" ? { ...base, purpose: "kyc", min_age: 18 }
                : { user_id: "u-1", min_age: 18 };
      const out = checkInitArgs(args)!;
      expect(out.code).toBe(code);
      // The default 400 text is generic; each code has its own remedy.
      expect(out.fix).not.toContain("Check the request body against the endpoint schema");
    }
  });
});
