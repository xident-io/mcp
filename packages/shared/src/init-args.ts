import { toAgentError, type AgentError } from "./errors.js";

/**
 * The rules POST /verify/v1/init applies to a session's settings, checked
 * before the request is sent.
 *
 * The API is the authority and applies the same rules itself (api PR #44,
 * plans/requirements-check-trusted-params.md version 4, Part 1 and Part 1c).
 * The tools check them first so an agent gets the refusal without a network
 * call, with the same code and message the API would send. The tools never
 * round the age themselves: the API is the one place that turns 19 into 21.
 */

/** The youngest minimum age a session may ask for. */
export const MIN_AGE_FLOOR = 12;
/** The oldest minimum age a session may ask for. */
export const MIN_AGE_CEILING = 25;

/** Tool input description of `min_age`, shared by both servers. */
export const MIN_AGE_DESCRIPTION =
  "Required for age_verification: a whole number from 12 to 25. Xident rounds it up to the next of " +
  "12, 15, 18, 21 or 25 and enforces that band, so 19 is enforced as 21. An id_verification takes no " +
  "age: leave it out or send 0. Any other value is refused with INVALID_MIN_AGE.";

/** Tool input description of `purpose`, shared by both servers. */
export const PURPOSE_DESCRIPTION =
  "One of: age_verification (default) or id_verification. An id_verification always needs a document " +
  "and a face match, and takes no min_age. Any other value is refused with INVALID_PURPOSE.";

/** Tool input description of `verification_mode`, shared by both servers. */
export const VERIFICATION_MODE_DESCRIPTION =
  "One of: auto (default), document (an ID document and a face match are always required), or facial " +
  "(on-device only, never a document). facial cannot be combined with purpose id_verification, " +
  "which always needs a document. Any other value is refused with INVALID_VERIFICATION_MODE.";

/** Tool input description of `callback_url`, shared by both servers. */
export const CALLBACK_URL_DESCRIPTION =
  "REQUIRED. Where the widget returns the person after the flow: HTTPS, or http://localhost in " +
  "development. A missing one is refused with MISSING_CALLBACK_URL.";

/** Tool input description of `user_id` for the runtime tool. */
export const USER_ID_DESCRIPTION =
  "REQUIRED. Your own identifier for the person being verified. It comes back on the callback and in " +
  "the result. Must not be a Xident key or token. A missing or blank one is refused with MISSING_USER_ID.";

/** The API's messages, copied so a local refusal reads exactly like the API's. */
export const MISSING_CALLBACK_URL_MESSAGE = "callback_url is required";
export const MISSING_USER_ID_MESSAGE =
  "user_id is required: pass your own identifier for the person being verified";
export const INVALID_MIN_AGE_MESSAGE =
  "min_age must be between 12 and 25; it is rounded up to the next of 12, 15, 18, 21 or 25 " +
  "(19 is enforced as 21). An id_verification takes no min_age.";
export const ID_VERIFICATION_FACIAL_MESSAGE =
  "verification_mode facial cannot be combined with purpose id_verification, which always requires a document";
export const INVALID_PURPOSE_MESSAGE = "purpose must be 'age_verification' or 'id_verification'";
export const INVALID_VERIFICATION_MODE_MESSAGE = "verification_mode must be one of: auto, document, facial";

const PURPOSES = ["age_verification", "id_verification"];
const VERIFICATION_MODES = ["auto", "document", "facial"];

function refuse(code: string, message: string): AgentError {
  // Status 400 is what the API answers for each of these codes, so an agent
  // sees one shape whether the refusal came from here or from the API.
  return toAgentError(400, { code, message });
}

function isBlank(v: unknown): boolean {
  return typeof v !== "string" || v.trim() === "";
}

/** Absent, or the empty string the API also reads as "not sent". */
function isUnset(v: unknown): boolean {
  return v === undefined || v === "";
}

/**
 * Return the refusal the API would give for these init settings, or null when
 * the API's settings rules accept them.
 *
 * `args` is the request body exactly as it will be sent: a missing key means
 * the field is not sent. The checks run in the API's own order (init.go), so
 * an input with two problems gets the code the API would give first.
 *
 * The tools' input schemas are deliberately loose about these fields (types
 * only, no required list, no bounds): the MCP SDK refuses a schema failure
 * with its own text before the tool runs, so a strict schema would hide these
 * codes from a real tools/call.
 */
export function checkInitArgs(args: Readonly<Record<string, unknown>>): AgentError | null {
  if (isBlank(args["callback_url"])) {
    return refuse("MISSING_CALLBACK_URL", MISSING_CALLBACK_URL_MESSAGE);
  }
  if (isBlank(args["user_id"])) {
    return refuse("MISSING_USER_ID", MISSING_USER_ID_MESSAGE);
  }

  const purpose = args["purpose"];
  if (!isUnset(purpose) && !PURPOSES.includes(purpose as string)) {
    return refuse("INVALID_PURPOSE", INVALID_PURPOSE_MESSAGE);
  }
  const isIdVerification = purpose === "id_verification";

  const minAge = args["min_age"];
  if (isIdVerification) {
    // An ID verification has no age threshold: 0 or nothing.
    if (minAge !== undefined && minAge !== 0) {
      return refuse("INVALID_MIN_AGE", INVALID_MIN_AGE_MESSAGE);
    }
  } else if (
    // Any other purpose is an age verification: the age is required and
    // must be a whole number from 12 to 25.
    typeof minAge !== "number" ||
    !Number.isInteger(minAge) ||
    minAge < MIN_AGE_FLOOR ||
    minAge > MIN_AGE_CEILING
  ) {
    return refuse("INVALID_MIN_AGE", INVALID_MIN_AGE_MESSAGE);
  }

  const mode = args["verification_mode"];
  if (!isUnset(mode) && !VERIFICATION_MODES.includes(mode as string)) {
    return refuse("INVALID_VERIFICATION_MODE", INVALID_VERIFICATION_MODE_MESSAGE);
  }
  if (isIdVerification && mode === "facial") {
    return refuse("INVALID_VERIFICATION_MODE", ID_VERIFICATION_FACIAL_MESSAGE);
  }
  return null;
}
