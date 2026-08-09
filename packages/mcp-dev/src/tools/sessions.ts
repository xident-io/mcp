import { z } from "zod";
import { explainReason, keyKind } from "@xident/mcp-shared";
import { fail, ok, requireClient, type ToolDef } from "./types.js";

const SANDBOX_ONLY_FIX =
  "Configure XIDENT_API_KEY with a sandbox key (sk_test_...). This server is for development; " +
  "point it at live credentials and it would create real, billable sessions.";

/** Refuse to act against live credentials. */
function requireSandbox(ctx: { sandbox: boolean; apiKey: string | null }) {
  if (!ctx.sandbox) {
    return fail("LIVE_KEY_REFUSED", "This tool refuses to run against a live API key.", SANDBOX_ONLY_FIX);
  }
  return null;
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
      problems.push("This is a PUBLIC key (pk_). Server-to-server calls need a secret key (sk_).");
    }
    if (kind === "unknown") {
      problems.push("Unrecognised key prefix. Xident keys start with sk_, pk_, or ak_.");
    }
    if (!ctx.sandbox) {
      problems.push("This is not a sandbox key. The development server refuses write operations against live credentials.");
    }
    return ok({
      base_url: ctx.baseUrl,
      key_kind: kind,
      sandbox: ctx.sandbox,
      key_hint: ctx.apiKey ? `${ctx.apiKey.slice(0, 11)}…` : null,
      ready_for_test_verifications: kind === "secret" && ctx.sandbox,
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
  inputSchema: {
    min_age: z.number().int().min(0).max(120).optional().describe("Age gate to test, e.g. 18"),
    purpose: z.enum(["age_verification", "id_verification"]).optional().describe("Default age_verification"),
    verification_mode: z.enum(["auto", "document", "facial"]).optional()
      .describe("auto (default), document (forces ID + face match), facial (on-device only)"),
    callback_url: z.string().url().optional().describe("Where the widget returns the user"),
    locale: z.string().optional().describe("BCP-47 locale, e.g. de-DE"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  requiresKey: true,
  handler: async (args, ctx) => {
    const guard = requireClient(ctx) ?? requireSandbox(ctx);
    if (guard) return guard;

    const body: Record<string, unknown> = {};
    for (const key of ["min_age", "purpose", "verification_mode", "callback_url", "locale"]) {
      if (args[key] !== undefined) body[key] = args[key];
    }

    const res = await ctx.client!.request<Record<string, unknown>>("POST", "/verify/v1/init", {
      body,
      idempotencyKey: `mcp-dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    });
    if (!res.ok) return res.error;

    return ok({
      created: true,
      ...res.data,
      next_step: "Open verify_url in a browser to run the flow, then call xident_get_result with the token.",
    });
  },
};

export const getResultTool: ToolDef = {
  name: "xident_get_result",
  title: "Read a verification result",
  description:
    "Fetch the verification result for a token. Returns Xident's verdict verbatim. " +
    "Report the `verified` field as given — never infer a verification outcome from other fields.",
  inputSchema: {
    token: z.string().min(1).describe("The verification token, e.g. xtk_..."),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  requiresKey: true,
  handler: async (args, ctx) => {
    const guard = requireClient(ctx);
    if (guard) return guard;
    const token = String(args["token"] ?? "");
    const res = await ctx.client!.request<Record<string, unknown>>("GET", `/verify/v1/result/${encodeURIComponent(token)}`);
    if (!res.ok) return res.error;
    return ok(res.data);
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
    "an integration: wrong key type, live key in a dev server, unreachable API.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  requiresKey: true,
  handler: async (_args, ctx) => {
    const guard = requireClient(ctx);
    if (guard) return guard;

    const checks: Array<{ check: string; passed: boolean; detail: string }> = [];
    const kind = ctx.kind ?? "unknown";

    checks.push({
      check: "key_type",
      passed: kind === "secret",
      detail: kind === "secret"
        ? "Secret key (sk_) — correct for server-to-server calls."
        : `Key kind is '${kind}'. Server-to-server calls require a secret key (sk_).`,
    });
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
