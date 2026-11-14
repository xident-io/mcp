import { z } from "zod";
import {
  accessCheck, CALLBACK_URL_DESCRIPTION, checkInitArgs, EXPECTED_USER_ID_DESCRIPTION, MIN_AGE_DESCRIPTION,
  PURPOSE_DESCRIPTION, readAccessArgs, REQUIRED_MIN_AGE_DESCRIPTION, RESULT_TOOL_GUIDANCE, USER_ID_DESCRIPTION,
  VERIFICATION_MODE_DESCRIPTION, XidentClient,
} from "@xident/mcp-shared";
import type { ZodRawShape } from "zod";

/** A runtime tool, gated on the scope its caller must hold. */
export interface RuntimeTool<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** The scope a token must carry for this tool to be offered or callable. */
  scope: string;
  inputSchema: Shape;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  handler: (args: Record<string, unknown>, client: XidentClient) => Promise<unknown>;
}

const getVerificationResult: RuntimeTool = {
  name: "xident_get_verification_result",
  title: "Read a verification result",
  description: "Fetch Xident's verdict for a verification token. " + RESULT_TOOL_GUIDANCE,
  scope: "verification:read",
  // Types only for the access-check fields, so readAccessArgs's code reaches
  // a real tools/call. No test-verdict opt-in here: this server acts for a
  // live tenant, where a test-key verdict never grants anything.
  inputSchema: {
    token: z.string().min(1).describe("The verification token, e.g. xtk_..."),
    expected_user_id: z.string().optional().describe(EXPECTED_USER_ID_DESCRIPTION),
    required_min_age: z.number().optional().describe(REQUIRED_MIN_AGE_DESCRIPTION),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, client) => {
    const access = readAccessArgs({ expected_user_id: args["expected_user_id"], required_min_age: args["required_min_age"] });
    if (access && "error" in access) return access;
    const res = await client.request<Record<string, unknown>>(
      "GET", `/verify/v1/result/${encodeURIComponent(String(args["token"] ?? ""))}`);
    if (!res.ok) return res.error;
    if (!access) return res.data;
    return { ...res.data, access: accessCheck(res.data, access.userId, access.requiredMinAge) };
  },
};

const startVerification: RuntimeTool = {
  name: "xident_start_verification",
  title: "Start a verification",
  description:
    "Create a verification session and return a URL for a person to complete. " +
    "The person must open the URL themselves; there is no way to verify someone without their participation.",
  scope: "verification:write",
  // The settings fields carry types only: no required list, no bounds, no
  // enums. The MCP SDK refuses a schema failure with its own text before the
  // handler runs, so a strict schema would hide the API's codes
  // (MISSING_USER_ID, INVALID_MIN_AGE, ...) from a real tools/call. The
  // handler applies the API's rules (checkInitArgs) and the descriptions say
  // which fields are required.
  inputSchema: {
    min_age: z.number().optional().describe(MIN_AGE_DESCRIPTION),
    purpose: z.string().optional().describe(PURPOSE_DESCRIPTION),
    verification_mode: z.string().optional().describe(VERIFICATION_MODE_DESCRIPTION),
    callback_url: z.string().optional().describe(CALLBACK_URL_DESCRIPTION),
    user_id: z.string().optional().describe(USER_ID_DESCRIPTION),
    idempotency_key: z.string().min(1).describe(
      "REQUIRED. A stable key for this logical request. Retrying with the same key returns the same session " +
      "instead of creating a second one."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, client) => {
    const body: Record<string, unknown> = {};
    for (const k of ["min_age", "purpose", "verification_mode", "callback_url", "user_id"]) {
      if (args[k] !== undefined) body[k] = args[k];
    }
    // The API refuses these settings too. Checking first gives the agent the
    // same refusal without a request.
    const problem = checkInitArgs(body);
    if (problem) return problem;
    const res = await client.request<Record<string, unknown>>("POST", "/verify/v1/init", {
      body,
      idempotencyKey: String(args["idempotency_key"] ?? ""),
    });
    return res.ok ? res.data : res.error;
  },
};

const verifyFace2FA: RuntimeTool = {
  name: "xident_verify_face_2fa",
  title: "Verify a face against a 2FA enrollment",
  description:
    "Check a supplied face image against an existing 2FA enrollment. Returns a challenge to poll. " +
    "Cannot enrol a new face and cannot delete an enrollment — both require a human.",
  scope: "2fa:verify",
  inputSchema: {
    user_id: z.string().min(1).describe("Your identifier for the enrolled person"),
    image: z.string().min(1).describe("Base64-encoded image of the face to check"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (args, client) => {
    const res = await client.request<Record<string, unknown>>("POST", "/verify/v1/2fa/verify", {
      body: { user_id: args["user_id"], image: args["image"] },
    });
    return res.ok ? res.data : res.error;
  },
};

const listBlacklist: RuntimeTool = {
  name: "xident_list_blacklist",
  title: "List blacklist entries",
  description:
    "List this tenant's fraud blacklist entries. Read only — entries cannot be added or removed through " +
    "this server, by any credential.",
  scope: "blacklist:read",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (_args, client) => {
    const res = await client.request<unknown>("GET", "/verify/v1/blacklist");
    return res.ok ? res.data : res.error;
  },
};

/**
 * Every runtime tool, in a stable order.
 *
 * There is deliberately no tool here for deleting a 2FA enrollment, writing to
 * the blacklist, or changing billing. That is not an oversight and not a
 * backlog item — those operations have no scope in the vocabulary, and the API
 * refuses them for agent credentials regardless of what this server offers.
 */
export const RUNTIME_TOOLS: readonly RuntimeTool[] = [
  getVerificationResult,
  startVerification,
  verifyFace2FA,
  listBlacklist,
];

/** The tools a caller holding these scopes may see and use. */
export function toolsForScopes(scopes: readonly string[]): readonly RuntimeTool[] {
  return RUNTIME_TOOLS.filter((t) => scopes.includes(t.scope));
}
