import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  accessCheck, ALLOW_TEST_RESULTS_DESCRIPTION, CALLBACK_URL_DESCRIPTION, checkInitArgs,
  EXPECTED_USER_ID_DESCRIPTION, explainReason, keyKind, MIN_AGE_DESCRIPTION, PURPOSE_DESCRIPTION,
  readAccessArgs, REQUIRED_MIN_AGE_DESCRIPTION, RESULT_TOOL_GUIDANCE, VERIFICATION_MODE_DESCRIPTION,
} from "@xident/mcp-shared";
import type { DevContext } from "../context.js";
import { fail, ok, requireClient, type ToolDef } from "./types.js";

const SANDBOX_ONLY_FIX =
  "Configure XIDENT_API_KEY with a sandbox key (sk_test_... or ak_test_...). This server is for development; " +
  "point it at live credentials and it would create real, billable sessions.";

/** The scope a key needs to start a verification (POST /verify/v1/init). */
const START_SCOPE = "verification:write";

/**
 * Whether the configured key may start a verification, as the API sees it.
 *
 * A secret key (sk_) is unrestricted. An agent key (ak_) carries scopes, so
 * ask the API (GET /verify/v1/token-info, the same call the runtime server
 * uses to choose its tools) instead of guessing from the prefix: an ak_ key
 * with verification:write starts sessions exactly like an sk_ key.
 */
async function canStartVerifications(
  ctx: DevContext,
  kind: string,
): Promise<{ ok: boolean; detail: string; scopes: string[] | null }> {
  if (kind === "secret") {
    return { ok: true, detail: "Secret key (sk_): correct for server-to-server calls.", scopes: null };
  }
  if (kind !== "agent") {
    return {
      ok: false,
      detail: `Key kind is '${kind}'. Server-to-server calls need a server key: sk_, or ak_ with ${START_SCOPE}.`,
      scopes: null,
    };
  }
  const res = await ctx.client!.request<Record<string, unknown>>("GET", "/verify/v1/token-info");
  if (!res.ok) {
    return { ok: false, detail: `Could not read the agent key's scopes: ${res.error.code}: ${res.error.message}`, scopes: null };
  }
  const scopes = Array.isArray(res.data["scopes"]) ? res.data["scopes"].filter((x): x is string => typeof x === "string") : [];
  if (res.data["unrestricted"] === true || scopes.includes(START_SCOPE)) {
    return { ok: true, detail: `Agent key (ak_) with ${START_SCOPE}: can start verifications.`, scopes };
  }
  return {
    ok: false,
    detail: `Agent key (ak_) without ${START_SCOPE}: the API refuses POST /verify/v1/init with INSUFFICIENT_SCOPE. ` +
      `Create an agent key that holds ${START_SCOPE}.`,
    scopes,
  };
}

/** Refuse to act against live credentials. */
function requireSandbox(ctx: { sandbox: boolean; apiKey: string | null }) {
  if (!ctx.sandbox) {
    return fail("LIVE_KEY_REFUSED", "This tool refuses to run against a live API key.", SANDBOX_ONLY_FIX);
  }
  return null;
}

/** The start of every user_id this tool generates. */
export const DEV_USER_ID_PREFIX = "mcp-dev-";

/**
 * A user_id for a sandbox session when the caller gives none.
 *
 * The API requires a user_id on every session (api PR #44). For a quick test
 * the developer has no person to name, so the tool makes one up: "mcp-dev-"
 * and 16 hex characters from the operating system's random source. It starts
 * with none of the credential prefixes the API refuses as a user_id (sk_, ak_,
 * xat_, xit_, xtk_), and it never ends in "+fail", so the test session passes.
 */
export function generateDevUserId(): string {
  return DEV_USER_ID_PREFIX + randomBytes(8).toString("hex");
}

export const whoamiTool: ToolDef = {
  name: "xident_whoami",
  title: "Check the configured Xident credential",
  description:
    "Report which Xident credential this server is using and whether it is a sandbox key. " +
    "Run this first when a Xident call is failing with an auth error.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  requiresKey: true,
  handler: async (_args, ctx) => {
    const guard = requireClient(ctx);
    if (guard) return guard;
    const kind = ctx.kind ?? keyKind(ctx.apiKey ?? "");
    const problems: string[] = [];
    if (kind === "public") {
      problems.push("This is a PUBLIC key (pk_). Server-to-server calls need a server key: sk_, or ak_ with verification:write.");
    }
    if (kind === "unknown") {
      problems.push("Unrecognised key prefix. Xident keys start with sk_, pk_, or ak_.");
    }
    if (!ctx.sandbox) {
      problems.push("This is not a sandbox key. The development server refuses write operations against live credentials.");
    }
    const start = kind === "agent" || kind === "secret" ? await canStartVerifications(ctx, kind) : null;
    if (start && !start.ok) problems.push(start.detail);
    return ok({
      base_url: ctx.baseUrl,
      key_kind: kind,
      sandbox: ctx.sandbox,
      key_hint: ctx.apiKey ? `${ctx.apiKey.slice(0, 11)}…` : null,
      ...(start?.scopes ? { scopes: start.scopes } : {}),
      ready_for_test_verifications: start !== null && start.ok && ctx.sandbox,
      problems,
    });
  },
};

export const startTestVerificationTool: ToolDef = {
  name: "xident_start_test_verification",
  title: "Start a sandbox verification",
  description:
    "Create a sandbox verification session and return a verify_url to open in a browser. " +
    "Sandbox keys only. Use this to see the real flow end to end while building an integration.",
  // Types only for the settings fields, as in the runtime tool: a strict
  // schema would make the MCP SDK refuse with its own text before the handler
  // could return the API's code. checkInitArgs applies the rules.
  inputSchema: {
    min_age: z.number().optional().describe(MIN_AGE_DESCRIPTION),
    purpose: z.string().optional().describe(PURPOSE_DESCRIPTION),
    verification_mode: z.string().optional().describe(VERIFICATION_MODE_DESCRIPTION),
    callback_url: z.string().optional().describe(CALLBACK_URL_DESCRIPTION),
    user_id: z.string().optional().describe(
      "Your identifier for the test person. It comes back on the callback and in the result. Leave it out " +
      "and the tool generates mcp-dev-<random>. End it with +fail to make the test session fail."),
    locale: z.string().optional().describe("BCP-47 locale, e.g. de-DE"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  requiresKey: true,
  handler: async (args, ctx) => {
    const guard = requireClient(ctx) ?? requireSandbox(ctx);
    if (guard) return guard;

    const body: Record<string, unknown> = {};
    for (const key of ["min_age", "purpose", "verification_mode", "callback_url", "user_id", "locale"]) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    // Only a user_id that was left out gets the generated default. One that
    // was sent blank is refused below, not silently replaced.
    if (body["user_id"] === undefined) body["user_id"] = generateDevUserId();

    // The API refuses these settings too. Checking first gives the same
    // refusal without a request.
    const problem = checkInitArgs(body);
    if (problem) return problem;

    const res = await ctx.client!.request<Record<string, unknown>>("POST", "/verify/v1/init", {
      body,
      idempotencyKey: `mcp-dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    });
    if (!res.ok) return res.error;

    return ok({
      created: true,
      ...res.data,
      user_id: body["user_id"],
      next_step: "Open verify_url in a browser to run the flow, then call xident_get_result with the token.",
    });
  },
};

export const getResultTool: ToolDef = {
  name: "xident_get_result",
  title: "Read a verification result",
  description: "Fetch the verification result for a token. Returns Xident's verdict verbatim. " + RESULT_TOOL_GUIDANCE,
  // Types only for the access-check fields, so readAccessArgs's code reaches
  // a real tools/call instead of the MCP SDK's own schema text.
  inputSchema: {
    token: z.string().min(1).describe("The verification token, e.g. xtk_..."),
    expected_user_id: z.string().optional().describe(EXPECTED_USER_ID_DESCRIPTION),
    required_min_age: z.number().optional().describe(REQUIRED_MIN_AGE_DESCRIPTION),
    allow_test_results: z.boolean().optional().describe(ALLOW_TEST_RESULTS_DESCRIPTION),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  requiresKey: true,
  handler: async (args, ctx) => {
    const guard = requireClient(ctx);
    if (guard) return guard;
    const access = readAccessArgs(args);
    if (access && "error" in access) return access;
    const token = String(args["token"] ?? "");
    const res = await ctx.client!.request<Record<string, unknown>>("GET", `/verify/v1/result/${encodeURIComponent(token)}`);
    if (!res.ok) return res.error;
    if (!access) return ok(res.data);
    return ok({
      ...res.data,
      access: accessCheck(res.data, access.userId, access.requiredMinAge, { allowTest: access.allowTest }),
    });
  },
};

export const explainSessionTool: ToolDef = {
  name: "xident_explain_session",
  title: "Explain why a verification did not pass",
  description:
    "Translate a Xident failure reason code into what it means, who can act on it, and whether " +
    "retrying can help. Pass either a token (it will be fetched) or a reason code directly.",
  inputSchema: {
    token: z.string().optional().describe("A verification token to look up"),
    reason: z.string().optional().describe("A reason code, if you already have one"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  requiresKey: false,
  handler: async (args, ctx) => {
    const direct = args["reason"];
    if (typeof direct === "string" && direct.length > 0) {
      return ok({ source: "provided", ...explainReason(direct) });
    }

    const token = args["token"];
    if (typeof token !== "string" || token.length === 0) {
      return fail("MISSING_INPUT", "Provide either a token or a reason code.", "Call again with { reason: 'liveness_failed' } or { token: 'xtk_...' }.");
    }

    const guard = requireClient(ctx);
    if (guard) return guard;

    const res = await ctx.client!.request<Record<string, unknown>>("GET", `/verify/v1/result/${encodeURIComponent(token)}`);
    if (!res.ok) return res.error;

    const reason = res.data["reason"];
    if (typeof reason !== "string" || reason.length === 0) {
      return ok({
        source: "token",
        token,
        status: res.data["status"] ?? null,
        verified: res.data["verified"] ?? null,
        explanation: null,
        note: "This session carries no failure reason. If status is not terminal yet, poll again.",
      });
    }
    return ok({ source: "token", token, status: res.data["status"] ?? null, ...explainReason(reason) });
  },
};

export const checkIntegrationTool: ToolDef = {
  name: "xident_check_integration",
  title: "Lint a Xident integration",
  description:
    "Run practical checks against the configured credential and report anything that would break " +
    "an integration: wrong key type, an agent key without verification:write, live key in a dev server, " +
    "unreachable API.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  requiresKey: true,
  handler: async (_args, ctx) => {
    const guard = requireClient(ctx);
    if (guard) return guard;

    const checks: Array<{ check: string; passed: boolean; detail: string }> = [];
    const kind = ctx.kind ?? "unknown";

    const start = await canStartVerifications(ctx, kind);
    checks.push({ check: "key_type", passed: start.ok, detail: start.detail });
    checks.push({
      check: "sandbox",
      passed: ctx.sandbox,
      detail: ctx.sandbox ? "Sandbox key — safe for development." : "Live key configured in a development server.",
    });

    const res = await ctx.client!.request<unknown>("GET", "/verify/v1/countries");
    checks.push({
      check: "api_reachable",
      passed: res.ok,
      detail: res.ok ? `Reached ${ctx.baseUrl}.` : `Could not reach the API: ${res.error.code} — ${res.error.message}`,
    });

    return ok({ base_url: ctx.baseUrl, checks, all_passed: checks.every((c) => c.passed) });
  },
};
