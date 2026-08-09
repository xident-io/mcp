import type { ZodRawShape } from "zod";
import type { DevContext } from "../context.js";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * A tool definition, independent of any transport.
 *
 * Keeping definitions as plain data (rather than registering directly against a
 * live server) is what makes the frozen-contract golden test and the
 * never-exposed test possible without standing up a transport.
 */
export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  annotations: ToolAnnotations;
  /** When true the tool is hidden unless an API key is configured. */
  requiresKey: boolean;
  handler: (args: Record<string, unknown>, ctx: DevContext) => Promise<unknown>;
}

/** Every tool returns data, never prose. See spec §5.1. */
export function ok(data: unknown): unknown {
  return data;
}

export function fail(code: string, message: string, fix: string): unknown {
  return { error: true, code, message, fix, retryable: false };
}

/** Guard for tools that need a configured key. */
export function requireClient(ctx: DevContext) {
  if (!ctx.client) {
    return fail(
      "NO_API_KEY",
      "No Xident API key is configured for this MCP server.",
      "Set XIDENT_API_KEY to a sandbox secret key (sk_test_...) in the MCP server config, then restart the client.",
    );
  }
  return null;
}
