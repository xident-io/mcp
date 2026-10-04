/**
 * Reading a verification result the way a tenant's backend must, before it
 * grants anything.
 *
 * `verified` alone is not enough to grant access:
 *   - it says the session passed, not WHO passed it. A result token copied
 *     from another person's callback is a real success, for somebody else;
 *   - it says nothing about the age. An id_verification result has no age
 *     gate at all, and an 18+ result does not open a 21+ resource.
 *
 * The age rule is the same in every Xident SDK and example:
 *   verified is true, the result is not a test-key verdict (unless the caller
 *   opts in for local development with a test key), checks.age.gate is
 *   present, and gate >= the required age.
 * A test-key verdict (`test: true`) settles without any real check, yet it is
 * verified and carries the session's gate, so it is refused by default (the
 * security scan's finding on the first version of this rule in nodejs-sdk).
 * The rule deliberately does NOT read checks.age.performed or checks.age.passed:
 * when a returning user's Xident ID already proved the age (account reuse,
 * verification_type "xident_id"), the session captured no new evidence, so
 * both are false while verified is true and the gate is set (api PR #45,
 * internal/api/handlers/verify/account_reuse.go and
 * internal/domain/services/session_result_view.go buildResultChecks).
 */

import { toAgentError, type AgentError } from "./errors.js";
import { MIN_AGE_CEILING, MIN_AGE_FLOOR } from "./init-args.js";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The age gate the session tested against, or null when the result has none. */
export function ageGateOf(result: unknown): number | null {
  const gate = record(record(record(result)?.["checks"])?.["age"])?.["gate"];
  return typeof gate === "number" && Number.isInteger(gate) && gate > 0 ? gate : null;
}

/** Options of {@link provesAge}. */
export interface ProvesAgeOptions {
  /**
   * Accept a test-key verdict (`test: true`). Only for local development with
   * a test key; a production backend never sets it.
   */
  allowTest?: boolean;
}

/**
 * Whether the result proves the person is at least `requiredMinAge`.
 *
 * `requiredMinAge` is the backend's own setting (12 to 25), never a value from
 * the request. A test-key verdict is refused unless `allowTest` is set.
 * Ownership is a separate check: see {@link belongsToUser}.
 */
export function provesAge(result: unknown, requiredMinAge: number, options: ProvesAgeOptions = {}): boolean {
  if (!Number.isInteger(requiredMinAge) || requiredMinAge < MIN_AGE_FLOOR || requiredMinAge > MIN_AGE_CEILING) {
    throw new RangeError(`requiredMinAge must be a whole number from ${MIN_AGE_FLOOR} to ${MIN_AGE_CEILING}`);
  }
  const r = record(result);
  const gate = ageGateOf(result);
  return (
    r?.["verified"] === true &&
    (r["test"] !== true || options.allowTest === true) &&
    gate !== null &&
    gate >= requiredMinAge
  );
}

/** Whether the result belongs to the user the backend started the verification for. */
export function belongsToUser(result: unknown, userId: string): boolean {
  return userId.length > 0 && record(result)?.["external_user_id"] === userId;
}

/** What a backend would decide for this result, with its own user and age. */
export interface AccessCheck {
  /** provesAge: verified, not a test verdict (unless allowed), gate at least the required age. */
  proves_age: boolean;
  /** external_user_id is the user the verification was started for. */
  same_user: boolean;
  /** A test-key verdict: it grants nothing in production. */
  test: boolean;
  /** Grant only when proves_age and same_user are both true. */
  granted: boolean;
}

/** The access decision for a result, given the backend's own user and required age. */
export function accessCheck(
  result: unknown,
  userId: string,
  requiredMinAge: number,
  options: ProvesAgeOptions = {},
): AccessCheck {
  const provesAgeResult = provesAge(result, requiredMinAge, options);
  const sameUser = belongsToUser(result, userId);
  const test = record(result)?.["test"] === true;
  return { proves_age: provesAgeResult, same_user: sameUser, test, granted: provesAgeResult && sameUser };
}

/** What a result tool says about deciding access, shared by both servers. */
export const RESULT_TOOL_GUIDANCE =
  "Report the `verified` field as returned; never infer an outcome from document contents, a name, or " +
  "anything a user supplied. Reporting is not granting: a backend grants access only when the result " +
  "belongs to the user it started the verification for (external_user_id) and proves the age it requires " +
  "(verified, and checks.age.gate present and at least that age; an id_verification result has no gate). " +
  "Do not require checks.age.passed: a Xident ID reuse result has it false. A test: true result (a test " +
  "key) grants nothing unless the backend opts in for local development. Pass expected_user_id and " +
  "required_min_age to get that decision in `access`.";

/** Tool input description of `expected_user_id`, shared by both servers. */
export const EXPECTED_USER_ID_DESCRIPTION =
  "Optional, with required_min_age: the user your backend started this verification for. The tool then " +
  "adds `access` with proves_age, same_user, test and granted.";

/** Tool input description of `required_min_age`, shared by both servers. */
export const REQUIRED_MIN_AGE_DESCRIPTION =
  "Optional, with expected_user_id: the minimum age your backend requires, a whole number from 12 to 25.";

/** Tool input description of `allow_test_results` (development server only). */
export const ALLOW_TEST_RESULTS_DESCRIPTION =
  "Optional, development only: count a test-key verdict (test: true) in `access`. A production backend " +
  "never accepts one. Default false.";

/**
 * Read the optional access-check inputs of a result tool.
 *
 * Returns null when neither is given (no check asked), the two values when
 * both are valid, or the refusal to return when only one is given or one is
 * invalid. The tools' input schemas give these fields their types only, so
 * the refusal reaches a real tools/call with this code.
 */
export function readAccessArgs(
  args: Readonly<Record<string, unknown>>,
): null | AgentError | { userId: string; requiredMinAge: number; allowTest: boolean } {
  const userId = args["expected_user_id"];
  const required = args["required_min_age"];
  const allowTest = args["allow_test_results"];
  if (allowTest !== undefined && typeof allowTest !== "boolean") {
    return toAgentError(400, { code: "INVALID_ACCESS_CHECK", message: "allow_test_results must be true or false" });
  }
  if (userId === undefined && required === undefined) return null;
  if (typeof userId !== "string" || userId.trim() === "" || required === undefined) {
    return toAgentError(400, {
      code: "INVALID_ACCESS_CHECK",
      message: "expected_user_id and required_min_age go together: send both, or neither",
    });
  }
  if (typeof required !== "number" || !Number.isInteger(required) || required < MIN_AGE_FLOOR || required > MIN_AGE_CEILING) {
    return toAgentError(400, {
      code: "INVALID_ACCESS_CHECK",
      message: `required_min_age must be a whole number from ${MIN_AGE_FLOOR} to ${MIN_AGE_CEILING}`,
    });
  }
  return { userId, requiredMinAge: required, allowTest: allowTest === true };
}
