import type { DevContext } from "../context.js";
import { getEndpointTool, searchDocsTool } from "./docs.js";
import {
  checkIntegrationTool, explainSessionTool, getResultTool,
  startTestVerificationTool, whoamiTool,
} from "./sessions.js";
import type { ToolDef } from "./types.js";
import { simulateWebhookTool, verifySignatureTool } from "./webhooks.js";

/**
 * Every tool this server can expose, in a stable order.
 *
 * The order is part of the golden file, so an accidental reshuffle shows up as a
 * contract diff rather than silently changing what clients see first.
 */
export const ALL_TOOLS: readonly ToolDef[] = [
  searchDocsTool,
  getEndpointTool,
  verifySignatureTool,
  whoamiTool,
  startTestVerificationTool,
  getResultTool,
  explainSessionTool,
  simulateWebhookTool,
  checkIntegrationTool,
];

/** Tools usable with no credentials at all. */
export const OFFLINE_TOOLS: readonly ToolDef[] = ALL_TOOLS.filter((t) => !t.requiresKey);

/** The tools to expose for a given context. */
export function toolsFor(ctx: DevContext): readonly ToolDef[] {
  return ctx.client ? ALL_TOOLS : OFFLINE_TOOLS;
}
