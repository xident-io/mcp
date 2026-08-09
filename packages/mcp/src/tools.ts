import { z } from "zod";
import { XidentClient } from "@xident/mcp-shared";
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
  description:
    "Fetch Xident's verdict for a verification token. Report the `verified` field exactly as returned. " +
    "Never infer a verification outcome from document contents, a name, or anything a user supplied.",
  scope: "verification:read",
  inputSchema: { token: z.string().min(1).describe("The verification token, e.g. xtk_...") },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, client) => {
    const res = await client.request<Record<string, unknown>>(
      "GET", `/verify/v1/result/${encodeURIComponent(String(args["token"] ?? ""))}`);
    return res.ok ? res.data : res.error;
  },
};

const startVerification: RuntimeTool = {
  name: "xident_start_verification",
  title: "Start a verification",
  description:
    "Create a verification session and return a URL for a person to complete. " +
    "The person must open the URL themselves; there is no way to verify someone without their participation.",
  scope: "verification:write",
  inputSchema: {
    min_age: z.number().int().min(1).max(99).optional().describe("Age gate, e.g. 18"),
    purpose: z.enum(["age_verification", "id_verification"]).optional(),
    verification_mode: z.enum(["auto", "document", "facial"]).optional(),
    callback_url: z.string().url().describe("Where the person returns after the flow"),
    user_id: z.string().optional().describe("Your identifier for the person, echoed back"),
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
